// Общие именованные константы проекта. Никаких магических чисел/строк в коде.

import type { LanguageOption, TranslationStatus } from '@/lib/types';

// --- Совпадения URL для контент-скриптов ---
export const YOUTUBE_MATCHES: string[] = ['https://www.youtube.com/*'];

// --- Ключи chrome.storage.local (префикс mnemosyne_) ---
export const STORAGE_KEYS = {
  apiKey: 'local:mnemosyne_api_key',
  targetLanguage: 'local:mnemosyne_target_language',
  ttsEngine: 'local:mnemosyne_tts_engine',
  selectedVoice: 'local:mnemosyne_selected_voice',
  selectedVoiceEdge: 'local:mnemosyne_selected_voice_edge',
  ttsEnabled: 'local:mnemosyne_tts_enabled',
  subtitlesEnabled: 'local:mnemosyne_subtitles_enabled',
  useYoutubeTranslation: 'local:mnemosyne_use_youtube_translation',
  autoStart: 'local:mnemosyne_auto_start',
  translationVolume: 'local:mnemosyne_translation_volume',
  videoDucking: 'local:mnemosyne_video_ducking',
  showCost: 'local:mnemosyne_show_cost',
  ttsMinRate: 'local:mnemosyne_tts_min_rate',
  ttsMaxRate: 'local:mnemosyne_tts_max_rate',
  ttsEndpoint: 'local:mnemosyne_tts_endpoint',
  ttsOffsetMs: 'local:mnemosyne_tts_offset_ms',
  subsPositionPct: 'local:mnemosyne_subs_position_pct',
} as const;

// --- Значения по умолчанию ---
export const DEFAULT_TARGET_LANGUAGE = 'ru';
export const DEFAULT_TTS_ENGINE = 'edge'; // нейронный Edge по умолчанию
export const DEFAULT_SELECTED_VOICE = ''; // Web Speech: '' — авто-подбор по языку
export const DEFAULT_SELECTED_VOICE_EDGE = ''; // Edge: '' — первый голос языка из каталога
export const DEFAULT_TTS_ENABLED = true;
export const DEFAULT_SUBTITLES_ENABLED = true;
export const DEFAULT_USE_YOUTUBE_TRANSLATION = false;
export const DEFAULT_AUTO_START = false;
export const DEFAULT_TRANSLATION_VOLUME = 0.9; // громкость TTS, 0..1
export const DEFAULT_VIDEO_DUCKING = 0.4; // приглушение оригинала, 0..MAX_VIDEO_DUCKING
export const DEFAULT_SHOW_COST = false; // показывать примерную стоимость перевода в виджете
export const DEFAULT_TTS_MIN_RATE = 1.0; // нижняя граница темпа TTS по умолчанию (настраивается в Inspector)
export const DEFAULT_TTS_MAX_RATE = 4.0; // верхняя граница темпа TTS по умолчанию (настраивается в Inspector)
export const DEFAULT_TTS_OFFSET_MS = 0; // сдвиг времени озвучки/субтитров относительно видео, мс
export const DEFAULT_SUBS_POSITION_PCT = 88; // вертикальное положение субтитров (низ ~88%)

// --- Границы значений ---
export const MIN_VOLUME = 0;
export const MAX_VOLUME = 1;
export const MAX_VIDEO_DUCKING = 0.8; // субтитры: приглушение не более 80%

// --- Связь Inspector <-> остальные контексты ---
export const INSPECTOR_PORT_NAME = 'mnemosyne-inspector';
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
export const WIDGET_HOST_ID = 'mnemosyne-widget-host';
export const PLAYER_SELECTOR = '.html5-video-player'; // элемент, уходящий в фуллскрин
export const WIDGET_MOUNT_POLL_MS = 1000; // проверка наличия плеера/виджета
export const WIDGET_LABEL_START = 'Перевести и озвучить';
export const WIDGET_LABEL_STOP = 'Выключить перевод';
export const WIDGET_LABEL_TRANSLATING = 'Перевод'; // + " N/M" — индикатор прогресса батчей
// Показ примерной стоимости перевода в виджете (Стадия 3.4). Считается по точным символам
// оригинала × R (калибровка). Погрешность — доп. батчи/повторы.
export const WIDGET_COST_PREFIX = 'Стоимость ≈ '; // + $X
export const WIDGET_COST_NO_DATA = 'Стоимость: нет калибровки'; // R неизвестен (нет замеров)

