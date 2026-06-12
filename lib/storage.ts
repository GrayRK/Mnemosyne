import { storage } from '#imports';
import {
  STORAGE_KEYS,
  DEFAULT_TARGET_LANGUAGE,
  DEFAULT_SELECTED_VOICE,
  DEFAULT_TTS_ENABLED,
  DEFAULT_SUBTITLES_ENABLED,
  DEFAULT_USE_YOUTUBE_TRANSLATION,
  DEFAULT_AUTO_START,
  DEFAULT_TRANSLATION_VOLUME,
  DEFAULT_VIDEO_DUCKING,
  DEFAULT_SHOW_COST,
} from '@/lib/constants';

// Типизированные элементы настроек поверх chrome.storage.local.
// Каждый элемент даёт getValue/setValue/watch — основа для мгновенного
// применения в popup и живого обновления в Inspector.
export const settings = {
  apiKey: storage.defineItem<string>(STORAGE_KEYS.apiKey, {
    fallback: '',
  }),
  targetLanguage: storage.defineItem<string>(STORAGE_KEYS.targetLanguage, {
    fallback: DEFAULT_TARGET_LANGUAGE,
  }),
  selectedVoice: storage.defineItem<string>(STORAGE_KEYS.selectedVoice, {
    fallback: DEFAULT_SELECTED_VOICE,
  }),
  ttsEnabled: storage.defineItem<boolean>(STORAGE_KEYS.ttsEnabled, {
    fallback: DEFAULT_TTS_ENABLED,
  }),
  subtitlesEnabled: storage.defineItem<boolean>(STORAGE_KEYS.subtitlesEnabled, {
    fallback: DEFAULT_SUBTITLES_ENABLED,
  }),
  useYoutubeTranslation: storage.defineItem<boolean>(STORAGE_KEYS.useYoutubeTranslation, {
    fallback: DEFAULT_USE_YOUTUBE_TRANSLATION,
  }),
  autoStart: storage.defineItem<boolean>(STORAGE_KEYS.autoStart, {
    fallback: DEFAULT_AUTO_START,
  }),
  translationVolume: storage.defineItem<number>(STORAGE_KEYS.translationVolume, {
    fallback: DEFAULT_TRANSLATION_VOLUME,
  }),
  videoDucking: storage.defineItem<number>(STORAGE_KEYS.videoDucking, {
    fallback: DEFAULT_VIDEO_DUCKING,
  }),
  showCost: storage.defineItem<boolean>(STORAGE_KEYS.showCost, {
    fallback: DEFAULT_SHOW_COST,
  }),
} as const;
