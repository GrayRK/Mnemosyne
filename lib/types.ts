// Общие типы проекта.

// Пользовательские настройки (хранятся в chrome.storage.local).
export interface CvmSettings {
  apiKey: string;
  targetLanguage: string;
  selectedVoice: string;
  ttsEnabled: boolean;
  subtitlesEnabled: boolean;
  useYoutubeTranslation: boolean; // брать готовый перевод YouTube вместо API
  autoStart: boolean; // запускать перевод при открытии страницы
  translationVolume: number; // 0..1
  videoDucking: number; // 0..MAX_VIDEO_DUCKING
  showCost: boolean; // показывать примерную стоимость перевода в виджете
}

// Статус перевода для индикатора и Inspector.
export type TranslationStatus = 'ready' | 'translating' | 'error';

// Прогресс перевода через API: сколько батчей завершено из общего числа.
export interface TranslationProgress {
  done: number;
  total: number;
}

// Рантайм-состояние (не сохраняется, живёт во время сессии).
export interface CvmRuntimeState {
  currentVideoId: string | null;
  translationStatus: TranslationStatus;
  translationActive: boolean; // состояние кнопки виджета (вкл/выкл перевод)
  translationProgress: TranslationProgress | null; // null — перевод не идёт
}

// Рантайм-состояние конкретной вкладки (per-tab, Стадия 3.4). Фон хранит
// Map<tabId, CvmRuntimeState>; в Inspector уходит массив таких записей.
export interface TabRuntimeState extends CvmRuntimeState {
  tabId: number;
}

// Полный снимок состояния для Live State Inspector.
export interface CvmStateSnapshot extends CvmSettings, CvmRuntimeState {}

// Вариант языка перевода для дропдауна popup.
export interface LanguageOption {
  code: string;
  label: string;
}

// --- Стадия 2: субтитры и кэш текстов ---

// Источник дорожки субтитров: ручная или авто-сгенерированная (ASR).
export type CaptionKind = 'manual' | 'asr';

// Дорожка субтитров из ytInitialPlayerResponse.captionTracks.
export interface CaptionTrack {
  baseUrl: string; // эндпоинт timedtext (без fmt/tlang)
  languageCode: string; // язык дорожки, напр. "en"
  kind: CaptionKind;
  name: string; // человекочитаемое имя дорожки
}

// Один сегмент субтитров с таймингом (нужен для синхронной озвучки, Стадия 4).
export interface CaptionSegment {
  start: number; // начало, мс
  duration: number; // длительность, мс
  text: string;
}

// Метрики одного перевода через Claude API (для API Monitor, Стадия 3.2).
export interface ApiTranslationMeta {
  model: string; // id модели, которой переводили
  batchCount: number; // сколько батчей сформировано
  segmentCount: number; // число сегментов (строк) субтитров
  charsTotal: number; // суммарно символов оригинала, ушедших в перевод
  inputTokens: number; // суммарно usage.input_tokens по всем батчам
  outputTokens: number; // суммарно usage.output_tokens по всем батчам
  totalMs: number; // wall-clock всего перевода (с учётом параллелизма)
  batchMs: number[]; // длительность каждого батча, мс
  videoSeconds: number; // длительность субтитровой дорожки, сек (для плотности речи)
  costUsd: number | null; // зафиксированная стоимость перевода, $ (Стадия 3.3); null — не задана
  createdAt: number; // когда выполнен замер, epoch мс
  completedBatches: number; // сколько батчей уже записано (потоковая отдача, Стадия 3.4)
  complete: boolean; // true — перевод дописан целиком; false — ещё наполняется
}

// --- Калибровка калькулятора стоимости (Стадия 3.3) ---

// Один замер: реальная стоимость перевода против его объёма/длительности.
// Хранится отдельно от кэша (cvm_cost_samples), переживает очистку кэша.
export interface CostSample {
  dollars: number; // фактически потрачено на перевод, $
  chars: number; // символов оригинала (база расчёта)
  tokensIn: number; // суммарно входных токенов
  tokensOut: number; // суммарно выходных токенов
  videoSeconds: number; // длительность видео/дорожки, сек
  model: string; // модель, которой переводили (выборки фильтруются по ней)
  videoId: string;
  language: string;
  at: number; // когда зафиксировано, epoch мс
}

// Усреднённые коэффициенты калькулятора по выборкам текущей модели.
export interface CalibrationStats {
  sampleCount: number; // сколько выборок учтено
  dollarsPerChar: number; // R — средняя стоимость символа, $
  charsPerMinute: number; // D — средняя плотность речи, символов/мин
  tokensPerChar: number; // для оценки токенов в калькуляторе
}

// Полная запись кэша (одна на видео, хранится под ключом cvm_cap_{videoId}).
// Оригинал хранится один раз; автопереводы — по одному на целевой язык.
export interface CvmCacheEntry {
  videoId: string;
  title: string;
  url: string;
  createdAt: number; // первое создание, epoch мс
  updatedAt: number; // последнее изменение (добавлен перевод)
  originalLanguage: string; // язык исходной дорожки
  originalKind: CaptionKind;
  original: CaptionSegment[];
  // Автопереводы YouTube (Google) по коду целевого языка: { ru: [...], es: [...] }.
  translations: Record<string, CaptionSegment[]>;
  // Переводы Claude API по коду целевого языка (Стадия 3): { ru: [...], es: [...] }.
  apiTranslations: Record<string, CaptionSegment[]>;
  // Метрики перевода Claude API по коду целевого языка (для API Monitor).
  apiMeta: Record<string, ApiTranslationMeta>;
}

// Метаданные записи для списка в Inspector (без тяжёлых сегментов).
export interface CvmCacheMeta {
  videoId: string;
  title: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  originalLanguage: string;
  originalKind: CaptionKind;
  translationLanguages: string[]; // какие целевые языки автоперевода YouTube уже есть
  apiLanguages: string[]; // какие целевые языки перевода Claude API уже есть
}
