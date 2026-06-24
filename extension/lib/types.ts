// Общие типы проекта.

// Пользовательские настройки (хранятся в chrome.storage.local).
export interface CvmSettings {
  apiKey: string;
  targetLanguage: string;
  ttsEngine: TtsEngineName; // выбранный движок озвучки
  selectedVoice: string; // голос для Web Speech (системный)
  selectedVoiceEdge: string; // голос для Edge (нейронный); '' — авто по языку
  ttsEnabled: boolean;
  subtitlesEnabled: boolean;
  useYoutubeTranslation: boolean; // брать готовый перевод YouTube вместо API
  autoStart: boolean; // запускать перевод при открытии страницы
  translationVolume: number; // 0..1
  videoDucking: number; // 0..MAX_VIDEO_DUCKING
  ttsMinRate: number; // нижняя граница темпа TTS (множитель)
  ttsMaxRate: number; // верхняя граница темпа TTS (множитель)
  ttsEndpoint: string; // адрес прокси-эндпоинта синтеза (Cloudflare Worker или локальный релей)
  ttsOffsetMs: number; // сдвиг ВРЕМЕНИ озвучки/субтитров относительно видео, мс (+раньше / −позже)
  subsPositionPct: number; // вертикальное положение субтитров на экране, 0 (верх) .. 100 (низ)
}

// Движок озвучки: 'edge' — нейронный через прокси, 'webspeech' — системные голоса браузера.
export type TtsEngineName = 'edge' | 'webspeech';

// Статус перевода для индикатора виджета.
export type TranslationStatus = 'ready' | 'translating' | 'error';

// Прогресс перевода через API: сколько батчей завершено из общего числа.
export interface TranslationProgress {
  done: number;
  total: number;
}

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

// Данные одного перевода через Claude API. Прогресс (complete/completedBatches/batchCount)
// показывается на странице кэша; usage/тайминги хранятся для будущего расчёта стоимости (этап 2.4).
export interface ApiTranslationMeta {
  model: string; // id модели, которой переводили
  batchCount: number; // сколько батчей сформировано
  segmentCount: number; // число сегментов (строк) субтитров
  charsTotal: number; // суммарно символов оригинала, ушедших в перевод
  inputTokens: number; // суммарно usage.input_tokens по всем батчам
  outputTokens: number; // суммарно usage.output_tokens по всем батчам
  totalMs: number; // wall-clock всего перевода (с учётом параллелизма)
  batchMs: number[]; // длительность каждого батча, мс
  videoSeconds: number; // длительность субтитровой дорожки, сек
  createdAt: number; // когда выполнен замер, epoch мс
  completedBatches: number; // сколько батчей уже записано (потоковая отдача)
  complete: boolean; // true — перевод дописан целиком; false — ещё наполняется
}

// Полная запись кэша (одна на видео, хранится под ключом mnemosyne_cap_{videoId}).
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

// Метаданные записи для списка кэша (без тяжёлых сегментов).
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
