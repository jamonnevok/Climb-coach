/**
 * Settings > Data: phone <-> laptop sync (private GitHub Gist), Garmin import status,
 * CSV export for Excel (semicolons), JSON export / import, automatic weekly backups.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { Badge, Button, Card, Field, Section, Segmented, Toggle, confirmAction } from '../../components/ui';
import { connectGist, GistClient, getToken, setToken } from '../../../sync/gist';
import { getDeviceState, setDeviceState, type DeviceState } from '../../../sync/deviceState';
import { getBackupStore, pulledChanges, syncNow } from '../../../sync/autoSync';
import { createBackup, type BackupMeta } from '../../../sync/backup';
import { buildCsvFiles, zipFiles } from '../../../sync/csv';
import { autoDownload } from '../../../sync/download';

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
};

function SyncCard() {
  const { svc, run, refresh, toast } = useStore();
  const [dev, setDev] = useState<DeviceState>(getDeviceState());
  const [token, setTok] = useState(getToken() ?? '');
  const [gistId, setGistId] = useState(dev.gistId ?? '');
  const [busy, setBusy] = useState(false);
  const update = (p: Partial<DeviceState>) => setDev(setDeviceState(p));
  const connected = !!getToken() && !!dev.gistId;

  const connect = () =>
    void run(async () => {
      if (!token.trim()) throw new Error('Paste a GitHub token with the "gist" permission first.');
      setToken(token.trim());
      const r = await connectGist(svc.repo, new GistClient(token.trim()), gistId.trim() || null);
      update({ gistId: r.gistId, lastSyncError: null });
      setGistId(r.gistId);
      const s = await syncNow(svc.repo);
      setDev(getDeviceState());
      if (s && pulledChanges(s)) await refresh();
    }, 'Sync connected');

  const syncClick = async () => {
    setBusy(true);
    try {
      const r = await syncNow(svc.repo);
      setDev(getDeviceState());
      if (r) {
        if (pulledChanges(r)) await refresh();
        toast(`Synced — ${r.pulled ? r.pulled.added + r.pulled.updated : 0} change(s) received${r.garmin?.saved ? `, ${r.garmin.saved} Garmin night(s)` : ''}`);
      }
    } catch (e) {
      setDev(getDeviceState());
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-semibold">Phone ↔ laptop sync</span>
        {connected ? <Badge cls="bg-ok/15 text-ok">On</Badge> : <Badge>Off</Badge>}
      </div>
      {connected ? (
        <>
          <div className="text-sm text-muted">
            Last sync {ago(dev.lastSyncAt)} · Gist <span className="font-mono">{dev.gistId!.slice(0, 8)}…</span>
          </div>
          {dev.lastSyncError && <div className="text-sm text-bad">Last error: {dev.lastSyncError}</div>}
          <div className="flex gap-2">
            <Button className="flex-1" disabled={busy} onClick={() => void syncClick()}>
              {busy ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button
              tone="ghost"
              onClick={() => {
                if (!confirmAction('Disconnect this device from sync? Local data stays on this device; the gist is not deleted.')) return;
                setToken(null);
                update({ gistId: null, lastSyncAt: null, lastSyncError: null });
                setTok('');
              }}
            >
              Disconnect
            </Button>
          </div>
          <Toggle checked={dev.autoSync} onChange={(v) => update({ autoSync: v })} label="Sync automatically" />
          <p className="text-xs text-muted">Every sync is a revision of your private gist on gist.github.com (free version history).</p>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">
            Create a GitHub token with the <b>gist</b> permission (README, step 4), paste it below. On the first device leave Gist ID empty: a private gist is created. On the second device, the same token finds it automatically.
          </p>
          <Field label="GitHub token (stored on this device only)">
            <input type="password" autoComplete="off" value={token} onChange={(e) => setTok(e.target.value)} placeholder="github_pat_… or ghp_…" />
          </Field>
          <Field label="Gist ID (optional)">
            <input value={gistId} onChange={(e) => setGistId(e.target.value)} placeholder="auto" />
          </Field>
          <Button className="w-full" onClick={connect}>
            Connect & sync
          </Button>
        </>
      )}
    </Card>
  );
}

function GarminCard() {
  const dev = getDeviceState();
  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-semibold">Garmin (sleep, HRV, resting HR, Body Battery)</span>
        {dev.garminFetchedAt ? <Badge cls="bg-ok/15 text-ok">Active</Badge> : <Badge>Not set up</Badge>}
      </div>
      {dev.garminFetchedAt ? (
        <p className="text-sm text-muted">
          Last Garmin pull {ago(dev.garminFetchedAt)} · {dev.garminDays} day(s) in the last import. Imported nights replace manual sleep for readiness; manual entry stays available.
        </p>
      ) : (
        <p className="text-sm text-muted">
          A free GitHub Action pulls your data twice a day into the sync gist (README, step 6: Garmin personal API key + 3 repository secrets). Requires sync to be on. Until then, enter sleep in the morning check-in.
        </p>
      )}
    </Card>
  );
}

function ExportCard() {
  const { svc, run, d } = useStore();
  const [dev, setDev] = useState<DeviceState>(getDeviceState());
  const file = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  return (
    <Card className="space-y-3">
      <div className="font-semibold">Export / import</div>
      <Button
        className="w-full"
        onClick={() =>
          void run(async () => {
            const snap = await svc.repo.exportSnapshot();
            const files = buildCsvFiles(snap, { decimalComma: dev.decimalComma });
            autoDownload(`climb-coach-csv-${d.today}.zip`, zipFiles(files), 'application/zip');
          }, 'CSV exported (zip with 8 tables)')
        }
      >
        Export CSV for Excel (.zip)
      </Button>
      <Toggle checked={dev.decimalComma} onChange={(v) => setDev(setDeviceState({ decimalComma: v }))} label="Decimal comma (Belgian / French Excel)" />
      <Button tone="ghost" className="w-full" onClick={() => void run(async () => autoDownload(`climb-coach-${d.today}.json`, await svc.exportJSON(), 'application/json'), 'Exported')}>
        Export all data (JSON)
      </Button>
      <Segmented value={mode} onChange={setMode} options={[{ value: 'merge', label: 'Import: merge' }, { value: 'replace', label: 'Import: replace' }]} />
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          if (mode === 'replace' && !confirmAction('Replace ALL local data with this file? A pre-import copy is kept on this device.')) return;
          void run(async () => svc.importJSON(await f.text(), mode), 'Import done');
          e.target.value = '';
        }}
      />
      <Button tone="ghost" className="w-full" onClick={() => file.current?.click()}>
        Import JSON…
      </Button>
      <p className="text-xs text-muted">Files from any older app version are migrated automatically. Personal data stays on your devices and your private gist.</p>
    </Card>
  );
}

function BackupCard() {
  const { svc, run, d } = useStore();
  const [items, setItems] = useState<BackupMeta[]>([]);
  const [dev, setDev] = useState<DeviceState>(getDeviceState());
  const reload = () => void getBackupStore().list().then(setItems);
  useEffect(reload, []);
  const download = async (b: BackupMeta) => {
    const json = await getBackupStore().get(b.id);
    if (json) autoDownload(`climb-coach-backup-${b.date}.json`, json, 'application/json');
  };
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-semibold">Automatic weekly backup</span>
        <span className="text-xs text-muted">last {ago(dev.lastAutoBackupAt)}</span>
      </div>
      <Toggle checked={dev.autoDownloadBackup} onChange={(v) => setDev(setDeviceState({ autoDownloadBackup: v }))} label="Also save the weekly file to Downloads" />
      {items.length ? (
        <ul className="space-y-1 text-sm">
          {items.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-2">
              <span>
                {b.date} · {Math.round(b.bytes / 1024)} kB · {b.records} records{b.auto ? '' : ' · manual'}
              </span>
              <span className="flex gap-1">
                <Button small tone="subtle" onClick={() => void download(b)}>
                  Save
                </Button>
                <Button
                  small
                  tone="ghost"
                  onClick={() =>
                    confirmAction(`Restore the backup of ${b.date}? Current data is replaced (a pre-import copy is kept).`) &&
                    void run(async () => {
                      const json = await getBackupStore().get(b.id);
                      if (!json) throw new Error('Backup not found');
                      await svc.importJSON(json, 'replace');
                    }, 'Backup restored')
                  }
                >
                  Restore
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No backup yet — the first one is made automatically.</p>
      )}
      <Button tone="ghost" className="w-full" onClick={() => void run(async () => { await createBackup(svc.repo, getBackupStore(), false); reload(); }, 'Backup saved on this device')}>
        Back up now
      </Button>
      <p className="text-xs text-muted">The last 8 backups are kept on this device ({d.today}).</p>
    </Card>
  );
}

export function DataSection() {
  return (
    <Section title="Data">
      <div className="space-y-3">
        <SyncCard />
        <GarminCard />
        <ExportCard />
        <BackupCard />
      </div>
    </Section>
  );
}
