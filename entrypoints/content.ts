import { defineContentScript, browser } from '#imports';
import { settings } from '@/lib/storage';
import { costSamples, computeStats } from '@/lib/calibration';
import { createTtsEngine, ensureVoicesLoaded } from '@/lib/tts';
import type { CaptionSegment, TtsEngineName } from '@/lib/types';
import type {
  BackgroundMessage,
  BridgeMessage,
  BridgeExtractionDataMessage,
  CacheLookupMessage,
  CacheLookupResponse,
  CacheStoreMessage,
  ApiTranslateMessage,
  ApiTranslateResponse,
  GetTranslationMessage,
  GetTranslationResponse,
  TranslationSource,
  TabMessage,
} from '@/lib/messaging';
import {
  YOUTUBE_MATCHES,
  WIDGET_HOST_ID,
  PLAYER_SELECTOR,
  WIDGET_MOUNT_POLL_MS,
  WIDGET_LABEL_START,
  WIDGET_LABEL_STOP,
  WIDGET_LABEL_TRANSLATING,
  WIDGET_COST_PREFIX,
  WIDGET_COST_NO_DATA,
  SUBS_HOST_ID,
  SUBS_RATE_PREFIX,
  DEFAULT_SUBTITLES_ENABLED,
  API_MODEL,
  BRIDGE_MESSAGE_SOURCE,
  TIMEDTEXT_FORMAT,
  TIMEDTEXT_FORMAT_PARAM,
  TIMEDTEXT_TLANG_PARAM,
  EXTRACTION_REQUEST_TIMEOUT_MS,
  VIDEO_WATCH_URL,
  TTS_BASELINE_CPS,
  TTS_MIN_BUDGET_MS,
  TTS_PREFETCH_AHEAD,
  DEFAULT_TTS_MIN_RATE,
  DEFAULT_TTS_MAX_RATE,
  DEFAULT_TTS_OFFSET_MS,
  DEFAULT_TTS_ENGINE,
  DEFAULT_SELECTED_VOICE_EDGE,
  DEFAULT_SUBS_POSITION_PCT,
  EDGE_VOICE_CATALOG,
  VIDEO_SELECTOR,
  DUCK_RESTORE_MS,
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
  .cvm-cost {
    margin-top: 6px;
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 12px;
    color: #fff;
    background: rgba(0, 0, 0, 0.6);
    border-radius: 6px;
    padding: 4px 8px;
    text-align: center;
    white-space: nowrap;
  }
  .cvm-cost[hidden] {
    display: none;
  }
`;

// Караоке-субтитры: три строки внизу плеера. Текущая — ярко, соседние — тускло.
// Слева от текущей строки — множитель темпа TTS.
const SUBS_STYLES = `
  .cvm-subs {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: 84%;
    max-width: 980px;
    pointer-events: none;
    font-family: 'Segoe UI', system-ui, sans-serif;
    text-align: center;
  }
  .cvm-subs[hidden] {
    display: none;
  }
  .cvm-sub:empty {
    display: none;
  }
  .cvm-sub-prev,
  .cvm-sub-next {
    font-size: 18px;
    color: rgba(255, 255, 255, 0.5);
    background: rgba(0, 0, 0, 0.4);
    border-radius: 6px;
    padding: 1px 8px;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  }
  .cvm-sub-cur {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    max-width: 100%;
  }
  .cvm-sub-cur-text {
    font-size: 26px;
    font-weight: 700;
    color: #fff;
    background: rgba(0, 0, 0, 0.58);
    border-radius: 8px;
    padding: 2px 12px;
    text-shadow: 0 2px 6px rgba(0, 0, 0, 0.95);
  }
  .cvm-sub-rate {
    font-size: 16px;
    font-weight: 700;
    color: #fff;
    background: rgba(124, 58, 237, 0.95);
    border-radius: 6px;
    padding: 2px 8px;
    white-space: nowrap;
    flex: none;
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
    let currentVideoId: string | null = null; // видео текущего пайплайна (для индикатора)
    let progressText: string | null = null; // подпись прогресса перевода или null

    // --- Показ примерной стоимости в виджете (Стадия 3.4) ---
    let costEl: HTMLElement | null = null;
    let showCost = false; // флаг из настроек
    let dollarsPerChar = 0; // R из калибровки (0 — нет данных)
    let currentOriginalChars: number | null = null; // символы оригинала текущего видео

    function formatMoney(value: number): string {
      return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
    }

    // Перерисовать строку стоимости: точные символы оригинала × R.
    function renderCost(): void {
      if (costEl === null) {
        return;
      }
      if (!showCost || currentOriginalChars === null) {
        costEl.hidden = true; // флаг выключен или символы ещё неизвестны
        return;
      }
      costEl.hidden = false;
      if (dollarsPerChar > 0) {
        costEl.textContent = WIDGET_COST_PREFIX + formatMoney(currentOriginalChars * dollarsPerChar);
      } else {
        costEl.textContent = WIDGET_COST_NO_DATA; // нет калибровки
      }
    }

    // =====================================================================
    // Озвучка перевода (TTS, Стадия 4) + приглушение оригинала
    // =====================================================================
    const tts = createTtsEngine();
    let ttsSegments: CaptionSegment[] = []; // озвучиваемые реплики (по таймингу), отсортированы
    let ttsIndex = 0; // индекс следующей реплики на озвучку
    let ttsSpeaking = false; // реплика сейчас звучит/в очереди движка
    let ttsLang = ''; // целевой язык (для подбора голоса/произношения)
    let ttsEngine: TtsEngineName = DEFAULT_TTS_ENGINE; // выбранный движок (живо из настроек)
    let ttsVoiceName = ''; // голос Web Speech ('' — авто-подбор по языку)
    let edgeVoiceName = DEFAULT_SELECTED_VOICE_EDGE; // голос Edge ('' — дефолт языка из каталога)
    let ttsVolume = 1; // громкость TTS 0..1
    let ttsMinRate = DEFAULT_TTS_MIN_RATE; // нижняя граница темпа (живо из cvm_tts_min_rate)
    let ttsMaxRate = DEFAULT_TTS_MAX_RATE; // верхняя граница темпа (живо из cvm_tts_max_rate)
    let ttsOffsetMs = DEFAULT_TTS_OFFSET_MS; // сдвиг озвучки/субтитров относительно видео (живо)
    let ttsSession = 0; // счётчик сессий озвучки — префикс cacheId, чтобы префетч не путал видео
    const plannedRate = new Map<number, number>(); // rate по индексу: один и тот же для prefetch и speak
    let videoEl: HTMLVideoElement | null = null; // основной <video> плеера
    let ttsListenersAttached = false; // слушатели событий видео навешаны
    let ttsGen = 0; // поколение озвучки: смена инвалидирует коллбэки прерванной реплики

    // Приглушение оригинала на время речи (ducking).
    let duckAmount = 0; // доля приглушения 0..MAX_VIDEO_DUCKING
    let duckBaseVolume: number | null = null; // громкость до приглушения (null — не приглушено)
    let restoreRaf = 0; // id анимации восстановления громкости

    // Караоке-субтитры (оверлей плеера).
    let subtitlesEnabled = DEFAULT_SUBTITLES_ENABLED;
    let subsPositionPct = DEFAULT_SUBS_POSITION_PCT; // вертикальное положение на экране (живо)
    let subsBox: HTMLElement | null = null; // контейнер трёх строк (показ/скрытие через .hidden)
    let subPrevEl: HTMLElement | null = null; // предыдущая строка (тускло)
    let subCurTextEl: HTMLElement | null = null; // текущая строка (ярко)
    let subRateEl: HTMLElement | null = null; // множитель темпа TTS слева от текущей
    let subNextEl: HTMLElement | null = null; // следующая строка (тускло)

    function findVideo(): HTMLVideoElement | null {
      return (
        document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR) ??
        document.querySelector<HTMLVideoElement>('video')
      );
    }

    // Конец окна показа реплики (мс видео): старт следующей реплики, а для последней —
    // её собственный конец. Это и есть реальная «каденция» субтитров (не путать с duration:
    // соседние реплики часто идут вплотную или внахлёст).
    function windowEndMs(index: number): number {
      const next = ttsSegments[index + 1];
      if (next !== undefined) {
        return next.start;
      }
      const seg = ttsSegments[index];
      return seg !== undefined ? seg.start + seg.duration : 0;
    }

    // Оценка длительности проговаривания текста на нормальном темпе (rate 1.0).
    function speechEstimateMs(text: string): number {
      return (text.length / TTS_BASELINE_CPS) * 1000;
    }

    // Темп реплики от РЕАЛЬНОГО бюджета: время до старта следующей реплики минус уже
    // накопленное отставание (windowEnd − now). Отстаём → бюджет меньше → темп выше → догоняем.
    // playbackRate учитываем: на ускоренном видео реальный бюджет короче во столько же раз.
    function rateFor(index: number, nowMs: number): number {
      const seg = ttsSegments[index];
      if (seg === undefined) {
        return ttsMinRate;
      }
      const playback = videoEl?.playbackRate ?? 1;
      const budgetMs = Math.max(TTS_MIN_BUDGET_MS, windowEndMs(index) - nowMs);
      const rate = (speechEstimateMs(seg.text) / budgetMs) * playback;
      // Зажимаем в пользовательский диапазон [min..max], оба масштабируются скоростью видео.
      const min = ttsMinRate * playback;
      const max = ttsMaxRate * playback;
      return Math.min(max, Math.max(min, rate));
    }

    // Время видео для синхронизации с учётом пользовательского сдвига (+ раньше / − позже).
    function videoNowMs(): number {
      return (videoEl !== null ? videoEl.currentTime * 1000 : 0) + ttsOffsetMs;
    }

    // Имя голоса для текущего движка: Web Speech → ttsVoiceName; Edge → выбранный из каталога,
    // если он валиден для целевого языка, иначе '' (движок подберёт дефолт языка).
    function currentVoiceName(): string {
      if (ttsEngine !== 'edge') {
        return ttsVoiceName;
      }
      const list = EDGE_VOICE_CATALOG[baseLanguage(ttsLang)] ?? [];
      return edgeVoiceName !== '' && list.some((v) => v.id === edgeVoiceName) ? edgeVoiceName : '';
    }

    // ЗАПЕЧЁННЫЙ темп реплики: считается один раз (при первом префетче) на реальный момент времени
    // и кэшируется по индексу — чтобы префетч и воспроизведение синтезировали ОДНО аудио (Edge
    // вшивает темп в MP3, изменить на лету нельзя). Это лишь baseline; точную подстройку под
    // отставание делает ЖИВАЯ коррекция в момент старта реплики (см. speakSegment / speedAdjustFor).
    function planRate(index: number): number {
      const cached = plannedRate.get(index);
      if (cached !== undefined) {
        return cached;
      }
      const seg = ttsSegments[index];
      const rate = seg === undefined ? ttsMinRate : rateFor(index, videoNowMs());
      plannedRate.set(index, rate);
      return rate;
    }

    // Живая коррекция темпа в момент старта реплики: во сколько раз ускорить/замедлить уже
    // синтезированное аудио, чтобы попасть в РЕАЛЬНЫЙ бюджет (с учётом накопленного отставания).
    // Запечённый темп оптимистичен (считался заранее, до того как отставание проявилось), поэтому
    // именно эта коррекция реально догоняет видео. Применяется поверх запечённого rate.
    function speedAdjustFor(index: number): number {
      const baked = planRate(index);
      if (baked <= 0) {
        return 1;
      }
      const live = rateFor(index, videoNowMs());
      return live / baked;
    }

    // Заранее синтезировать реплику (пока играет текущая) — убирает сетевую паузу перед ней.
    function prefetchSegment(index: number): void {
      const seg = ttsSegments[index];
      if (seg === undefined) {
        return;
      }
      tts.prefetch({
        text: seg.text,
        voiceName: currentVoiceName(),
        lang: ttsLang,
        volume: ttsVolume,
        rate: planRate(index),
        cacheId: `${ttsSession}:${index}`,
      });
    }

    // Приглушить оригинал (мгновенно). Базовую громкость запоминаем один раз на серию реплик.
    function duckVideo(): void {
      const video = videoEl;
      if (video === null) {
        return;
      }
      cancelAnimationFrame(restoreRaf);
      if (duckBaseVolume === null) {
        duckBaseVolume = video.volume;
      }
      video.volume = duckBaseVolume * (1 - duckAmount);
    }

    // Плавно вернуть громкость оригинала за DUCK_RESTORE_MS.
    function restoreVideo(): void {
      const video = videoEl;
      if (video === null || duckBaseVolume === null) {
        duckBaseVolume = null;
        return;
      }
      const target = video; // non-null захват для замыкания step
      const base = duckBaseVolume;
      const from = target.volume;
      const startedAt = performance.now();
      cancelAnimationFrame(restoreRaf);
      function step(now: number): void {
        const t = Math.min(1, (now - startedAt) / DUCK_RESTORE_MS);
        target.volume = from + (base - from) * t;
        if (t < 1) {
          restoreRaf = requestAnimationFrame(step);
        } else {
          duckBaseVolume = null; // серия реплик закончилась — следующий duck перечитает базу
        }
      }
      restoreRaf = requestAnimationFrame(step);
    }

    function hideSubs(): void {
      if (subsBox !== null) {
        subsBox.hidden = true;
      }
    }

    // Физическое вертикальное положение субтитров на экране (0 — верх, 100 — низ).
    function applySubsPosition(): void {
      if (subsBox !== null) {
        subsBox.style.top = `${subsPositionPct}%`;
      }
    }

    // Обновить караоке: предыдущая/текущая/следующая строки + множитель темпа текущей.
    function updateSubs(index: number, rate: number): void {
      const box = subsBox;
      const prevEl = subPrevEl;
      const curEl = subCurTextEl;
      const rateEl = subRateEl;
      const nextEl = subNextEl;
      if (box === null || prevEl === null || curEl === null || rateEl === null || nextEl === null) {
        return;
      }
      if (!subtitlesEnabled) {
        box.hidden = true;
        return;
      }
      prevEl.textContent = ttsSegments[index - 1]?.text ?? '';
      curEl.textContent = ttsSegments[index]?.text ?? '';
      nextEl.textContent = ttsSegments[index + 1]?.text ?? '';
      rateEl.textContent = SUBS_RATE_PREFIX + rate.toFixed(1);
      box.hidden = false;
    }

    function speakSegment(): void {
      const index = ttsIndex;
      const segment = ttsSegments[index];
      if (segment === undefined) {
        return;
      }
      ttsSpeaking = true;
      const gen = ttsGen; // зафиксировано на момент запуска реплики
      const rate = planRate(index); // запечённый в синтез baseline (для совпадения с префетчем)
      const speedAdjust = speedAdjustFor(index); // живая подстройка под реальное отставание
      updateSubs(index, rate * speedAdjust); // в караоке — РЕАЛЬНЫЙ темп воспроизведения
      tts.speak({
        text: segment.text,
        voiceName: currentVoiceName(),
        lang: ttsLang,
        volume: ttsVolume,
        rate,
        speedAdjust,
        cacheId: `${ttsSession}:${index}`,
        onStart: () => {
          if (gen !== ttsGen) {
            return; // реплика уже неактуальна (перемотка/пауза прервали её)
          }
          duckVideo();
        },
        onEnd: () => {
          if (gen !== ttsGen) {
            return; // прервана — индекс/громкость обработаны управляющим путём (seek/pause)
          }
          ttsSpeaking = false;
          ttsIndex = index + 1;
          restoreVideo();
          // Сразу пробуем следующую реплику, не дожидаясь timeupdate (она уже префетчнута).
          onTtsTick();
        },
      });
      // Пока играет текущая — заранее синтезируем несколько реплик вперёд: на плотной речи один
      // запрос наперёд не успевает спрятать сетевой RTT, поэтому держим запас (TTS_PREFETCH_AHEAD).
      for (let ahead = 1; ahead <= TTS_PREFETCH_AHEAD; ahead += 1) {
        prefetchSegment(index + ahead);
      }
    }

    // Тик синхронизации: на каждый timeupdate проверяем, не пора ли озвучить реплику.
    function onTtsTick(): void {
      const video = videoEl;
      if (video === null || video.paused) {
        return;
      }
      if (ttsSpeaking || tts.isSpeaking()) {
        return; // ждём окончания текущей реплики (без наложения голосов)
      }
      // Реплики НЕ пропускаем: строго последовательно. Перемотка вперёд — отдельно (onSeeked).
      const segment = ttsSegments[ttsIndex];
      if (segment === undefined) {
        return; // реплики кончились или озвучка не запущена
      }
      if (videoNowMs() >= segment.start) {
        speakSegment();
      }
    }

    // Индекс реплики под момент времени: первая, ещё не ушедшая целиком в прошлое
    // (активная сейчас или предстоящая). Для старта и пересчёта после перемотки.
    function indexForTime(nowMs: number): number {
      const idx = ttsSegments.findIndex((segment) => segment.start + segment.duration > nowMs);
      return idx < 0 ? ttsSegments.length : idx;
    }

    // Немедленно вернуть громкость оригинала (без анимации — это разрыв, не конец реплики).
    function unduckInstant(): void {
      if (videoEl !== null && duckBaseVolume !== null) {
        cancelAnimationFrame(restoreRaf);
        videoEl.volume = duckBaseVolume;
        duckBaseVolume = null;
      }
    }

    // Прервать текущую реплику, не трогая список/индекс (для seek/pause). Смена поколения
    // глушит onStart/onEnd прерванной реплики, чтобы они не сбили индекс и приглушение.
    function cancelSpeech(): void {
      ttsGen += 1;
      tts.cancel();
      ttsSpeaking = false;
    }

    // Перемотка: текущая реплика относится к старой позиции — прерываем, снимаем
    // приглушение и пересчитываем индекс под новое время. timeupdate подхватит дальше.
    function onSeeked(): void {
      cancelSpeech();
      unduckInstant();
      ttsIndex = indexForTime(videoNowMs());
      onTtsTick();
    }

    // Пауза видео: ЗАМОРАЖИВАЕМ реплику на месте (не обрываем) — на паузе видео без звука,
    // а на возобновлении речь продолжится с того же места, без перечитывания строки заново
    // (иначе пока перечитываем услышанное, видео уходит вперёд и копится отставание).
    function onPauseVideo(): void {
      tts.pause();
    }

    // Возобновление: продолжаем замороженную реплику; если ничего не звучало — стартуем актуальную.
    function onPlayVideo(): void {
      tts.resume();
      onTtsTick();
    }

    function attachVideoListeners(): void {
      if (ttsListenersAttached) {
        return;
      }
      const video = videoEl ?? findVideo();
      if (video === null) {
        return; // плеер ещё не готов — навесим при следующем запуске
      }
      videoEl = video;
      ctx.addEventListener(video, 'timeupdate', onTtsTick);
      ctx.addEventListener(video, 'seeked', onSeeked);
      ctx.addEventListener(video, 'pause', onPauseVideo);
      ctx.addEventListener(video, 'play', onPlayVideo);
      // ratechange отдельного слушателя не требует: rateForSegment читает playbackRate
      // на каждой реплике, так что новая скорость применяется со следующей реплики.
      ttsListenersAttached = true;
    }

    function stopTts(): void {
      cancelSpeech();
      tts.clearCache();
      plannedRate.clear();
      ttsSession += 1; // новая сессия — старые префетчи по cacheId не переиспользуются
      ttsSegments = [];
      ttsIndex = 0;
      unduckInstant();
      hideSubs();
    }

    // Забрать готовый перевод из кэша и запустить озвучку текущего видео.
    async function startTts(videoId: string): Promise<void> {
      stopTts(); // идемпотентный перезапуск (смена языка/настроек)
      if (!(await settings.ttsEnabled.getValue())) {
        return;
      }
      const targetLanguage = await settings.targetLanguage.getValue();
      const useYoutube = await settings.useYoutubeTranslation.getValue();
      const source: TranslationSource = useYoutube ? 'youtube' : 'api';
      const request: GetTranslationMessage = {
        type: 'get-translation',
        videoId,
        language: targetLanguage,
        source,
      };
      const response = (await browser.runtime.sendMessage(request)) as
        | GetTranslationResponse
        | undefined;
      const segments = response?.segments ?? null;
      if (segments === null || segments.length === 0) {
        console.info('[CVM] озвучивать нечего: перевода на язык в кэше нет');
        return;
      }
      await ensureVoicesLoaded();
      ttsLang = targetLanguage;
      ttsEngine = await settings.ttsEngine.getValue();
      ttsVoiceName = await settings.selectedVoice.getValue();
      edgeVoiceName = await settings.selectedVoiceEdge.getValue();
      ttsVolume = await settings.translationVolume.getValue();
      duckAmount = await settings.videoDucking.getValue();
      tts.setEngine(ttsEngine);
      ttsSegments = [...segments].sort((a, b) => a.start - b.start);
      // Старт с реплики под текущее время (не переигрываем то, что уже позади).
      videoEl = findVideo();
      ttsIndex = indexForTime(videoNowMs());
      attachVideoListeners();
      console.info(
        `[CVM] TTS запущен: ${ttsSegments.length} реплик, движок "${ttsEngine}", голос "${currentVoiceName() || '(авто)'}"`,
      );
    }

    function reportActive(): void {
      const message: BackgroundMessage = { type: 'set-translation-active', active };
      void browser.runtime.sendMessage(message).catch(() => {
        // background мог быть усыплён — состояние синхронизируется при следующем сообщении.
      });
    }

    // Перевод оригинала через Claude API (если задан ключ и язык ≠ оригинала).
    async function maybeTranslateViaApi(
      videoId: string,
      originalLanguage: string,
      targetLanguage: string,
      original: CaptionSegment[],
      hasApiTranslation: boolean,
    ): Promise<void> {
      if (baseLanguage(originalLanguage) === baseLanguage(targetLanguage)) {
        console.info(
          `[CVM] целевой язык совпадает с оригиналом (${originalLanguage}) — перевод API не нужен`,
        );
        return;
      }
      if (hasApiTranslation) {
        console.info(`[CVM] перевод API "${targetLanguage}" уже в кэше — пропуск`);
        return;
      }
      const apiKey = await settings.apiKey.getValue();
      if (apiKey.trim() === '') {
        console.warn('[CVM] API-ключ не задан — перевод через API пропущен (укажи ключ в popup)');
        return;
      }
      const request: ApiTranslateMessage = {
        type: 'api-translate',
        videoId,
        language: targetLanguage,
        original,
      };
      const response = (await browser.runtime.sendMessage(request)) as
        | ApiTranslateResponse
        | undefined;
      if (response?.ok === true) {
        console.info(`[CVM] перевод API "${targetLanguage}" готов и закэширован`);
      } else {
        console.warn(`[CVM] перевод API не выполнен: ${response?.error ?? 'нет ответа'}`);
      }
    }

    // Извлечь и закэшировать тексты текущего видео (если ещё не в кэше).
    async function runPipeline(): Promise<void> {
      const targetLanguage = await settings.targetLanguage.getValue();
      const useYoutubeTranslation = await settings.useYoutubeTranslation.getValue();

      // Быстрый путь для уже обработанных видео: если нужный перевод есть в кэше — извлечение
      // не требуется. Критично для перезагрузки/кэшированных видео: плеер может отдавать
      // субтитры из своего кэша БЕЗ сетевого запроса, и перехватывать будет нечего.
      const urlVideoId = new URLSearchParams(location.search).get('v');
      if (urlVideoId !== null) {
        const cachedLookup: CacheLookupMessage = {
          type: 'cache-lookup',
          videoId: urlVideoId,
          language: targetLanguage,
        };
        const cached = (await browser.runtime.sendMessage(cachedLookup)) as
          | CacheLookupResponse
          | undefined;
        const haveNeeded = useYoutubeTranslation
          ? cached?.hasTranslation === true
          : cached?.hasApiTranslation === true;
        if (haveNeeded) {
          currentVideoId = urlVideoId;
          console.info('[CVM] перевод уже в кэше — извлечение пропущено, старт озвучки');
          return; // startTts подхватит готовый перевод из кэша
        }
      }

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
      currentVideoId = data.videoId;
      const originalLanguage = data.originalLanguage ?? 'unknown';

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

      // Режим «Использовать автоперевод» выключен — оригинал + перевод Claude API.
      if (!useYoutubeTranslation) {
        const originalSegments = parseSegments(data.capturedBody);
        if (originalSegments.length === 0) {
          console.warn('[CVM] перехваченный оригинал пуст — кэш не записан');
          return;
        }
        // Точные символы оригинала известны — обновляем строку стоимости в виджете.
        currentOriginalChars = originalSegments.reduce(
          (sum, segment) => sum + segment.text.length,
          0,
        );
        renderCost();
        // Оригинал кэшируем один раз (если записи ещё нет).
        if (lookupResponse?.entryExists !== true) {
          const store: CacheStoreMessage = {
            type: 'cache-store',
            ...baseStore,
            original: originalSegments,
          };
          await browser.runtime.sendMessage(store);
          console.info(`[CVM] закэширован оригинал: ${originalSegments.length} сегм.`);
        }
        await maybeTranslateViaApi(
          data.videoId,
          originalLanguage,
          targetLanguage,
          originalSegments,
          lookupResponse?.hasApiTranslation === true,
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
      // Пока идёт перевод — показываем индикатор N/M вместо «Выключить перевод».
      button.textContent = active
        ? (progressText ?? WIDGET_LABEL_STOP)
        : WIDGET_LABEL_START;
      button.dataset.active = String(active);
    }

    // Прогресс перевода из background: обновляем подпись кнопки активного видео.
    function onTabMessage(message: TabMessage): void {
      if (message.type !== 'translation-progress') {
        return;
      }
      if (!active || message.videoId !== currentVideoId) {
        return;
      }
      const inProgress = message.status === 'translating' && message.done < message.total;
      progressText = inProgress
        ? `${WIDGET_LABEL_TRANSLATING}… ${message.done}/${message.total}`
        : null;
      render();
    }
    browser.runtime.onMessage.addListener((raw: unknown) => {
      onTabMessage(raw as TabMessage);
    });

    function resetActive(): void {
      // Новое видео / SPA-навигация — стоимость прежнего видео больше не актуальна.
      currentOriginalChars = null;
      renderCost();
      // Озвучка прежнего видео больше не нужна (тайминги другого ролика).
      stopTts();
      // Состояние перевода начинается заново.
      if (!active) {
        return;
      }
      active = false;
      progressText = null;
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
        // Перевод готов и в кэше — запускаем озвучку текущего видео.
        if (active && currentVideoId !== null) {
          await startTts(currentVideoId);
        }
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
      } else {
        stopTts();
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

    // Стоимость в виджете: подтягиваем флаг и калибровку, живо обновляем при смене.
    function refreshDollarsPerChar(samples: Parameters<typeof computeStats>[0]): void {
      dollarsPerChar = computeStats(samples, API_MODEL).dollarsPerChar;
      renderCost();
    }
    void settings.showCost.getValue().then((value) => {
      showCost = value;
      renderCost();
    });
    void costSamples.getValue().then(refreshDollarsPerChar);
    settings.showCost.watch((value) => {
      showCost = value;
      renderCost();
    });
    costSamples.watch(refreshDollarsPerChar);

    // Караоке-субтитры: флаг из настроек, живое скрытие при выключении.
    void settings.subtitlesEnabled.getValue().then((value) => {
      subtitlesEnabled = value;
      if (!value) {
        hideSubs();
      }
    });
    settings.subtitlesEnabled.watch((value) => {
      subtitlesEnabled = value;
      if (!value) {
        hideSubs();
      }
    });

    // Смена диапазона скорости делает посчитанные/префетчнутые рейты неактуальными — сбрасываем,
    // чтобы следующие реплики синтезировались с новым темпом.
    function invalidateRates(): void {
      plannedRate.clear();
      tts.clearCache();
    }

    // Диапазон скорости TTS из Inspector — живо применяется к следующим репликам.
    void settings.ttsMinRate.getValue().then((value) => {
      ttsMinRate = value;
    });
    settings.ttsMinRate.watch((value) => {
      ttsMinRate = value;
      invalidateRates();
    });
    void settings.ttsMaxRate.getValue().then((value) => {
      ttsMaxRate = value;
    });
    settings.ttsMaxRate.watch((value) => {
      ttsMaxRate = value;
      invalidateRates();
    });

    // Сдвиг времени озвучки/субтитров относительно видео (инструмент подгонки синхрона).
    void settings.ttsOffsetMs.getValue().then((value) => {
      ttsOffsetMs = value;
    });
    settings.ttsOffsetMs.watch((value) => {
      ttsOffsetMs = value;
    });

    // Движок озвучки: переключение на лету (popup). Сбрасываем кэш — новый движок/голос.
    void settings.ttsEngine.getValue().then((value) => {
      ttsEngine = value;
      tts.setEngine(value);
    });
    settings.ttsEngine.watch((value) => {
      ttsEngine = value;
      tts.setEngine(value);
      invalidateRates();
    });

    // Выбор голоса (отдельно для Web Speech и Edge) — смена сбрасывает префетч-кэш.
    void settings.selectedVoice.getValue().then((value) => {
      ttsVoiceName = value;
    });
    settings.selectedVoice.watch((value) => {
      ttsVoiceName = value;
      invalidateRates();
    });
    void settings.selectedVoiceEdge.getValue().then((value) => {
      edgeVoiceName = value;
    });
    settings.selectedVoiceEdge.watch((value) => {
      edgeVoiceName = value;
      invalidateRates();
    });

    // Физическое положение субтитров на экране (живо).
    void settings.subsPositionPct.getValue().then((value) => {
      subsPositionPct = value;
      applySubsPosition();
    });
    settings.subsPositionPct.watch((value) => {
      subsPositionPct = value;
      applySubsPosition();
    });

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

      const cost = document.createElement('div');
      cost.className = 'cvm-cost';
      cost.hidden = true;

      shadow.append(style, btn, cost);
      button = btn;
      costEl = cost;
      render();
      renderCost();
      return host;
    }

    function createSubs(): HTMLElement {
      const host = document.createElement('div');
      host.id = SUBS_HOST_ID;
      // На всю площадь плеера (inset:0), поверх него, без перехвата кликов (контролы под нами
      // кликабельны). Полная высота нужна, чтобы top:50% у .cvm-subs давал реальный центр.
      host.style.cssText = 'position:absolute;inset:0;z-index:1000;pointer-events:none;';

      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = SUBS_STYLES;

      const box = document.createElement('div');
      box.className = 'cvm-subs';
      box.hidden = true;

      const prev = document.createElement('div');
      prev.className = 'cvm-sub cvm-sub-prev';

      const cur = document.createElement('div');
      cur.className = 'cvm-sub cvm-sub-cur';
      const rate = document.createElement('span');
      rate.className = 'cvm-sub-rate';
      const curText = document.createElement('span');
      curText.className = 'cvm-sub-cur-text';
      cur.append(rate, curText);

      const next = document.createElement('div');
      next.className = 'cvm-sub cvm-sub-next';

      box.append(prev, cur, next);
      shadow.append(style, box);

      subsBox = box;
      subPrevEl = prev;
      subCurTextEl = curText;
      subRateEl = rate;
      subNextEl = next;
      applySubsPosition(); // вертикальное положение из настроек
      return host;
    }

    function removeWidget(): void {
      document.getElementById(WIDGET_HOST_ID)?.remove();
      document.getElementById(SUBS_HOST_ID)?.remove();
      button = null;
      costEl = null;
      subsBox = null;
      subPrevEl = null;
      subCurTextEl = null;
      subRateEl = null;
      subNextEl = null;
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
      if (player.querySelector(`#${WIDGET_HOST_ID}`) === null) {
        player.append(createWidget());
      }
      if (player.querySelector(`#${SUBS_HOST_ID}`) === null) {
        player.append(createSubs());
      }
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
