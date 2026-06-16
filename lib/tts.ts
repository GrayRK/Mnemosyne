// Абстракция TTS-движка (Стадия 4).
//
// Цель — отвязать планировщик озвучки от конкретного синтезатора: сегодня это
// Web Speech API (системные голоса Windows / Microsoft Neural), завтра —
// CosyVoice / Qwen3-TTS / Yandex SpeechKit. Планировщик работает только с
// интерфейсом TtsEngine и не знает, что под ним.

import { browser } from '#imports';
import {
  TTS_DEFAULT_RATE,
  TTS_HARD_MIN_RATE,
  TTS_HARD_MAX_RATE,
  TTS_PLAYBACK_ADJUST_MIN,
  TTS_NEURAL_HINT,
  EDGE_VOICE_CATALOG,
  EDGE_TTS_DEFAULT_VOICE,
  EDGE_TTS_AUDIO_MIME,
  EDGE_TTS_PREFETCH_CACHE_LIMIT,
} from '@/lib/constants';
import type { TtsSynthMessage, TtsSynthResponse } from '@/lib/messaging';
import type { TtsEngineName } from '@/lib/types';

// Параметры одной озвучиваемой реплики. Тайминги/синхронизацию считает
// планировщик; движок только произносит текст с заданными голосом и темпом.
export interface SpeakOptions {
  text: string;
  voiceName: string; // имя голоса (из настроек); пустое — авто-подбор по языку
  lang: string; // BCP-47 целевого языка (для подбора голоса и произношения)
  volume: number; // 0..1
  rate: number; // запечённый в синтез темп (1.0 = норма); под него готовится/кэшируется аудио
  // Живая коррекция темпа в момент воспроизведения ПОВЕРХ rate (1 = без коррекции). Считается
  // планировщиком от реального отставания при старте реплики; для Edge → audio.playbackRate,
  // для Web Speech → множитель к utterance.rate. Именно она догоняет видео без пересинтеза.
  speedAdjust?: number;
  cacheId?: string; // ключ для префетча: prefetch(id) → speak(id) играет заранее готовое аудио
  onStart?: () => void; // фактическое начало речи (для ducking оригинала)
  onEnd?: () => void; // конец речи ИЛИ обрыв (ошибка/cancel) — восстановить громкость
}

// Контракт движка: озвучить реплику и уметь прервать/заморозить текущую речь.
export interface TtsEngine {
  speak(opts: SpeakOptions): void;
  prefetch(opts: SpeakOptions): void; // заранее синтезировать реплику (по cacheId); убирает паузу
  clearCache(): void; // сбросить префетч-кэш (смена видео/языка/настроек темпа)
  cancel(): void; // прервать текущую и сбросить очередь движка
  pause(): void; // заморозить текущую реплику на месте (без перечитывания)
  resume(): void; // продолжить замороженную реплику с того же места
  isSpeaking(): boolean;
}

// Базовый код языка без региона: 'ru-RU' -> 'ru' (для сравнения дорожек/голосов).
function baseLang(code: string): string {
  return code.split('-')[0]?.toLowerCase() ?? code.toLowerCase();
}

// Защитный клам в пределах самого движка: музыкальный потолок (под слот/скорость
// видео) считает планировщик, движок лишь страхует от значений вне диапазона API.
function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) {
    return TTS_DEFAULT_RATE;
  }
  return Math.min(TTS_HARD_MAX_RATE, Math.max(TTS_HARD_MIN_RATE, rate));
}

// Клам живой коррекции темпа: не медленнее TTS_PLAYBACK_ADJUST_MIN, не быстрее предела движка.
function clampAdjust(adjust: number | undefined): number {
  if (adjust === undefined || !Number.isFinite(adjust)) {
    return 1;
  }
  return Math.min(TTS_HARD_MAX_RATE, Math.max(TTS_PLAYBACK_ADJUST_MIN, adjust));
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return 1;
  }
  return Math.min(1, Math.max(0, volume));
}

// Дождаться, пока список голосов наполнится (getVoices() часто пуст до 'voiceschanged').
export function ensureVoicesLoaded(synth: SpeechSynthesis = window.speechSynthesis): Promise<void> {
  if (synth.getVoices().length > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    function onChange(): void {
      synth.removeEventListener('voiceschanged', onChange);
      resolve();
    }
    synth.addEventListener('voiceschanged', onChange);
  });
}

// Подобрать голос: точное имя из настроек → Neural на нужный язык → любой на язык.
// null — подходящего нет; движок озвучит системным голосом по utterance.lang.
function resolveVoice(
  synth: SpeechSynthesis,
  voiceName: string,
  lang: string,
): SpeechSynthesisVoice | null {
  const voices = synth.getVoices();
  if (voices.length === 0) {
    return null;
  }
  if (voiceName !== '') {
    const exact = voices.find((voice) => voice.name === voiceName);
    if (exact !== undefined) {
      return exact;
    }
  }
  const base = baseLang(lang);
  const sameLang = voices.filter((voice) => baseLang(voice.lang) === base);
  const neural = sameLang.find((voice) => voice.name.toLowerCase().includes(TTS_NEURAL_HINT));
  return neural ?? sameLang[0] ?? null;
}

