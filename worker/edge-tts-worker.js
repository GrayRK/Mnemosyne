/**
 * Cloudflare Worker — прокси к Edge нейронному TTS для ClaudeVoiceMaster (Стадия 4).
 *
 * Зачем: прямой эндпоинт Microsoft недоступен из браузера (нельзя задать Origin/User-Agent)
 * и заблокирован в РФ по DPI. Worker живёт вне РФ и НЕ браузер — он спокойно ставит нужные
 * заголовки и открывает WebSocket к Microsoft. Расширение ходит сюда обычным GET.
 *
 * Деплой (один раз):
 *   npm i -g wrangler
 *   cd worker && wrangler deploy            (см. wrangler.toml рядом)
 * Бесплатный тариф CF: ~100k запросов/день — с запасом.
 *
 * Проверка после деплоя:
 *   https://<имя>.<аккаунт>.workers.dev/tts?text=Привет&voice=ru-RU-DmitryNeural&rate=+0%
 */

// Значения 1:1 с пакетом edge-tts (constants.py / drm.py) — Microsoft проверяет версию клиента
// и набор заголовков, на устаревших/неполных отвечает 403. При новой ошибке 403 — обновить
// CHROMIUM_FULL до текущей версии edge-tts.
const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_TOKEN}`;
const CHROMIUM_FULL = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL.split('.')[0];
const GEC_VERSION = `1-${CHROMIUM_FULL}`;
const WIN_EPOCH = 11644473600;
const GEC_WINDOW_SEC = 300;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`;
const SYNTH_TIMEOUT_MS = 12000;

// Случайный hex (n байт → 2n символов) для ConnectionId и MUID, как в edge-tts.
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CORS = { 'access-control-allow-origin': '*' };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/tts') {
      return new Response('CVM edge-tts worker ok', { headers: CORS });
    }
    const text = (url.searchParams.get('text') || '').trim();
    const voice = url.searchParams.get('voice') || 'ru-RU-DmitryNeural';
    const rate = url.searchParams.get('rate') || '+0%';
    if (text === '') {
      return new Response('no text', { status: 400, headers: CORS });
    }
    try {
      const audio = await synthesize(text, voice, rate);
      return new Response(audio, { headers: { 'content-type': 'audio/mpeg', ...CORS } });
    } catch (error) {
      return new Response(`edge-tts error: ${error}`, { status: 502, headers: CORS });
    }
  },
};

async function secMsGec() {
  const unix = BigInt(Math.floor(Date.now() / 1000));
  let ticks = unix + BigInt(WIN_EPOCH);
  ticks -= ticks % BigInt(GEC_WINDOW_SEC);
  ticks *= 10000000n;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ticks}${TRUSTED_TOKEN}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function ratePercent(rate) {
  return rate; // расширение уже шлёт готовую строку '+50%'; принимаем как есть
}

function voiceLang(voice) {
  return voice.split('-').slice(0, 2).join('-');
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

function configMessage() {
  const body = JSON.stringify({
    context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: OUTPUT_FORMAT } } },
  });
  return `X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${body}`;
}

function ssmlMessage(id, text, voice, rate) {
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${voiceLang(voice)}'>` +
    `<voice name='${voice}'><prosody rate='${ratePercent(rate)}' pitch='+0Hz'>${escapeXml(text)}</prosody></voice></speak>`;
  return `X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n${ssml}`;
}

async function synthesize(text, voice, rate) {
  const gec = await secMsGec();
  const wsUrl =
    `${WSS}&ConnectionId=${randomHex(16)}` +
    `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}`;
  const resp = await fetch(wsUrl, {
    headers: {
      Upgrade: 'websocket',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      Origin: ORIGIN,
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: `muid=${randomHex(16).toUpperCase()};`,
    },
  });
  const ws = resp.webSocket;
  if (!ws) {
    throw new Error(`нет webSocket в ответе (status ${resp.status})`);
  }
  ws.accept();

  return await new Promise((resolve, reject) => {
    const chunks = [];
    const id = crypto.randomUUID().replace(/-/g, '');
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) { /* already closed */ }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('таймаут синтеза'))), SYNTH_TIMEOUT_MS);

    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        if (event.data.includes('Path:turn.end')) {
          finish(() => (chunks.length ? resolve(concat(chunks)) : reject(new Error('пустой ответ'))));
        }
        return;
      }
      const view = new Uint8Array(event.data);
      const headerLen = (view[0] << 8) | view[1];
      chunks.push(view.subarray(2 + headerLen));
    });
    ws.addEventListener('close', () => finish(() => reject(new Error('соединение закрыто до конца синтеза'))));
    ws.addEventListener('error', () => finish(() => reject(new Error('ошибка websocket'))));

    ws.send(configMessage());
    ws.send(ssmlMessage(id, text, voice, rate));
  });
}

function concat(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}