// --- Караоке-субтитры озвучки (Стадия 4) ---
// Оверлей внизу плеера: предыдущая (тускло) / текущая (ярко, с множителем темпа) / следующая (тускло).
export const SUBS_HOST_ID = 'mnemosyne-subs-host';
export const SUBS_RATE_PREFIX = '×'; // префикс множителя темпа TTS перед текущей строкой

// --- Извлечение субтитров YouTube (Стадия 2) ---
// Прямой запрос к timedtext: оригинал + автоперевод (Google) через &tlang.
export const TIMEDTEXT_FORMAT = 'json3'; // структурированный JSON с таймингами
export const TIMEDTEXT_FORMAT_PARAM = 'fmt';
export const TIMEDTEXT_TLANG_PARAM = 'tlang'; // целевой язык автоперевода
export const TIMEDTEXT_VIDEO_PARAM = 'v'; // id видео в URL запроса timedtext (привязка перехвата)
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
export const CAPTION_HIDE_STYLE_ID = 'mnemosyne-hide-captions'; // id временного <style>, прячущего субтитры

// --- Канал мост(MAIN) <-> content(ISOLATED) через window.postMessage ---
export const BRIDGE_MESSAGE_SOURCE = 'mnemosyne-bridge'; // метка своих сообщений в общем window

// --- Кэш текстов (Стадия 2, chrome.storage.local) ---
// Префикс отделён от зарезервированного под Стадию 3 ключа mnemosyne_v_{videoId}_{lang}.
export const CACHE_ENTRY_PREFIX = 'local:mnemosyne_cap_'; // mnemosyne_cap_{videoId}_{lang}
export const CACHE_INDEX_KEY = 'local:mnemosyne_cap_index'; // список метаданных записей

// --- Меню кэша в Inspector ---
export const CACHE_LIST_EMPTY_LABEL = 'Кэш пуст';
export const CACHE_CLEAR_LABEL = 'Очистить кэш';
export const CACHE_CLEAR_CONFIRM = 'Удалить все кэшированные тексты?';
export const CACHE_BANNER_ORIGINAL_LABEL = 'Оригинал';
export const CACHE_BANNER_AUTO_LABEL = 'Автоперевод YouTube';
export const CACHE_BANNER_API_LABEL = 'Перевод Claude API';
export const CACHE_BANNER_API_PLACEHOLDER = '— нет перевода API —';
export const CACHE_BANNER_API_FILLING = 'наполняется'; // + " N/M" пока перевод потоково пишется
export const CACHE_BANNER_EMPTY_PLACEHOLDER = '— нет текста —';

// --- API Monitor (Стадия 3.2) ---
export const MONITOR_BUTTON_LABEL = '📊 Монитор';
export const MONITOR_TITLE = 'API Monitor';
export const MONITOR_LABELS = {
  model: 'Модель Claude API',
  batches: 'Сформировано батчей',
  charsPerBatch: 'Символов на батч (средн.)',
  charsTotal: 'Символов всего',
  segments: 'Сегментов (строк)',
  batchTime: 'Время на батч (средн.)',
  totalTime: 'Время на весь текст',
  inputTokens: 'Входные токены',
  outputTokens: 'Выходные токены',
} as const;

// --- Фиксация стоимости в API Monitor (Стадия 3.3) ---
export const COST_FIX_TITLE = 'Стоимость этого перевода';
export const COST_FIX_PLACEHOLDER = '0.00';
export const COST_FIX_BUTTON = 'Зафиксировать';
export const COST_FIX_LOCKED_NOTE = 'Зафиксировано — учтено в калибровке калькулятора';
export const COST_FIX_HINT = 'Введи реальную сумму ($), списанную за этот перевод';
export const COST_FIX_CONFIRM = 'Зафиксировать стоимость $%s? Изменить позже нельзя.';
export const COST_FIX_INVALID = 'Введи положительную сумму в долларах';

