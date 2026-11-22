/**
 * Progressor client. Transport-agnostic (see BleTransport) so the logic is unit-tested with a
 * fake transport; the browser uses WebBluetoothTransport (webBluetooth.ts).
 *
 * Features: connect / one-tap reconnect, force stream started AUTOMATICALLY on connect (live kg
 * everywhere without an extra tap), automatic zero at stream start when nothing hangs on the
 * device, software tare (default) or device tare, battery, low-power warning, automatic
 * reconnection after an unexpected disconnect, recording of force curves with live peak.
 *
 * Auto-shutdown: the Progressor powers off after ~10 min of inactivity when NOT connected
 * (published API notes). If reconnection fails, the UI asks the user to press the device button.
 */
import { thresholds } from '../config';
import { CMD, decodeMessage, encodeCommand, parseBatteryMv, parseText, TimestampUnwrapper, type CommandCode, type ProgressorMessage } from './protocol';
import type { Pt } from './forceAnalysis';

export interface BleTransport {
  /** Pick (or silently re-acquire) a device and open GATT. Returns device id + name. */
  connect(opts: { rememberedId: string | null; interactive: boolean }): Promise<{ id: string; name: string }>;
  disconnect(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  onNotify(cb: (view: DataView) => void): void;
  onDisconnect(cb: () => void): void;
  readonly connected: boolean;
}

export type ConnState = 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'lost';

export interface ProgressorSnapshot {
  state: ConnState;
  deviceId: string | null;
  deviceName: string | null;
  streaming: boolean;
  currentKg: number;
  peakKg: number;
  batteryMv: number | null;
  lowPower: boolean;
  firmware: string | null;
  error: string | null;
}

type Listener = (s: ProgressorSnapshot) => void;
type SampleListener = (p: Pt) => void;

/** Samples used for the automatic zero at stream start (~0.3 s at 80 Hz). */
const AUTO_TARE_SAMPLES = 25;

export class Progressor {
  private snap: ProgressorSnapshot = {
    state: 'disconnected',
    deviceId: null,
    deviceName: null,
    streaming: false,
    currentKg: 0,
    peakKg: 0,
    batteryMv: null,
    lowPower: false,
    firmware: null,
    error: null,
  };
  private listeners = new Set<Listener>();
  private sampleListeners = new Set<SampleListener>();
  private pendingResponse: ((p: Uint8Array) => void) | null = null;
  private unwrap = new TimestampUnwrapper();
  private tareOffset = 0;
  private recent: Pt[] = [];
  private recording: Pt[] | null = null;
  private autoTareBuf: number[] | null = null;
  private manualDisconnect = false;
  private wantStream = false;
  private sleep: (ms: number) => Promise<void>;

  constructor(private transport: BleTransport | null, opts: { sleep?: (ms: number) => Promise<void> } = {}) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (!transport) this.snap.state = 'unsupported';
    transport?.onNotify((v) => this.handle(decodeMessage(v)));
    transport?.onDisconnect(() => void this.onUnexpectedDisconnect());
  }

