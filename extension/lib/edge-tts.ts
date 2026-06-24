// Клиент Edge нейронного TTS через локальный релей (Стадия 4, путь B). Работает в background.
// Прямой WebSocket к Microsoft из браузера невозможен (сервер требует «свои» Origin/User-Agent,
// которые браузер не даёт задать). Поэтому синтез выполняет локальный хелпер на базе пакета
// edge-tts (tools/edge-tts-relay.py): сюда приходит готовый MP3.

import {
  EDGE_TTS_SYNTH_TIMEOUT_MS,
  EDGE_TTS_SYNTH_RETRIES,
  EDGE_TTS_SYNTH_RETRY_DELAY_MS,
} from '@/lib/constants';

// rate (множитель) → проценты для edge-tts: 1.0 → +0%, 1.5 → +50%, 3.0 → +200%.
function ratePercent(rate: number): string {
  const pct = Math.round((rate - 1) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Один запрос синтеза в MP3 (ArrayBuffer) через прокси-эндпоинт (Worker/релей).
async function synthesizeOnce(
  endpoint: string,
  text: string,
  voice: string,
  rate: number,
): Promise<ArrayBuffer> {
  const url = new URL(endpoint);
  url.searchParams.set('text', text);
  url.searchParams.set('voice', voice);
  url.searchParams.set('rate', ratePercent(rate));

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(EDGE_TTS_SYNTH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`[Mnemosyne] edge-tts релей вернул статус ${response.status}`);
  }
  return await response.arrayBuffer();
}

// Синтез с ретраями: сбои Worker (холодный старт CF / таймаут) обычно транзиентны. Несколько
// попыток надёжно отдают аудио, не скатываясь к подмене реплики системным голосом (Web Speech).
export async function synthesize(
  endpoint: string,
  text: string,
  voice: string,
  rate: number,
): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EDGE_TTS_SYNTH_RETRIES; attempt += 1) {
    try {
      return await synthesizeOnce(endpoint, text, voice, rate);
    } catch (error: unknown) {
      lastError = error;
      if (attempt < EDGE_TTS_SYNTH_RETRIES) {
        await delay(EDGE_TTS_SYNTH_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// MP3 → base64 (runtime.sendMessage не переносит ArrayBuffer — отдаём строкой).
export function audioToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // посимвольно btoa падает на больших массивах — частями
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
