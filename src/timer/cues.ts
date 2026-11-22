/**
 * Audio / voice / vibration cues for the guided timer. Browser-only, all features optional:
 * every call is a no-op when the API is unavailable. Must be unlocked by a user gesture
 * (Chrome autoplay policy): call `cues.unlock()` from the "Start" button handler.
 */
import { thresholds } from '../config';
import type { TimerEvent } from './timerEngine';

export interface CueSettings {
  sound: boolean;
  voice: boolean;
  vibration: boolean;
}

export class Cues {
  private ctx: AudioContext | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  constructor(public settings: CueSettings = { sound: true, voice: true, vibration: true }) {}

  /** Create/resume the AudioContext and pick an English voice. Call on a user gesture. */
  unlock(): void {
    try {
      const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
      if (AC && !this.ctx) this.ctx = new AC();
      void this.ctx?.resume();
    } catch {
      this.ctx = null;
    }
    if ('speechSynthesis' in window) {
      const pick = () => {
        const voices = window.speechSynthesis.getVoices();
        const lang = thresholds.timer.voiceLang;
        this.voice = voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
      };
      pick();
      window.speechSynthesis.onvoiceschanged = pick;
      // Speaking an empty utterance inside the gesture unlocks speech on some Android builds.
      const u = new SpeechSynthesisUtterance('');
      window.speechSynthesis.speak(u);
    }
  }

  beep(freqHz: number, durationMs = 150, volume = 0.6): void {
    if (!this.settings.sound || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freqHz;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + durationMs / 1000);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + durationMs / 1000 + 0.02);
  }

  speak(text: string): void {
    if (!this.settings.voice || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang ?? thresholds.timer.voiceLang;
    u.rate = 1.15;
    window.speechSynthesis.speak(u);
  }

  vibrate(pattern: number[]): void {
    if (!this.settings.vibration || !('vibrate' in navigator)) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      /* ignore */
    }
  }

  /** Map timer events to cues. */
  handle(events: TimerEvent[]): void {
    const t = thresholds.timer;
    for (const e of events) {
      if (e.type === 'countdown') {
        this.beep(t.beepCountHz, 90);
        if (e.phase.kind === 'work' || e.phase.kind === 'prepare' || e.phase.kind === 'setRest' || e.phase.kind === 'rest') this.speak(String(e.secondsLeft));
      } else if (e.type === 'phase_start') {
        if (e.phase.kind === 'work') {
          this.beep(t.beepWorkHz, 300);
          this.vibrate(t.vibrateWorkMs);
        } else if (e.phase.kind === 'rest' || e.phase.kind === 'setRest') {
          this.beep(t.beepRestHz, 300);
          this.vibrate(t.vibrateRestMs);
          if (e.phase.kind === 'setRest') this.speak('Rest');
        }
      } else if (e.type === 'done') {
        this.beep(t.beepWorkHz, 150);
        setTimeout(() => this.beep(t.beepWorkHz * 1.25, 300), 180);
        this.vibrate([150, 80, 150, 80, 300]);
        this.speak('Done');
      }
    }
  }
}
