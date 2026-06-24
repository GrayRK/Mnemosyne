import { browser } from '#imports';
import { settings } from '@/lib/storage';
import {
  SUPPORTED_LANGUAGES,
  MAX_VOLUME,
  MAX_VIDEO_DUCKING,
  PERCENT_SCALE,
  API_KEY_SAVE_DEBOUNCE_MS,
  CACHE_PAGE,
  CACHE_DELETE_VIDEO_CONFIRM,
  CACHE_DELETE_VIDEO_YES,
  CACHE_DELETE_VIDEO_NO,
  TTS_ENGINE_OPTIONS,
  TTS_METHOD_STUBS,
  EDGE_VOICE_CATALOG,
  TRANSLATION_METHOD_OPTIONS,
  TRANSLATION_METHOD_GOOGLE,
  DEFAULT_TRANSLATION_METHOD,
  youtubeThumbnailUrl,
  SUBS_BG_OPACITY_MIN,
  SUBS_BG_OPACITY_MAX,
  SUBS_BG_OPACITY_STEP,
  SUBS_SIZE_MIN,
  SUBS_SIZE_MAX,
  SUBS_SIZE_STEP,
  SUBS_POSITION_MIN,
  SUBS_POSITION_MAX,
  SUBS_POSITION_STEP,
  SUBS_FONT_OPTIONS,
  DEFAULT_SUBS_FONT,
} from '@/lib/constants';
import type { TranslationMethodOption } from '@/lib/constants';
import type { TtsEngineName, CvmCacheMeta } from '@/lib/types';
import type {
  RequestVideoMetaMessage,
  VideoMetaResponse,
  DeleteVideoCacheMessage,
  DeleteVideoCacheResponse,
  HelperStatusMessage,
  HelperStatusResponse,
} from '@/lib/messaging';
import { buildThemeCss } from '@/lib/theme';
import { t, UI_LANGUAGES, DEFAULT_UI_LANGUAGE } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n';

// Дизайн-токены Mnemosyne (--m-*) доступны как CSS-переменные на всей странице.
const themeStyle = document.createElement('style');
themeStyle.textContent = buildThemeCss(':root');
document.head.appendChild(themeStyle);

// --- Доступ к элементам (строго, без any) ---
function requireEl<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`[Mnemosyne] popup: элемент #${id} не найден`);
  }
  return node as T;
}

const apiKeyEl = requireEl<HTMLInputElement>('api-key');
const languageEl = requireEl<HTMLSelectElement>('language');
const ttsEngineEl = requireEl<HTMLSelectElement>('tts-engine');
const voiceEl = requireEl<HTMLSelectElement>('voice');
const ttsEnabledEl = requireEl<HTMLInputElement>('tts-enabled');
const subtitlesEnabledEl = requireEl<HTMLInputElement>('subtitles-enabled');
const translationMethodEl = requireEl<HTMLSelectElement>('translation-method');
const translationMethodHintEl = requireEl<HTMLElement>('translation-method-hint');
const autoStartEl = requireEl<HTMLInputElement>('auto-start');
const ttsVolumeEl = requireEl<HTMLInputElement>('tts-volume');
const ttsVolumeValueEl = requireEl<HTMLElement>('tts-volume-value');
const videoVolumeEl = requireEl<HTMLInputElement>('video-volume');
const videoVolumeValueEl = requireEl<HTMLElement>('video-volume-value');
const openHistoryEl = requireEl<HTMLButtonElement>('open-history');
const langButtonEl = requireEl<HTMLButtonElement>('lang-button');
const langDropdownEl = requireEl<HTMLElement>('lang-dropdown');
const trBatchingEl = requireEl<HTMLInputElement>('tr-batching');
const trPromptEl = requireEl<HTMLTextAreaElement>('tr-prompt');

// Статус нативного хэлпера (Стадия 5).
const helperDotEl = requireEl<HTMLElement>('helper-dot');
const helperStatusTextEl = requireEl<HTMLElement>('helper-status-text');
const helperRecheckEl = requireEl<HTMLButtonElement>('helper-recheck');
// Последний полученный статус — чтобы перерисовать его при смене языка интерфейса.
let lastHelperStatus: HelperStatusResponse | null = null;

