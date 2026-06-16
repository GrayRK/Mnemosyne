import { defineContentScript } from '#imports';
import {
  YOUTUBE_MATCHES,
  BRIDGE_MESSAGE_SOURCE,
  TIMEDTEXT_PATH,
  TIMEDTEXT_TLANG_PARAM,
  TIMEDTEXT_VIDEO_PARAM,
  EXTRACTION_CAPTURE_TIMEOUT_MS,
  EXTRACTION_POLL_MS,
  CC_BUTTON_SELECTOR,
  CC_PRESSED_ATTR,
  CAPTION_WINDOW_SELECTOR,
  CAPTION_HIDE_STYLE_ID,
} from '@/lib/constants';
import type { BridgeMessage, BridgeExtractionDataMessage } from '@/lib/messaging';

// MAIN world: патчит fetch/XHR и перехватывает РЕАЛЬНЫЙ запрос плеера к
// /api/timedtext — у него уже есть валидный pot-токен (самим его не собрать).
// По запросу из ISOLATED-мира отдаёт перехваченный URL + тело оригинала.

// --- Минимальные типы внутренних структур YouTube ---
interface YtPlayerResponse {
  videoDetails?: {
    videoId?: string;
    title?: string;
  };
}
interface YtMoviePlayer extends Element {
  getPlayerResponse?: () => unknown;
  loadModule?: (name: string) => void;
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => void;
}

// --- Перехваченное состояние (привязано к конкретному видео) ---
let capturedUrl: string | null = null; // последний запрос ОРИГИНАЛА (без tlang)
let capturedBody: string | null = null; // его тело
let capturedLanguage: string | null = null; // lang из URL
let capturedVideoId: string | null = null; // id видео из URL (param v) — против кросс-загрязнения

function resetCapture(): void {
  capturedUrl = null;
  capturedBody = null;
  capturedLanguage = null;
  capturedVideoId = null;
}

// Есть ли валидный перехват именно для этого видео. videoId === null (плеер не отдал id) —
// принимаем любой перехват (не регрессируем редкий случай).
function hasCaptureFor(videoId: string | null): boolean {
  return capturedUrl !== null && (videoId === null || capturedVideoId === videoId);
}

function isTimedtextUrl(url: string): boolean {
  return url.includes(TIMEDTEXT_PATH);
}

function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url; // Request
}

// Сохраняем только «оригинальный» запрос (без tlang) — из него берём pot и текст.
function recordTimedtext(url: string, body: string): void {
  const parsed = new URL(url, window.location.origin);
  if (parsed.searchParams.has(TIMEDTEXT_TLANG_PARAM)) {
    return; // это перевод, нам нужен исходный запрос
  }
  if (body.trim() === '') {
    return; // пустое тело не пригодно
  }
  capturedUrl = url;
  capturedBody = body;
  capturedLanguage = parsed.searchParams.get('lang');
  capturedVideoId = parsed.searchParams.get(TIMEDTEXT_VIDEO_PARAM);
}

// --- Патч fetch / XMLHttpRequest (один раз на страницу) ---
const PATCH_FLAG = '__cvmTimedtextPatched';
const xhrUrls = new WeakMap<XMLHttpRequest, string>();

function installInterceptors(): void {
  const flags = window as unknown as Record<string, boolean>;
  if (flags[PATCH_FLAG] === true) {
    return;
  }
  flags[PATCH_FLAG] = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await originalFetch(input, init);
    try {
      const url = requestUrlOf(input);
      if (isTimedtextUrl(url)) {
        void response
          .clone()
          .text()
          .then((body) => recordTimedtext(url, body))
          .catch(() => {});
      }
    } catch {
      // не мешаем основному потоку страницы
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ): void {
    const urlString = typeof url === 'string' ? url : url.toString();
    if (isTimedtextUrl(urlString)) {
      xhrUrls.set(this, urlString);
    }
    Reflect.apply(originalOpen, this, [method, url, async, username, password]);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const url = xhrUrls.get(this);
    if (url !== undefined) {
      this.addEventListener('load', () => {
        try {
          recordTimedtext(url, this.responseText);
        } catch {
          // игнорируем
        }
      });
    }
    Reflect.apply(originalSend, this, [body]);
  };
}

function getPlayer(): YtMoviePlayer | null {
  return document.getElementById('movie_player') as YtMoviePlayer | null;
}

