import { browser } from '#imports';
import {
  CACHE_PORT_NAME,
  CACHE_RECONNECT_DELAY_MS,
  CACHE_LIST_EMPTY_LABEL,
  CACHE_CLEAR_CONFIRM,
  CACHE_BANNER_ORIGINAL_LABEL,
  CACHE_BANNER_AUTO_LABEL,
  CACHE_BANNER_API_LABEL,
  CACHE_BANNER_API_FILLING,
  CACHE_BANNER_EMPTY_PLACEHOLDER,
  CACHE_DELETE_VIDEO_CONFIRM,
  CACHE_DELETE_VIDEO_LABEL,
  youtubeThumbnailUrl,
} from '@/lib/constants';
import type { CvmCacheMeta, CvmCacheEntry, CaptionSegment } from '@/lib/types';
import type {
  CachePortMessage,
  CachePortControlMessage,
  DeleteVideoCacheMessage,
} from '@/lib/messaging';
import { buildThemeCss } from '@/lib/theme';

// Дизайн-токены Mnemosyne (--m-*) доступны как CSS-переменные на всей странице.
const themeStyle = document.createElement('style');
themeStyle.textContent = buildThemeCss(':root');
document.head.appendChild(themeStyle);

type RuntimePort = ReturnType<typeof browser.runtime.connect>;

// Типизированный доступ к обязательным элементам разметки.
function requireEl<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`[Mnemosyne] cache: нет элемента #${id}`);
  }
  return node as T;
}

const cacheListEl = requireEl<HTMLDivElement>('cache-list');
const cacheClearEl = requireEl<HTMLButtonElement>('cache-clear');
const cacheSortEl = requireEl<HTMLButtonElement>('cache-sort');

// =====================================================================
// Меню кэша текстов
// =====================================================================

let activePort: RuntimePort | null = null;
let expandedKey: string | null = null; // ключ раскрытой позиции (аккордеон)
let cacheItems: CvmCacheMeta[] = []; // последний полученный список
let sortNewestFirst = true; // направление сортировки по времени создания
// Тела позиций по ключу — чтобы дозаполнить баннеры по приходу записи.
const cacheBodies = new Map<string, HTMLElement>();

// Deep-link из popup (?v=<videoId>): развернуть конкретное видео и доскроллить к нему
// один раз, когда список приедет.
const DEEP_LINK_PARAM = 'v';
let deepLinkScrollPending = false;

function readDeepLink(): void {
  const videoId = new URLSearchParams(location.search).get(DEEP_LINK_PARAM);
  if (videoId !== null && videoId !== '') {
    expandedKey = videoId;
    deepLinkScrollPending = true;
  }
}

function sendControl(message: CachePortControlMessage): void {
  activePort?.postMessage(message);
}

// Удалить кэш одного видео (с подтверждением). Через runtime.sendMessage — он надёжно
// будит service worker (порт MV3 может «спать»). Список обновится по приходу cache-list.
function deleteVideo(videoId: string): void {
  if (!window.confirm(CACHE_DELETE_VIDEO_CONFIRM)) {
    return;
  }
  const message: DeleteVideoCacheMessage = { type: 'delete-video-cache', videoId };
  void browser.runtime.sendMessage(message);
}

function segmentsToText(segments: CaptionSegment[]): string {
  return segments.map((segment) => segment.text).join('\n');
}

function formatTime(createdAt: number): string {
  return new Date(createdAt).toLocaleString();
}

// Один баннер: подпись + текст (или курсивный плейсхолдер при отсутствии).
function createBanner(label: string, text: string, isPlaceholder: boolean): HTMLElement {
  const wrapper = document.createElement('div');

  const labelEl = document.createElement('div');
  labelEl.className = 'banner-label';
  labelEl.textContent = label;

  const textEl = document.createElement('div');
  textEl.className = isPlaceholder ? 'banner-text placeholder' : 'banner-text';
  textEl.textContent = text;

  wrapper.append(labelEl, textEl);
  return wrapper;
}