// Текущий язык интерфейса (живо переключается, см. setUiLanguage).
let uiLang: string = DEFAULT_UI_LANGUAGE;

// Карточка «Текущее видео».
const videoCardEl = requireEl<HTMLElement>('video-card');
const videoThumbEl = requireEl<HTMLImageElement>('video-thumb');
const videoTitleEl = requireEl<HTMLElement>('video-title');
const videoLangEl = requireEl<HTMLElement>('video-lang');
const videoCacheEl = requireEl<HTMLElement>('video-cache');
const videoDeleteCacheEl = requireEl<HTMLButtonElement>('video-delete-cache');
const videoDetailsEl = requireEl<HTMLButtonElement>('video-details');
const videoDeleteConfirmEl = requireEl<HTMLElement>('video-delete-confirm');
const videoDeleteConfirmQEl = requireEl<HTMLElement>('video-delete-confirm-q');
const videoDeleteConfirmYesEl = requireEl<HTMLButtonElement>('video-delete-confirm-yes');
const videoDeleteConfirmNoEl = requireEl<HTMLButtonElement>('video-delete-confirm-no');

// videoId активной вкладки (для «Подробнее» и удаления кэша конкретного видео).
let currentVideoId: string | null = null;

// Настройки субтитров.
const subsBgTransparencyEl = requireEl<HTMLInputElement>('subs-bg-transparency');
const subsBgTransparencyValueEl = requireEl<HTMLElement>('subs-bg-transparency-value');
const subsSizeEl = requireEl<HTMLInputElement>('subs-size');
const subsSizeValueEl = requireEl<HTMLElement>('subs-size-value');
const subsPositionEl = requireEl<HTMLInputElement>('subs-position');
const subsPositionValueEl = requireEl<HTMLElement>('subs-position-value');
const subsNeighborsEl = requireEl<HTMLInputElement>('subs-neighbors');
const subsRateEl = requireEl<HTMLInputElement>('subs-rate');
const subsFontEl = requireEl<HTMLSelectElement>('subs-font');

// Вкладки popup (Главная / Перевод / Озвучка).
const tabButtons = document.querySelectorAll<HTMLButtonElement>('[data-tab]');
const tabPanels = document.querySelectorAll<HTMLElement>('[data-panel]');

// Карточки настроек перевода, зависящие от возможностей метода (data-cap).
const translationCapCards = document.querySelectorAll<HTMLElement>('[data-cap]');

// --- Вспомогательные функции ---
function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(...args), ms);
  };
}

function ratioToPercent(ratio: number): number {
  return Math.round(ratio * PERCENT_SCALE);
}

function percentToRatio(percent: number): number {
  return percent / PERCENT_SCALE;
}

function updateVolumeLabel(): void {
  ttsVolumeValueEl.textContent = `${ttsVolumeEl.value}%`;
}

function updateVideoVolumeLabel(): void {
  videoVolumeValueEl.textContent = `${videoVolumeEl.value}%`;
}

// «Громкость видео» — обратная сторона приглушения оригинала (storage хранит ducking):
// 100% громкости = 0% приглушения. Минимум громкости = 100 − MAX_VIDEO_DUCKING.
function duckingToVideoVolumePercent(duckingRatio: number): number {
  return PERCENT_SCALE - ratioToPercent(duckingRatio);
}

function videoVolumePercentToDucking(videoVolumePercent: number): number {
  return percentToRatio(PERCENT_SCALE - videoVolumePercent);
}

// Переключение вкладок: показываем выбранную панель, остальные скрываем.
function activateTab(tabId: string): void {
  for (const button of tabButtons) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tabId));
  }
  for (const panel of tabPanels) {
    panel.hidden = panel.dataset.panel !== tabId;
  }
}

// --- Локализация интерфейса ---

