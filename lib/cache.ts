import { storage } from '#imports';
import { CACHE_ENTRY_PREFIX, CACHE_INDEX_KEY } from '@/lib/constants';
import type {
  CvmCacheEntry,
  CvmCacheMeta,
  CaptionSegment,
  CaptionKind,
  ApiTranslationMeta,
} from '@/lib/types';

// Слой кэша текстов поверх chrome.storage.local (Стадия 2).
// Одна запись на видео (ключ mnemosyne_cap_{videoId}); внутри — оригинал один раз и
// словарь автопереводов по целевым языкам. Лёгкий индекс (mnemosyne_cap_index)
// даёт список без чтения всех сегментов.

type EntryKey = `local:mnemosyne_cap_${string}`;

function entryKey(videoId: string): EntryKey {
  return `${CACHE_ENTRY_PREFIX}${videoId}` as EntryKey;
}

function toMeta(entry: CvmCacheEntry): CvmCacheMeta {
  return {
    videoId: entry.videoId,
    title: entry.title,
    url: entry.url,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    originalLanguage: entry.originalLanguage,
    originalKind: entry.originalKind,
    translationLanguages: Object.keys(entry.translations),
    apiLanguages: Object.keys(entry.apiTranslations),
  };
}

function isValidMeta(value: unknown): value is CvmCacheMeta {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { videoId?: unknown }).videoId === 'string'
  );
}

// Чтение индекса с защитой от повреждённых данных: отбрасываем всё, что не
// валидная запись (мусор от прежних версий/рассинхрона не должен ронять запись).
async function readIndex(): Promise<CvmCacheMeta[]> {
  const raw = await storage.getItem<unknown>(CACHE_INDEX_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isValidMeta);
}

async function writeMeta(entry: CvmCacheEntry): Promise<void> {
  const index = await readIndex();
  const next = index.filter((meta) => meta.videoId !== entry.videoId);
  next.push(toMeta(entry));
  await storage.setItem(CACHE_INDEX_KEY, next);
}

// Полная запись по видео или null, если не кэширована.
export async function getEntry(videoId: string): Promise<CvmCacheEntry | null> {
  return storage.getItem<CvmCacheEntry>(entryKey(videoId));
}

// Параметры записи в кэш (фрагмент от content-скрипта).
// language/translation опциональны: без них пишется только оригинал.
export interface UpsertEntryParams {
  videoId: string;
  title: string;
  url: string;
  originalLanguage: string;
  originalKind: CaptionKind;
  original: CaptionSegment[];
  language?: string; // целевой язык автоперевода
  translation?: CaptionSegment[];
}

// Создать запись (оригинал) либо дополнить существующую автопереводом.
export async function upsertEntry(params: UpsertEntryParams): Promise<void> {
  const now = Date.now();
  const existing = await getEntry(params.videoId);

  const entry: CvmCacheEntry = existing ?? {
    videoId: params.videoId,
    title: params.title,
    url: params.url,
    createdAt: now,
    updatedAt: now,
    originalLanguage: params.originalLanguage,
    originalKind: params.originalKind,
    original: params.original,
    translations: {},
    apiTranslations: {},
    apiMeta: {},
  };

  if (params.language !== undefined && params.translation !== undefined) {
    entry.translations[params.language] = params.translation;
  }
  entry.updatedAt = now;

  await storage.setItem(entryKey(params.videoId), entry);
  await writeMeta(entry);
}

// Дописать перевод Claude API на целевой язык в существующую запись.
// Запись оригинала должна уже существовать (её создаёт пайплайн до перевода);
// если её нет — возвращаем false, перевод хранить не к чему.
export async function upsertApiTranslation(
  videoId: string,
  language: string,
  translation: CaptionSegment[],
  meta: ApiTranslationMeta,
): Promise<boolean> {
  const entry = await getEntry(videoId);
  if (entry === null) {
    return false;
  }
  entry.apiTranslations[language] = translation;
  // Старые записи могли быть сохранены без apiMeta — подстрахуемся.
  entry.apiMeta = { ...entry.apiMeta, [language]: meta };
  entry.updatedAt = Date.now();
  await storage.setItem(entryKey(videoId), entry);
  await writeMeta(entry);
  return true;
}

// Метаданные одного видео или null, если оно не кэшировано.
export async function getMeta(videoId: string): Promise<CvmCacheMeta | null> {
  const index = await readIndex();
  return index.find((meta) => meta.videoId === videoId) ?? null;
}

// Список метаданных, отсортированный по времени создания (новые сверху).
export async function listMeta(): Promise<CvmCacheMeta[]> {
  const index = await readIndex();
  return [...index].sort((a, b) => b.createdAt - a.createdAt);
}

// Удалить кэш одного видео (запись + строка индекса).
export async function removeEntry(videoId: string): Promise<void> {
  console.info('[Mnemosyne cache] removeEntry старт', videoId, 'key=', entryKey(videoId));
  await storage.removeItem(entryKey(videoId));
  const index = await readIndex();
  const next = index.filter((meta) => meta.videoId !== videoId);
  console.info(
    '[Mnemosyne cache] removeEntry индекс',
    index.map((m) => m.videoId),
    '→',
    next.map((m) => m.videoId),
  );
  await storage.setItem(CACHE_INDEX_KEY, next);
  console.info('[Mnemosyne cache] removeEntry готово', videoId);
}

// Полностью очистить кэш текстов (записи + индекс).
export async function clearAll(): Promise<void> {
  const index = await readIndex();
  await Promise.all(index.map((meta) => storage.removeItem(entryKey(meta.videoId))));
  await storage.removeItem(CACHE_INDEX_KEY);
}
