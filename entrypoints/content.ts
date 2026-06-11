import { defineContentScript, browser } from '#imports';
import { settings } from '@/lib/storage';
import type { CaptionSegment } from '@/lib/types';
import type {
  BackgroundMessage,
  BridgeMessage,
  BridgeExtractionDataMessage,
  CacheLookupMessage,
  CacheLookupResponse,
  CacheStoreMessage,
} from '@/lib/messaging';
import {
  YOUTUBE_MATCHES,
  WIDGET_HOST_ID,
  PLAYER_SELECTOR,
  WIDGET_MOUNT_POLL_MS,
  WIDGET_LABEL_START,
  WIDGET_LABEL_STOP,
  BRIDGE_MESSAGE_SOURCE,
  TIMEDTEXT_FORMAT,
  TIMEDTEXT_FORMAT_PARAM,
  TIMEDTEXT_TLANG_PARAM,
  EXTRACTION_REQUEST_TIMEOUT_MS,
  VIDEO_WATCH_URL,
} from '@/lib/constants';

// SPA-событие YouTube об окончании внутренней навигации.
const YT_NAVIGATE_EVENT = 'yt-navigate-finish';

const WIDGET_STYLES = `
  .cvm-toggle {
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    background: rgba(124, 58, 237, 0.92);
    border: none;
    border-radius: 8px;
    padding: 8px 14px;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }
  .cvm-toggle:hover {
    background: rgba(124, 58, 237, 1);
  }
  .cvm-toggle[data-active='true'] {
    background: rgba(220, 38, 38, 0.92);
  }
  .cvm-toggle[data-active='true']:hover {
    background: rgba(220, 38, 38, 1);
  }
`;

// =====================================================================
// Канал с мостом content-bridge (MAIN world) через window.postMessage
// =====================================================================

interface BridgeEnvelope {
  source: typeof BRIDGE_MESSAGE_SOURCE;
  message: BridgeMessage;
}

function isBridgeEnvelope(data: unknown): data is BridgeEnvelope {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  return (data as { source?: unknown }).source === BRIDGE_MESSAGE_SOURCE;
}

function postToBridge(message: BridgeMessage): void {
  const envelope: BridgeEnvelope = { source: BRIDGE_MESSAGE_SOURCE, message };
  window.postMessage(envelope, window.location.origin);
}

// Запросить у моста перехваченные данные субтитров (одноразовый ответ).
function requestExtraction(): Promise<BridgeExtractionDataMessage> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('[CVM] мост не ответил на запрос извлечения'));
    }, EXTRACTION_REQUEST_TIMEOUT_MS);

    function onMessage(event: MessageEvent): void {
      if (event.source !== window || !isBridgeEnvelope(event.data)) {
        return;
      }
      const message = event.data.message;
      if (message.type === 'extraction-data') {
        window.clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(message);
      }
    }

    window.addEventListener('message', onMessage);
    postToBridge({ type: 'request-extraction' });
  });
}

// =====================================================================
// Извлечение текста субтитров через timedtext (json3)
// =====================================================================

interface Json3Segment {
  utf8?: string;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Segment[];
}
interface Json3Response {
  events?: Json3Event[];
}

function parseJson3(body: string): CaptionSegment[] {
  if (body.trim() === '') {
    return [];
  }
  const events = (JSON.parse(body) as Json3Response).events ?? [];
  const segments: CaptionSegment[] = [];
  for (const event of events) {
    if (event.segs === undefined) {
      continue; // служебные события без текста (определения окон и т.п.)
    }
    const text = event.segs.map((seg) => seg.utf8 ?? '').join('').trim();
    if (text === '') {
      continue;
    }
    segments.push({
      start: event.tStartMs ?? 0,
      duration: event.dDurationMs ?? 0,
      text,
    });
  }
  return segments;
}