// Применить переводы к статической разметке (data-i18n) и динамическим полям.
function applyI18n(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset.i18n as MessageKey | undefined;
    if (key !== undefined) {
      el.textContent = t(uiLang, key);
    }
  }
  langButtonEl.textContent = uiLang.toUpperCase();
  langButtonEl.title = t(uiLang, 'uiLanguageTitle');
  openHistoryEl.title = t(uiLang, 'historyTitle');
  trBatchingEl.value = t(uiLang, 'trAuto');
  trPromptEl.placeholder = t(uiLang, 'trPromptPlaceholder');
}

function openLangDropdown(): void {
  langDropdownEl.hidden = false;
  langButtonEl.setAttribute('aria-expanded', 'true');
}

function closeLangDropdown(): void {
  langDropdownEl.hidden = true;
  langButtonEl.setAttribute('aria-expanded', 'false');
}

function markLangSelected(): void {
  for (const opt of langDropdownEl.querySelectorAll<HTMLElement>('.lang-option')) {
    opt.setAttribute('aria-selected', String(opt.dataset.lang === uiLang));
  }
}

function populateLangDropdown(): void {
  langDropdownEl.replaceChildren();
  for (const lang of UI_LANGUAGES) {
    const button = document.createElement('button');
    button.className = 'lang-option';
    button.textContent = lang.label;
    button.dataset.lang = lang.code;
    button.setAttribute('aria-selected', String(lang.code === uiLang));
    button.addEventListener('click', () => {
      closeLangDropdown();
      void setUiLanguage(lang.code);
    });
    langDropdownEl.append(button);
  }
}

// Сменить язык интерфейса на лету: переводы + перестройка локализованных списков (с сохранением
// выбора) + перерисовка карточки видео.
async function setUiLanguage(lang: string): Promise<void> {
  if (lang === uiLang) {
    return;
  }
  uiLang = lang;
  await settings.uiLanguage.setValue(lang);
  applyI18n();
  markLangSelected();

  const method = translationMethodEl.value;
  populateTranslationMethods();
  translationMethodEl.value = method;
  applyTranslationMethod(method);

  const engine = ttsEngineEl.value;
  populateEngines();
  ttsEngineEl.value = engine;

  // Динамический текст статуса хэлпера не помечен data-i18n — перерисуем вручную.
  if (lastHelperStatus !== null) {
    renderHelperStatus(lastHelperStatus);
  }

  await loadVideoInfo();
}

// --- Заполнение списков ---
function populateLanguages(): void {
  for (const lang of SUPPORTED_LANGUAGES) {
    const option = document.createElement('option');
    option.value = lang.code;
    option.textContent = lang.label;
    languageEl.append(option);
  }
}

// Локализованный лейбл движка озвучки по id.
function engineLabel(id: string): string {
  if (id === 'webspeech') {
    return t(uiLang, 'engineWebspeech');
  }
  return t(uiLang, 'engineEdge');
}

function populateEngines(): void {
  ttsEngineEl.replaceChildren();
  for (const engine of TTS_ENGINE_OPTIONS) {
    const option = document.createElement('option');
    option.value = engine.id;
    option.textContent = engineLabel(engine.id);
    ttsEngineEl.append(option);
  }
  // Будущие движки — нерабочие пункты-заглушки (дорожная карта, Стадия 4).
  for (const stub of TTS_METHOD_STUBS) {
    const option = document.createElement('option');
    option.textContent = `${stub.label} — ${t(uiLang, 'badgeSoon')}`;
    option.disabled = true;
    ttsEngineEl.append(option);
  }
}

function baseLang(code: string): string {
  return (code.split('-')[0] ?? code).toLowerCase();
}

// --- Карточка «Текущее видео» ---

// Достать id видео YouTube из URL вкладки (watch?v=… или youtu.be/…). null — не видео.
function parseVideoId(rawUrl: string | undefined): string | null {
  if (rawUrl === undefined) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    if (url.hostname.endsWith('youtube.com') && url.pathname === '/watch') {
      return url.searchParams.get('v');
    }
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1);
      return id === '' ? null : id;
    }
  } catch {
    return null;
  }
  return null;
}