// --- Калибровка калькулятора (Стадия 3.3) ---
export const CALIBRATION_SAMPLES_KEY = 'local:mnemosyne_cost_samples'; // массив CostSample
export const CALC_MAX_MINUTES = 180; // верх ползунка длины видео
export const CALC_DEFAULT_MINUTES = 15; // стартовое значение ползунка
export const CALC_RESET_CONFIRM = 'Сбросить все калибровочные замеры калькулятора?';
export const CALC_LABELS = {
  title: 'Калькулятор стоимости',
  minutes: 'Длина видео',
  chars: 'Символов',
  cost: 'Стоимость, $',
  perKChar: '$ / 1000 символов',
  costPerMinute: '≈ $ / мин видео', // D × R: грубое «среднее по видео» (Стадия 3.4)
  density: 'Символов в минуту',
  samples: 'Замеров (текущая модель)',
  model: 'Модель',
  reset: 'Сбросить калибровку',
  tokensUnit: 'токенов',
  empty: 'Зафиксируй хотя бы одну стоимость в API Monitor — калькулятор обучится на реальных данных.',
} as const;

// --- Claude API (Стадия 3) ---
export const API_ENDPOINT = 'https://aiprimetech.io/v1/messages';
export const API_MODEL = 'claude-sonnet-4-6';
export const API_MODEL_DISPLAY = 'Claude Sonnet 4.6'; // человекочитаемое имя для UI
export const API_ANTHROPIC_VERSION = '2023-06-01';
export const API_MAX_TOKENS = 8192; // потолок выходных токенов на батч
// 50 строк на батч: модель надёжнее держит построчное соответствие, чем на 150,
// и батч отвечает быстрее. Значение тюнится вместе с пользователем (см. TASKS).
// 50 строк на батч: серверная латентность от размера батча НЕ зависит (зомби случается
// и на 25 строках), поэтому крупные батчи = меньше запросов = меньше «бросков кубика» на
// зомби, и всё укладывается в одну волну. Самый устойчивый вариант. Тюнится (см. TASKS 3.4).
export const API_BATCH_SIZE = 50; // сегментов субтитров на один запрос
// 6 воркеров = реальный потолок Chrome (~6 соединений на хост). Выше — лишние запросы
// висят в очереди браузера и только замедляют.
export const API_BATCH_CONCURRENCY = 6; // одновременных запросов к API
export const API_RETRY_COUNT = 1; // повторов при ошибке сети/прочем HTTP (не формата)

// ПОЛ жёсткого таймаута батча (нижняя граница). Реальный таймаут адаптивен —
// масштабируется от медианы латентности батчей текущего прогона (см. ниже), но не
// опускается ниже этого значения. Достигнут — батч обрывается и перезапускается.
export const API_BATCH_TIMEOUT_MS = 45000; // пол адаптивного таймаута, мс
export const API_TIMEOUT_RETRY_COUNT = 2; // повторов именно на таймаут (abort)

// Адаптивный таймаут против серверного «хвоста» (по данным ЛК прокси держит отдельные
// запросы до ~170с). Порог относителен медиане латентности завершённых батчей ТЕКУЩЕГО
// прогона, поэтому length-инвариантен: батч всегда 50 строк, длина видео не меняет ожидаемое
// время батча. Превышение → abort + перезапрос (новый запрос обычно попадает на здоровый
// путь). Хеджирование (дубль-запрос) пробовали — на queue-bound прокси добавляет нагрузку
// и дубль сам зомбирует, поэтому отказались в пользу таймаута.
export const MEDIAN_MIN_SAMPLES = 2; // завершённых батчей нужно, чтобы доверять медиане
export const TIMEOUT_LATENCY_FACTOR = 2.5; // таймаут = max(пол, FACTOR × медиана)
export const TIMEOUT_POLL_MS = 1000; // период проверки таймаута для in-flight батча, мс

// Backoff на rate-limit/перегрузку прокси (статусы 429/529/503). Лимиты прокси
// неизвестны — повторяем с экспоненциальной задержкой + джиттер (воркеры не бьют синхронно).
export const API_RATE_LIMIT_RETRY_COUNT = 4; // повторов именно на 429/перегрузку
export const API_BACKOFF_BASE_MS = 500; // база экспоненты: 500, 1000, 2000, 4000…
export const API_BACKOFF_MAX_MS = 8000; // потолок одной задержки
export const API_BACKOFF_JITTER_MS = 300; // случайный разброс поверх задержки

