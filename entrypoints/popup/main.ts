import { browser } from '#imports';
import { settings } from '@/lib/storage';
import {
  SUPPORTED_LANGUAGES,
  STATUS_LABELS,
  MAX_VOLUME,
  MAX_VIDEO_DUCKING,
  PERCENT_SCALE,
  API_KEY_SAVE_DEBOUNCE_MS,
  INSPECTOR_PAGE,
  TTS_ENGINE_OPTIONS,
  EDGE_VOICE_CATALOG,
} from '@/lib/constants';
import type { TranslationStatus, TtsEngineName } from '@/lib/types';

// --- Доступ к элементам (строго, без any) ---
function requireEl<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`[Mnemosyne] popup: элемент #${id} не найден`);
  }
  return node as T;
}

const apiKeyEl = requireEl<HTMLInputElement>('api-key');
const languageEl = requireEl<HTMLSelectElement>('language');
const ttsEngineEl = requireEl<HTMLSelectElement>('tts-engine');
const voiceEl = requireEl<HTMLSelectElement>('voice');
const ttsEnabledEl = requireEl<HTMLInputElement>('tts-enabled');
const subtitlesEnabledEl = requireEl<HTMLInputElement>('subtitles-enabled');
const useYoutubeTranslationEl = requireEl<HTMLInputElement>('use-youtube-translation');
const autoStartEl = requireEl<HTMLInputElement>('auto-start');
const showCostEl = requireEl<HTMLInputElement>('show-cost');
const ttsVolumeEl = requireEl<HTMLInputElement>('tts-volume');
const ttsVolumeValueEl = requireEl<HTMLElement>('tts-volume-value');
const duckingEl = requireEl<HTMLInputElement>('ducking');
const duckingValueEl = requireEl<HTMLElement>('ducking-value');
const statusEl = requireEl<HTMLElement>('status');
const openInspectorEl = requireEl<HTMLButtonElement>('open-inspector');

// --- Вспомогательные функции ---
function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(...args), ms);
  };
}

function ratioToPercent(ratio: number): number {
  return Math.round(ratio * PERCENT_SCALE);
}

function percentToRatio(percent: number): number {
  return percent / PERCENT_SCALE;
}

function setStatus(status: TranslationStatus): void {
  statusEl.textContent = STATUS_LABELS[status];
  statusEl.dataset.status = status;
}

function updateVolumeLabel(): void {
  ttsVolumeValueEl.textContent = `${ttsVolumeEl.value}%`;
}

function updateDuckingLabel(): void {
  duckingValueEl.textContent = `${duckingEl.value}%`;
}

// --- Заполнение списков ---
function populateLanguages(): void {
  for (const lang of SUPPORTED_LANGUAGES) {
    const option = document.createElement('option');
    option.value = lang.code;
    option.textContent = lang.label;
    languageEl.append(option);
  }
}

function populateEngines(): void {
  for (const engine of TTS_ENGINE_OPTIONS) {
    const option = document.createElement('option');
    option.value = engine.id;
    option.textContent = engine.label;
    ttsEngineEl.append(option);
  }
}

function baseLang(code: string): string {
  return (code.split('-')[0] ?? code).toLowerCase();
}

// Голоса зависят от выбранного движка: Edge — из каталога по языку, Web Speech — системные.
async function populateVoices(): Promise<void> {
  const engine = (await settings.ttsEngine.getValue()) as TtsEngineName;
  const targetLanguage = baseLang(await settings.targetLanguage.getValue());
  voiceEl.replaceChildren();

  if (engine === 'edge') {
    const list = EDGE_VOICE_CATALOG[targetLanguage] ?? [];
    if (list.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Нейронных голосов для языка нет';
      voiceEl.append(option);
      voiceEl.disabled = true;
      return;
    }
    voiceEl.disabled = false;
    for (const voice of list) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = voice.label;
      voiceEl.append(option);
    }
    const saved = await settings.selectedVoiceEdge.getValue();
    const first = list[0];
    if (list.some((voice) => voice.id === saved)) {
      voiceEl.value = saved;
    } else if (first !== undefined) {
      voiceEl.value = first.id;
      await settings.selectedVoiceEdge.setValue(first.id);
    }
    return;
  }

  // Web Speech: системные голоса, отфильтрованные по языку.
  const matching = speechSynthesis
    .getVoices()
    .filter((voice) => voice.lang.toLowerCase().startsWith(targetLanguage));
  if (matching.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Голоса для языка не найдены';
    voiceEl.append(option);
    voiceEl.disabled = true;
    return;
  }
  voiceEl.disabled = false;
  for (const voice of matching) {
    const option = document.createElement('option');
    option.value = voice.name;
    option.textContent = `${voice.name} (${voice.lang})`;
    voiceEl.append(option);
  }
  const savedVoice = await settings.selectedVoice.getValue();
  const firstVoice = matching[0];
  if (matching.some((voice) => voice.name === savedVoice)) {
    voiceEl.value = savedVoice;
  } else if (firstVoice !== undefined) {
    voiceEl.value = firstVoice.name;
    await settings.selectedVoice.setValue(firstVoice.name);
  }
}