// Человекочитаемое имя языка оригинала: метка из списка или код в верхнем регистре.
function languageLabel(code: string): string {
  if (code === '' || code === 'unknown') {
    return t(uiLang, 'langUndetermined');
  }
  const known = SUPPORTED_LANGUAGES.find((lang) => lang.code === baseLang(code));
  return known !== undefined ? known.label : code.toUpperCase();
}

// Заголовок вкладки YouTube без хвоста " - YouTube".
function cleanTitle(tabTitle: string | undefined): string {
  return (tabTitle ?? '').replace(/ - YouTube$/, '').trim();
}

// Список готовых переводов из кэша: Google Translate (автоперевод) и/или Claude (API),
// с перечнем языков каждого. Пусто — блок скрыт.
function renderVideoCache(meta: CvmCacheMeta | null): void {
  videoCacheEl.replaceChildren();
  const entries: { method: string; languages: string[] }[] = [];
  if (meta !== null) {
    if (meta.translationLanguages.length > 0) {
      entries.push({ method: 'Google Translate', languages: meta.translationLanguages });
    }
    if (meta.apiLanguages.length > 0) {
      entries.push({ method: 'Claude', languages: meta.apiLanguages });
    }
  }
  for (const entry of entries) {
    const line = document.createElement('div');
    line.className = 'cache-line';
    const dot = document.createElement('span');
    dot.className = 'cache-dot';
    const text = document.createElement('span');
    const languages = entry.languages.map(languageLabel).join(', ');
    text.textContent = `${t(uiLang, 'hasTranslationPrefix')} ${entry.method} · ${languages}`;
    line.append(dot, text);
    videoCacheEl.append(line);
  }
  videoCacheEl.hidden = entries.length === 0;
}

// Наполнить карточку: превью/название/язык активного видео + переводы в кэше + кнопка удаления.
// Карточка целиком скрыта, если активная вкладка — не видео YouTube.
async function loadVideoInfo(): Promise<void> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const videoId = parseVideoId(tab?.url);

  if (videoId === null) {
    currentVideoId = null;
    videoCardEl.hidden = true;
    return;
  }
  currentVideoId = videoId;
  videoCardEl.hidden = false;
  videoThumbEl.src = youtubeThumbnailUrl(videoId);

  const request: RequestVideoMetaMessage = { type: 'request-video-meta', videoId };
  const response = (await browser.runtime.sendMessage(request)) as VideoMetaResponse | undefined;
  const meta = response?.meta ?? null;

  videoTitleEl.textContent = meta?.title ?? cleanTitle(tab?.title);
  videoLangEl.textContent = languageLabel(meta?.originalLanguage ?? '');
  renderVideoCache(meta);
  // «Подробнее» и «Удалить кэш видео» активны только когда у видео есть кэш.
  const hasCache = meta !== null;
  videoDetailsEl.disabled = !hasCache;
  videoDeleteCacheEl.disabled = !hasCache;
  // Сброс встроенного подтверждения (на случай повторного открытия карточки).
  videoDeleteConfirmEl.hidden = true;
  videoDeleteCacheEl.hidden = false;
}

// --- Методы перевода ---
function populateTranslationMethods(): void {
  translationMethodEl.replaceChildren();
  for (const method of TRANSLATION_METHOD_OPTIONS) {
    const option = document.createElement('option');
    option.value = method.id;
    // Бренд-имя не переводим; для нереализованных добавляем локализованный суффикс «скоро».
    option.textContent = method.available
      ? method.label
      : `${method.label} — ${t(uiLang, 'badgeSoon')}`;
    option.disabled = !method.available;
    translationMethodEl.append(option);
  }
}

function findTranslationMethod(id: string): TranslationMethodOption {
  const found =
    TRANSLATION_METHOD_OPTIONS.find((method) => method.id === id) ??
    TRANSLATION_METHOD_OPTIONS.find((method) => method.id === DEFAULT_TRANSLATION_METHOD);
  if (found === undefined) {
    throw new Error('[Mnemosyne] popup: список методов перевода пуст');
  }
  return found;
}

