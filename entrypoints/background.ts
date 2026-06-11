import { defineBackground, browser } from '#imports';
import { INSPECTOR_PORT_NAME } from '@/lib/constants';
import { getEntry, upsertEntry, listMeta, clearAll } from '@/lib/cache';
import type { CvmRuntimeState } from '@/lib/types';
import type {
  InspectorMessage,
  InspectorControlMessage,
  BackgroundMessage,
  CacheLookupResponse,
  CacheStoreResponse,
} from '@/lib/messaging';

// Тип порта выводим из слушателя, чтобы не зависеть от имён неймспейсов WXT.
type RuntimePort = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

export default defineBackground(() => {
  // Рантайм-состояние (не сохраняется). Точки обновления появятся в Стадии 3.
  const runtimeState: CvmRuntimeState = {
    currentVideoId: null,
    translationStatus: 'ready',
    translationActive: false,
  };

  // Подключённые страницы Inspector — реестр для рассылки обновлений.
  const inspectorPorts = new Set<RuntimePort>();

  function broadcastRuntimeState(): void {
    const message: InspectorMessage = { type: 'runtime-state', state: runtimeState };
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

    const stateMessage: InspectorMessage = { type: 'runtime-state', state: runtimeState };
    port.postMessage(stateMessage);
    void broadcastCacheList();

    port.onMessage.addListener((raw: unknown) => {
      void handleInspectorControl(port, raw as InspectorControlMessage);
    });

    port.onDisconnect.addListener(() => {
      inspectorPorts.delete(port);
    });
  });

  // --- Сообщения от content-скрипта (с ответом для lookup/store) ---
  browser.runtime.onMessage.addListener((message: unknown) => {
    const backgroundMessage = message as BackgroundMessage;

    if (backgroundMessage.type === 'set-translation-active') {
      runtimeState.translationActive = backgroundMessage.active;
      broadcastRuntimeState();
      return; // ответ не требуется
    }

    if (backgroundMessage.type === 'cache-lookup') {
      const { videoId, language } = backgroundMessage;
      return getEntry(videoId).then(
        (entry): CacheLookupResponse => ({
          entryExists: entry !== null,
          hasTranslation: entry !== null && entry.translations[language] !== undefined,
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

    return undefined;
  });

  console.info('[CVM] background ready');
});
