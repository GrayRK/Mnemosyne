# Mnemosyne Helper — нативный десктоп-компаньон

Нативное приложение-компаньон (Стадия 5). Тонкое расширение делегирует ему тяжёлую
работу, которая принципиально не решается в браузере: добыча медиа (yt-dlp/ffmpeg —
этап 5.2) и полноразмерные локальные LLM вне ограничений WebGPU (этап 5.3).

Расширение **полностью работает и без хэлпера** (лайт-режим). Установленный хэлпер лишь
разблокирует мощные опции.

## Стек

Go (stdlib, без внешних зависимостей). Один статический бинарь — простая упаковка и
служба Windows (этап 5.4).

## Архитектура связки (этап 5.1)

Два канала:

1. **Native Messaging** (stdio) — браузер запускает хост, тот проверяет ID вызвавшего
   расширения по allow-list и отдаёт координаты подключения (порт + токен сессии).
2. **Локальный HTTP-сервер на `127.0.0.1`** (будущая служба) — тяжёлые/потоковые задачи.
   Сейчас только `/health` (token-gated) под индикатор статуса. WebSocket добавится в 5.2.

Безопасность: сервер слушает только loopback, каждое подключение требует токен,
ID расширения сверяется с allow-list (`internal/config`). У dev/unpacked и Web Store —
разные ID, оба должны быть в allow-list.

## Команды

```
mnemosyne-helper serve        запустить локальный сервер на 127.0.0.1 (будущая служба)
mnemosyne-helper nm           режим native-messaging-хоста (запускается браузером)
mnemosyne-helper register     прописать native-messaging-манифест и реестр (dev)
mnemosyne-helper unregister   снять регистрацию
mnemosyne-helper version      показать версию
```

`nm` сам поднимает `serve` отдельным процессом, если сервер ещё не запущен.

## Сборка и dev-связка

```bash
# из папки helper/ (Go должен быть в PATH; иначе вызывать go.exe по полному пути)
go build -o bin/mnemosyne-helper.exe .

# зарегистрировать хост для текущего пользователя (Chrome + Edge)
bin/mnemosyne-helper.exe register
```

После `register` манифест указывает на собранный бинарь, а в реестр
(`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mnemosyne.helper` и аналог Edge)
прописан путь к манифесту. Запусти расширение (`npm run dev` из `../extension`) — в popup,
вкладка «Главная» → «Нативный хэлпер», нажми «Проверить»: статус станет «Подключён · vX».

ID dev-сборки расширения фиксирован публичным ключом (`extension/wxt.config.ts` →
`manifest.key`) и равен `fgdljagjbgmkjebhadodlahahapnbalp`. Приватный ключ — в
`helper/.dev-keys/` (не в репозитории).

## Рантайм-файлы

- `%LOCALAPPDATA%\Mnemosyne\helper.json` — порт/токен/pid живого сервера.
- `%LOCALAPPDATA%\Mnemosyne\nm\com.mnemosyne.helper.json` — native-messaging-манифест.

## Тест без браузера (этап 5.8)

```bash
go vet ./...
# рукопожатие имитируется кадром native messaging в stdin (см. изолированный тест:
# 4 байта длины LE + JSON {"type":"hello"}; хост отвечает welcome с port+token)
```