// Показать только те карточки настроек, что поддерживает метод; подставить подсказку.
function applyTranslationMethod(id: string): void {
  const method = findTranslationMethod(id);
  for (const card of translationCapCards) {
    const cap = card.dataset.cap;
    const supported = cap === 'apiKey' || cap === 'model' || cap === 'prompt' ? method.caps[cap] : false;
    card.hidden = !supported;
  }
  // Подсказку имеет только Google (бесплатный метод без настроек).
  const hasHint = method.id === TRANSLATION_METHOD_GOOGLE;
  translationMethodHintEl.textContent = hasHint ? t(uiLang, 'trGoogleHint') : '';
  translationMethodHintEl.hidden = !hasHint;
}

// Голоса зависят от выбранного движка: Edge — из каталога по языку, Web Speech — системные.
async function populateVoices(): Promise<void> {
  const engine = (await settings.ttsEngine.getValue()) as TtsEngineName;
  const targetLanguage = baseLang(await settings.targetLanguage.getValue());
  voiceEl.replaceChildren();

  if (engine === 'edge') {
    const list = EDGE_VOICE_CATALOG[targetLanguage] ?? [];
    if (list.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = t(uiLang, 'noNeuralVoices');
      voiceEl.append(option);
      voiceEl.disabled = true;
      return;
    }
    voiceEl.disabled = false;
    for (const voice of list) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = voice.label;
      voiceEl.append(option);
    }
    const saved = await settings.selectedVoiceEdge.getValue();
    const first = list[0];
    if (list.some((voice) => voice.id === saved)) {
      voiceEl.value = saved;
    } else if (first !== undefined) {
      voiceEl.value = first.id;
      await settings.selectedVoiceEdge.setValue(first.id);
    }
    return;
  }

  // Web Speech: системные голоса, отфильтрованные по языку.
  const matching = speechSynthesis
    .getVoices()
    .filter((voice) => voice.lang.toLowerCase().startsWith(targetLanguage));
  if (matching.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = t(uiLang, 'noSystemVoices');
    voiceEl.append(option);
    voiceEl.disabled = true;
    return;
  }
  voiceEl.disabled = false;
  for (const voice of matching) {
    const option = document.createElement('option');
    option.value = voice.name;
    option.textContent = `${voice.name} (${voice.lang})`;
    voiceEl.append(option);
  }
  const savedVoice = await settings.selectedVoice.getValue();
  const firstVoice = matching[0];
  if (matching.some((voice) => voice.name === savedVoice)) {
    voiceEl.value = savedVoice;
  } else if (firstVoice !== undefined) {
    voiceEl.value = firstVoice.name;
    await settings.selectedVoice.setValue(firstVoice.name);
  }
}

// --- Настройки субтитров ---
function populateFonts(): void {
  for (const font of SUBS_FONT_OPTIONS) {
    const option = document.createElement('option');
    option.value = font.name;
    option.textContent = font.name;
    option.style.fontFamily = font.stack; // показать пункт в самом шрифте
    subsFontEl.append(option);
  }
}

function updateSubsTransparencyLabel(): void {
  subsBgTransparencyValueEl.textContent = `${subsBgTransparencyEl.value}%`;
}

function updateSubsSizeLabel(): void {
  subsSizeValueEl.textContent = `${subsSizeEl.value}%`;
}

function updateSubsPositionLabel(): void {
  subsPositionValueEl.textContent = `${subsPositionEl.value}%`;
}

