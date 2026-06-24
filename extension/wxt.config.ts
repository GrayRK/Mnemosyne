import { defineConfig } from 'wxt';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// Постоянный профиль Chrome для dev: логин в YouTube и cookie-согласие
// сохраняются между запусками (иначе web-ext поднимает чистый профиль).
// Папка ВНЕ проекта — иначе Vite-вотчер падает на залоченных Chrome файлах.
const CHROME_PROFILE_DIR = resolve(homedir(), '.mnemosyne-chrome-profile');

// Конфиг расширения. Часть полей manifest задаётся здесь (заменяет manifest.json).
// imports: false — отключаем авто-импорты WXT, используем явные импорты из '#imports'.
export default defineConfig({
  imports: false,
  webExt: {
    chromiumProfile: CHROME_PROFILE_DIR,
    keepProfileChanges: true,
    startUrls: ['https://www.youtube.com'],
    // Маскируем «автоматизированный» режим: YouTube отдаёт обычную сессию,
    // меньше шансов на урезанные/пустые ответы.
    chromiumArgs: ['--disable-blink-features=AutomationControlled'],
  },
  manifest: {
    name: 'Mnemosyne',
    description: 'Mnemosyne — перевод и нейронная озвучка видео-субтитров на любом языке.',
    // key — публичный ключ, фиксирующий ID dev/unpacked-сборки
    // (ID = fgdljagjbgmkjebhadodlahahapnbalp). Нужен, чтобы ID был детерминированным и
    // попадал в allow-list нативного хэлпера и в allowed_origins его native-messaging
    // манифеста (Стадия 5.1). Приватный ключ — в helper/.dev-keys (НЕ в репозитории).
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuJmrecXUyp3sVSJzeUzxAT1uWq7fvjo/I3E1TWFIMvbGezA/WHlUq+HRd14LyLUUS6ua0uNHSGTv8IweHoPPCLUQ/QZfcfJjbhY4SkbLolO318SAEvhCPqM/2QCrY77n+xEmMXfySa7tC99l/s+JEKFj7wqF0bDQ7rAf06lkvThs64bLPwEM8qXFiwxR1ulGnRrmTUJAwmrDP9AEYu/l3cTAE3QLsSzPW/+d9zoj/a6yMaYdKFtCpNNV1FtvjhSnFLEDlfuofWjAY7uxG31DtKtGixmvVbpp7ieHZaku1i+N9hKLVzFtTd4APgOy1mPxf6Sle8gAamOQPOqR9hXmmwIDAQAB',
    // activeTab — чтобы popup мог прочитать URL/заголовок активной вкладки (карточка
    // «Текущее видео»): определить videoId и превью. Доступ выдаётся при клике по иконке
    // расширения, без широкого предупреждения «читать историю».
    // nativeMessaging — связь с нативным хэлпером (Стадия 5): connectNative к хосту.
    // Сохранение медиа идёт через File System Access (showSaveFilePicker) — без доп. разрешений.
    permissions: ['storage', 'activeTab', 'nativeMessaging'],
    // Доступ из service worker: API перевода (aiprimetech.io) + прокси Edge TTS (Стадия 4):
    // Cloudflare Worker (*.workers.dev) и/или локальный релей (127.0.0.1). Порт в match-паттерн
    // не входит — покрывает любой. Для своего домена Worker'а добавь сюда его хост.
    host_permissions: [
      'https://aiprimetech.io/*',
      'https://*.workers.dev/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
    ],
    icons: {
      16: '/icons/16.png',
      32: '/icons/32.png',
      48: '/icons/48.png',
      128: '/icons/128.png',
    },
  },
});
