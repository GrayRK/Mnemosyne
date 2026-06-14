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
  CACHE_BANNER_API_FILLING,
  CACHE_BANNER_EMPTY_PLACEHOLDER,
  API_MODEL,
  API_MODEL_DISPLAY,
  MONITOR_BUTTON_LABEL,
  MONITOR_TITLE,
  MONITOR_LABELS,
  COST_FIX_TITLE,
  COST_FIX_BUTTON,
  COST_FIX_LOCKED_NOTE,
  COST_FIX_HINT,
  COST_FIX_CONFIRM,
  COST_FIX_INVALID,
  CALC_MAX_MINUTES,
  CALC_DEFAULT_MINUTES,
  CALC_RESET_CONFIRM,
  CALC_LABELS,
  TTS_RATE_MIN,
  TTS_RATE_MAX,
  TTS_RATE_STEP,
  TTS_OFFSET_MIN_MS,
  TTS_OFFSET_MAX_MS,
  TTS_OFFSET_STEP_MS,
  SUBS_POSITION_MIN,
  SUBS_POSITION_MAX,
  SUBS_POSITION_STEP,
  SUBS_RATE_PREFIX,
  TTS_ENDPOINT_LABEL,
  TTS_ENDPOINT_HINT,
  API_KEY_SAVE_DEBOUNCE_MS,
} from '@/lib/constants';
import { costSamples, computeStats, clearCostSamples } from '@/lib/calibration';
import type {
  TabRuntimeState,
  CvmCacheMeta,
  CvmCacheEntry,
  CaptionSegment,
  ApiTranslationMeta,
  CalibrationStats,
} from '@/lib/types';
import type {
  InspectorMessage,
  InspectorControlMessage,
  RecordApiCostMessage,
  RecordApiCostResponse,
} from '@/lib/messaging';

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
const monitorOverlayEl = document.getElementById('monitor-overlay');
const monitorTitleEl = document.getElementById('monitor-title');
const monitorBodyEl = document.getElementById('monitor-body');
const monitorCloseEl = document.getElementById('monitor-close');
if (
  rowsBody === null ||
  connEl === null ||
  connLabelEl === null ||
  cacheListEl === null ||
  cacheClearEl === null ||
  cacheSortEl === null ||
  monitorOverlayEl === null ||
  monitorTitleEl === null ||
  monitorBodyEl === null ||
  monitorCloseEl === null
) {
  throw new Error('[CVM] inspector: разметка не найдена');
}

// Типизированный доступ к обязательным элементам (без длинных null-проверок).
function requireEl<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`[CVM] inspector: нет элемента #${id}`);
  }
  return node as T;
}

// Фиксация стоимости в модалке монитора.
const mcTitleEl = requireEl<HTMLDivElement>('mc-title');
const mcInputEl = requireEl<HTMLInputElement>('mc-input');
const mcFixEl = requireEl<HTMLButtonElement>('mc-fix');
const mcNoteEl = requireEl<HTMLDivElement>('mc-note');

// Калькулятор стоимости.
const calcResetEl = requireEl<HTMLButtonElement>('calc-reset');
const calcEmptyEl = requireEl<HTMLDivElement>('calc-empty');
const calcControlsEl = requireEl<HTMLDivElement>('calc-controls');
const calcMinutesEl = requireEl<HTMLInputElement>('calc-minutes');
const calcMinutesOutEl = requireEl<HTMLSpanElement>('calc-minutes-out');
const calcCharsEl = requireEl<HTMLInputElement>('calc-chars');
const calcCostEl = requireEl<HTMLInputElement>('calc-cost');
const calcLiveEl = requireEl<HTMLDivElement>('calc-live');
const calcStatsEl = requireEl<HTMLDivElement>('calc-stats');