async function loadSubtitleSettings(): Promise<void> {
  subsBgTransparencyEl.min = String(SUBS_BG_OPACITY_MIN);
  subsBgTransparencyEl.max = String(SUBS_BG_OPACITY_MAX);
  subsBgTransparencyEl.step = String(SUBS_BG_OPACITY_STEP);
  subsSizeEl.min = String(SUBS_SIZE_MIN);
  subsSizeEl.max = String(SUBS_SIZE_MAX);
  subsSizeEl.step = String(SUBS_SIZE_STEP);
  subsPositionEl.min = String(SUBS_POSITION_MIN);
  subsPositionEl.max = String(SUBS_POSITION_MAX);
  subsPositionEl.step = String(SUBS_POSITION_STEP);

  const [bgOpacity, size, position, neighbors, rate, font] = await Promise.all([
    settings.subsBgOpacity.getValue(),
    settings.subsSizePct.getValue(),
    settings.subsPositionPct.getValue(),
    settings.subsShowNeighbors.getValue(),
    settings.subsShowRate.getValue(),
    settings.subsFont.getValue(),
  ]);
  // В UI — прозрачность (инверсия непрозрачности фона): 100% = фон полностью прозрачный.
  subsBgTransparencyEl.value = String(PERCENT_SCALE - bgOpacity);
  subsSizeEl.value = String(size);
  subsPositionEl.value = String(position);
  subsNeighborsEl.checked = neighbors;
  subsRateEl.checked = rate;
  // Значение из storage может не совпадать со списком (напр. старое пустое) — тогда дефолт.
  subsFontEl.value = font;
  if (subsFontEl.selectedIndex === -1) {
    subsFontEl.value = DEFAULT_SUBS_FONT;
    void settings.subsFont.setValue(DEFAULT_SUBS_FONT);
  }
  updateSubsTransparencyLabel();
  updateSubsSizeLabel();
  updateSubsPositionLabel();
}

// --- Нативный хэлпер (Стадия 5): индикатор статуса ---

// Отрисовать состояние связки: цвет точки + локализованный текст (+ версия при подключении).
function renderHelperStatus(status: HelperStatusResponse): void {
  lastHelperStatus = status;
  helperDotEl.classList.toggle('is-connected', status.state === 'connected');
  helperDotEl.classList.toggle('is-error', status.state === 'error');
  if (status.state === 'connected') {
    const version = status.version !== null ? ` · v${status.version}` : '';
    helperStatusTextEl.textContent = `${t(uiLang, 'helperConnected')}${version}`;
  } else if (status.state === 'error') {
    helperStatusTextEl.textContent = t(uiLang, 'helperError');
  } else {
    helperStatusTextEl.textContent = t(uiLang, 'helperNotInstalled');
  }
}

// Опросить хэлпер через background и отрисовать результат. Лайт-режим: отсутствие
// хэлпера — штатное состояние «не установлен», без ошибок в UI.
async function refreshHelperStatus(): Promise<void> {
  helperDotEl.classList.remove('is-connected', 'is-error');
  helperStatusTextEl.textContent = t(uiLang, 'helperChecking');
  helperRecheckEl.disabled = true;
  try {
    const message: HelperStatusMessage = { type: 'helper-status' };
    const response = (await browser.runtime.sendMessage(message)) as HelperStatusResponse | undefined;
    renderHelperStatus(response ?? { state: 'error', version: null, error: 'no response' });
  } finally {
    helperRecheckEl.disabled = false;
  }
}

// --- Загрузка текущих значений настроек в UI ---
async function loadValues(): Promise<void> {
  const [
    apiKey,
    targetLanguage,
    ttsEngine,
    ttsEnabled,
    subtitlesEnabled,
    translationMethod,
    autoStart,
    translationVolume,
    videoDucking,
  ] = await Promise.all([
    settings.apiKey.getValue(),
    settings.targetLanguage.getValue(),
    settings.ttsEngine.getValue(),
    settings.ttsEnabled.getValue(),
    settings.subtitlesEnabled.getValue(),
    settings.translationMethod.getValue(),
    settings.autoStart.getValue(),
    settings.translationVolume.getValue(),
    settings.videoDucking.getValue(),
  ]);

  apiKeyEl.value = apiKey;
  languageEl.value = targetLanguage;
  ttsEngineEl.value = ttsEngine;
  ttsEnabledEl.checked = ttsEnabled;
  subtitlesEnabledEl.checked = subtitlesEnabled;
  translationMethodEl.value = translationMethod;
  applyTranslationMethod(translationMethod);
  autoStartEl.checked = autoStart;

  ttsVolumeEl.max = String(ratioToPercent(MAX_VOLUME));
  ttsVolumeEl.value = String(ratioToPercent(translationVolume));
  // Слайдер «Громкость видео» инвертирует ducking: нижняя граница = 100 − MAX_VIDEO_DUCKING.
  videoVolumeEl.min = String(duckingToVideoVolumePercent(MAX_VIDEO_DUCKING));
  videoVolumeEl.max = String(PERCENT_SCALE);
  videoVolumeEl.value = String(duckingToVideoVolumePercent(videoDucking));
  updateVolumeLabel();
  updateVideoVolumeLabel();
}