// --- TTS / озвучка (Стадия 4) ---
// Старт-движок — Web Speech API (системные голоса Windows, Microsoft Neural).
// Параметры передаются в движок как есть; адаптацию темпа считает планировщик.
export const TTS_DEFAULT_RATE = 1.0; // нормальный темп речи (1.0 = как у голоса по умолчанию)
// Диапазон скорости речи задаётся пользователем (mnemosyne_tts_min_rate / mnemosyne_tts_max_rate). Темп
// реплики считается по бюджету и зажимается в [min..max] (оба ×playbackRate). Реплики НЕ
// пропускаем — лучше «протараторить» и догнать. min позволяет «не читать медленнее ×N».
// Границы обоих ползунков в Inspector:
export const TTS_RATE_MIN = 1.0;
export const TTS_RATE_MAX = 10.0; // абсолютный предел Web Speech
export const TTS_RATE_STEP = 0.5;
// Сдвиг озвучки/субтитров относительно видео (мс). + = реплики раньше (упреждение задержки),
// − = позже. Инструмент для подгонки синхрона на тестах.
export const TTS_OFFSET_MIN_MS = -3000;
export const TTS_OFFSET_MAX_MS = 3000;
export const TTS_OFFSET_STEP_MS = 100;
// Жёсткие границы rate самого движка (предел спецификации Web Speech 0.1..10). Планировщик
// масштабирует свой потолок скоростью видео, поэтому абсолютный потолок движка = предел спеки.
export const TTS_HARD_MIN_RATE = 0.1;
export const TTS_HARD_MAX_RATE = 10;
// Живая коррекция темпа в момент воспроизведения (поверх запечённого в синтез rate): для Edge —
// audio.playbackRate, для Web Speech — множитель к utterance.rate. Считается от реального
// отставания при старте реплики, поэтому именно она реально догоняет видео. Границы — чтобы
// замедление не делало речь неразборчиво медленной, а ускорение не выходило за предел движка.
export const TTS_PLAYBACK_ADJUST_MIN = 0.5;
// Подстрока в имени голоса, по которой узнаём Microsoft Neural (для выбора и fallback-уведомления).
export const TTS_NEURAL_HINT = 'neural';

// --- Edge нейронный TTS через прокси-эндпоинт (Стадия 4, путь B) ---
// Прямой эндпоинт Microsoft из браузера недоступен (нельзя задать Origin/User-Agent) и
// заблокирован в РФ. Синтез делает внешний прокси вне РФ: Cloudflare Worker (worker/) —
// рекомендуется, ноль настройки для пользователя; либо локальный хелпер (tools/edge-tts-relay.py)
// через VPN — для отладки. Адрес эндпоинта настраивается в Inspector (mnemosyne_tts_endpoint).
// По умолчанию — общий Cloudflare Worker проекта (вне РФ, обходит блокировку + Origin).
// Конечному пользователю настройка не нужна. Локальный релей (127.0.0.1:5599) — для отладки.
export const DEFAULT_TTS_ENDPOINT = 'https://cvm-edge-tts.aksenovgeorgiy.workers.dev/tts';
export const EDGE_TTS_SYNTH_TIMEOUT_MS = 12000; // таймаут одного запроса к эндпоинту
export const EDGE_TTS_AUDIO_MIME = 'audio/mpeg';
// Ретраи синтеза у Worker: большинство сбоев транзиентны (холодный старт CF / таймаут).
// При окончательном провале реплика молча пропускается (без подмены системным голосом).
export const EDGE_TTS_SYNTH_RETRIES = 2; // дополнительные попытки сверх первой
export const EDGE_TTS_SYNTH_RETRY_DELAY_MS = 400; // пауза между попытками
// Префетч-кэш Edge: сколько реплик держать синтезированными наперёд.
export const TTS_PREFETCH_AHEAD = 6; // синтезируем N реплик вперёд, чтобы убрать сетевые паузы
export const EDGE_TTS_PREFETCH_CACHE_LIMIT = 10; // ёмкость кэша (≥ TTS_PREFETCH_AHEAD + запас)
export const TTS_ENDPOINT_LABEL = 'Адрес TTS-эндпоинта';
export const TTS_ENDPOINT_HINT =
  'Cloudflare Worker (…workers.dev/tts) или локальный релей. Меняется на лету.';
