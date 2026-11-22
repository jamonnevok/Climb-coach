import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../src/data/storage';
import { Repo } from '../src/data/repo';
import { mergeSnapshots } from '../src/data/merge';
import type { ClimbLog, SessionLog, Settings, Snapshot } from '../src/data/schema';
import { connectGist, DATA_FILE, GARMIN_FILE, GIST_DESCRIPTION, GistClient, sync, SyncError, type FetchLike, type Gist } from '../src/sync/gist';
import { collectDated, importGarmin, parseGarmin, type GarminRaw } from '../src/sync/garmin';
import { buildCsvFiles, cell, crc32, toCsv, zipFiles } from '../src/sync/csv';
import { createBackup, KEEP_BACKUPS, maybeWeeklyBackup, MemoryBackupStore } from '../src/sync/backup';
import { getDeviceState, setDeviceState } from '../src/sync/deviceState';

/* ---------------- fake GitHub ---------------- */

class FakeGitHub {
  gists = new Map<string, Gist>();
  calls: string[] = [];
  nextId = 1;
  fail: number | null = null;
  fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${url.replace('https://api.github.com', '')}`);
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (this.fail) return reply(this.fail, { message: 'nope' });
    if (url.startsWith('https://raw/')) return reply(200, this.raw.get(url) ?? '');
    const m = url.match(/\/gists\/([^?]+)$/);
    if (method === 'GET' && url.includes('/gists?')) return reply(200, [...this.gists.values()]);
    if (method === 'POST') {
      const body = JSON.parse(init!.body!) as { description: string; public: boolean; files: Record<string, { content: string }> };
      const id = `g${this.nextId++}`;
      const g: Gist = { id, description: body.description, public: body.public, updated_at: '', files: {} };
      for (const [k, v] of Object.entries(body.files)) g.files[k] = { filename: k, content: v.content };
      this.gists.set(id, g);
      return reply(201, g);
    }
    if (m) {
      const g = this.gists.get(decodeURIComponent(m[1]));
      if (!g) return reply(404, {});
      if (method === 'PATCH') {
        const body = JSON.parse(init!.body!) as { files: Record<string, { content: string } | null> };
        for (const [k, v] of Object.entries(body.files)) {
          if (v === null) delete g.files[k];
          else g.files[k] = { filename: k, content: v.content };
        }
      }
      return reply(200, JSON.parse(JSON.stringify(g)));
    }
    return reply(404, {});
  };
  raw = new Map<string, string>();
}

function device(iso: string) {
  let now = new Date(iso);
  const repo = new Repo(new MemoryStorage(), () => now);
  return { repo, tick: (s: string) => (now = new Date(s)) };
}

const climb = (grade: string): Omit<ClimbLog, 'id' | 'createdAt' | 'updatedAt'> => ({
  date: '2026-11-20', discipline: 'route', grade, style: 'redpoint', angle: 'vertical', setting: 'outdoor', grips: ['half_crimp'], attempts: 2,
});

/* ---------------- merge: device-local settings ---------------- */

describe('merge keeps device-local settings', () => {
  it('takes shared fields from the newer record but keeps local tindeq/sync/backup', async () => {
    const a = device('2026-11-20T10:00:00Z');
    const b = device('2026-11-21T10:00:00Z');
    await a.repo.updateSettings({ tindeq: { deviceId: 'phone-tindeq', deviceName: 'Progressor_A' } });
    await b.repo.updateSettings({ theme: 'light', tindeq: { deviceId: null, deviceName: null } });
    const sa = await a.repo.exportSnapshot();
    const sb = await b.repo.exportSnapshot();
    const { merged } = mergeSnapshots(sa, sb);
    const s = merged.stores.settings[0] as Settings;
    expect(s.theme).toBe('light'); // newer shared value from B
    expect(s.tindeq.deviceId).toBe('phone-tindeq'); // A's own device
  });
});

/* ---------------- gist sync ---------------- */

describe('gist sync', () => {
  it('first device creates a private gist; second device finds it and both converge', async () => {
    const gh = new FakeGitHub();
    const client = new GistClient('tok', gh.fetch);
    const phone = device('2026-11-21T08:00:00Z');
    await phone.repo.getSettings();
    await phone.repo.save('climbs', climb('7a'));
    const c1 = await connectGist(phone.repo, client, null);
    expect(c1.created).toBe(true);
    const g = gh.gists.get(c1.gistId)!;
    expect(g.public).toBe(false);
    expect(g.description).toBe(GIST_DESCRIPTION);

    const laptop = device('2026-11-21T09:00:00Z');
    await laptop.repo.save('climbs', climb('7b'));
    const c2 = await connectGist(laptop.repo, client, null);
    expect(c2.gistId).toBe(c1.gistId);
    expect(c2.created).toBe(false);
    const r2 = await sync(laptop.repo, client, c2.gistId);
    expect(r2.pulled!.added > 0).toBe(true);
    expect((await laptop.repo.list('climbs')).length).toBe(2);

    phone.tick('2026-11-21T10:00:00Z');
    await sync(phone.repo, client, c1.gistId, () => new Date('2026-11-21T10:00:00Z'));
    expect((await phone.repo.list('climbs')).map((c) => c.grade).sort()).toEqual(['7a', '7b']);
    expect(getDeviceState().gistId).toBe(c1.gistId);
    expect(getDeviceState().lastSyncAt).toBe('2026-11-21T10:00:00.000Z');
  });

  it('deletions propagate through the gist', async () => {
    const gh = new FakeGitHub();
    const client = new GistClient('tok', gh.fetch);
    const a = device('2026-11-21T08:00:00Z');
    const c = await a.repo.save('climbs', climb('6c'));
    const { gistId } = await connectGist(a.repo, client, null);
    const b = device('2026-11-21T09:00:00Z');
    await sync(b.repo, client, gistId);
    expect(await b.repo.list('climbs')).toHaveLength(1);
    a.tick('2026-11-21T11:00:00Z');
    await a.repo.softDelete('climbs', c.id);
    await sync(a.repo, client, gistId);
    b.tick('2026-11-21T12:00:00Z');
    await sync(b.repo, client, gistId);
    expect(await b.repo.list('climbs')).toHaveLength(0);
  });

  it('reads truncated (> 1 MB) files from raw_url', async () => {
    const gh = new FakeGitHub();
    const client = new GistClient('tok', gh.fetch);
    const src = device('2026-11-21T08:00:00Z');
    await src.repo.save('climbs', climb('7c'));
    const snap = await src.repo.exportSnapshot();
    gh.gists.set('big', { id: 'big', description: GIST_DESCRIPTION, public: false, updated_at: '', files: { [DATA_FILE]: { filename: DATA_FILE, truncated: true, content: '{"cut', raw_url: 'https://raw/big' } } });
    gh.raw.set('https://raw/big', JSON.stringify(snap));
    const dst = device('2026-11-21T09:00:00Z');
    await sync(dst.repo, client, 'big');
    expect((await dst.repo.list('climbs'))[0].grade).toBe('7c');
  });

  it('maps HTTP errors to helpful messages', async () => {
    const gh = new FakeGitHub();
    gh.fail = 401;
    const client = new GistClient('bad', gh.fetch);
    await expect(client.get('x')).rejects.toThrow(/Token invalid/);
    gh.fail = 404;
    let err: unknown = null;
    try {
      await client.get('x');
    } catch (e) {
      err = e;
    }
    expect(err instanceof SyncError && err.status === 404).toBe(true);
  });

  it('imports Garmin nights from the gist during sync', async () => {
    const gh = new FakeGitHub();
    const client = new GistClient('tok', gh.fetch);
    const a = device('2026-11-21T08:00:00Z');
    const { gistId } = await connectGist(a.repo, client, null);
    gh.gists.get(gistId)!.files[GARMIN_FILE] = { filename: GARMIN_FILE, content: JSON.stringify(RAW) };
    const r = await sync(a.repo, client, gistId);
    expect(r.garmin!.saved).toBe(2);
    const sleep = (await a.repo.list('sleep')).sort((x, y) => x.date.localeCompare(y.date));
    expect(sleep.map((s) => s.id)).toEqual(['sleep-2026-11-20-garmin', 'sleep-2026-11-21-garmin']);
    const again = await sync(a.repo, client, gistId);
    expect(again.garmin!.saved).toBe(0); // unchanged nights are not rewritten
  });
});

/* ---------------- garmin parser ---------------- */

const RAW: GarminRaw = {
  version: 1,
  fetchedAt: '2026-11-21T05:20:00Z',
  from: '2026-11-12',
  to: '2026-11-21',
  sleep: [
    { calendarDate: '2026-11-20', sleepTimeSeconds: 25920, sleepScores: { overall: { value: 81 } } },
    { dailySleepDTO: { calendarDate: '2026-11-21', sleepTimeSeconds: 21600, overallSleepScore: 64 } },
    { calendarDate: '2026-11-19' }, // no duration -> ignored for sleep
  ],
  hrv: { hrvSummaries: [{ calendarDate: '2026-11-20', lastNightAvg: 58 }, { calendarDate: '2026-11-21', lastNightAvg: 49 }] },
  daily: [
    { calendarDate: '2026-11-20', restingHeartRate: 47, bodyBatteryHighestValue: 88 },
    { calendarDate: '2026-11-21', restingHeartRate: 52 },
  ],
  errors: {},
};

describe('garmin parser', () => {
  it('collects dated objects at any depth', () => {
    expect(collectDated(RAW.hrv)).toHaveLength(2);
  });

  it('merges sleep, HRV and daily values per night; missing stays missing', () => {
    const days = parseGarmin(RAW);
    const d20 = days.find((d) => d.date === '2026-11-20')!;
    expect([d20.sleepH, d20.sleepScore, d20.hrvMs, d20.restingHr, d20.bodyBatteryHigh]).toEqual([7.2, 81, 58, 47, 88]);
    const d21 = days.find((d) => d.date === '2026-11-21')!;
    expect(d21.sleepH).toBe(6);
    expect(d21.sleepScore).toBe(64);
    expect(d21.bodyBatteryHigh).toBeUndefined();
  });

  it('reports fetch errors and survives invalid JSON', async () => {
    const r = device('2026-11-21T08:00:00Z');
    const bad = await importGarmin(r.repo, '{not json');
    expect(bad.errors).toEqual(['garmin-raw.json is not valid JSON']);
    const partial = await importGarmin(r.repo, JSON.stringify({ ...RAW, hrv: null, errors: { hrv: 'HTTP 429' } }));
    expect(partial.errors).toEqual(['hrv: HTTP 429']);
    expect(partial.saved).toBe(2);
  });
});

/* ---------------- CSV + zip ---------------- */

const session = (p: Partial<SessionLog>): SessionLog => ({
  id: 's1', createdAt: '', updatedAt: '', date: '2026-11-17', startedAt: null, kind: 'training', durationMin: 85, sessionRPE: 7.5, location: 'gym',
  sets: [{ id: 'x', exerciseId: 'max_hang_20_hc', setIndex: 0, completed: true, reps: 1, workS: 10, load: { mode: 'added_kg', value: 12.5 }, grip: 'half_crimp', rpe: 8, at: '' }],
  globalLoad: 638, fingerLoad: 43.25, restrictedGripLoad: 0, source: 'guided', notes: 'felt "strong"; A2 ok', ...p,
});

describe('csv', () => {
  const o = { decimalComma: true };
  it('escapes semicolons, quotes and line breaks; decimal comma', () => {
    expect(cell(7.5, o)).toBe('7,5');
    expect(cell(7.5, { decimalComma: false })).toBe('7.5');
    expect(cell('a;b', o)).toBe('"a;b"');
    expect(cell('say "hi"', o)).toBe('"say ""hi"""');
    expect(cell('x\ny', o)).toBe('"x\ny"');
    expect(cell(null, o)).toBe('');
    expect(toCsv(['a', 'b'], [[1.5, 'z']], o)).toBe('\uFEFFa;b\r\n1,5;z\r\n');
  });

  it('builds the 8 tables with one row per set and weekly totals', () => {
    const snap = { stores: { sessions: [session({}), session({ id: 's2', date: '2026-11-19', globalLoad: 400, fingerLoad: 10 }), session({ id: 'dead', deleted: true })], climbs: [], checkins: [], sleep: [], benchmarks: [], pain: [] } } as unknown as Snapshot;
    const files = buildCsvFiles(snap, o);
    expect(Object.keys(files).sort()).toEqual(['benchmarks.csv', 'checkins.csv', 'climbs.csv', 'pain.csv', 'sessions.csv', 'sets.csv', 'sleep.csv', 'weekly_load.csv']);
    const lines = files['sessions.csv'].trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"felt ""strong""; A2 ok"');
    expect(lines[1]).toContain(';7,5;638;43,25;');
    expect(files['sets.csv'].trim().split('\r\n')[1]).toContain(';added_kg;12,5;half_crimp;');
    expect(files['weekly_load.csv'].trim().split('\r\n')[1]).toBe('2026-11-16;2026-11-22;2;170;1038;53,3;0');
  });

  it('zip: valid structure and CRC', () => {
    expect(crc32(new TextEncoder().encode('123456789')).toString(16)).toBe('cbf43926');
    const z = zipFiles({ 'a.csv': 'x;y\r\n', 'b.csv': 'é' });
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(v.getUint16(z.length - 12, true)).toBe(2);
  });
});

/* ---------------- backups ---------------- */

describe('weekly backup', () => {
  it('runs once per 7 days and keeps the last 8', async () => {
    setDeviceState({ lastAutoBackupAt: null });
    const r = device('2026-11-01T08:00:00Z');
    await r.repo.save('climbs', climb('7a'));
    const store = new MemoryBackupStore();
    expect(await maybeWeeklyBackup(r.repo, store, new Date('2026-11-01T08:00:00Z'))).not.toBeNull();
    expect(await maybeWeeklyBackup(r.repo, store, new Date('2026-11-05T08:00:00Z'))).toBeNull();
    expect(await maybeWeeklyBackup(r.repo, store, new Date('2026-11-08T08:00:01Z'))).not.toBeNull();
    for (let i = 0; i < 10; i++) await createBackup(r.repo, store, false, new Date(Date.UTC(2026, 10, 10 + i)));
    const list = await store.list();
    expect(list).toHaveLength(KEEP_BACKUPS);
    expect(list[0].date).toBe('2026-11-19');
    const json = await store.get(list[0].id);
    expect((JSON.parse(json!) as Snapshot).stores.climbs).toHaveLength(1);
  });
});
