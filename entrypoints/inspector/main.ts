import { browser } from '#imports';
import { settings } from '@/lib/storage';
import {
  INSPECTOR_PORT_NAME,
  INSPECTOR_RECONNECT_DELAY_MS,
  HIGHLIGHT_DURATION_MS,
  CACHE_LIST_EMPTY_LABEL,
  CACHE_CLEAR_CONFIRM,
  CACHE_BANNER_ORIGINAL_LABEL,
  CACHE_BANNER_AUTO_LABEL,
  CACHE_BANNER_API_LABEL,
  CACHE_BANNER_API_PLACEHOLDER,
  CACHE_BANNER_EMPTY_PLACEHOLDER,
} from '@/lib/constants';
import type { CvmRuntimeState, CvmCacheMeta, CvmCacheEntry, CaptionSegment } from '@/lib/types';
import type { InspectorMessage, InspectorControlMessage } from '@/lib/messaging';

type RuntimePort = ReturnType<typeof browser.runtime.connect>;

// --- Источники строк ---
const SOURCE_STORAGE = 'chrome.storage';
const SOURCE_RUNTIME = 'runtime state';

// --- Отображаемое значение ---
interface DisplayValue {
  text: string;
  typeName: string;
}

function asString(value: string): DisplayValue {
  return { text: `"${value}"`, typeName: 'String' };
}
function asBoolean(value: boolean): DisplayValue {
  return { text: String(value), typeName: 'Boolean' };
}
function asNumber(value: number): DisplayValue {
  return { text: String(value), typeName: 'Number' };
}
function asMasked(value: string): DisplayValue {
  return { text: value.length > 0 ? '•••••• (задан)' : '(пусто)', typeName: 'String' };
}
function asNullableId(value: string | null): DisplayValue {
  return { text: value === null ? 'null' : `"${value}"`, typeName: 'String' };
}

// --- Доступ к storage-элементу в обобщённом виде ---
interface WatchableValue<T> {
  getValue: () => Promise<T>;
  watch: (callback: (value: T) => void) => unknown;
}

// --- Реестр строк таблицы ---
interface Row {
  valueCell: HTMLElement;
  typeCell: HTMLElement;
  container: HTMLElement;
  previousText: string | null;
  highlightTimer: ReturnType<typeof setTimeout> | undefined;
}

const rows = new Map<string, Row>();
const rowsBody = document.getElementById('rows');
const connEl = document.getElementById('conn');
const connLabelEl = document.getElementById('conn-label');
const cacheListEl = document.getElementById('cache-list');
const cacheClearEl = document.getElementById('cache-clear');
const cacheSortEl = document.getElementById('cache-sort');
if (
  rowsBody === null ||
  connEl === null ||
  connLabelEl === null ||
  cacheListEl === null ||
  cacheClearEl === null ||
  cacheSortEl === null
) {
  throw new Error('[CVM] inspector: разметка не найдена');
}

function createRow(id: string, label: string, source: string): void {
  const tr = document.createElement('tr');

  const dotCell = document.createElement('td');
  dotCell.className = 'col-dot';
  const dot = document.createElement('span');
  dot.className = 'row-dot';
  dotCell.append(dot);

  const nameCell = document.createElement('td');
  nameCell.className = 'cell-name';
  nameCell.textContent = label;

  const valueCell = document.createElement('td');
  valueCell.className = 'cell-value';
  valueCell.textContent = '…';

  const typeCell = document.createElement('td');
  typeCell.className = 'cell-type';

  const sourceCell = document.createElement('td');
  sourceCell.className = 'cell-source';
  sourceCell.textContent = source;

  tr.append(dotCell, nameCell, valueCell, typeCell, sourceCell);
  rowsBody!.append(tr);

  rows.set(id, {
    valueCell,
    typeCell,
    container: tr,
    previousText: null,
    highlightTimer: undefined,
  });
}

