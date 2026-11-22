import { describe, expect, it } from 'vitest';
import {
  CMD,
  batteryPercent,
  decodeMessage,
  encodeCommand,
  parseBatteryMv,
  TimestampUnwrapper,
} from '../src/tindeq/protocol';
import {
  asymmetryWatch,
  bandStatus,
  criticalForce,
  detectForceDrop,
  downsample,
  meanForce,
  peak,
  repStat,
  timeUnderLoadS,
  type Pt,
  type RepStat,
} from '../src/tindeq/forceAnalysis';
import { Progressor, type BleTransport } from '../src/tindeq/progressor';
import { RepeaterMonitor } from '../src/tindeq/repeaterMonitor';
import type { BenchmarkResult } from '../src/data/schema';

function weightPacket(samples: [number, number][]): DataView {
  const buf = new ArrayBuffer(2 + samples.length * 8);
  const v = new DataView(buf);
  v.setUint8(0, 1);
  v.setUint8(1, samples.length * 8);
  samples.forEach(([kg, us], i) => {
    v.setFloat32(2 + i * 8, kg, true);
    v.setUint32(2 + i * 8 + 4, us, true);
  });
  return v;
}

describe('protocol', () => {
  it('encodes TLV commands', () => {
    expect([...encodeCommand(CMD.START_WEIGHT_MEAS)]).toEqual([101, 0]);
    expect([...encodeCommand(CMD.TARE_SCALE)]).toEqual([100, 0]);
  });
  it('decodes little-endian weight samples', () => {
    const m = decodeMessage(weightPacket([[12.5, 1000], [13.25, 13500]]));
    expect(m.type).toBe('weight');
    if (m.type === 'weight') {
      expect(m.samples.map((s) => s.kg)).toEqual([12.5, 13.25]);
      expect(m.samples.map((s) => s.us)).toEqual([1000, 13500]);
    }
  });
  it('decodes battery responses and low-power warnings', () => {
    const v = new DataView(new Uint8Array([0, 4, 0x68, 0x10, 0, 0]).buffer); // 0x1068 = 4200 mV
    const m = decodeMessage(v);
    expect(m.type).toBe('command_response');
    if (m.type === 'command_response') expect(parseBatteryMv(m.payload)).toBe(4200);
    expect(batteryPercent(4200)).toBe(100);
    expect(batteryPercent(3600)).toBe(50);
    expect(decodeMessage(new DataView(new Uint8Array([4, 0]).buffer)).type).toBe('low_power');
  });
  it('unwraps the uint32 microsecond counter', () => {
    const u = new TimestampUnwrapper();
    expect(u.toMs(0xfffff000)).toBe(0);
    expect(u.toMs(0x00001000)).toBe(8.192);
  });
});

/* ---------------- synthetic curves ---------------- */

function hang(target: number, durS: number, hz = 80, from = 0): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= durS * hz; i++) {
    const t = from + (i * 1000) / hz;
    const ramp = Math.min(1, (t - from) / 300);
    pts.push({ t, f: target * ramp });
  }
  return pts;
}

/** Repeater test: 7 s on / 3 s off; force decays linearly from start to end kg. */
function repeaterCurve(reps: number, startKg: number, endKg: number, hz = 40): { pts: Pt[]; windows: [number, number][] } {
  const pts: Pt[] = [];
  const windows: [number, number][] = [];
  for (let r = 0; r < reps; r++) {
    const kg = startKg + ((endKg - startKg) * r) / Math.max(1, reps - 1);
    const s = r * 10_000;
    windows.push([s, s + 7000]);
    pts.push(...hang(kg, 7, hz, s));
    for (let i = 1; i < 3 * hz; i++) pts.push({ t: s + 7000 + (i * 1000) / hz, f: 0 });
  }
  return { pts, windows };
}

describe('force analysis', () => {
  it('peak, mean, time under load', () => {
    const pts = hang(40, 10);
    expect(peak(pts)).toBe(40);
    expect(Math.round(meanForce(pts))).toBe(39);
    expect(Math.round(timeUnderLoadS(pts))).toBe(10);
  });
  it('target band', () => {
    expect(bandStatus(0.5, 40)).toBe('idle');
    expect(bandStatus(37, 40)).toBe('below');
    expect(bandStatus(40.5, 40)).toBe('in');
    expect(bandStatus(43, 40)).toBe('above');
  });
  it('force-drop detection stops after 2 consecutive failed reps', () => {
    const { pts, windows } = repeaterCurve(10, 40, 28);
    const reps: RepStat[] = windows.map(([a, b], i) => repStat(pts, i, a, b));
    const early = detectForceDrop(reps.slice(0, 5), null);
    expect(early.stop).toBe(false);
    const all = detectForceDrop(reps, null);
    expect(all.stop).toBe(true);
    expect(all.referenceKg! > 39).toBe(true);
  });
  it('a let-go (hand off mid-rep) counts as a failed rep', () => {
    const pts = [...hang(40, 2), ...Array.from({ length: 200 }, (_, i) => ({ t: 2000 + i * 25, f: 0 }))];
    const r = repStat(pts, 0, 0, 7000);
    expect(r.loadedFraction < 0.6).toBe(true);
    expect(detectForceDrop([r, r], 40).stop).toBe(true);
  });
  it('critical force = mean of last 6 reps of an all-out test', () => {
    const { pts, windows } = repeaterCurve(24, 50, 20);
    const reps = windows.map(([a, b], i) => repStat(pts, i, a, b));
    const cf = criticalForce(reps)!;
    expect(cf.peakKg).toBe(50);
    expect(cf.cfKg > 20 && cf.cfKg < 25).toBe(true);
    expect(criticalForce(reps.slice(0, 8))).toBeNull();
  });
  it('downsampling keeps the exact peak and bounds size', () => {
    const pts = hang(42.3, 30, 80);
    pts[1234] = { t: pts[1234].t, f: 55.5 };
    const d = downsample(pts, 400);
    expect(d.length <= 400).toBe(true);
    expect(peak(d)).toBe(55.5);
  });
  it('live repeater monitor', () => {
    const { pts, windows } = repeaterCurve(10, 40, 28);
    const m = new RepeaterMonitor(null);
    pts.forEach((p) => m.addSample(p));
    let stopAt = -1;
    windows.forEach(([a, b], i) => {
      m.workStarted(a);
      const r = m.workEnded(b)!;
      if (r.decision.stop && stopAt < 0) stopAt = i;
    });
    expect(stopAt > 4).toBe(true);
  });
});

