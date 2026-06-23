import type {
  CvmCacheEntry,
  CvmCacheMeta,
  CaptionSegment,
  CaptionKind,
  TranslationStatus,
} from '@/lib/types';

// =====================================================================
// Страница кэша  <--  background   (long-lived port)
// =====================================================================

// Список метаданных кэша для страницы «История».
export interface CacheListMessage {
  type: 'cache-list';
  items: CvmCacheMeta[];
}

// Полная запись кэша (в ответ на раскрытие позиции).
export interface CacheEntryMessage {
  type: 'cache-entry';
  entry: CvmCacheEntry | null;
}

export type CachePortMessage = CacheListMessage | CacheEntryMessage;

// =====================================================================
// Страница кэша  -->  background   (тот же порт, управляющие команды)
// =====================================================================

export interface RequestCacheListMessage {
  type: 'request-cache-list';
}

export interface RequestCacheEntryMessage {
  type: 'request-cache-entry';
  videoId: string;
}

export interface ClearCacheMessage {
  type: 'clear-cache';
}

export type CachePortControlMessage =
  | RequestCacheListMessage
  | RequestCacheEntryMessage
  | ClearCacheMessage
  | DeleteVideoCacheMessage;

// =====================================================================
// content (ISOLATED)  -->  background   (runtime.sendMessage)
// =====================================================================

export interface SetTranslationActiveMessage {
  type: 'set-translation-active';
  active: boolean;
}

// Проверка состояния кэша по видео: есть ли запись и есть ли перевод на язык.
export interface CacheLookupMessage {
  type: 'cache-lookup';
  videoId: string;
  language: string;
}

export interface CacheLookupResponse {
  entryExists: boolean; // запись (оригинал) уже в кэше
  hasTranslation: boolean; // автоперевод YouTube на запрошенный язык уже есть
  hasApiTranslation: boolean; // перевод Claude API на запрошенный язык уже есть
}

// Запись в кэш: создаёт запись (оригинал) или дополняет существующую.
// language/translation опциональны — без них пишется только оригинал
// (режим «Использовать автоперевод» выключен).
export interface CacheStoreMessage {
  type: 'cache-store';
  videoId: string;
  title: string;
  url: string;
  originalLanguage: string;
  originalKind: CaptionKind;
  original: CaptionSegment[];
  language?: string; // целевой язык автоперевода
  translation?: CaptionSegment[];
}

export interface CacheStoreResponse {
  ok: boolean;
}

// Запрос перевода оригинала через Claude API на целевой язык.
// Оригинал передаётся целиком; background батчит, переводит и пишет в кэш.
export interface ApiTranslateMessage {
  type: 'api-translate';
  videoId: string;
  language: string; // целевой язык перевода
  original: CaptionSegment[];
}

export interface ApiTranslateResponse {
  ok: boolean;
  error: string | null; // напр. 'no-api-key', текст ошибки сети/формата
}

// Метаданные кэша по видео для карточки «Текущее видео» в popup. meta = null — видео
// ещё не обработано (нет ни оригинала, ни перевода в кэше).
export interface RequestVideoMetaMessage {
  type: 'request-video-meta';
  videoId: string;
}

export interface VideoMetaResponse {
  meta: CvmCacheMeta | null;
}


// Удалить кэш одного видео (переводы + оригинал). Запрос из popup и страницы кэша.
// После удаления фон рассылает обновлённый cache-list всем открытым страницам.
export interface DeleteVideoCacheMessage {
  type: 'delete-video-cache';
  videoId: string;
}

export interface DeleteVideoCacheResponse {
  ok: boolean;
}

// Источник озвучиваемого перевода: Claude API или автоперевод YouTube.
export type TranslationSource = 'api' | 'youtube';

// Запрос финальных переведённых сегментов из кэша для озвучки (Стадия 4).
// content сам не держит результат API-перевода (его формирует и кэширует фон),
// поэтому забирает готовые сегменты этим сообщением.
export interface GetTranslationMessage {
  type: 'get-translation';
  videoId: string;
  language: string;
  source: TranslationSource;
}

export interface GetTranslationResponse {
  segments: CaptionSegment[] | null; // null — перевода на язык в кэше нет
}

// Синтез одной реплики через Edge нейронный TTS (Стадия 4). Фон открывает websocket к
// Microsoft, возвращает MP3 в base64 (ArrayBuffer через runtime.sendMessage не переносится).
export interface TtsSynthMessage {
  type: 'tts-synth';
  text: string;
  voice: string; // нейронный голос, напр. 'ru-RU-DmitryNeural'
  rate: number; // множитель темпа (запекается в SSML)
}

export interface TtsSynthResponse {
  ok: boolean;
  audio: string | null; // MP3 в base64
  error: string | null;
}

export type BackgroundMessage =
  | SetTranslationActiveMessage
  | CacheLookupMessage
  | CacheStoreMessage
  | ApiTranslateMessage
  | RequestVideoMetaMessage
  | DeleteVideoCacheMessage
  | GetTranslationMessage
  | TtsSynthMessage;

// =====================================================================
// background  -->  content (tab)   (browser.tabs.sendMessage)
// =====================================================================

// Прогресс перевода через API для индикатора на кнопке виджета.
export interface TranslationProgressMessage {
  type: 'translation-progress';
  videoId: string;
  done: number; // завершено батчей
  total: number; // всего батчей
  status: TranslationStatus;
}

export type TabMessage = TranslationProgressMessage;

// =====================================================================
// мост content-bridge (MAIN)  <->  content (ISOLATED)   (window.postMessage)
// =====================================================================

// content -> bridge: запрос данных для извлечения текущего видео.
export interface BridgeRequestExtractionMessage {
  type: 'request-extraction';
}

// bridge -> content: перехваченный у плеера запрос субтитров (с валидным pot)
// + метаданные. capturedUrl/capturedBody = null, если перехватить не удалось.
export interface BridgeExtractionDataMessage {
  type: 'extraction-data';
  videoId: string | null;
  title: string;
  originalLanguage: string | null;
  capturedUrl: string | null; // полный URL timedtext с pot (для автоперевода через &tlang)
  capturedBody: string | null; // сырое тело оригинала (json3 или XML)
  error: string | null; // напр. 'no-capture' — субтитры не перехвачены
}

export type BridgeMessage = BridgeRequestExtractionMessage | BridgeExtractionDataMessage;
