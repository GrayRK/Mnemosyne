// Общие именованные константы проекта. Никаких магических чисел/строк в коде.

import type { LanguageOption, TranslationStatus } from '@/lib/types';

// --- Совпадения URL для контент-скриптов ---
export const YOUTUBE_MATCHES: string[] = ['https://www.youtube.com/*'];

// --- Ключи chrome.storage.local (префикс cvm_) ---
export const STORAGE_KEYS = {
  apiKey: 'local:cvm_api_key',
  targetLanguage: 'local:cvm_target_language',
  selectedVoice: 'local:cvm_selected_voice',
  ttsEnabled: 'local:cvm_tts_enabled',
  subtitlesEnabled: 'local:cvm_subtitles_enabled',
  useYoutubeTranslation: 'local:cvm_use_youtube_translation',
  autoStart: 'local:cvm_auto_start',
  translationVolume: 'local:cvm_translation_volume',
  videoDucking: 'local:cvm_video_ducking',
} as const;

// --- Значения по умолчанию ---
export const DEFAULT_TARGET_LANGUAGE = 'ru';
export const DEFAULT_SELECTED_VOICE = '';
export const DEFAULT_TTS_ENABLED = true;
export const DEFAULT_SUBTITLES_ENABLED = true;
export const DEFAULT_USE_YOUTUBE_TRANSLATION = false;
export const DEFAULT_AUTO_START = false;
export const DEFAULT_TRANSLATION_VOLUME = 0.9; // громкость TTS, 0..1
export const DEFAULT_VIDEO_DUCKING = 0.4; // приглушение оригинала, 0..MAX_VIDEO_DUCKING

// --- Границы значений ---
export const MIN_VOLUME = 0;
export const MAX_VOLUME = 1;
export const MAX_VIDEO_DUCKING = 0.8; // субтитры: приглушение не более 80%

// --- Связь Inspector <-> остальные контексты ---
export const INSPECTOR_PORT_NAME = 'cvm-inspector';
export const HIGHLIGHT_DURATION_MS = 1000; // подсветка изменённого значения
export const INSPECTOR_RECONNECT_DELAY_MS = 1000; // переподключение порта при перезапуске SW

// --- Имя страницы Live State Inspector (entrypoint inspector/) ---
export const INSPECTOR_PAGE = 'inspector.html';

// --- Языки перевода (короткий список, легко расширяется) ---
export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
];

// --- Подписи статуса перевода для индикатора ---
export const STATUS_LABELS: Record<TranslationStatus, string> = {
  ready: 'Готов',
  translating: 'Переводим…',
  error: 'Ошибка',
};

// --- UI popup ---
export const PERCENT_SCALE = 100; // хранение 0..1 <-> отображение 0..100%
export const API_KEY_SAVE_DEBOUNCE_MS = 400;

// --- Виджет на странице видео (content.ts) ---
export const WIDGET_HOST_ID = 'cvm-widget-host';
export const PLAYER_SELECTOR = '.html5-video-player'; // элемент, уходящий в фуллскрин
export const WIDGET_MOUNT_POLL_MS = 1000; // проверка наличия плеера/виджета
export const WIDGET_LABEL_START = 'Перевести и озвучить';
export const WIDGET_LABEL_STOP = 'Выключить перевод';

// --- Извлечение субтитров YouTube (Стадия 2) ---
// Прямой запрос к timedtext: оригинал + автоперевод (Google) через &tlang.
export const TIMEDTEXT_FORMAT = 'json3'; // структурированный JSON с таймингами
export const TIMEDTEXT_FORMAT_PARAM = 'fmt';
export const TIMEDTEXT_TLANG_PARAM = 'tlang'; // целевой язык автоперевода
export const CAPTION_KIND_ASR = 'asr'; // авто-сгенерированные субтитры (fallback)
export const VIDEO_WATCH_URL = 'https://www.youtube.com/watch?v='; // ссылка на видео по id

// Перехват реального запроса плеера (у него валидный pot-токен).
export const TIMEDTEXT_PATH = '/api/timedtext'; // признак запроса субтитров
export const EXTRACTION_REQUEST_TIMEOUT_MS = 9000; // общий таймаут ожидания ответа моста
export const EXTRACTION_CAPTURE_TIMEOUT_MS = 6000; // ожидание перехвата у моста
export const EXTRACTION_POLL_MS = 200; // период опроса перехвата

// Авто-включение субтитров плеера (чтобы пользователь не жал CC вручную).
export const CC_BUTTON_SELECTOR = '.ytp-subtitles-button'; // родная кнопка CC
export const CC_PRESSED_ATTR = 'aria-pressed'; // 'true' когда субтитры включены
export const CAPTION_WINDOW_SELECTOR = '.ytp-caption-window-container'; // контейнер субтитров на экране
export const CAPTION_HIDE_STYLE_ID = 'cvm-hide-captions'; // id временного <style>, прячущего субтитры

// --- Канал мост(MAIN) <-> content(ISOLATED) через window.postMessage ---
export const BRIDGE_MESSAGE_SOURCE = 'cvm-bridge'; // метка своих сообщений в общем window

// --- Кэш текстов (Стадия 2, chrome.storage.local) ---
// Префикс отделён от зарезервированного под Стадию 3 ключа cvm_v_{videoId}_{lang}.
export const CACHE_ENTRY_PREFIX = 'local:cvm_cap_'; // cvm_cap_{videoId}_{lang}
export const CACHE_INDEX_KEY = 'local:cvm_cap_index'; // список метаданных записей

// --- Меню кэша в Inspector ---
export const CACHE_LIST_EMPTY_LABEL = 'Кэш пуст';
export const CACHE_CLEAR_LABEL = 'Очистить кэш';
export const CACHE_CLEAR_CONFIRM = 'Удалить все кэшированные тексты?';
export const CACHE_BANNER_ORIGINAL_LABEL = 'Оригинал';
export const CACHE_BANNER_AUTO_LABEL = 'Автоперевод YouTube';
export const CACHE_BANNER_API_LABEL = 'Перевод API (Стадия 3)';
export const CACHE_BANNER_API_PLACEHOLDER = '— заготовка, появится в Стадии 3 —';
export const CACHE_BANNER_EMPTY_PLACEHOLDER = '— нет текста —';
