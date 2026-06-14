import { defineConfig } from 'wxt';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// Постоянный профиль Chrome для dev: логин в YouTube и cookie-согласие
// сохраняются между запусками (иначе web-ext поднимает чистый профиль).
// Папка ВНЕ проекта — иначе Vite-вотчер падает на залоченных Chrome файлах.
const CHROME_PROFILE_DIR = resolve(homedir(), '.cvm-chrome-profile');

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
    name: 'ClaudeVoiceMaster',
    description: 'Перевод и озвучка субтитров YouTube в реальном времени.',
    permissions: ['storage'],
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