// Заполнить тело: оригинал + по баннеру на каждый целевой язык.
function fillBody(body: HTMLElement, entry: CvmCacheEntry): void {
  body.replaceChildren();

  const originalText = segmentsToText(entry.original);
  const originalLabel = `${CACHE_BANNER_ORIGINAL_LABEL} · ${entry.originalLanguage}${
    entry.originalKind === 'asr' ? ' (ASR)' : ''
  }`;
  body.append(
    createBanner(
      originalLabel,
      originalText === '' ? CACHE_BANNER_EMPTY_PLACEHOLDER : originalText,
      originalText === '',
    ),
  );

  // По баннеру на каждый целевой язык (сортируем по коду для стабильности).
  for (const language of Object.keys(entry.translations).sort()) {
    const text = segmentsToText(entry.translations[language] ?? []);
    body.append(
      createBanner(
        `${CACHE_BANNER_AUTO_LABEL} · ${language}`,
        text === '' ? CACHE_BANNER_EMPTY_PLACEHOLDER : text,
        text === '',
      ),
    );
  }

  // Переводы Claude API: по баннеру на язык. Нет перевода — раздел не показываем.
  const apiLanguages = Object.keys(entry.apiTranslations).sort();
  for (const language of apiLanguages) {
    const text = segmentsToText(entry.apiTranslations[language] ?? []);
    const meta = (entry.apiMeta ?? {})[language];
    // Пока перевод потоково наполняется — показываем прогресс в подписи.
    const label =
      meta !== undefined && !meta.complete
        ? `${CACHE_BANNER_API_LABEL} · ${language} · ${CACHE_BANNER_API_FILLING} ${meta.completedBatches}/${meta.batchCount}`
        : `${CACHE_BANNER_API_LABEL} · ${language}`;
    const banner = createBanner(
      label,
      text === '' ? CACHE_BANNER_EMPTY_PLACEHOLDER : text,
      text === '',
    );
    body.append(banner);
  }
}

// Раскрыть/свернуть позицию (аккордеон: раскрытие сворачивает прежнюю).
// Видимость тела управляется ТОЛЬКО классом .open (см. CSS), не атрибутом hidden.
function toggleItem(meta: CvmCacheMeta, item: HTMLElement, body: HTMLElement): void {
  const key = meta.videoId;
  if (expandedKey === key) {
    item.classList.remove('open');
    expandedKey = null;
    return;
  }
  // Свернуть ранее раскрытую.
  if (expandedKey !== null) {
    cacheListEl.querySelector('.cache-item.open')?.classList.remove('open');
  }
  expandedKey = key;
  item.classList.add('open');
  body.replaceChildren(); // покажем содержимое по приходу записи
  sendControl({ type: 'request-cache-entry', videoId: meta.videoId });
}

// Один чип языка перевода (auto — YouTube, api — Claude с акцентом).
function createLangChip(language: string, isApi: boolean): HTMLElement {
  const chip = document.createElement('span');
  chip.className = isApi ? 'ci-lang api' : 'ci-lang';
  chip.textContent = language;
  return chip;
}

// Иконка-корзина (контурная, наследует currentColor) для кнопки удаления.
const SVG_NS = 'http://www.w3.org/2000/svg';
const TRASH_PATHS = [
  'M3 6h18', // линия крышки
  'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2', // ручка
  'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6', // бак
  'M10 11v6', // левая полоска
  'M14 11v6', // правая полоска
];
function createTrashIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of TRASH_PATHS) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function createCacheItem(meta: CvmCacheMeta): HTMLElement {
  const key = meta.videoId;
  const item = document.createElement('div');
  item.className = 'cache-item';

  const head = document.createElement('div');
  head.className = 'ci-head';

  // Превью видео (как миниатюра в списке YouTube). Если кадр недоступен —
  // остаётся тёмная подложка контейнера.
  const thumb = document.createElement('div');
  thumb.className = 'ci-thumb';
  const thumbImg = document.createElement('img');
  thumbImg.loading = 'lazy';
  thumbImg.alt = '';
  thumbImg.src = youtubeThumbnailUrl(meta.videoId);
  thumbImg.addEventListener('error', () => {
    thumbImg.remove();
  });
  thumb.append(thumbImg);

  // Колонка с названием и метаданными.
  const main = document.createElement('div');
  main.className = 'ci-main';

  const title = document.createElement('span');
  title.className = 'ci-title';
  title.textContent = meta.title === '' ? meta.videoId : meta.title;

  const metaRow = document.createElement('div');
  metaRow.className = 'ci-meta';
  const origEl = document.createElement('span');
  origEl.textContent = `${CACHE_BANNER_ORIGINAL_LABEL}: ${meta.originalLanguage}${
    meta.originalKind === 'asr' ? ' (ASR)' : ''
  }`;
  const dot = document.createElement('span');
  dot.className = 'ci-meta-dot';
  dot.textContent = '·';
  const time = document.createElement('span');
  time.className = 'ci-time';
  time.textContent = formatTime(meta.createdAt);
  metaRow.append(origEl, dot, time);
  main.append(title, metaRow);

  // Чипы доступных переводов: сначала автоперевод (YouTube), затем Claude API.
  const apiSet = new Set(meta.apiLanguages);
  const autoOnly = meta.translationLanguages.filter((lang) => !apiSet.has(lang));
  if (autoOnly.length > 0 || meta.apiLanguages.length > 0) {
    const langs = document.createElement('div');
    langs.className = 'ci-langs';
    for (const lang of autoOnly) {
      langs.append(createLangChip(lang, false));
    }
    for (const lang of meta.apiLanguages) {
      langs.append(createLangChip(lang, true));
    }
    main.append(langs);
  }

  // Правый столбец (по центру): кнопка «смотреть видео» + удалить переводы.
  const aside = document.createElement('div');
  aside.className = 'ci-aside';
  const link = document.createElement('a');
  link.className = 'ci-link';
  link.href = meta.url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = 'Смотреть на YouTube';
  link.setAttribute('aria-label', 'Смотреть видео на YouTube');
  link.textContent = '▶';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ci-del';
  del.title = CACHE_DELETE_VIDEO_LABEL;
  del.setAttribute('aria-label', CACHE_DELETE_VIDEO_LABEL);
  del.append(createTrashIcon());
  del.addEventListener('click', (event: MouseEvent) => {
    event.stopPropagation(); // клик по удалению не раскрывает карточку
    void deleteVideo(meta.videoId);
  });
  aside.append(link, del);

  head.append(thumb, main, aside);

  // Тело: грид-контейнер анимирует высоту → clip (overflow:hidden, схлопывание в 0)
  // → content (отступы/граница/баннеры). См. CSS.
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'ci-body';
  const bodyClip = document.createElement('div');
  bodyClip.className = 'ci-body-clip';
  const body = document.createElement('div');
  body.className = 'ci-body-content';
  bodyClip.append(body);
  bodyWrap.append(bodyClip);

  head.addEventListener('click', (event: MouseEvent) => {
    if (event.target === link) {
      return; // клик по ссылке не сворачивает/раскрывает
    }
    toggleItem(meta, item, body);
  });

  item.append(head, bodyWrap);
  cacheBodies.set(key, body);
  return item;
}

