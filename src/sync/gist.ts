/**
 * GIST SYNC — phone <-> laptop through ONE private GitHub Gist (free).
 *
 * Gist files:
 *   climb-coach-data.json   full snapshot (any schema version; migrated on read)
 *   garmin-raw.json         written by the Garmin GitHub Action (scripts/garmin-sync.mjs)
 * Every PATCH creates a Gist revision, so GitHub keeps a free version history of your data.
 *
 * Algorithm (sync()):
 *   1. GET the gist; if the data file exists -> Repo.importSnapshot(remote, 'merge')
 *      (migrations + last-write-wins per record; device-local settings kept, see merge.ts)
 *   2. import Garmin nights from garmin-raw.json (garmin.ts)
 *   3. export the merged local snapshot -> PATCH the gist
 * The personal access token is stored only in this browser (localStorage), never synced.
 * Fallback (documented, not implemented): Supabase free tier with the same snapshot format.
 */
import type { RawSnapshot } from '../data/migrations';
import type { Repo } from '../data/repo';
import type { MergeStats } from '../data/merge';
import { nowISO } from '../lib/dates';
import { importGarmin, type GarminImportResult } from './garmin';
import { setDeviceState } from './deviceState';

export const DATA_FILE = 'climb-coach-data.json';
export const GARMIN_FILE = 'garmin-raw.json';
export const GIST_DESCRIPTION = 'Climb Coach data (private, do not edit by hand)';
const API = 'https://api.github.com';
const TOKEN_KEY = 'climbcoach.gistToken';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GistFile {
  filename: string;
  content?: string;
  truncated?: boolean;
  raw_url?: string;
  size?: number;
}

export interface Gist {
  id: string;
  description: string | null;
  public: boolean;
  updated_at: string;
  files: Record<string, GistFile>;
}

export class SyncError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

/* ---------------- token storage (device only) ---------------- */

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token.trim());
  else localStorage.removeItem(TOKEN_KEY);
}

/* ---------------- API client ---------------- */

export class GistClient {
  constructor(private token: string, private fetchImpl: FetchLike = (u, i) => fetch(u, i)) {}

  private async call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const hint =
        res.status === 401 ? 'Token invalid or expired.' : res.status === 403 ? 'Token lacks the "gist" permission or rate limit reached.' : res.status === 404 ? 'Gist not found (check the Gist ID and token owner).' : `GitHub error ${res.status}.`;
      throw new SyncError(hint, res.status);
    }
    return (await res.json()) as T;
  }

  get(id: string): Promise<Gist> {
    return this.call<Gist>(`/gists/${encodeURIComponent(id)}`);
  }

  /** Find this app's gist among the user's gists (first page of 100 is plenty). */
  async findAppGist(): Promise<Gist | null> {
    const list = await this.call<Gist[]>('/gists?per_page=100');
    return list.find((g) => !g.public && g.description === GIST_DESCRIPTION) ?? null;
  }

  create(files: Record<string, string>): Promise<Gist> {
    return this.call<Gist>('/gists', 'POST', {
      description: GIST_DESCRIPTION,
      public: false,
      files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: v }])),
    });
  }

  update(id: string, files: Record<string, string | null>): Promise<Gist> {
    return this.call<Gist>(`/gists/${encodeURIComponent(id)}`, 'PATCH', {
      files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v === null ? null : { content: v }])),
    });
  }

  /** File content; large files (> 1 MB) come back truncated and are fetched from raw_url. */
  async fileContent(g: Gist, name: string): Promise<string | null> {
    const f = g.files[name];
    if (!f) return null;
    if (!f.truncated && typeof f.content === 'string') return f.content;
    if (!f.raw_url) return null;
    const res = await this.fetchImpl(f.raw_url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new SyncError(`Could not download ${name} (${res.status}).`, res.status);
    return res.text();
  }
}

/* ---------------- sync ---------------- */

export interface SyncResult {
  gistId: string;
  created: boolean;
  pulled: MergeStats | null;
  garmin: GarminImportResult | null;
  pushedBytes: number;
  at: string;
}

/**
 * Connect this device: use the given gist id, else find the app gist, else create it
 * with the current local data. Returns the gist id (remembered in device state).
 */
export async function connectGist(repo: Repo, client: GistClient, gistId: string | null): Promise<{ gistId: string; created: boolean }> {
  if (gistId) {
    await client.get(gistId);
    return { gistId, created: false };
  }
  const found = await client.findAppGist();
  if (found) return { gistId: found.id, created: false };
  const snap = await repo.exportSnapshot();
  const g = await client.create({ [DATA_FILE]: JSON.stringify(snap) });
  return { gistId: g.id, created: true };
}

export async function sync(repo: Repo, client: GistClient, gistId: string, now: () => Date = () => new Date()): Promise<SyncResult> {
  const gist = await client.get(gistId);
  let pulled: MergeStats | null = null;
  const remoteText = await client.fileContent(gist, DATA_FILE);
  if (remoteText) {
    let raw: RawSnapshot;
    try {
      raw = JSON.parse(remoteText) as RawSnapshot;
    } catch {
      throw new SyncError(`${DATA_FILE} in the gist is not valid JSON. Restore a previous revision on gist.github.com.`);
    }
    pulled = await repo.importSnapshot(raw, 'merge');
  }
  let garmin: GarminImportResult | null = null;
  const garminText = await client.fileContent(gist, GARMIN_FILE);
  if (garminText) garmin = await importGarmin(repo, garminText);

  const snap = await repo.exportSnapshot();
  const body = JSON.stringify(snap);
  await client.update(gistId, { [DATA_FILE]: body });
  const at = nowISO(now());
  setDeviceState({ gistId, lastSyncAt: at, lastSyncError: null, ...(garmin?.fetchedAt ? { garminFetchedAt: garmin.fetchedAt, garminDays: garmin.days } : {}) });
  return { gistId, created: false, pulled, garmin, pushedBytes: body.length, at };
}
