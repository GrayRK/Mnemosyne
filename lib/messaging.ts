import type {
  CvmRuntimeState,
  CvmCacheEntry,
  CvmCacheMeta,
  CaptionSegment,
  CaptionKind,
} from '@/lib/types';

// =====================================================================
// Inspector  <--  background   (long-lived port)
// =====================================================================

export interface RuntimeStateMessage {
  type: 'runtime-state';
  state: CvmRuntimeState;
}

// Список метаданных кэша для меню Inspector.
export interface CacheListMessage {
  type: 'cache-list';
  items: CvmCacheMeta[];
}

// Полная запись кэша (в ответ на раскрытие позиции).
export interface CacheEntryMessage {
  type: 'cache-entry';
  entry: CvmCacheEntry | null;
}

export type InspectorMessage = RuntimeStateMessage | CacheListMessage | CacheEntryMessage;

// =====================================================================
// Inspector  -->  background   (тот же порт, управляющие команды)
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

export type InspectorControlMessage =
  | RequestCacheListMessage
  | RequestCacheEntryMessage
  | ClearCacheMessage;

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
  hasTranslation: boolean; // автоперевод на запрошенный язык уже есть
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

export type BackgroundMessage =
  | SetTranslationActiveMessage
  | CacheLookupMessage
  | CacheStoreMessage;

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