  get snapshot(): ProgressorSnapshot {
    return { ...this.snap };
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.snapshot);
    return () => this.listeners.delete(l);
  }

  onSample(l: SampleListener): () => void {
    this.sampleListeners.add(l);
    return () => this.sampleListeners.delete(l);
  }

  private set(patch: Partial<ProgressorSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l(this.snapshot);
  }

  /** interactive=true must be called from a user gesture (Chrome device chooser). */
  async connect(rememberedId: string | null, interactive = true): Promise<boolean> {
    if (!this.transport) return false;
    this.manualDisconnect = false;
    this.set({ state: 'connecting', error: null });
    try {
      const d = await this.transport.connect({ rememberedId, interactive });
      this.set({ state: 'connected', deviceId: d.id, deviceName: d.name });
      await this.refreshBattery().catch(() => undefined);
    } catch (e) {
      this.set({ state: 'disconnected', error: e instanceof Error ? e.message : String(e) });
      return false;
    }
    // Live force from the moment the device is connected.
    try {
      await this.startStream();
    } catch (e) {
      this.set({ error: `Connected, but the force stream did not start: ${e instanceof Error ? e.message : String(e)}` });
    }
    return true;
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    this.wantStream = false;
    try {
      if (this.snap.streaming) await this.send(CMD.STOP_WEIGHT_MEAS);
    } catch {
      /* ignore */
    }
    await this.transport?.disconnect();
    this.set({ state: 'disconnected', streaming: false });
  }

  private async onUnexpectedDisconnect() {
    this.set({ streaming: false });
    if (this.manualDisconnect) return;
    const k = thresholds.tindeq;
    this.set({ state: 'reconnecting' });
    for (let i = 0; i < k.reconnectAttempts; i++) {
      await this.sleep(k.reconnectBackoffMs[Math.min(i, k.reconnectBackoffMs.length - 1)]);
      try {
        const d = await this.transport!.connect({ rememberedId: this.snap.deviceId, interactive: false });
        this.set({ state: 'connected', deviceId: d.id, deviceName: d.name, error: null });
        if (this.wantStream) await this.startStream();
        return;
      } catch {
        /* retry */
      }
    }
    this.set({ state: 'lost', error: 'Connection lost. Press the Progressor button to wake it (it powers off after ~10 min unconnected), then tap Reconnect.' });
  }

  private async send(code: CommandCode): Promise<void> {
    if (!this.transport?.connected) throw new Error('Progressor not connected');
    await this.transport.write(encodeCommand(code));
  }

  private request(code: CommandCode, timeoutMs = 1500): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponse = null;
        reject(new Error('Progressor did not answer'));
      }, timeoutMs);
      this.pendingResponse = (p) => {
        clearTimeout(timer);
        resolve(p);
      };
      this.send(code).catch((e) => {
        clearTimeout(timer);
        this.pendingResponse = null;
        reject(e);
      });
    });
  }

  async refreshBattery(): Promise<number | null> {
    if (this.snap.streaming) return this.snap.batteryMv; // avoid mixing responses with the stream
    const mv = parseBatteryMv(await this.request(CMD.GET_BATTERY_VOLTAGE));
    this.set({ batteryMv: mv });
    return mv;
  }

  async readFirmware(): Promise<string | null> {
    if (this.snap.streaming) return this.snap.firmware;
    const v = parseText(await this.request(CMD.GET_APP_VERSION));
    this.set({ firmware: v });
    return v;
  }

  async startStream(): Promise<void> {
    this.wantStream = true;
    this.unwrap.reset();
    this.recent = [];
    this.autoTareBuf = [];
    await this.send(CMD.START_WEIGHT_MEAS);
    this.set({ streaming: true, peakKg: 0 });
  }

  /** Start the stream if connected and not already streaming (safe to call repeatedly). */
  async ensureStream(): Promise<void> {
    if (this.snap.state === 'connected' && !this.snap.streaming) await this.startStream();
  }

  async stopStream(): Promise<void> {
    this.wantStream = false;
    if (this.transport?.connected) await this.send(CMD.STOP_WEIGHT_MEAS);
    this.set({ streaming: false });
  }

  /**
   * Software tare (default): zero = mean of the last ~0.5 s of raw readings. Works regardless of
   * firmware behaviour. `device=true` sends the device's TARE command instead (stream is
   * restarted around it to be safe across firmware versions).
   */
  async tare(device = false): Promise<void> {
    if (device) {
      const was = this.snap.streaming;
      if (was) await this.send(CMD.STOP_WEIGHT_MEAS);
      await this.sleep(150);
      await this.send(CMD.TARE_SCALE);
      await this.sleep(150);
      this.tareOffset = 0;
      if (was) await this.startStream();
      return;
    }
    const lastT = this.recent.length ? this.recent[this.recent.length - 1].t : 0;
    const win = this.recent.filter((p) => p.t >= lastT - 500);
    if (win.length) this.tareOffset = win.reduce((a, p) => a + p.f, 0) / win.length; // raw mean = new zero
    this.autoTareBuf = null;
    this.set({ currentKg: 0, peakKg: 0 });
  }

  resetPeak(): void {
    this.set({ peakKg: 0 });
  }

  /** Begin recording a force curve (e.g. at the start of a work phase / test). Starts the stream if needed. */
  startRecording(): void {
    this.recording = [];
    this.set({ peakKg: 0 });
    void this.ensureStream().catch((e) => this.set({ error: e instanceof Error ? e.message : String(e) }));
  }

  /** Stop recording; returns points with t relative to the first recorded sample. */
  stopRecording(): Pt[] {
    const pts = this.recording ?? [];
    this.recording = null;
    if (!pts.length) return [];
    const t0 = pts[0].t;
    return pts.map((p) => ({ t: p.t - t0, f: p.f }));
  }

  get isRecording(): boolean {
    return this.recording !== null;
  }

  /** Exposed for tests: feed a decoded message. */
  handle(msg: ProgressorMessage): void {
    switch (msg.type) {
      case 'weight': {
        let peakKg = this.snap.peakKg;
        let cur = this.snap.currentKg;
        for (const s of msg.samples) {
          const raw: Pt = { t: this.unwrap.toMs(s.us), f: s.kg };
          this.recent.push(raw);
          // Automatic zero at stream start, only if nothing hangs on the device.
          if (this.autoTareBuf) {
            this.autoTareBuf.push(s.kg);
            if (this.autoTareBuf.length >= AUTO_TARE_SAMPLES) {
              const buf = this.autoTareBuf;
              this.autoTareBuf = null;
              if (Math.max(...buf.map(Math.abs)) < thresholds.tindeq.loadOnsetKg) this.tareOffset = buf.reduce((a, x) => a + x, 0) / buf.length;
            }
          }
          const p: Pt = { t: raw.t, f: s.kg - this.tareOffset };
          cur = p.f;
          if (p.f > peakKg) peakKg = p.f;
          this.recording?.push(p);
          for (const l of this.sampleListeners) l(p);
        }
        if (this.recent.length > 400) this.recent.splice(0, this.recent.length - 400);
        this.set({ currentKg: Math.round(cur * 10) / 10, peakKg: Math.round(peakKg * 10) / 10 });
        break;
      }
      case 'command_response':
        if (this.pendingResponse) {
          const r = this.pendingResponse;
          this.pendingResponse = null;
          r(msg.payload);
        }
        break;
      case 'low_power':
        this.set({ lowPower: true });
        break;
      default:
        break;
    }
  }
}
