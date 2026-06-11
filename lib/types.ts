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
}

// Статус перевода для индикатора и Inspector.
export type TranslationStatus = 'ready' | 'translating' | 'error';

// Рантайм-состояние (не сохраняется, живёт во время сессии).
export interface CvmRuntimeState {
  currentVideoId: string | null;
  translationStatus: TranslationStatus;
  translationActive: boolean; // состояние кнопки виджета (вкл/выкл перевод)
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
  apiTranslation: CaptionSegment[] | null; // перевод Claude API — заготовка под Стадию 3
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
  translationLanguages: string[]; // какие целевые языки уже есть
  hasApi: boolean;
}
