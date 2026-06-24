// Клиент нативного хэлпера (Стадия 5). Тонкое расширение опрашивает десктоп-компаньон:
// рукопожатие по native messaging → хост отдаёт порт+токен локального сервера →
// проверяем /health. Расширение полностью работает и без хэлпера (лайт-режим): при
// отсутствии хоста возвращаем состояние 'not-installed', не ломая остальной UI.
import { browser } from '#imports';
import {
  HELPER_NM_HOST,
  HELPER_PROTOCOL_VERSION,
  HELPER_HANDSHAKE_TIMEOUT_MS,
  HELPER_HEALTH_TIMEOUT_MS,
  HELPER_HEALTH_PATH,
} from '@/lib/constants';

// Состояние связки с хэлпером для индикатора в popup.
//  connected     — хост ответил и локальный сервер доступен по токену
//  not-installed — хост не зарегистрирован (нормальный лайт-режим)
//  error         — хост есть, но рукопожатие/сервер не сложились
export type HelperState = 'connected' | 'not-installed' | 'error';

export interface HelperStatus {
  state: HelperState;
  version: string | null;
  error: string | null;
}

// Ответ хоста на рукопожатие (см. helper/internal/nm/nm.go → outbound).
interface HelperWelcome {
  type: string;
  ok?: boolean;
  error?: string;
  version?: string;
  port?: number;
  token?: string;
}

// Что добываем у хэлпера (этап 5.2).
export type HelperMediaKind = 'audio' | 'video';

// Снимок задачи добычи (зеркало helper/internal/media.Status).
export interface MediaJobStatus {
  id: string;
  kind: string;
  videoId: string;
  state: 'running' | 'done' | 'error';
  progress: number; // 0..100
  fileName?: string;
  error?: string;
}

// Координаты живого локального сервера, полученные при рукопожатии. Кэшируем, чтобы
// медиа-вызовы не делали connectNative на каждый опрос прогресса. Токен — на сессию
// сервера; при 401/сбое сбрасываем и пере-рукопожатимся.
let cachedConn: { port: number; token: string } | null = null;

// Опрашивает хэлпер и возвращает текущее состояние связки.
export async function checkHelper(): Promise<HelperStatus> {
  let welcome: HelperWelcome;
  try {
    welcome = await handshake();
  } catch (error) {
    // connectNative бросает / порт сразу отключается, если хост не зарегистрирован —
    // это штатный лайт-режим, не ошибка для пользователя.
    cachedConn = null;
    return { state: 'not-installed', version: null, error: errorMessage(error) };
  }

  if (!welcome.ok || !welcome.port || !welcome.token) {
    cachedConn = null;
    return { state: 'error', version: welcome.version ?? null, error: welcome.error ?? 'bad handshake' };
  }

  const healthy = await pingHealth(welcome.port, welcome.token);
  if (!healthy) {
    cachedConn = null;
    return { state: 'error', version: welcome.version ?? null, error: 'local server unreachable' };
  }
  cachedConn = { port: welcome.port, token: welcome.token };
  return { state: 'connected', version: welcome.version ?? null, error: null };
}

// Гарантирует соединение с сервером хэлпера (рукопожатие при необходимости).
async function ensureConnection(): Promise<{ port: number; token: string }> {
  if (cachedConn !== null) {
    return cachedConn;
  }
  const welcome = await handshake();
  if (!welcome.ok || !welcome.port || !welcome.token) {
    throw new Error(welcome.error ?? 'helper unavailable');
  }
  cachedConn = { port: welcome.port, token: welcome.token };
  return cachedConn;
}

// Старт задачи добычи. Возвращает id задачи.
export async function startMedia(videoId: string, kind: HelperMediaKind): Promise<string> {
  const { port, token } = await ensureConnection();
  const response = await fetch(`http://127.0.0.1:${port}/media/jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId, kind }),
  });
  if (!response.ok) {
    if (response.status === 401) cachedConn = null;
    throw new Error(`media-start: HTTP ${response.status}`);
  }
  const data = (await response.json()) as { ok: boolean; id?: string; error?: string };
  if (!data.ok || data.id === undefined) {
    throw new Error(data.error ?? 'media-start failed');
  }
  return data.id;
}

// Текущий статус задачи добычи (для % на кнопке).
export async function mediaStatus(jobId: string): Promise<MediaJobStatus> {
  const { port, token } = await ensureConnection();
  const response = await fetch(`http://127.0.0.1:${port}/media/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    if (response.status === 401) cachedConn = null;
    throw new Error(`media-status: HTTP ${response.status}`);
  }
  return (await response.json()) as MediaJobStatus;
}

// URL готового файла с токеном в query (страница «История» сама стримит его в файл,
// выбранный через File System Access).
// null — если соединение ещё не установлено.
export function mediaFileUrl(jobId: string): string | null {
  if (cachedConn === null) {
    return null;
  }
  return `http://127.0.0.1:${cachedConn.port}/media/jobs/${jobId}/file?token=${encodeURIComponent(cachedConn.token)}`;
}

// Native-messaging рукопожатие: подключаемся к хосту, шлём hello, ждём welcome.
function handshake(): Promise<HelperWelcome> {
  return new Promise<HelperWelcome>((resolve, reject) => {
    let settled = false;

    let port: ReturnType<typeof browser.runtime.connectNative>;
    try {
      port = browser.runtime.connectNative(HELPER_NM_HOST);
    } catch (error) {
      reject(error);
      return;
    }

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        // порт мог уже закрыться — игнорируем
      }
      action();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error('handshake timeout')));
    }, HELPER_HANDSHAKE_TIMEOUT_MS);

    port.onMessage.addListener((message: unknown) => {
      finish(() => resolve(message as HelperWelcome));
    });

    port.onDisconnect.addListener(() => {
      const lastError = browser.runtime.lastError;
      finish(() => reject(new Error(lastError?.message ?? 'native host disconnected')));
    });

    try {
      port.postMessage({ type: 'hello', version: HELPER_PROTOCOL_VERSION });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

// Проверка доступности локального сервера по выданному токену (Bearer).
async function pingHealth(port: number, token: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HELPER_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/${HELPER_HEALTH_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