// Декодирование HTML-сущностей (XML-формат timedtext отдаёт &#39; и т.п.).
function decodeEntities(value: string): string {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

// Фолбэк-парсер «сырого» XML-формата timedtext (<transcript><text start dur>).
function parseXml(body: string): CaptionSegment[] {
  if (body.trim() === '') {
    return [];
  }
  const doc = new DOMParser().parseFromString(body, 'text/xml');
  const segments: CaptionSegment[] = [];
  for (const node of Array.from(doc.querySelectorAll('text'))) {
    const text = decodeEntities(node.textContent ?? '').trim();
    if (text === '') {
      continue;
    }
    const startSec = Number.parseFloat(node.getAttribute('start') ?? '0');
    const durSec = Number.parseFloat(node.getAttribute('dur') ?? '0');
    segments.push({
      start: Math.round(startSec * 1000),
      duration: Math.round(durSec * 1000),
      text,
    });
  }
  return segments;
}

// Базовый код языка без региона: 'en-US' -> 'en' (для сравнения с целевым).
function baseLanguage(code: string): string {
  return code.split('-')[0]?.toLowerCase() ?? code.toLowerCase();
}

// Разобрать тело timedtext с автоопределением формата (json3 или «сырой» XML).
function parseSegments(body: string): CaptionSegment[] {
  const trimmed = body.trim();
  if (trimmed === '') {
    return [];
  }
  return trimmed.startsWith('{') ? parseJson3(body) : parseXml(body);
}

// Автоперевод YouTube: тот же перехваченный URL (с валидным pot) + &tlang.
async function fetchTranslation(capturedUrl: string, tlang: string): Promise<CaptionSegment[]> {
  const url = new URL(capturedUrl);
  url.searchParams.set(TIMEDTEXT_FORMAT_PARAM, TIMEDTEXT_FORMAT);
  url.searchParams.set(TIMEDTEXT_TLANG_PARAM, tlang);
  const response = await fetch(url.toString(), { credentials: 'include' });
  const body = await response.text();
  console.info(
    `[CVM] автоперевод ${response.status} (${body.length} б, tlang=${tlang})`,
  );
  if (!response.ok) {
    throw new Error(`[CVM] автоперевод вернул статус ${response.status}`);
  }
  return parseSegments(body);
}

// ISOLATED world: плавающий виджет управления + пайплайн извлечения текста.
export default defineContentScript({
  matches: YOUTUBE_MATCHES,
  runAt: 'document_idle',
  main(ctx) {
    let active = false;
    let button: HTMLButtonElement | null = null;

    function reportActive(): void {
      const message: BackgroundMessage = { type: 'set-translation-active', active };
      void browser.runtime.sendMessage(message).catch(() => {
        // background мог быть усыплён — состояние синхронизируется при следующем сообщении.
      });
    }

    // Извлечь и закэшировать тексты текущего видео (если ещё не в кэше).
    async function runPipeline(): Promise<void> {
      const data = await requestExtraction();
      if (data.videoId === null) {
        console.warn('[CVM] не удалось определить videoId — извлечение пропущено');
        return;
      }
      if (data.error !== null || data.capturedUrl === null || data.capturedBody === null) {
        console.warn(
          '[CVM] не удалось перехватить субтитры. Включи CC на видео и нажми кнопку снова.',
        );
        return;
      }
      const originalLanguage = data.originalLanguage ?? 'unknown';
      const targetLanguage = await settings.targetLanguage.getValue();
      const useYoutubeTranslation = await settings.useYoutubeTranslation.getValue();

      const lookup: CacheLookupMessage = {
        type: 'cache-lookup',
        videoId: data.videoId,
        language: targetLanguage,
      };
      const lookupResponse = (await browser.runtime.sendMessage(lookup)) as
        | CacheLookupResponse
        | undefined;

      // Общая часть записи (оригинал и метаданные).
      const baseStore = {
        videoId: data.videoId,
        title: data.title,
        url: VIDEO_WATCH_URL + data.videoId,
        originalLanguage,
        // Перехват не различает manual/asr — помечаем как manual (источник — плеер).
        originalKind: 'manual' as const,
      };

      // Режим «Использовать автоперевод» выключен — кэшируем только оригинал.
      if (!useYoutubeTranslation) {
        if (lookupResponse?.entryExists === true) {
          console.info('[CVM] оригинал уже в кэше (автоперевод выключен) — пропуск');
          return;
        }
        const originalSegments = parseSegments(data.capturedBody);
        if (originalSegments.length === 0) {
          console.warn('[CVM] перехваченный оригинал пуст — кэш не записан');
          return;
        }
        const store: CacheStoreMessage = {
          type: 'cache-store',
          ...baseStore,
          original: originalSegments,
        };
        await browser.runtime.sendMessage(store);
        console.info(
          `[CVM] закэшировано: только оригинал ${originalSegments.length} сегм. (автоперевод выключен)`,
        );
        return;
      }

      // Автоперевод включён. Целевой язык совпадает с оригиналом — переводить нечего.
      if (baseLanguage(originalLanguage) === baseLanguage(targetLanguage)) {
        console.info(
          `[CVM] целевой язык совпадает с оригиналом (${originalLanguage}) — автоперевод не нужен`,
        );
        return;
      }
      // Автоперевод на этот язык уже есть — извлечение пропускаем.
      if (lookupResponse?.hasTranslation === true) {
        console.info(`[CVM] автоперевод "${targetLanguage}" уже в кэше — пропуск`);
        return;
      }

      const originalSegments = parseSegments(data.capturedBody);
      if (originalSegments.length === 0) {
        console.warn('[CVM] перехваченный оригинал пуст — кэш не записан');
        return;
      }
      const translationSegments = await fetchTranslation(data.capturedUrl, targetLanguage);

      const store: CacheStoreMessage = {
        type: 'cache-store',
        ...baseStore,
        original: originalSegments,
        language: targetLanguage,
        translation: translationSegments,
      };
      await browser.runtime.sendMessage(store);
      console.info(
        `[CVM] закэшировано: оригинал ${originalSegments.length} / автоперевод "${targetLanguage}" ${translationSegments.length} сегм.`,
      );
    }

    function render(): void {
      if (button === null) {
        return;
      }
      button.textContent = active ? WIDGET_LABEL_STOP : WIDGET_LABEL_START;
      button.dataset.active = String(active);
    }

    function resetActive(): void {
      // Новое видео / SPA-навигация — состояние перевода начинается заново.
      if (!active) {
        return;
      }
      active = false;
      render();
      reportActive();
    }

    // Защита от наложения: гоняем пайплайн по одному; если за время работы
    // пришёл новый триггер (смена языка), перезапускаем по завершении с
    // актуальными настройками.
    let pipelineInFlight = false;
    let rerunRequested = false;

    async function runPipelineGuarded(): Promise<void> {
      if (pipelineInFlight) {
        rerunRequested = true;
        return;
      }
      pipelineInFlight = true;
      try {
        do {
          rerunRequested = false;
          await runPipeline();
        } while (rerunRequested);
      } catch (error: unknown) {
        console.error('[CVM] извлечение субтитров не удалось', error);
      } finally {
        pipelineInFlight = false;
      }
    }

    function toggle(): void {
      active = !active;
      render();
      reportActive();
      if (active) {
        void runPipelineGuarded();
      }
    }

    // Триггер при смене настроек: пока виджет включён, до-кэшируем новый язык
    // автоматически (без передёргивания кнопки). Срабатывает на смену целевого
    // языка и на включение «Использовать автоперевод».
    function onSettingsChanged(): void {
      if (active) {
        void runPipelineGuarded();
      }
    }
    settings.targetLanguage.watch(onSettingsChanged);
    settings.useYoutubeTranslation.watch(onSettingsChanged);

    // Автозапуск: при открытии страницы/смене видео виджет сам переходит
    // в состояние «включено» и запускает пайплайн (если флаг включён).
    async function applyAutoStart(): Promise<void> {
      if (active || !isWatchPage()) {
        return;
      }
      if (!(await settings.autoStart.getValue())) {
        return;
      }
      active = true;
      render();
      reportActive();
      void runPipelineGuarded();
    }

    function createWidget(): HTMLElement {
      const host = document.createElement('div');
      host.id = WIDGET_HOST_ID;
      host.style.cssText = 'position:absolute;top:12px;right:12px;z-index:1000;';

      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = WIDGET_STYLES;

      const btn = document.createElement('button');
      btn.className = 'cvm-toggle';
      btn.addEventListener('click', toggle);

      shadow.append(style, btn);
      button = btn;
      render();
      return host;
    }

    function removeWidget(): void {
      document.getElementById(WIDGET_HOST_ID)?.remove();
      button = null;
    }

    function isWatchPage(): boolean {
      return location.pathname === '/watch';
    }

    function mount(): void {
      if (!isWatchPage()) {
        removeWidget();
        return;
      }
      const player = document.querySelector(PLAYER_SELECTOR);
      if (player === null) {
        return; // плеер ещё не готов — попробуем на следующем тике
      }
      if (player.querySelector(`#${WIDGET_HOST_ID}`) !== null) {
        return; // уже смонтирован
      }
      player.append(createWidget());
    }

    mount();
    reportActive(); // синхронизируем начальное состояние с background
    void applyAutoStart();
    ctx.setInterval(mount, WIDGET_MOUNT_POLL_MS);
    ctx.addEventListener(document, YT_NAVIGATE_EVENT, () => {
      resetActive();
      mount();
      void applyAutoStart();
    });

    console.info('[CVM] content (isolated) loaded');
  },
});
