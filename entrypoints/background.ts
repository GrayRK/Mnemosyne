import { defineBackground, browser } from '#imports';
import { settings } from '@/lib/storage';
import {
  INSPECTOR_PORT_NAME,
  API_ENDPOINT,
  API_MODEL,
  API_ANTHROPIC_VERSION,
  API_MAX_TOKENS,
  API_BATCH_SIZE,
  API_BATCH_CONCURRENCY,
  API_RETRY_COUNT,
  API_BATCH_TIMEOUT_MS,
  API_TIMEOUT_RETRY_COUNT,
  API_RATE_LIMIT_RETRY_COUNT,
  API_BACKOFF_BASE_MS,
  API_BACKOFF_MAX_MS,
  API_BACKOFF_JITTER_MS,
  MEDIAN_MIN_SAMPLES,
  TIMEOUT_LATENCY_FACTOR,
  TIMEOUT_POLL_MS,
  API_SYSTEM_PROMPT_TEMPLATE,
  LANGUAGE_NAMES,
} from '@/lib/constants';
import {
  getEntry,
  upsertEntry,
  upsertApiTranslation,
  setApiCost,
  listMeta,
  clearAll,
} from '@/lib/cache';
import { addCostSample } from '@/lib/calibration';
import { synthesize, audioToBase64 } from '@/lib/edge-tts';
import type {
  CvmRuntimeState,
  TabRuntimeState,
  CaptionSegment,
  TranslationProgress,
  TranslationStatus,
  ApiTranslationMeta,
} from '@/lib/types';
import type {
  InspectorMessage,
  InspectorControlMessage,
  BackgroundMessage,
  CacheLookupResponse,
  CacheStoreResponse,
  ApiTranslateMessage,
  ApiTranslateResponse,
  RecordApiCostMessage,
  RecordApiCostResponse,
  GetTranslationMessage,
  GetTranslationResponse,
  TtsSynthMessage,
  TtsSynthResponse,
  TabMessage,
} from '@/lib/messaging';

// Тип порта выводим из слушателя, чтобы не зависеть от имён неймспейсов WXT.
type RuntimePort = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