// Панель озвучки (TTS): ползунки диапазона скорости «От/До».
const ttsMinRateEl = requireEl<HTMLInputElement>('tts-minrate');
const ttsMinRateOutEl = requireEl<HTMLSpanElement>('tts-minrate-out');
const ttsMaxRateEl = requireEl<HTMLInputElement>('tts-maxrate');
const ttsMaxRateOutEl = requireEl<HTMLSpanElement>('tts-maxrate-out');
const ttsOffsetEl = requireEl<HTMLInputElement>('tts-offset');
const ttsOffsetOutEl = requireEl<HTMLSpanElement>('tts-offset-out');
const subsPosEl = requireEl<HTMLInputElement>('subs-pos');
const subsPosOutEl = requireEl<HTMLSpanElement>('subs-pos-out');
const ttsEndpointEl = requireEl<HTMLInputElement>('tts-endpoint');
const ttsEndpointLabelEl = requireEl<HTMLLabelElement>('tts-endpoint-label');
const ttsEndpointHintEl = requireEl<HTMLDivElement>('tts-endpoint-hint');

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

// Удалить строку (для динамических per-tab строк закрытых вкладок).
function removeRow(id: string): void {
  const row = rows.get(id);
  if (row === undefined) {
    return;
  }
  if (row.highlightTimer !== undefined) {
    clearTimeout(row.highlightTimer);
  }
  row.container.remove();
  rows.delete(id);
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

// --- Рантайм-состояние из порта (per-tab, Стадия 3.4) ---
const TAB_ROW_PREFIX = 'tab:'; // префикс id динамических строк вкладок
const RUNTIME_EMPTY_ROW_ID = 'tabs-empty'; // строка-заглушка, когда активных вкладок нет
const knownTabRowIds = new Set<string>();

// Компактная сводка состояния вкладки в одну ячейку значения.
function formatTabState(tab: TabRuntimeState): DisplayValue {
  const parts = [
    tab.currentVideoId === null ? '—' : `"${tab.currentVideoId}"`,
    tab.translationStatus,
    tab.translationActive ? 'active' : 'idle',
    tab.translationProgress === null
      ? '—'
      : `${tab.translationProgress.done}/${tab.translationProgress.total}`,
  ];
  return { text: parts.join(' · '), typeName: 'Tab' };
}

function applyRuntimeTabs(tabs: TabRuntimeState[]): void {
  // Заглушка, если ни одной активной вкладки нет.
  if (tabs.length === 0) {
    if (!rows.has(RUNTIME_EMPTY_ROW_ID)) {
      createRow(RUNTIME_EMPTY_ROW_ID, '(нет активных вкладок)', SOURCE_RUNTIME);
    }
    updateRow(RUNTIME_EMPTY_ROW_ID, { text: '—', typeName: 'null' });
  } else {
    removeRow(RUNTIME_EMPTY_ROW_ID);
  }

  const seen = new Set<string>();
  for (const tab of tabs) {
    const id = `${TAB_ROW_PREFIX}${tab.tabId}`;
    seen.add(id);
    if (!knownTabRowIds.has(id)) {
      createRow(id, `tab ${tab.tabId}`, SOURCE_RUNTIME);
      knownTabRowIds.add(id);
    }
    updateRow(id, formatTabState(tab));
  }
  // Удаляем строки закрытых/исчезнувших вкладок.
  for (const id of [...knownTabRowIds]) {
    if (!seen.has(id)) {
      removeRow(id);
      knownTabRowIds.delete(id);
    }
  }
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

// --- API Monitor: кнопка в баннере + модалка с метриками (Стадия 3.2) ---

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} с`;
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString('ru-RU');
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function addMonitorRow(label: string, value: string): void {
  const row = document.createElement('div');
  row.className = 'monitor-row';
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  row.append(dt, dd);
  monitorBodyEl!.append(row);
}

// Контекст открытой модалки — для фиксации стоимости этого перевода.
let openCost: { videoId: string; language: string } | null = null;

// Настроить блок фиксации стоимости: заблокирован, если стоимость уже задана.
function setupCostBlock(meta: ApiTranslationMeta): void {
  mcTitleEl.textContent = COST_FIX_TITLE;
  mcFixEl.textContent = COST_FIX_BUTTON;
  mcNoteEl.classList.remove('error', 'locked');

  const fixed = meta.costUsd !== null && meta.costUsd !== undefined;
  if (fixed) {
    mcInputEl.value = String(meta.costUsd);
    mcInputEl.disabled = true;
    mcFixEl.disabled = true;
    mcNoteEl.textContent = COST_FIX_LOCKED_NOTE;
    mcNoteEl.classList.add('locked');
  } else {
    mcInputEl.value = '';
    mcInputEl.disabled = false;
    mcFixEl.disabled = false;
    mcNoteEl.textContent = COST_FIX_HINT;
  }
}

function openMonitor(meta: ApiTranslationMeta, videoId: string, language: string): void {
  openCost = { videoId, language };

  monitorTitleEl!.textContent = MONITOR_TITLE;
  const sub = document.createElement('span');
  sub.className = 'monitor-sub';
  sub.textContent = language;
  monitorTitleEl!.append(sub);

  monitorBodyEl!.replaceChildren();
  const modelName = meta.model === API_MODEL ? API_MODEL_DISPLAY : meta.model;
  addMonitorRow(MONITOR_LABELS.model, modelName);
  addMonitorRow(MONITOR_LABELS.batches, formatInt(meta.batchCount));
  addMonitorRow(
    MONITOR_LABELS.charsPerBatch,
    formatInt(meta.batchCount === 0 ? 0 : meta.charsTotal / meta.batchCount),
  );
  addMonitorRow(MONITOR_LABELS.charsTotal, formatInt(meta.charsTotal));
  addMonitorRow(MONITOR_LABELS.segments, formatInt(meta.segmentCount));
  addMonitorRow(MONITOR_LABELS.batchTime, formatMs(average(meta.batchMs)));
  addMonitorRow(MONITOR_LABELS.totalTime, formatMs(meta.totalMs));
  addMonitorRow(MONITOR_LABELS.inputTokens, formatInt(meta.inputTokens));
  addMonitorRow(MONITOR_LABELS.outputTokens, formatInt(meta.outputTokens));

  setupCostBlock(meta);
  monitorOverlayEl!.hidden = false;
}

function closeMonitor(): void {
  monitorOverlayEl!.hidden = true;
  openCost = null;
}

// Зафиксировать введённую стоимость: валидация → подтверждение → запись в фон.
async function fixCost(): Promise<void> {
  if (openCost === null) {
    return;
  }
  const value = Number.parseFloat(mcInputEl.value);
  if (!(value > 0) || !Number.isFinite(value)) {
    mcNoteEl.textContent = COST_FIX_INVALID;
    mcNoteEl.classList.add('error');
    return;
  }
  if (!window.confirm(COST_FIX_CONFIRM.replace('%s', value.toFixed(4)))) {
    return;
  }
  const message: RecordApiCostMessage = {
    type: 'record-api-cost',
    videoId: openCost.videoId,
    language: openCost.language,
    costUsd: value,
  };
  const response = (await browser.runtime.sendMessage(message)) as
    | RecordApiCostResponse
    | undefined;
  if (response?.ok === true) {
    mcInputEl.value = value.toFixed(4);
    mcInputEl.disabled = true;
    mcFixEl.disabled = true;
    mcNoteEl.classList.remove('error');
    mcNoteEl.classList.add('locked');
    mcNoteEl.textContent = COST_FIX_LOCKED_NOTE;
  } else {
    mcNoteEl.textContent = `Ошибка: ${response?.error ?? 'нет ответа'}`;
    mcNoteEl.classList.add('error');
  }
}

// Добавить в баннер кнопку открытия монитора для метрик этого языка.
function appendMonitorButton(
  wrapper: HTMLElement,
  meta: ApiTranslationMeta,
  videoId: string,
  language: string,
): void {
  const actions = document.createElement('div');
  actions.className = 'banner-actions';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'monitor-btn';
  button.textContent = MONITOR_BUTTON_LABEL;
  button.addEventListener('click', () => openMonitor(meta, videoId, language));
  actions.append(button);
  wrapper.append(actions);
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

  // Переводы Claude API: по баннеру на язык, либо один плейсхолдер, если их нет.
  const apiLanguages = Object.keys(entry.apiTranslations).sort();
  if (apiLanguages.length === 0) {
    body.append(createBanner(CACHE_BANNER_API_LABEL, CACHE_BANNER_API_PLACEHOLDER, true));
  } else {
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
      // Кнопка монитора — только если по этому языку есть замеры (apiMeta).
      if (meta !== undefined) {
        appendMonitorButton(banner, meta, entry.videoId, language);
      }
      body.append(banner);
    }
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

// =====================================================================
// Калькулятор стоимости (Стадия 3.3)
// =====================================================================

let calcStats: CalibrationStats = {
  sampleCount: 0,
  dollarsPerChar: 0,
  charsPerMinute: 0,
  tokensPerChar: 0,
};
let calcChars = 0; // канонический объём; из него считаются минуты и стоимость

function formatMoney(value: number): string {
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function addCsRow(label: string, value: string): void {
  const row = document.createElement('div');
  row.className = 'cs-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'cs-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'cs-val';
  valueEl.textContent = value;
  row.append(labelEl, valueEl);
  calcStatsEl.append(row);
}

function renderCalcStats(): void {
  calcStatsEl.replaceChildren();
  addCsRow(CALC_LABELS.perKChar, `$${(calcStats.dollarsPerChar * 1000).toFixed(3)}`);
  addCsRow(
    CALC_LABELS.density,
    calcStats.charsPerMinute > 0 ? formatInt(calcStats.charsPerMinute) : '—',
  );
  // Грубое «среднее по видео»: $/мин = плотность речи (D) × ставка ($/символ, R).
  const costPerMinute = calcStats.charsPerMinute * calcStats.dollarsPerChar;
  addCsRow(CALC_LABELS.costPerMinute, costPerMinute > 0 ? formatMoney(costPerMinute) : '—');
  addCsRow(CALC_LABELS.samples, formatInt(calcStats.sampleCount));
  addCsRow(CALC_LABELS.model, API_MODEL_DISPLAY);
}

// Пересчитать и расставить значения всех контролов из канонического объёма.
// Программная установка .value не вызывает 'input' — обратной связи нет.
function syncFromChars(chars: number): void {
  const density = calcStats.charsPerMinute;
  const rate = calcStats.dollarsPerChar;
  const maxChars = density > 0 ? density * CALC_MAX_MINUTES : Math.max(chars, 0);
  const clamped = Math.max(0, Math.min(chars, maxChars));
  calcChars = clamped;

  if (density > 0) {
    const minutes = clamped / density;
    calcMinutesEl.disabled = false;
    calcMinutesEl.value = String(Math.round(minutes));
    calcMinutesOutEl.textContent = `${Math.round(minutes)} мин`;
  } else {
    calcMinutesEl.disabled = true;
    calcMinutesOutEl.textContent = '—';
  }

  calcCharsEl.value = String(Math.round(clamped));
  const cost = clamped * rate;
  calcCostEl.value = cost.toFixed(4);

  const tokens = Math.round(clamped * calcStats.tokensPerChar);
  calcLiveEl.textContent = `${formatMoney(cost)} · ≈ ${formatInt(tokens)} ${CALC_LABELS.tokensUnit}`;
}

function renderCalc(): void {
  calcResetEl.disabled = calcStats.sampleCount === 0;

  const usable = calcStats.dollarsPerChar > 0;
  calcEmptyEl.hidden = usable;
  calcControlsEl.hidden = !usable;
  if (!usable) {
    calcEmptyEl.textContent = CALC_LABELS.empty;
    return;
  }

  calcMinutesEl.max = String(CALC_MAX_MINUTES);
  if (calcChars <= 0) {
    // Первичная инициализация объёма от стартовой длины видео.
    calcChars =
      calcStats.charsPerMinute > 0 ? calcStats.charsPerMinute * CALC_DEFAULT_MINUTES : 5000;
  }
  renderCalcStats();
  syncFromChars(calcChars);
}

async function loadCalibration(): Promise<void> {
  const samples = await costSamples.getValue();
  calcStats = computeStats(samples, API_MODEL);
  renderCalc();
}

async function resetCalibration(): Promise<void> {
  if (!window.confirm(CALC_RESET_CONFIRM)) {
    return;
  }
  await clearCostSamples();
  calcChars = 0; // watch пересоберёт stats и перерисует
}

function initCalc(): void {
  calcMinutesEl.addEventListener('input', () => {
    syncFromChars(Number(calcMinutesEl.value) * calcStats.charsPerMinute);
  });
  calcCharsEl.addEventListener('input', () => {
    syncFromChars(Number(calcCharsEl.value));
  });
  calcCostEl.addEventListener('input', () => {
    const rate = calcStats.dollarsPerChar;
    syncFromChars(rate > 0 ? Number(calcCostEl.value) / rate : 0);
  });
  calcResetEl.addEventListener('click', () => {
    void resetCalibration();
  });
  costSamples.watch((samples) => {
    calcStats = computeStats(samples, API_MODEL);
    renderCalc();
  });
  void loadCalibration();
}

// =====================================================================
// Панель озвучки (TTS, Стадия 4): потолок скорости
// =====================================================================

function formatRate(rate: number): string {
  return `${SUBS_RATE_PREFIX}${rate.toFixed(1)}`;
}

function initTtsPanel(): void {
  for (const slider of [ttsMinRateEl, ttsMaxRateEl]) {
    slider.min = String(TTS_RATE_MIN);
    slider.max = String(TTS_RATE_MAX);
    slider.step = String(TTS_RATE_STEP);
  }

  function paintMin(value: number): void {
    ttsMinRateEl.value = String(value);
    ttsMinRateOutEl.textContent = formatRate(value);
  }
  function paintMax(value: number): void {
    ttsMaxRateEl.value = String(value);
    ttsMaxRateOutEl.textContent = formatRate(value);
  }

  void settings.ttsMinRate.getValue().then(paintMin);
  void settings.ttsMaxRate.getValue().then(paintMax);

  // «От» не может превышать «До»: тянем «До» вверх за собой при необходимости.
  ttsMinRateEl.addEventListener('input', () => {
    const value = Number(ttsMinRateEl.value);
    paintMin(value);
    void settings.ttsMinRate.setValue(value);
    if (value > Number(ttsMaxRateEl.value)) {
      paintMax(value);
      void settings.ttsMaxRate.setValue(value);
    }
  });

  // «До» не может опускаться ниже «От»: тянем «От» вниз за собой при необходимости.
  ttsMaxRateEl.addEventListener('input', () => {
    const value = Number(ttsMaxRateEl.value);
    paintMax(value);
    void settings.ttsMaxRate.setValue(value);
    if (value < Number(ttsMinRateEl.value)) {
      paintMin(value);
      void settings.ttsMinRate.setValue(value);
    }
  });

  // Внешние изменения (другая вкладка/контекст) — обновляем контролы.
  settings.ttsMinRate.watch(paintMin);
  settings.ttsMaxRate.watch(paintMax);

  // Сдвиг озвучки/субтитров относительно видео (мс).
  ttsOffsetEl.min = String(TTS_OFFSET_MIN_MS);
  ttsOffsetEl.max = String(TTS_OFFSET_MAX_MS);
  ttsOffsetEl.step = String(TTS_OFFSET_STEP_MS);
  function paintOffset(ms: number): void {
    ttsOffsetEl.value = String(ms);
    ttsOffsetOutEl.textContent = `${ms > 0 ? '+' : ''}${ms} мс`;
  }
  void settings.ttsOffsetMs.getValue().then(paintOffset);
  ttsOffsetEl.addEventListener('input', () => {
    const ms = Number(ttsOffsetEl.value);
    paintOffset(ms);
    void settings.ttsOffsetMs.setValue(ms);
  });
  settings.ttsOffsetMs.watch(paintOffset);

  // Положение субтитров на экране (вертикаль, %).
  subsPosEl.min = String(SUBS_POSITION_MIN);
  subsPosEl.max = String(SUBS_POSITION_MAX);
  subsPosEl.step = String(SUBS_POSITION_STEP);
  function paintSubsPos(pct: number): void {
    subsPosEl.value = String(pct);
    subsPosOutEl.textContent = `${pct}%`;
  }
  void settings.subsPositionPct.getValue().then(paintSubsPos);
  subsPosEl.addEventListener('input', () => {
    const pct = Number(subsPosEl.value);
    paintSubsPos(pct);
    void settings.subsPositionPct.setValue(pct);
  });
  settings.subsPositionPct.watch(paintSubsPos);

  // Эндпоинт синтеза (Cloudflare Worker / локальный релей). Сохраняем с debounce.
  ttsEndpointLabelEl.textContent = TTS_ENDPOINT_LABEL;
  ttsEndpointHintEl.textContent = TTS_ENDPOINT_HINT;
  void settings.ttsEndpoint.getValue().then((value) => {
    ttsEndpointEl.value = value;
  });
  let endpointTimer: ReturnType<typeof setTimeout> | undefined;
  ttsEndpointEl.addEventListener('input', () => {
    if (endpointTimer !== undefined) {
      clearTimeout(endpointTimer);
    }
    endpointTimer = setTimeout(() => {
      void settings.ttsEndpoint.setValue(ttsEndpointEl.value.trim());
    }, API_KEY_SAVE_DEBOUNCE_MS);
  });
  settings.ttsEndpoint.watch((value) => {
    if (document.activeElement !== ttsEndpointEl) {
      ttsEndpointEl.value = value;
    }
  });
}

function connect(): void {
  const port = browser.runtime.connect({ name: INSPECTOR_PORT_NAME });
  activePort = port;
  setConnection(true);

  port.onMessage.addListener((message: unknown) => {
    const inspectorMessage = message as InspectorMessage;
    if (inspectorMessage.type === 'runtime-state') {
      applyRuntimeTabs(inspectorMessage.tabs);
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
  createRow('ttsMinRate', 'ttsMinRate', SOURCE_STORAGE);
  createRow('ttsMaxRate', 'ttsMaxRate', SOURCE_STORAGE);
  createRow('ttsEndpoint', 'ttsEndpoint', SOURCE_STORAGE);
  createRow('ttsOffsetMs', 'ttsOffsetMs', SOURCE_STORAGE);
  createRow('subsPositionPct', 'subsPositionPct', SOURCE_STORAGE);
  createRow('subtitlesEnabled', 'subtitlesEnabled', SOURCE_STORAGE);
  createRow('ttsEnabled', 'ttsEnabled', SOURCE_STORAGE);
  createRow('ttsEngine', 'ttsEngine', SOURCE_STORAGE);
  createRow('useYoutubeTranslation', 'useYoutubeTranslation', SOURCE_STORAGE);
  createRow('autoStart', 'autoStart', SOURCE_STORAGE);
  createRow('selectedVoice', 'selectedVoice', SOURCE_STORAGE);
  createRow('selectedVoiceEdge', 'selectedVoiceEdge', SOURCE_STORAGE);
  createRow('targetLanguage', 'targetLanguage', SOURCE_STORAGE);
  createRow('apiKey', 'apiKey', SOURCE_STORAGE);
  // Runtime-строки создаются динамически per-tab (applyRuntimeTabs) по приходу состояния.

  bindStorageRow('videoDucking', settings.videoDucking, asNumber);
  bindStorageRow('translationVolume', settings.translationVolume, asNumber);
  bindStorageRow('ttsMinRate', settings.ttsMinRate, asNumber);
  bindStorageRow('ttsMaxRate', settings.ttsMaxRate, asNumber);
  bindStorageRow('ttsEndpoint', settings.ttsEndpoint, asString);
  bindStorageRow('ttsOffsetMs', settings.ttsOffsetMs, asNumber);
  bindStorageRow('subsPositionPct', settings.subsPositionPct, asNumber);
  bindStorageRow('subtitlesEnabled', settings.subtitlesEnabled, asBoolean);
  bindStorageRow('ttsEnabled', settings.ttsEnabled, asBoolean);
  bindStorageRow('ttsEngine', settings.ttsEngine, asString);
  bindStorageRow('useYoutubeTranslation', settings.useYoutubeTranslation, asBoolean);
  bindStorageRow('autoStart', settings.autoStart, asBoolean);
  bindStorageRow('selectedVoice', settings.selectedVoice, asString);
  bindStorageRow('selectedVoiceEdge', settings.selectedVoiceEdge, asString);
  bindStorageRow('targetLanguage', settings.targetLanguage, asString);
  bindStorageRow('apiKey', settings.apiKey, asMasked);

  cacheClearEl!.addEventListener('click', clearCache);
  cacheSortEl!.addEventListener('click', toggleSort);

  // Закрытие модалки монитора: крестик, клик по фону, Esc.
  monitorCloseEl!.addEventListener('click', closeMonitor);
  monitorOverlayEl!.addEventListener('click', (event: MouseEvent) => {
    if (event.target === monitorOverlayEl) {
      closeMonitor();
    }
  });
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && monitorOverlayEl!.hidden === false) {
      closeMonitor();
    }
  });

  mcFixEl.addEventListener('click', () => {
    void fixCost();
  });
  initCalc();
  initTtsPanel();

  connect();
  console.info('[CVM] inspector ready');
}

document.addEventListener('DOMContentLoaded', init);