function updateRow(id: string, display: DisplayValue): void {
  const row = rows.get(id);
  if (row === undefined) {
    return;
  }

  row.valueCell.textContent = display.text;
  row.typeCell.textContent = display.typeName;

  const isFirstPaint = row.previousText === null;
  const changed = !isFirstPaint && row.previousText !== display.text;
  row.previousText = display.text;

  if (!changed) {
    return;
  }

  if (row.highlightTimer !== undefined) {
    clearTimeout(row.highlightTimer);
  }
  row.container.classList.add('changed');
  row.highlightTimer = setTimeout(() => {
    row.container.classList.remove('changed');
    row.highlightTimer = undefined;
  }, HIGHLIGHT_DURATION_MS);
}

// --- Привязка storage-строки: начальное значение + живое наблюдение ---
function bindStorageRow<T>(
  id: string,
  source: WatchableValue<T>,
  format: (value: T) => DisplayValue,
): void {
  void source.getValue().then((value) => updateRow(id, format(value)));
  source.watch((value) => updateRow(id, format(value)));
}

// --- Рантайм-состояние из порта ---
function applyRuntimeState(state: CvmRuntimeState): void {
  updateRow('currentVideoId', asNullableId(state.currentVideoId));
  updateRow('translationStatus', asString(state.translationStatus));
  updateRow('translationActive', asBoolean(state.translationActive));
}

function setConnection(online: boolean): void {
  connEl!.classList.toggle('online', online);
  connLabelEl!.textContent = online ? 'подключено' : 'отключено';
}

// =====================================================================
// Меню кэша текстов (Стадия 2)
// =====================================================================

let activePort: RuntimePort | null = null;
let expandedKey: string | null = null; // ключ раскрытой позиции (аккордеон)
let cacheItems: CvmCacheMeta[] = []; // последний полученный список
let sortNewestFirst = true; // направление сортировки по времени создания
// Тела позиций по ключу — чтобы дозаполнить баннеры по приходу записи.
const cacheBodies = new Map<string, HTMLElement>();

function sendControl(message: InspectorControlMessage): void {
  activePort?.postMessage(message);
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

// Заполнить тело: оригинал + по баннеру на каждый целевой язык + заглушка API.
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

  const apiText = entry.apiTranslation === null ? '' : segmentsToText(entry.apiTranslation);
  body.append(
    createBanner(
      CACHE_BANNER_API_LABEL,
      apiText === '' ? CACHE_BANNER_API_PLACEHOLDER : apiText,
      apiText === '',
    ),
  );
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
    cacheBodies.get(expandedKey)?.parentElement?.classList.remove('open');
  }
  expandedKey = key;
  item.classList.add('open');
  body.replaceChildren(); // покажем содержимое по приходу записи
  sendControl({ type: 'request-cache-entry', videoId: meta.videoId });
}

function createCacheItem(meta: CvmCacheMeta): HTMLElement {
  const key = meta.videoId;
  const item = document.createElement('div');
  item.className = 'cache-item';

  const head = document.createElement('div');
  head.className = 'ci-head';

  const caret = document.createElement('span');
  caret.className = 'ci-caret';
  caret.textContent = '▶';

  const title = document.createElement('span');
  title.className = 'ci-title';
  title.textContent = meta.title === '' ? meta.videoId : meta.title;

  const link = document.createElement('a');
  link.className = 'ci-link';
  link.href = meta.url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = '↗';

  const time = document.createElement('span');
  time.className = 'ci-time';
  time.textContent = formatTime(meta.createdAt);

  head.append(caret, title, link, time);

  const body = document.createElement('div');
  body.className = 'ci-body';

  head.addEventListener('click', (event: MouseEvent) => {
    if (event.target === link) {
      return; // клик по ссылке не сворачивает/раскрывает
    }
    toggleItem(meta, item, body);
  });

  item.append(head, body);
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
  cacheListEl!.replaceChildren();
  (cacheSortEl as HTMLButtonElement).disabled = cacheItems.length === 0;

  if (cacheItems.length === 0) {
    expandedKey = null;
    const empty = document.createElement('div');
    empty.className = 'cache-empty';
    empty.textContent = CACHE_LIST_EMPTY_LABEL;
    cacheListEl!.append(empty);
    (cacheClearEl as HTMLButtonElement).disabled = true;
    return;
  }

  (cacheClearEl as HTMLButtonElement).disabled = false;
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
    cacheListEl!.append(item);
    // Восстановить раскрытие и перезапросить запись, если позиция была открыта.
    if (meta.videoId === expandedKey) {
      const body = cacheBodies.get(expandedKey);
      if (body !== undefined) {
        item.classList.add('open');
        sendControl({ type: 'request-cache-entry', videoId: meta.videoId });
      }
    }
  }
}