describe('asymmetry watch (experimental)', () => {
  const b = (date: string, hand: 'left' | 'right', value: number): BenchmarkResult => ({
    id: date + hand, createdAt: '', updatedAt: date, date, type: 'tindeq_peak_force', value, unit: 'kg', bodyMassKg: 74, hand, source: 'tindeq',
  });
  it('flags a > 10 % left/right gap and a drop vs own baseline, as watch signals', () => {
    const hist = [b('2026-10-01', 'left', 50), b('2026-10-01', 'right', 51), b('2026-10-20', 'left', 51), b('2026-10-20', 'right', 52),
      b('2026-11-20', 'left', 50), b('2026-11-20', 'right', 44)];
    const w = asymmetryWatch(hist, '2026-11-21');
    expect(w.asymmetryWatch).toBe(true);
    expect(w.baselineWatch.right).toBe(true);
    expect(w.baselineWatch.left).toBe(false);
    expect(w.experimental).toBe(true);
    expect(w.messages.every((m) => m.includes('Watch signal only'))).toBe(true);
  });
  it('no baseline with fewer than 2 previous tests', () => {
    const w = asymmetryWatch([b('2026-11-20', 'left', 50), b('2026-11-20', 'right', 49)], '2026-11-21');
    expect(w.baseline.left).toBeNull();
    expect(w.asymmetryWatch).toBe(false);
  });
});

/* ---------------- Progressor client with a fake transport ---------------- */

class FakeTransport implements BleTransport {
  connected = false;
  written: number[][] = [];
  failConnects = 0;
  private notify: ((v: DataView) => void) | null = null;
  private disc: (() => void) | null = null;
  async connect() {
    if (this.failConnects > 0) {
      this.failConnects--;
      throw new Error('fail');
    }
    this.connected = true;
    return { id: 'dev1', name: 'Progressor_1234' };
  }
  async disconnect() {
    this.connected = false;
  }
  async write(bytes: Uint8Array) {
    this.written.push([...bytes]);
    if (bytes[0] === CMD.GET_BATTERY_VOLTAGE) queueMicrotask(() => this.notify?.(new DataView(new Uint8Array([0, 4, 0xd0, 0x0f, 0, 0]).buffer)));
  }
  onNotify(cb: (v: DataView) => void) {
    this.notify = cb;
  }
  onDisconnect(cb: () => void) {
    this.disc = cb;
  }
  push(v: DataView) {
    this.notify?.(v);
  }
  drop() {
    this.connected = false;
    this.disc?.();
  }
}

describe('Progressor client', () => {
  it('connects, reads battery, streams, tares in software, records a curve', async () => {
    const t = new FakeTransport();
    const p = new Progressor(t, { sleep: async () => undefined });
    expect(await p.connect(null)).toBe(true);
    expect(p.snapshot.batteryMv).toBe(4048);
    await p.startStream();
    expect(t.written.some((w) => w[0] === 101)).toBe(true);
    t.push(weightPacket([[1.0, 0], [1.0, 100_000], [1.0, 200_000], [1.0, 300_000]]));
    await p.tare();
    p.startRecording();
    t.push(weightPacket([[31.0, 400_000], [41.0, 500_000], [36.0, 600_000]]));
    const curve = p.stopRecording();
    expect(curve.map((c) => c.f)).toEqual([30, 40, 35]);
    expect(curve[0].t).toBe(0);
    expect(p.snapshot.peakKg).toBe(40);
    expect(p.snapshot.currentKg).toBe(35);
  });

  it('auto-reconnects after an unexpected disconnect and resumes the stream', async () => {
    const t = new FakeTransport();
    const p = new Progressor(t, { sleep: async () => undefined });
    await p.connect(null);
    await p.startStream();
    t.failConnects = 1;
    t.drop();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(p.snapshot.state).toBe('connected');
    expect(t.written.filter((w) => w[0] === 101)).toHaveLength(2);
  });

  it('reports "lost" with wake-up instructions after all retries fail', async () => {
    const t = new FakeTransport();
    const p = new Progressor(t, { sleep: async () => undefined });
    await p.connect(null);
    t.failConnects = 99;
    t.drop();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(p.snapshot.state).toBe('lost');
    expect(p.snapshot.error!.includes('Press the Progressor button')).toBe(true);
  });

  it('without Web Bluetooth the client is "unsupported" (manual entry fallback)', async () => {
    const p = new Progressor(null);
    expect(p.snapshot.state).toBe('unsupported');
    expect(await p.connect(null)).toBe(false);
  });
});