function getVideoDetails(): { videoId: string | null; title: string } {
  const player = getPlayer();
  const response = player?.getPlayerResponse?.();
  if (typeof response === 'object' && response !== null) {
    const details = (response as YtPlayerResponse).videoDetails;
    return { videoId: details?.videoId ?? null, title: details?.title ?? '' };
  }
  return { videoId: null, title: '' };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// --- Управление родной кнопкой субтитров (надёжнее недокументированного API) ---
function getCcButton(): HTMLElement | null {
  return getPlayer()?.querySelector<HTMLElement>(CC_BUTTON_SELECTOR) ?? null;
}

function isCaptionsOn(): boolean {
  return getCcButton()?.getAttribute(CC_PRESSED_ATTR) === 'true';
}

// Попытка через API плеера (если доступно) — тихий best-effort.
function tryEnableViaApi(): void {
  const player = getPlayer();
  try {
    player?.loadModule?.('captions');
    const tracklist = player?.getOption?.('captions', 'tracklist');
    if (Array.isArray(tracklist) && tracklist.length > 0) {
      player?.setOption?.('captions', 'track', tracklist[0]);
    }
  } catch {
    // API могло измениться — дальше клик по кнопке
  }
}

// На время авто-захвата прячем субтитры на экране, чтобы они не мелькнули.
function setCaptionsHidden(hidden: boolean): void {
  const existing = document.getElementById(CAPTION_HIDE_STYLE_ID);
  if (hidden) {
    if (existing !== null) {
      return;
    }
    const style = document.createElement('style');
    style.id = CAPTION_HIDE_STYLE_ID;
    style.textContent = `${CAPTION_WINDOW_SELECTOR}{display:none !important}`;
    document.head.append(style);
  } else {
    existing?.remove();
  }
}

// Дождаться перехвата: если субтитры выключены — включаем сами, ловим запрос,
// затем возвращаем как было (выключаем, если включали мы). Экран не мигает.
async function ensureCapture(): Promise<void> {
  const currentVideoId = getVideoDetails().videoId;
  // Уже есть валидный перехват для ТЕКУЩЕГО видео — переиспользуем.
  if (hasCaptureFor(currentVideoId)) {
    return;
  }
  // Другое видео (SPA-навигация) или первый раз — сбрасываем старый перехват и берём заново.
  resetCapture();

  const wasOn = isCaptionsOn();
  let weEnabled = false;

  if (!wasOn) {
    setCaptionsHidden(true);
    tryEnableViaApi();
    await delay(EXTRACTION_POLL_MS);
    if (!isCaptionsOn()) {
      getCcButton()?.click();
    }
    weEnabled = true;
  }

  // Ждём перехват ИМЕННО текущего видео (поздний ответ от старого не подходит).
  const deadline = Date.now() + EXTRACTION_CAPTURE_TIMEOUT_MS;
  while (!hasCaptureFor(currentVideoId) && Date.now() < deadline) {
    await delay(EXTRACTION_POLL_MS);
  }

  if (weEnabled) {
    if (isCaptionsOn()) {
      getCcButton()?.click(); // вернуть как было — субтитры снова выключены
    }
    setCaptionsHidden(false);
  }
}

async function buildExtractionData(): Promise<BridgeExtractionDataMessage> {
  await ensureCapture();
  const { videoId, title } = getVideoDetails();
  // Отдаём тело ТОЛЬКО если перехват принадлежит текущему видео — иначе перевели бы
  // чужие субтитры (кросс-загрязнение кэша).
  const matched = hasCaptureFor(videoId);
  return {
    type: 'extraction-data',
    videoId,
    title,
    originalLanguage: matched ? capturedLanguage : null,
    capturedUrl: matched ? capturedUrl : null,
    capturedBody: matched ? capturedBody : null,
    error: matched ? null : 'no-capture',
  };
}

function postToContent(message: BridgeMessage): void {
  window.postMessage({ source: BRIDGE_MESSAGE_SOURCE, message }, window.location.origin);
}

function isBridgeEnvelope(data: unknown): data is { source: string; message: BridgeMessage } {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { source?: unknown }).source === BRIDGE_MESSAGE_SOURCE
  );
}

export default defineContentScript({
  matches: YOUTUBE_MATCHES,
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installInterceptors();

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window || !isBridgeEnvelope(event.data)) {
        return;
      }
      if (event.data.message.type === 'request-extraction') {
        void buildExtractionData().then(postToContent);
      }
    });

    console.debug('[Mnemosyne] content bridge (MAIN) loaded — перехват timedtext активен');
  },
});