// Результат подбора голоса — для уведомления пользователю о fallback (Стадия 4).
export interface VoiceResolution {
  voice: SpeechSynthesisVoice | null; // выбранный голос (null — системный по языку)
  requestedFound: boolean; // нашёлся ли именно запрошенный голос из настроек
  isNeural: boolean; // выбранный голос — Microsoft Neural
}

// Описать, какой голос будет использован (для проверки при запуске и уведомлений).
export function describeVoice(
  voiceName: string,
  lang: string,
  synth: SpeechSynthesis = window.speechSynthesis,
): VoiceResolution {
  const voice = resolveVoice(synth, voiceName, lang);
  return {
    voice,
    requestedFound: voiceName !== '' && voice !== null && voice.name === voiceName,
    isNeural: voice !== null && voice.name.toLowerCase().includes(TTS_NEURAL_HINT),
  };
}

// Реализация поверх Web Speech API (speechSynthesis).
export class WebSpeechEngine implements TtsEngine {
  private readonly synth: SpeechSynthesis;

  constructor(synth: SpeechSynthesis = window.speechSynthesis) {
    this.synth = synth;
  }

  speak(opts: SpeakOptions): void {
    const utterance = new SpeechSynthesisUtterance(opts.text);
    const voice = resolveVoice(this.synth, opts.voiceName, opts.lang);
    if (voice !== null) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = opts.lang; // нет голоса под язык — пусть система выберет сама
    }
    utterance.volume = clampVolume(opts.volume);
    // Web Speech синтезирует в момент старта — живую коррекцию вносим прямо в rate.
    utterance.rate = clampRate(opts.rate * clampAdjust(opts.speedAdjust));

    utterance.onstart = (): void => opts.onStart?.();
    // Конец и ошибку (в т.ч. обрыв через cancel) трактуем одинаково: реплика
    // больше не звучит — планировщику нужно восстановить громкость и идти дальше.
    utterance.onend = (): void => opts.onEnd?.();
    utterance.onerror = (): void => opts.onEnd?.();

    this.synth.speak(utterance);
  }

  // Web Speech синтезирует локально и мгновенно — префетч/кэш не нужны.
  prefetch(): void {
    /* no-op */
  }

  clearCache(): void {
    /* no-op */
  }

  cancel(): void {
    this.synth.cancel();
  }

  pause(): void {
    this.synth.pause();
  }

  resume(): void {
    this.synth.resume();
  }

  isSpeaking(): boolean {
    return this.synth.speaking || this.synth.pending;
  }
}

