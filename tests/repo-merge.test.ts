import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../src/data/storage';
import { Repo } from '../src/data/repo';
import { mergeRecords, purgeTombstones } from '../src/data/merge';
import { emptySnapshot } from '../src/data/defaults';
import type { ClimbLog } from '../src/data/schema';

const at = (iso: string) => () => new Date(iso);

const climb = (id: string, updatedAt: string, grade: string, deleted = false): ClimbLog => ({
  id, createdAt: '2026-11-01T10:00:00.000Z', updatedAt, deleted, date: '2026-11-01',
  discipline: 'route', grade, style: 'redpoint', angle: 'vertical', setting: 'outdoor', grips: ['half_crimp'], attempts: 3,
});

describe('last-write-wins merge', () => {
  it('keeps the newer record and adds missing ones', () => {
    const local = [climb('a', '2026-11-02T10:00:00.000Z', '7a'), climb('b', '2026-11-02T10:00:00.000Z', '7b')];
    const remote = [climb('a', '2026-11-03T10:00:00.000Z', '7a+'), climb('c', '2026-11-01T10:00:00.000Z', '6c')];
    const { result, added, updated } = mergeRecords(local, remote);
    expect(added).toBe(1);
    expect(updated).toBe(1);
    expect(result.find((r) => r.id === 'a')!.grade).toBe('7a+');
  });

  it('propagates tombstones and is commutative', () => {
    const l = [climb('a', '2026-11-02T10:00:00.000Z', '7a')];
    const r = [climb('a', '2026-11-04T10:00:00.000Z', '7a', true)];
    const ab = mergeRecords(l, r).result;
    const ba = mergeRecords(r, l).result;
    expect(ab[0].deleted).toBe(true);
    expect(ab).toEqual(ba);
  });

  it('purges old tombstones only', () => {
    const s = emptySnapshot('dev');
    s.stores.climbs = [climb('old', '2026-01-01T00:00:00.000Z', '7a', true), climb('new', '2026-11-01T00:00:00.000Z', '7a', true)];
    const out = purgeTombstones(s, 180, '2026-11-21');
    expect(out.stores.climbs.map((c) => c.id)).toEqual(['new']);
  });
});

describe('Repo', () => {
  it('creates default settings and the initial profile on first read', async () => {
    const repo = new Repo(new MemoryStorage(), at('2026-11-21T09:00:00Z'));
    const s = await repo.getSettings();
    expect(s.sessionsPerWeek).toBe(3);
    const p = await repo.getProfile();
    expect(p.bodyMassKg).toBe(74);
    expect(p.goal.grade).toBe('7c');
  });

  it('keeps dated profile history; latest wins', async () => {
    const storage = new MemoryStorage();
    const r1 = new Repo(storage, at('2026-11-21T09:00:00Z'));
    await r1.getProfile();
    const r2 = new Repo(storage, at('2026-12-15T09:00:00Z'));
    await r2.updateProfile({ bodyMassKg: 73 });
    expect((await r2.profileHistory()).map((p) => p.bodyMassKg)).toEqual([74, 73]);
    expect((await r2.getProfile()).bodyMassKg).toBe(73);
  });

  it('soft-deletes and hides records', async () => {
    const repo = new Repo(new MemoryStorage());
    const c = await repo.save('climbs', { ...climb('x', '', '7a'), id: undefined } as never);
    await repo.softDelete('climbs', c.id);
    expect(await repo.list('climbs')).toHaveLength(0);
    expect(await repo.list('climbs', { includeDeleted: true })).toHaveLength(1);
  });

  it('round-trips export -> import(replace) and merges a v0 file', async () => {
    const a = new Repo(new MemoryStorage());
    await a.getSettings();
    await a.save('climbs', climb('k1', '', '7b'));
    const snap = await a.exportSnapshot();
    const b = new Repo(new MemoryStorage());
    await b.importSnapshot(JSON.parse(JSON.stringify(snap)), 'replace');
    expect((await b.list('climbs'))[0].grade).toBe('7b');
    const stats = await b.importSnapshot({ stores: { climbs: [{ id: 'k2', date: '2026-11-05', grade: '6c', attempts: 1 }] } }, 'merge');
    expect(stats.added).toBe(1);
    expect(await b.list('climbs')).toHaveLength(2);
  });
});