// Каталог нейронных голосов Edge по базовому коду языка (id + подпись для popup). Первый в
// списке — голос по умолчанию для языка. Расширяемо.
export const EDGE_VOICE_CATALOG: Record<string, { id: string; label: string }[]> = {
  ru: [
    { id: 'ru-RU-DmitryNeural', label: 'Дмитрий (М)' },
    { id: 'ru-RU-SvetlanaNeural', label: 'Светлана (Ж)' },
    { id: 'ru-RU-DariyaNeural', label: 'Дария (Ж)' },
  ],
  en: [
    { id: 'en-US-AndrewNeural', label: 'Andrew (US, M)' },
    { id: 'en-US-AriaNeural', label: 'Aria (US, F)' },
    { id: 'en-US-GuyNeural', label: 'Guy (US, M)' },
    { id: 'en-GB-RyanNeural', label: 'Ryan (UK, M)' },
    { id: 'en-GB-SoniaNeural', label: 'Sonia (UK, F)' },
  ],
  es: [
    { id: 'es-ES-AlvaroNeural', label: 'Álvaro (M)' },
    { id: 'es-ES-ElviraNeural', label: 'Elvira (F)' },
  ],
  de: [
    { id: 'de-DE-ConradNeural', label: 'Conrad (M)' },
    { id: 'de-DE-KatjaNeural', label: 'Katja (F)' },
  ],
  fr: [
    { id: 'fr-FR-HenriNeural', label: 'Henri (M)' },
    { id: 'fr-FR-DeniseNeural', label: 'Denise (F)' },
  ],
  zh: [
    { id: 'zh-CN-YunxiNeural', label: 'Yunxi (M)' },
    { id: 'zh-CN-XiaoxiaoNeural', label: 'Xiaoxiao (F)' },
  ],
  ja: [
    { id: 'ja-JP-KeitaNeural', label: 'Keita (M)' },
    { id: 'ja-JP-NanamiNeural', label: 'Nanami (F)' },
  ],
};
export const EDGE_TTS_DEFAULT_VOICE = 'ru-RU-DmitryNeural'; // если язык не в каталоге

// Выбор движка озвучки (popup).
export const TTS_ENGINE_OPTIONS: { id: string; label: string }[] = [
  { id: 'edge', label: 'Edge (нейронный)' },
  { id: 'webspeech', label: 'Системный (Web Speech)' },
];

// Положение субтитров на экране (вертикаль, % высоты плеера).
export const SUBS_POSITION_MIN = 0;
export const SUBS_POSITION_MAX = 100;
export const SUBS_POSITION_STEP = 1;

// --- Планировщик озвучки (Стадия 4) ---
// Базовая плотность речи голоса на rate 1.0 (символов/сек). Нужна для адаптации темпа:
// rate = нужный_cps / baseline. Старт ~15 для русского; уточняется на реальном видео.
export const TTS_BASELINE_CPS = 15;
// Минимальный бюджет на реплику (мс): пол для расчёта темпа, чтобы не делить на ~0 при
// сильном отставании/коротком окне (иначе rate улетает в потолок и речь «тараторит»).
export const TTS_MIN_BUDGET_MS = 300;
export const VIDEO_SELECTOR = 'video.html5-main-video'; // основной <video> плеера YouTube
export const DUCK_RESTORE_MS = 300; // плавное восстановление громкости оригинала после реплики

// Английские имена языков для системного промпта (надёжнее кодов).
export const LANGUAGE_NAMES: Record<string, string> = {
  ru: 'Russian',
  en: 'English',
  es: 'Spanish',
  de: 'German',
  fr: 'French',
  zh: 'Chinese',
  ja: 'Japanese',
};

// Нумерованный протокол: каждая реплика помечена номером [n], модель обязана
// вернуть строку [n] на каждый номер. Сборка идёт по номерам — потерянный номер
// заменяется оригиналом, поэтому несовпадение количества не рушит батч.
// Плейсхолдер {language} подставляется целевым языком перед запросом.
export const API_SYSTEM_PROMPT_TEMPLATE = `You are a professional subtitle translator. Translate subtitles into {language}.

The user message contains numbered subtitle lines, one per line, in the form:
[1] original text
[2] original text

Rules:
- Output one line per input number, in the SAME format: [n] translation
- Output EXACTLY one [n] line for every input number, with the same numbers, in order. Never skip, merge, reorder or invent numbers.
- Even if consecutive lines form a single sentence, translate them in place and keep each under its own number. Do not move words between numbers.
- Keep the content unchanged if it must not be translated (proper names, [Music], numbers, symbols).
- Natural spoken tone for voice-over; concise to fit the original timing.
- Output only the numbered lines: no preamble, comments or markdown.`;