export default defineBackground(() => {
  // Рантайм-состояние per-tab (не сохраняется). Ключ — tabId; у каждой вкладки своё
  // состояние перевода (Стадия 3.4). Очистка — по browser.tabs.onRemoved.
  const runtimeStates = new Map<number, CvmRuntimeState>();

  function getTabState(tabId: number): CvmRuntimeState {
    let state = runtimeStates.get(tabId);
    if (state === undefined) {
      state = {
        currentVideoId: null,
        translationStatus: 'ready',
        translationActive: false,
        translationProgress: null,
      };
      runtimeStates.set(tabId, state);
    }
    return state;
  }

  function buildRuntimeMessage(): InspectorMessage {
    const tabs: TabRuntimeState[] = [...runtimeStates.entries()].map(([tabId, state]) => ({
      tabId,
      ...state,
    }));
    return { type: 'runtime-state', tabs };
  }

  // Подключённые страницы Inspector — реестр для рассылки обновлений.
  const inspectorPorts = new Set<RuntimePort>();

  function broadcastRuntimeState(): void {
    const message = buildRuntimeMessage();
    for (const port of inspectorPorts) {
      port.postMessage(message);
    }
  }

  // Разослать актуальный список кэша всем открытым Inspector.
  async function broadcastCacheList(): Promise<void> {
    const message: InspectorMessage = { type: 'cache-list', items: await listMeta() };
    for (const port of inspectorPorts) {
      port.postMessage(message);
    }
  }

  // =====================================================================
  // Перевод через Claude API (Стадия 3)
  // =====================================================================

  // Обновить рантайм-состояние перевода: рассылка Inspector + кнопке виджета.
  function setTranslationRuntime(
    videoId: string | null,
    status: TranslationStatus,
    progress: TranslationProgress | null,
    tabId: number | null,
  ): void {
    if (tabId === null) {
      return; // без вкладки состояние не атрибутировать (per-tab)
    }
    const state = getTabState(tabId);
    state.currentVideoId = videoId;
    state.translationStatus = status;
    state.translationProgress = progress;
    broadcastRuntimeState();
    if (videoId !== null) {
      const message: TabMessage = {
        type: 'translation-progress',
        videoId,
        done: progress?.done ?? 0,
        total: progress?.total ?? 0,
        status,
      };
      void browser.tabs.sendMessage(tabId, message).catch(() => {
        // вкладка закрыта / нет приёмника — индикатор не критичен
      });
    }
  }

  // Нарезка массива на батчи фиксированного размера.
  function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      out.push(items.slice(i, i + size));
    }
    return out;
  }

  function buildSystemPrompt(language: string): string {
    const name = LANGUAGE_NAMES[language] ?? language;
    return API_SYSTEM_PROMPT_TEMPLATE.replace('{language}', name);
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  // Ошибка API с HTTP-статусом — несёт статус и Retry-After для backoff.
  class ApiError extends Error {
    readonly status: number;
    readonly retryAfterMs: number | null;
    constructor(status: number, retryAfterMs: number | null, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.retryAfterMs = retryAfterMs;
    }
  }

  // 429 (rate limit), 529 (overloaded), 503 — временные: ждём и повторяем.
  function isRateLimit(error: unknown): error is ApiError {
    return (
      error instanceof ApiError &&
      (error.status === 429 || error.status === 529 || error.status === 503)
    );
  }

  // Батч превысил таймаут и был оборван (abort) — повторяем без задержки.
  class TimeoutError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TimeoutError';
    }
  }
  function isTimeout(error: unknown): error is TimeoutError {
    return error instanceof TimeoutError;
  }

  // Одна попытка батча с адаптивным таймаутом. Таймаут перечитывается на лету
  // (подстраивается под медиану по мере завершения соседних батчей). Превышение →
  // abort fetch → TimeoutError наверх для перезапроса.
  async function runAttempt(
    texts: string[],
    language: string,
    apiKey: string,
    getTimeoutMs: () => number,
  ): Promise<BatchResult> {
    const controller = new AbortController();
    const startedAt = Date.now();
    let timedOut = false;
    const poll = setInterval(() => {
      if (Date.now() - startedAt >= getTimeoutMs()) {
        timedOut = true;
        controller.abort();
      }
    }, TIMEOUT_POLL_MS);
    try {
      return await translateBatch(texts, language, apiKey, controller.signal);
    } catch (error: unknown) {
      if (timedOut) {
        throw new TimeoutError(
          `[CVM bg] батч прерван по таймауту ${Math.round(getTimeoutMs())}мс`,
        );
      }
      throw error; // настоящая сетевая/HTTP-ошибка
    } finally {
      clearInterval(poll);
    }
  }

  // Один батч до успеха: попытка с адаптивным таймаутом + повторы по типу ошибки:
  //  - таймаут: до API_TIMEOUT_RETRY_COUNT, перезапрос сразу;
  //  - rate-limit (429/перегрузка): до API_RATE_LIMIT_RETRY_COUNT с backoff + джиттер;
  //  - прочее (сеть/HTTP): до API_RETRY_COUNT без задержки.
  async function runBatch(
    texts: string[],
    language: string,
    apiKey: string,
    getTimeoutMs: () => number,
  ): Promise<BatchResult> {
    let timeoutAttempts = 0;
    let rateLimitAttempts = 0;
    let networkAttempts = 0;
    for (;;) {
      try {
        return await runAttempt(texts, language, apiKey, getTimeoutMs);
      } catch (error: unknown) {
        if (isTimeout(error)) {
          timeoutAttempts += 1;
          if (timeoutAttempts > API_TIMEOUT_RETRY_COUNT) {
            throw error;
          }
          console.warn(
            `[CVM bg] таймаут батча, перезапуск (попытка ${timeoutAttempts}/${API_TIMEOUT_RETRY_COUNT})`,
          );
          continue;
        }
        if (isRateLimit(error)) {
          rateLimitAttempts += 1;
          if (rateLimitAttempts > API_RATE_LIMIT_RETRY_COUNT) {
            throw error;
          }
          const expBackoff = Math.min(
            API_BACKOFF_BASE_MS * 2 ** (rateLimitAttempts - 1),
            API_BACKOFF_MAX_MS,
          );
          const wait = (error.retryAfterMs ?? expBackoff) + Math.random() * API_BACKOFF_JITTER_MS;
          console.warn(
            `[CVM bg] ${error.status} rate-limit, повтор через ${Math.round(wait)}мс ` +
              `(попытка ${rateLimitAttempts}/${API_RATE_LIMIT_RETRY_COUNT})`,
          );
          await delay(wait);
          continue;
        }
        networkAttempts += 1;
        if (networkAttempts > API_RETRY_COUNT) {
          throw error;
        }
      }
    }
  }

  interface AnthropicTextBlock {
    type: string;
    text?: string;
  }
  interface AnthropicUsage {
    input_tokens?: number;
    output_tokens?: number;
  }
  interface AnthropicResponse {
    content?: AnthropicTextBlock[];
    usage?: AnthropicUsage;
  }

  // Результат одного батча: переводы + токены из usage.
  interface BatchResult {
    translations: string[];
    inputTokens: number;
    outputTokens: number;
  }

  // Строка-маркер ответа: [n] перевод. Захватываем номер и остаток строки.
  const LINE_MARKER = /^\s*\[(\d+)\]\s?(.*)$/;

  // Пронумеровать реплики для запроса: "[1] текст\n[2] текст".
  function buildNumberedInput(texts: string[]): string {
    return texts.map((text, index) => `[${index + 1}] ${text}`).join('\n');
  }

  // Толерантная сборка ответа по номерам. Длина результата ВСЕГДА равна originals:
  // потерянный/непереведённый номер заменяется оригиналом (без падения батча).
  function parseNumbered(answer: string, originals: string[]): string[] {
    const byNumber = new Map<number, string>();
    let current: number | null = null;
    for (const line of answer.split('\n')) {
      const match = LINE_MARKER.exec(line);
      if (match !== null) {
        current = Number(match[1]);
        byNumber.set(current, match[2] ?? '');
      } else if (current !== null && line.trim() !== '') {
        // Продолжение многострочного перевода под тем же номером.
        byNumber.set(current, `${byNumber.get(current) ?? ''}\n${line}`.trim());
      }
    }
    return originals.map((original, index) => {
      const translated = byNumber.get(index + 1);
      return translated !== undefined && translated.trim() !== '' ? translated : original;
    });
  }

  // Один запрос к API: реплики -> переводы той же длины (по номерам, с фолбэком).
  // signal — внешний (hedgeRace владеет хеджем/таймаутом): abort прерывает fetch.
  async function translateBatch(
    texts: string[],
    language: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<BatchResult> {
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: API_MODEL,
        max_tokens: API_MAX_TOKENS,
        system: buildSystemPrompt(language),
        messages: [{ role: 'user', content: buildNumberedInput(texts) }],
      }),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text();
      const retryAfterRaw = response.headers.get('retry-after');
      const retryAfterSec =
        retryAfterRaw !== null && retryAfterRaw.trim() !== '' ? Number(retryAfterRaw) : Number.NaN;
      const retryAfterMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : null;
      throw new ApiError(
        response.status,
        retryAfterMs,
        `[CVM bg] API ${response.status}: ${detail.slice(0, 200)}`,
      );
    }
    const data = (await response.json()) as AnthropicResponse;
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    const translations = parseNumbered(text, texts);
    const missing = translations.filter((value, index) => value === texts[index]).length;
    if (missing > 0) {
      console.warn(`[CVM bg] батч: ${missing}/${texts.length} строк остались оригиналом`);
    }
    return {
      translations,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  }

  // Агрегированный результат перевода всех батчей (для записи и метрик).
  interface AllBatchesResult {
    translations: string[];
    inputTokens: number;
    outputTokens: number;
    batchMs: number[];
  }

  // Перевод всех батчей пулом на API_BATCH_CONCURRENCY воркеров (порядок сохраняется).
  // onBatchDone вызывается по завершении каждого батча (для индикатора прогресса).
  async function translateAllBatches(
    batches: string[][],
    language: string,
    apiKey: string,
    onBatchDone: (done: number) => void,
  ): Promise<AllBatchesResult> {
    const results: string[][] = new Array<string[]>(batches.length);
    const batchMs: number[] = new Array<number>(batches.length);
    let nextIndex = 0;
    let doneCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    // Латентности завершённых батчей этого прогона — база для адаптивных порогов.
    const completedMs: number[] = [];
    function currentMedian(): number | null {
      if (completedMs.length < MEDIAN_MIN_SAMPLES) {
        return null; // мало выборок — медиане не доверяем
      }
      const sorted = [...completedMs].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? null;
    }
    // Адаптивный таймаут от медианы. Нет медианы → пол. Иначе max(пол, FACTOR × медиана).
    function timeoutMsFor(): number {
      const median = currentMedian();
      return median === null
        ? API_BATCH_TIMEOUT_MS
        : Math.max(API_BATCH_TIMEOUT_MS, median * TIMEOUT_LATENCY_FACTOR);
    }

    async function worker(): Promise<void> {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        const batch = batches[index];
        if (batch === undefined) {
          return; // батчи кончились
        }
        const startedAt = Date.now();
        const result = await runBatch(batch, language, apiKey, timeoutMsFor);
        const ms = Date.now() - startedAt;
        batchMs[index] = ms;
        completedMs.push(ms);
        results[index] = result.translations;
        inputTokens += result.inputTokens;
        outputTokens += result.outputTokens;
        doneCount += 1;
        onBatchDone(doneCount);
      }
    }

    const workerCount = Math.min(API_BATCH_CONCURRENCY, batches.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { translations: results.flat(), inputTokens, outputTokens, batchMs };
  }

  // Полный цикл перевода видео: батчинг -> пул -> склейка с таймингами -> кэш.
  async function handleApiTranslate(
    message: ApiTranslateMessage,
    tabId: number | null,
  ): Promise<ApiTranslateResponse> {
    const { videoId, language, original } = message;

    const apiKey = await settings.apiKey.getValue();
    if (apiKey.trim() === '') {
      return { ok: false, error: 'no-api-key' };
    }

    const batches = chunk(
      original.map((segment) => segment.text),
      API_BATCH_SIZE,
    );
    if (batches.length === 0) {
      return { ok: false, error: 'empty-original' };
    }

    setTranslationRuntime(videoId, 'translating', { done: 0, total: batches.length }, tabId);
    try {
      const startedAt = Date.now();
      const result = await translateAllBatches(batches, language, apiKey, (done) => {
        setTranslationRuntime(videoId, 'translating', { done, total: batches.length }, tabId);
      });
      const totalMs = Date.now() - startedAt;
      // Склейка обратно в сегменты: тайминги оригинала + переведённый текст (1:1).
      const translated: CaptionSegment[] = original.map((segment, index) => ({
        start: segment.start,
        duration: segment.duration,
        text: result.translations[index] ?? segment.text,
      }));
      const videoMs = original.reduce(
        (max, segment) => Math.max(max, segment.start + segment.duration),
        0,
      );
      const meta: ApiTranslationMeta = {
        model: API_MODEL,
        batchCount: batches.length,
        segmentCount: original.length,
        charsTotal: original.reduce((sum, segment) => sum + segment.text.length, 0),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalMs,
        batchMs: result.batchMs,
        videoSeconds: Math.round(videoMs / 1000),
        costUsd: null,
        createdAt: Date.now(),
        // Поток отдаётся в Стадии 4 лёгкими сообщениями; в storage пишем целиком и сразу.
        completedBatches: batches.length,
        complete: true,
      };
      const stored = await upsertApiTranslation(videoId, language, translated, meta);
      if (!stored) {
        throw new Error('[CVM bg] запись оригинала не найдена — перевод не сохранён');
      }
      await broadcastCacheList();
      setTranslationRuntime(videoId, 'ready', null, tabId);
      return { ok: true, error: null };
    } catch (error: unknown) {
      console.error('[CVM bg] перевод через API не удался', error);
      setTranslationRuntime(videoId, 'error', null, tabId);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Зафиксировать стоимость перевода: записать costUsd в apiMeta + калибровочный замер.
  async function handleRecordApiCost(
    message: RecordApiCostMessage,
  ): Promise<RecordApiCostResponse> {
    const { videoId, language, costUsd } = message;
    if (!(costUsd > 0) || !Number.isFinite(costUsd)) {
      return { ok: false, error: 'invalid' };
    }
    const entry = await getEntry(videoId);
    const meta = entry === null ? undefined : (entry.apiMeta ?? {})[language];
    if (meta === undefined) {
      return { ok: false, error: 'no-meta' };
    }
    if (meta.costUsd !== null) {
      return { ok: false, error: 'already-fixed' };
    }
    const updated = await setApiCost(videoId, language, costUsd);
    if (updated === null) {
      return { ok: false, error: 'no-meta' };
    }
    await addCostSample({
      dollars: costUsd,
      chars: meta.charsTotal,
      tokensIn: meta.inputTokens,
      tokensOut: meta.outputTokens,
      videoSeconds: meta.videoSeconds ?? 0,
      model: meta.model,
      videoId,
      language,
      at: Date.now(),
    });
    await broadcastCacheList();
    return { ok: true, error: null };
  }

  // Синтез одной реплики через Edge нейронный TTS (Стадия 4). Фон делает websocket-запрос
  // (из SW — мимо CSP страницы), возвращает MP3 в base64 для проигрывания в content.
  async function handleTtsSynth(message: TtsSynthMessage): Promise<TtsSynthResponse> {
    try {
      const endpoint = await settings.ttsEndpoint.getValue();
      const audio = await synthesize(endpoint, message.text, message.voice, message.rate);
      return { ok: true, audio: audioToBase64(audio), error: null };
    } catch (error: unknown) {
      console.warn('[CVM bg] edge-tts синтез не удался', error);
      return { ok: false, audio: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Отдать content финальные переведённые сегменты для озвучки (Стадия 4).
  async function handleGetTranslation(
    message: GetTranslationMessage,
  ): Promise<GetTranslationResponse> {
    const { videoId, language, source } = message;
    const entry = await getEntry(videoId);
    if (entry === null) {
      return { segments: null };
    }
    const segments =
      source === 'api' ? entry.apiTranslations[language] : entry.translations[language];
    return { segments: segments ?? null };
  }

  // --- Управляющие команды Inspector по тому же порту ---
  async function handleInspectorControl(
    port: RuntimePort,
    message: InspectorControlMessage,
  ): Promise<void> {
    if (message.type === 'request-cache-list') {
      const reply: InspectorMessage = { type: 'cache-list', items: await listMeta() };
      port.postMessage(reply);
      return;
    }
    if (message.type === 'request-cache-entry') {
      const entry = await getEntry(message.videoId);
      const reply: InspectorMessage = { type: 'cache-entry', entry };
      port.postMessage(reply);
      return;
    }
    if (message.type === 'clear-cache') {
      await clearAll();
      await broadcastCacheList();
    }
  }

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== INSPECTOR_PORT_NAME) {
      return;
    }
    inspectorPorts.add(port);

    port.postMessage(buildRuntimeMessage());
    void broadcastCacheList();

    port.onMessage.addListener((raw: unknown) => {
      void handleInspectorControl(port, raw as InspectorControlMessage);
    });

    port.onDisconnect.addListener(() => {
      inspectorPorts.delete(port);
    });
  });

  // --- Сообщения от content-скрипта (с ответом для lookup/store/translate) ---
  type MessageSender = Parameters<
    Parameters<typeof browser.runtime.onMessage.addListener>[0]
  >[1];

  browser.runtime.onMessage.addListener((message: unknown, sender: MessageSender) => {
    const backgroundMessage = message as BackgroundMessage;

    if (backgroundMessage.type === 'set-translation-active') {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) {
        getTabState(tabId).translationActive = backgroundMessage.active;
        broadcastRuntimeState();
      }
      return; // ответ не требуется
    }

    if (backgroundMessage.type === 'cache-lookup') {
      const { videoId, language } = backgroundMessage;
      return getEntry(videoId).then(
        (entry): CacheLookupResponse => ({
          entryExists: entry !== null,
          hasTranslation: entry !== null && entry.translations[language] !== undefined,
          // Незавершённый (потоковый) перевод считаем отсутствующим — иначе повторный
          // запуск пропустит дозаполнение. Требуем complete === true.
          hasApiTranslation:
            entry !== null &&
            entry.apiTranslations[language] !== undefined &&
            entry.apiMeta[language]?.complete === true,
        }),
      );
    }

    if (backgroundMessage.type === 'cache-store') {
      const { type, ...params } = backgroundMessage;
      void type;
      return upsertEntry(params)
        .then(async (): Promise<CacheStoreResponse> => {
          await broadcastCacheList();
          return { ok: true };
        })
        .catch((error: unknown) => {
          console.error('[CVM bg] cache-store не удался', error);
          throw error;
        });
    }

    if (backgroundMessage.type === 'api-translate') {
      return handleApiTranslate(backgroundMessage, sender.tab?.id ?? null);
    }

    if (backgroundMessage.type === 'record-api-cost') {
      return handleRecordApiCost(backgroundMessage);
    }

    if (backgroundMessage.type === 'get-translation') {
      return handleGetTranslation(backgroundMessage);
    }

    if (backgroundMessage.type === 'tts-synth') {
      return handleTtsSynth(backgroundMessage);
    }

    return undefined;
  });

  // Вкладка закрыта — убираем её рантайм-состояние (иначе утечка + мусор в Inspector).
  browser.tabs.onRemoved.addListener((tabId: number) => {
    if (runtimeStates.delete(tabId)) {
      broadcastRuntimeState();
    }
  });

  console.info('[CVM] background ready (Стадия 3.4: рантайм-состояние per-tab)');
});