// Сохранить новый список и перерисовать с учётом сортировки.
function applyCacheList(items: CvmCacheMeta[]): void {
  cacheItems = items;
  renderCacheList();
}

function renderCacheList(): void {
  cacheBodies.clear();
  cacheListEl.replaceChildren();
  cacheSortEl.disabled = cacheItems.length === 0;

  if (cacheItems.length === 0) {
    expandedKey = null;
    const empty = document.createElement('div');
    empty.className = 'cache-empty';
    empty.textContent = CACHE_LIST_EMPTY_LABEL;
    cacheListEl.append(empty);
    cacheClearEl.disabled = true;
    return;
  }

  cacheClearEl.disabled = false;
  const stillExpanded = cacheItems.some((meta) => meta.videoId === expandedKey);
  if (!stillExpanded) {
    expandedKey = null;
  }

  // Сортировка по времени создания согласно выбранному направлению.
  const sorted = [...cacheItems].sort((a, b) =>
    sortNewestFirst ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
  );

  for (const meta of sorted) {
    const item = createCacheItem(meta);
    cacheListEl.append(item);
    // Восстановить раскрытие и перезапросить запись, если позиция была открыта.
    if (meta.videoId === expandedKey) {
      const body = cacheBodies.get(expandedKey);
      if (body !== undefined) {
        item.classList.add('open');
        sendControl({ type: 'request-cache-entry', videoId: meta.videoId });
        // Deep-link из popup: один раз доскроллить к раскрытому видео.
        if (deepLinkScrollPending) {
          deepLinkScrollPending = false;
          item.scrollIntoView({ block: 'center' });
        }
      }
    }
  }
}

// Переключить направление сортировки и обновить подпись кнопки.
function toggleSort(): void {
  sortNewestFirst = !sortNewestFirst;
  cacheSortEl.textContent = sortNewestFirst ? '↓ Сначала новые' : '↑ Сначала старые';
  renderCacheList();
}

function applyCacheEntry(entry: CvmCacheEntry | null): void {
  if (entry === null) {
    return;
  }
  if (entry.videoId !== expandedKey) {
    return; // запись для уже свёрнутой позиции — игнорируем
  }
  const body = cacheBodies.get(entry.videoId);
  if (body !== undefined) {
    fillBody(body, entry);
  }
}

function clearCache(): void {
  if (!window.confirm(CACHE_CLEAR_CONFIRM)) {
    return;
  }
  sendControl({ type: 'clear-cache' });
}

// =====================================================================
// Подключение к фону (порт страницы кэша): кэш-сообщения
// =====================================================================

function connect(): void {
  const port = browser.runtime.connect({ name: CACHE_PORT_NAME });
  activePort = port;

  port.onMessage.addListener((message: unknown) => {
    const cacheMessage = message as CachePortMessage;
    if (cacheMessage.type === 'cache-list') {
      applyCacheList(cacheMessage.items);
    } else if (cacheMessage.type === 'cache-entry') {
      applyCacheEntry(cacheMessage.entry);
    }
  });

  port.onDisconnect.addListener(() => {
    activePort = null;
    setTimeout(connect, CACHE_RECONNECT_DELAY_MS);
  });
}

function init(): void {
  readDeepLink(); // ?v=<videoId> — развернуть конкретное видео при открытии
  cacheClearEl.addEventListener('click', clearCache);
  cacheSortEl.addEventListener('click', toggleSort);

  connect();
  console.info('[Mnemosyne] cache ready');
}

document.addEventListener('DOMContentLoaded', init);