// --- Загрузка текущих значений настроек в UI ---
async function loadValues(): Promise<void> {
  const [
    apiKey,
    targetLanguage,
    ttsEngine,
    ttsEnabled,
    subtitlesEnabled,
    useYoutubeTranslation,
    autoStart,
    translationVolume,
    videoDucking,
    showCost,
  ] = await Promise.all([
    settings.apiKey.getValue(),
    settings.targetLanguage.getValue(),
    settings.ttsEngine.getValue(),
    settings.ttsEnabled.getValue(),
    settings.subtitlesEnabled.getValue(),
    settings.useYoutubeTranslation.getValue(),
    settings.autoStart.getValue(),
    settings.translationVolume.getValue(),
    settings.videoDucking.getValue(),
    settings.showCost.getValue(),
  ]);

  apiKeyEl.value = apiKey;
  languageEl.value = targetLanguage;
  ttsEngineEl.value = ttsEngine;
  ttsEnabledEl.checked = ttsEnabled;
  subtitlesEnabledEl.checked = subtitlesEnabled;
  useYoutubeTranslationEl.checked = useYoutubeTranslation;
  autoStartEl.checked = autoStart;
  showCostEl.checked = showCost;

  ttsVolumeEl.max = String(ratioToPercent(MAX_VOLUME));
  duckingEl.max = String(ratioToPercent(MAX_VIDEO_DUCKING));
  ttsVolumeEl.value = String(ratioToPercent(translationVolume));
  duckingEl.value = String(ratioToPercent(videoDucking));
  updateVolumeLabel();
  updateDuckingLabel();
}

// --- Обработчики (мгновенное применение в storage) ---
function registerHandlers(): void {
  const saveApiKey = debounce((value: string) => {
    void settings.apiKey.setValue(value);
  }, API_KEY_SAVE_DEBOUNCE_MS);
  apiKeyEl.addEventListener('input', () => saveApiKey(apiKeyEl.value));

  languageEl.addEventListener('change', () => {
    void (async () => {
      await settings.targetLanguage.setValue(languageEl.value);
      await populateVoices();
    })();
  });

  ttsEngineEl.addEventListener('change', () => {
    void (async () => {
      await settings.ttsEngine.setValue(ttsEngineEl.value as TtsEngineName);
      await populateVoices(); // у разных движков — разные списки голосов
    })();
  });

  voiceEl.addEventListener('change', () => {
    void (async () => {
      const engine = (await settings.ttsEngine.getValue()) as TtsEngineName;
      if (engine === 'edge') {
        await settings.selectedVoiceEdge.setValue(voiceEl.value);
      } else {
        await settings.selectedVoice.setValue(voiceEl.value);
      }
    })();
  });

  ttsEnabledEl.addEventListener('change', () => {
    void settings.ttsEnabled.setValue(ttsEnabledEl.checked);
  });

  subtitlesEnabledEl.addEventListener('change', () => {
    void settings.subtitlesEnabled.setValue(subtitlesEnabledEl.checked);
  });

  useYoutubeTranslationEl.addEventListener('change', () => {
    void settings.useYoutubeTranslation.setValue(useYoutubeTranslationEl.checked);
  });

  autoStartEl.addEventListener('change', () => {
    void settings.autoStart.setValue(autoStartEl.checked);
  });

  showCostEl.addEventListener('change', () => {
    void settings.showCost.setValue(showCostEl.checked);
  });

  ttsVolumeEl.addEventListener('input', () => {
    updateVolumeLabel();
    void settings.translationVolume.setValue(percentToRatio(Number(ttsVolumeEl.value)));
  });

  duckingEl.addEventListener('input', () => {
    updateDuckingLabel();
    void settings.videoDucking.setValue(percentToRatio(Number(duckingEl.value)));
  });

  openInspectorEl.addEventListener('click', () => {
    void browser.tabs.create({ url: browser.runtime.getURL(`/${INSPECTOR_PAGE}`) });
  });

  // Голоса в Web Speech API подгружаются асинхронно.
  speechSynthesis.addEventListener('voiceschanged', () => {
    void populateVoices();
  });
}

async function init(): Promise<void> {
  populateLanguages();
  populateEngines();
  await loadValues();
  await populateVoices();
  registerHandlers();
  setStatus('ready');
  console.info('[Mnemosyne] popup ready');
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
