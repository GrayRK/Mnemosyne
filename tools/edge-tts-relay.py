"""
Локальный релей Edge нейронного TTS для расширения Mnemosyne (Стадия 4).

Зачем: прямой эндпоинт Microsoft из браузера недоступен (сервер рвёт рукопожатие — браузер
не даёт задать нужные Origin/User-Agent). Из обычного Python-клиента пакет `edge-tts`
обращается к нему штатно. Этот скрипт поднимает крошечный HTTP-сервер на localhost; расширение
шлёт ему GET и получает MP3 с нейронным голосом.

Установка (один раз):
    pip install edge-tts aiohttp

Запуск (держать открытым во время просмотра):
    python tools/edge-tts-relay.py

Проверка в браузере:
    http://127.0.0.1:5599/tts?text=Привет&voice=ru-RU-DmitryNeural&rate=+0%

Прокси (хост Microsoft часто заблокирован в РФ — гоним трафик через VPN):
    По умолчанию релей ходит к Microsoft через http://127.0.0.1:7890 (mixed-port Clash).
    Переопределить:   set MNEMOSYNE_TTS_PROXY=http://127.0.0.1:7890   (Windows)
    Отключить прокси: set MNEMOSYNE_TTS_PROXY=none

Безопасность: слушает только 127.0.0.1 (наружу не торчит).
"""

import os

import edge_tts
from aiohttp import web

HOST = "127.0.0.1"
PORT = 5599
DEFAULT_VOICE = "ru-RU-DmitryNeural"
DEFAULT_RATE = "+0%"

# Прокси к Microsoft: env MNEMOSYNE_TTS_PROXY, по умолчанию mixed-port Clash. 'none' — без прокси.
_proxy_env = os.environ.get("MNEMOSYNE_TTS_PROXY", "http://127.0.0.1:7890")
PROXY = None if _proxy_env.lower() == "none" else _proxy_env


async def handle_tts(request: web.Request) -> web.Response:
    text = request.query.get("text", "").strip()
    voice = request.query.get("voice", DEFAULT_VOICE)
    rate = request.query.get("rate", DEFAULT_RATE)

    if text == "":
        return web.Response(status=400, text="no text")

    try:
        communicate = edge_tts.Communicate(text, voice, rate=rate, proxy=PROXY)
        audio = bytearray()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio.extend(chunk["data"])
    except Exception as error:  # noqa: BLE001 — отдаём причину клиенту
        return web.Response(status=502, text=f"edge-tts error: {error}")

    if len(audio) == 0:
        return web.Response(status=502, text="empty audio")

    return web.Response(
        body=bytes(audio),
        content_type="audio/mpeg",
        headers={"Access-Control-Allow-Origin": "*"},
    )


async def handle_health(_request: web.Request) -> web.Response:
    return web.Response(text="ok", headers={"Access-Control-Allow-Origin": "*"})


def main() -> None:
    app = web.Application()
    app.router.add_get("/tts", handle_tts)
    app.router.add_get("/health", handle_health)
    print(f"[Mnemosyne edge-tts relay] слушаю http://{HOST}:{PORT}  (Ctrl+C — стоп)")
    print(f"[Mnemosyne edge-tts relay] прокси к Microsoft: {PROXY or 'нет (прямое подключение)'}")
    web.run_app(app, host=HOST, port=PORT, print=None)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