// --- Обработчики (мгновенное применение в storage) ---
function registerHandlers(): void {
  const saveApiKey = debounce((value: string) => {
    void settings.apiKey.setValue(value);
  }, API_KEY_SAVE_DEBOUNCE_MS);
  apiKeyEl.addEventListener('input', () => saveApiKey(apiKeyEl.value));

  languageEl.addEventListener('change', () => {
    void (async () => {
      await settings.targetLanguage.setValue(languageEl.value);
      await populateVoices();
    })();
  });

  ttsEngineEl.addEventListener('change', () => {
    void (async () => {
      await settings.ttsEngine.setValue(ttsEngineEl.value as TtsEngineName);
      await populateVoices(); // у разных движков — разные списки голосов
    })();
  });

  voiceEl.addEventListener('change', () => {
    void (async () => {
      const engine = (await settings.ttsEngine.getValue()) as TtsEngineName;
      if (engine === 'edge') {
        await settings.selectedVoiceEdge.setValue(voiceEl.value);
      } else {
        await settings.selectedVoice.setValue(voiceEl.value);
      }
    })();
  });

  ttsEnabledEl.addEventListener('change', () => {
    void settings.ttsEnabled.setValue(ttsEnabledEl.checked);
  });

  subtitlesEnabledEl.addEventListener('change', () => {
    void settings.subtitlesEnabled.setValue(subtitlesEnabledEl.checked);
  });

  translationMethodEl.addEventListener('change', () => {
    const method = translationMethodEl.value;
    applyTranslationMethod(method);
    void (async () => {
      await settings.translationMethod.setValue(method);
      // Google = бесплатный автоперевод субтитров (внутренний флаг конвейера перевода).
      await settings.useYoutubeTranslation.setValue(method === TRANSLATION_METHOD_GOOGLE);
    })();
  });

  autoStartEl.addEventListener('change', () => {
    void settings.autoStart.setValue(autoStartEl.checked);
  });

  ttsVolumeEl.addEventListener('input', () => {
    updateVolumeLabel();
    void settings.translationVolume.setValue(percentToRatio(Number(ttsVolumeEl.value)));
  });

  videoVolumeEl.addEventListener('input', () => {
    updateVideoVolumeLabel();
    void settings.videoDucking.setValue(videoVolumePercentToDucking(Number(videoVolumeEl.value)));
  });

  for (const button of tabButtons) {
    button.addEventListener('click', () => {
      const tabId = button.dataset.tab;
      if (tabId !== undefined) {
        activateTab(tabId);
      }
    });
  }

  // «История» — открыть страницу кэша всех озвученных видео.
  openHistoryEl.addEventListener('click', () => {
    void browser.tabs.create({ url: browser.runtime.getURL(`/${CACHE_PAGE}`) });
  });

  // «Подробнее» — открыть страницу кэша, развёрнутую на текущем видео (deep-link ?v=).
  videoDetailsEl.addEventListener('click', () => {
    if (currentVideoId === null) {
      return;
    }
    const url = browser.runtime.getURL(`/${CACHE_PAGE}?v=${encodeURIComponent(currentVideoId)}`);
    void browser.tabs.create({ url });
  });

  // «Удалить кэш видео» — встроенное подтверждение (window.confirm закрывает popup
  // до отправки сообщения), затем удаление переводов только текущего видео.
  videoDeleteConfirmQEl.textContent = CACHE_DELETE_VIDEO_CONFIRM;
  videoDeleteConfirmYesEl.textContent = CACHE_DELETE_VIDEO_YES;
  videoDeleteConfirmNoEl.textContent = CACHE_DELETE_VIDEO_NO;

  function setDeleteConfirm(open: boolean): void {
    videoDeleteConfirmEl.hidden = !open;
    videoDeleteCacheEl.hidden = open; // на время подтверждения прячем исходную кнопку
  }

  videoDeleteCacheEl.addEventListener('click', () => {
    if (currentVideoId === null) {
      return;
    }
    setDeleteConfirm(true);
  });

  videoDeleteConfirmNoEl.addEventListener('click', () => {
    setDeleteConfirm(false);
  });

  videoDeleteConfirmYesEl.addEventListener('click', () => {
    setDeleteConfirm(false);
    if (currentVideoId === null) {
      return;
    }
    const message: DeleteVideoCacheMessage = {
      type: 'delete-video-cache',
      videoId: currentVideoId,
    };
    void browser.runtime.sendMessage(message).then((raw) => {
      const response = raw as DeleteVideoCacheResponse | undefined;
      if (response?.ok === true) {
        void loadVideoInfo(); // обновить карточку: кэш ушёл → кнопки неактивны
      }
    });
  });

  // Меню выбора языка интерфейса.
  langButtonEl.addEventListener('click', (event) => {
    event.stopPropagation();
    if (langDropdownEl.hidden) {
      openLangDropdown();
    } else {
      closeLangDropdown();
    }
  });
  document.addEventListener('click', (event) => {
    const target = event.target as Node;
    if (!langDropdownEl.hidden && !langButtonEl.contains(target) && !langDropdownEl.contains(target)) {
      closeLangDropdown();
    }
  });

  subsBgTransparencyEl.addEventListener('input', () => {
    updateSubsTransparencyLabel();
    // Сохраняем непрозрачность (инверсия): 100% прозрачности = 0% непрозрачности фона.
    void settings.subsBgOpacity.setValue(PERCENT_SCALE - Number(subsBgTransparencyEl.value));
  });

  subsSizeEl.addEventListener('input', () => {
    updateSubsSizeLabel();
    void settings.subsSizePct.setValue(Number(subsSizeEl.value));
  });

  subsPositionEl.addEventListener('input', () => {
    updateSubsPositionLabel();
    void settings.subsPositionPct.setValue(Number(subsPositionEl.value));
  });

  subsNeighborsEl.addEventListener('change', () => {
    void settings.subsShowNeighbors.setValue(subsNeighborsEl.checked);
  });

  subsRateEl.addEventListener('change', () => {
    void settings.subsShowRate.setValue(subsRateEl.checked);
  });

  subsFontEl.addEventListener('change', () => {
    void settings.subsFont.setValue(subsFontEl.value);
  });

  // Превью не загрузилось (нет тамбнейла / офлайн) — прячем картинку, не показываем «битый» значок.
  videoThumbEl.addEventListener('error', () => {
    videoThumbEl.style.visibility = 'hidden';
  });
  videoThumbEl.addEventListener('load', () => {
    videoThumbEl.style.visibility = 'visible';
  });

  // Голоса в Web Speech API подгружаются асинхронно.
  speechSynthesis.addEventListener('voiceschanged', () => {
    void populateVoices();
  });

  // Повторная проверка связи с нативным хэлпером.
  helperRecheckEl.addEventListener('click', () => {
    void refreshHelperStatus();
  });
}

async function init(): Promise<void> {
  uiLang = await settings.uiLanguage.getValue();
  populateLanguages();
  populateTranslationMethods();
  populateEngines();
  populateFonts();
  populateLangDropdown();
  applyI18n();
  await loadValues();
  await loadSubtitleSettings();
  await populateVoices();
  registerHandlers();
  await loadVideoInfo();
  void refreshHelperStatus(); // не блокируем готовность popup ожиданием хэлпера
  console.info('[Mnemosyne] popup ready');
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