// Переключить направление сортировки и обновить подпись кнопки.
function toggleSort(): void {
  sortNewestFirst = !sortNewestFirst;
  cacheSortEl!.textContent = sortNewestFirst ? '↓ Сначала новые' : '↑ Сначала старые';
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

function connect(): void {
  const port = browser.runtime.connect({ name: INSPECTOR_PORT_NAME });
  activePort = port;
  setConnection(true);

  port.onMessage.addListener((message: unknown) => {
    const inspectorMessage = message as InspectorMessage;
    if (inspectorMessage.type === 'runtime-state') {
      applyRuntimeState(inspectorMessage.state);
    } else if (inspectorMessage.type === 'cache-list') {
      applyCacheList(inspectorMessage.items);
    } else if (inspectorMessage.type === 'cache-entry') {
      applyCacheEntry(inspectorMessage.entry);
    }
  });

  port.onDisconnect.addListener(() => {
    activePort = null;
    setConnection(false);
    setTimeout(connect, INSPECTOR_RECONNECT_DELAY_MS);
  });
}

function init(): void {
  // Storage-строки (порядок как в TASKS.md).
  createRow('videoDucking', 'videoDucking', SOURCE_STORAGE);
  createRow('translationVolume', 'translationVolume', SOURCE_STORAGE);
  createRow('subtitlesEnabled', 'subtitlesEnabled', SOURCE_STORAGE);
  createRow('ttsEnabled', 'ttsEnabled', SOURCE_STORAGE);
  createRow('useYoutubeTranslation', 'useYoutubeTranslation', SOURCE_STORAGE);
  createRow('autoStart', 'autoStart', SOURCE_STORAGE);
  createRow('selectedVoice', 'selectedVoice', SOURCE_STORAGE);
  createRow('targetLanguage', 'targetLanguage', SOURCE_STORAGE);
  createRow('apiKey', 'apiKey', SOURCE_STORAGE);
  // Runtime-строки.
  createRow('translationActive', 'translationActive', SOURCE_RUNTIME);
  createRow('currentVideoId', 'currentVideoId', SOURCE_RUNTIME);
  createRow('translationStatus', 'translationStatus', SOURCE_RUNTIME);

  bindStorageRow('videoDucking', settings.videoDucking, asNumber);
  bindStorageRow('translationVolume', settings.translationVolume, asNumber);
  bindStorageRow('subtitlesEnabled', settings.subtitlesEnabled, asBoolean);
  bindStorageRow('ttsEnabled', settings.ttsEnabled, asBoolean);
  bindStorageRow('useYoutubeTranslation', settings.useYoutubeTranslation, asBoolean);
  bindStorageRow('autoStart', settings.autoStart, asBoolean);
  bindStorageRow('selectedVoice', settings.selectedVoice, asString);
  bindStorageRow('targetLanguage', settings.targetLanguage, asString);
  bindStorageRow('apiKey', settings.apiKey, asMasked);

  cacheClearEl!.addEventListener('click', clearCache);
  cacheSortEl!.addEventListener('click', toggleSort);

  connect();
  console.info('[CVM] inspector ready');
}

document.addEventListener('DOMContentLoaded', init);