// Голос Edge по умолчанию для языка (первый в каталоге): 'ru' → 'ru-RU-DmitryNeural'.
function edgeVoiceFor(lang: string): string {
  return EDGE_VOICE_CATALOG[baseLang(lang)]?.[0]?.id ?? EDGE_TTS_DEFAULT_VOICE;
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

// Edge нейронный TTS (Стадия 4, путь B). Синтез делает background (websocket к Microsoft),
// сюда приходит MP3 — играем через <audio>. Темп запекается в синтез; громкость/пауза — на
// элементе (ducking оригинала живёт отдельно в планировщике).
//
// При выбранном Edge подмены системным голосом (Web Speech) НЕТ: на сбое синтеза (после ретраев
// в edge-tts.synthesize) реплика молча пропускается — иначе в нейронной озвучке проскакивали
// бы отдельные реплики системным голосом (Irina/Pavel), что звучит чужеродно.
const PREFETCH_CACHE_LIMIT = EDGE_TTS_PREFETCH_CACHE_LIMIT;

export class EdgeTtsEngine implements TtsEngine {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private speakingFlag = false;
  private generation = 0; // смена инвалидирует in-flight синтез/коллбэки прерванной реплики
  // Префетч-кэш: cacheId -> уже идущий/готовый синтез (base64 MP3 или null при ошибке).
  private readonly cache = new Map<string, Promise<string | null>>();

  // Запросить синтез у background (с мемоизацией по cacheId, чтобы prefetch и speak не дублировали).
  private fetchAudio(opts: SpeakOptions): Promise<string | null> {
    const key = opts.cacheId;
    if (key !== undefined) {
      const existing = this.cache.get(key);
      if (existing !== undefined) {
        return existing;
      }
    }
    const request: TtsSynthMessage = {
      type: 'tts-synth',
      text: opts.text,
      // voiceName задаёт планировщик (выбранный голос Edge); пусто — авто по языку.
      voice: opts.voiceName !== '' ? opts.voiceName : edgeVoiceFor(opts.lang),
      rate: clampRate(opts.rate),
    };
    const promise = browser.runtime
      .sendMessage(request)
      .then((raw) => {
        const response = raw as TtsSynthResponse | undefined;
        return response?.ok === true ? response.audio : null;
      })
      .catch(() => null);
    if (key !== undefined) {
      this.cache.set(key, promise);
      // Ограничиваем размер кэша (выкидываем самые старые ключи).
      while (this.cache.size > PREFETCH_CACHE_LIMIT) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.cache.delete(oldest);
      }
    }
    return promise;
  }

  // Заранее синтезировать реплику (пока играет текущая) — убирает сетевую паузу перед ней.
  prefetch(opts: SpeakOptions): void {
    void this.fetchAudio(opts);
  }

  clearCache(): void {
    this.cache.clear();
  }

  speak(opts: SpeakOptions): void {
    this.cancel(); // прервать предыдущую (и поднять generation); кэш НЕ трогаем
    this.speakingFlag = true;
    const generation = this.generation;
    void this.run(opts, generation);
  }

  private async run(opts: SpeakOptions, generation: number): Promise<void> {
    try {
      const audioBase64 = await this.fetchAudio(opts); // из кэша (префетч) или новый запрос
      if (generation !== this.generation) {
        return; // прервано, пока шёл синтез
      }
      if (audioBase64 === null) {
        throw new Error('нет аудио');
      }
      const url = URL.createObjectURL(base64ToBlob(audioBase64, EDGE_TTS_AUDIO_MIME));
      const audio = new Audio(url);
      audio.volume = clampVolume(opts.volume);
      // Живая коррекция темпа поверх запечённого rate — ускоряет/замедляет готовое MP3 без
      // пересинтеза, чтобы догнать видео. preservesPitch сохраняет высоту голоса при ускорении.
      audio.preservesPitch = true;
      audio.playbackRate = clampAdjust(opts.speedAdjust);
      this.audio = audio;
      this.objectUrl = url;
      if (opts.cacheId !== undefined) {
        this.cache.delete(opts.cacheId); // воспроизводится — освобождаем слот
      }
      audio.onplay = (): void => {
        if (generation === this.generation) {
          opts.onStart?.();
        }
      };
      const done = (): void => {
        if (generation !== this.generation) {
          return;
        }
        this.release();
        opts.onEnd?.();
      };
      audio.onended = done;
      audio.onerror = done;
      await audio.play().catch(() => done());
    } catch (error: unknown) {
      if (generation !== this.generation) {
        return; // прервано — реагировать не нужно
      }
      // Синтез не удался даже после ретраев — реплику ПРОПУСКАЕМ (без подмены Web Speech).
      // Планировщику сообщаем «конец реплики», чтобы он снял ducking и перешёл к следующей.
      console.warn('[Mnemosyne] edge-tts недоступен — реплика пропущена', error);
      this.release();
      opts.onEnd?.();
    }
  }

  // Освободить аудио-ресурсы текущей реплики (без смены generation).
  private release(): void {
    this.speakingFlag = false;
    if (this.audio !== null) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.onplay = null;
      this.audio = null;
    }
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  cancel(): void {
    this.generation += 1; // глушим коллбэки in-flight реплики
    if (this.audio !== null) {
      this.audio.pause();
    }
    this.release();
  }

  pause(): void {
    this.audio?.pause();
  }

  resume(): void {
    void this.audio?.play();
  }

  isSpeaking(): boolean {
    return this.speakingFlag;
  }
}

// Движок с возможностью переключения реализации на лету (выбор в popup).
export interface SwitchableTtsEngine extends TtsEngine {
  setEngine(name: TtsEngineName): void;
}

// Маршрутизатор: держит обе реализации и делегирует активной. Переключение прерывает текущую речь.
class CompositeTtsEngine implements SwitchableTtsEngine {
  private readonly edge = new EdgeTtsEngine();
  private readonly web = new WebSpeechEngine();
  private active: TtsEngine = this.edge;

  setEngine(name: TtsEngineName): void {
    const next = name === 'webspeech' ? this.web : this.edge;
    if (next !== this.active) {
      this.active.cancel();
      this.active = next;
    }
  }

  speak(opts: SpeakOptions): void {
    this.active.speak(opts);
  }
  prefetch(opts: SpeakOptions): void {
    this.active.prefetch(opts);
  }
  clearCache(): void {
    this.edge.clearCache();
    this.web.clearCache();
  }
  cancel(): void {
    this.active.cancel();
  }
  pause(): void {
    this.active.pause();
  }
  resume(): void {
    this.active.resume();
  }
  isSpeaking(): boolean {
    return this.active.isSpeaking();
  }
}

// Фабрика движка — планировщик зависит от интерфейса, а не от конкретных классов.
export function createTtsEngine(): SwitchableTtsEngine {
  return new CompositeTtsEngine();
}
