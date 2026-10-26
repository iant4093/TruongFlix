import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import { DatabaseZap, FilePen, HeartPulse, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { runScan } from '../../services/scanner';
import { clearLibrary } from '../../services/db';
import { connectShare, refreshShares } from '../../services/nas';
import { FolderList } from '../common/SetupControls';
import { Block, BTN, BTN_DANGER, BTN_PRIMARY, Group, INPUT, Page, Row, StatusText, ToggleRow } from './ui';
import { closeSettingsAnd } from './nav';

export default function LibraryPage() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const scanning = useLibraryStore((s) => s.scan.running);
  const reload = useLibraryStore((s) => s.reload);
  const toast = useLibraryStore((s) => s.toast);
  const confirm = useLibraryStore((s) => s.confirm);
  const counts = useLibraryStore(useShallow((s) => ({ movies: s.movies.length, series: s.series.length, episodes: s.episodes.length })));

  const wipe = async () => {
    const ok = await confirm({
      title: 'Clear the library?',
      message: 'Every title is removed from TruongFlix and watch progress is lost. Your video files are not touched.',
      confirmLabel: 'Clear library',
      danger: true,
    });
    if (!ok) return;
    await clearLibrary();
    await reload();
    toast('Library cleared', 'success');
  };

  return (
    <Page title="Library" description="Where your movies and shows live, and how TruongFlix keeps up with them.">
      <Group title="Media folders">
        <Block>
          <FolderList value={settings.media_directories} onChange={(dirs) => void updateSettings({ media_directories: dirs })} />
        </Block>
      </Group>

      <NetworkShares />

      <Group title="Scanning">
        <Block className="grid grid-cols-3 gap-2 text-center">
          {(
            [
              ['Movies', counts.movies],
              ['Shows', counts.series],
              ['Episodes', counts.episodes],
            ] as const
          ).map(([label, n]) => (
            <div key={label} className="rounded-md bg-black/30 py-3">
              <div className="text-2xl font-bold tabular-nums">{n}</div>
              <div className="text-xs text-nf-muted">{label}</div>
            </div>
          ))}
        </Block>
        <Row label="Scan for changes" description="Finds new, changed and removed files. Usually automatic (see below).">
          <button onClick={() => runScan()} disabled={scanning} className={BTN_PRIMARY}>
            <RefreshCw className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} /> Scan now
          </button>
        </Row>
        <Row label="Refresh all metadata" description="Downloads artwork and details again for every title.">
          <button onClick={() => runScan({ force: true })} disabled={scanning} className={BTN}>
            <DatabaseZap className="h-4 w-4" /> Refresh
          </button>
        </Row>
        <ToggleRow
          label="Watch folders for changes"
          description="New downloads, deletions and renames show up a few seconds after they happen."
          checked={settings.watch_folders}
          onChange={(v) => void updateSettings({ watch_folders: v })}
        />
        <ToggleRow
          label="Organize loose files into folders"
          description="Videos sitting directly in a media folder are moved into their own folder, along with their subtitles."
          checked={settings.organize_loose_files}
          onChange={(v) => void updateSettings({ organize_loose_files: v })}
        />
      </Group>

      <Group title="Tools">
        <Row label="Library health" description="Disk use, duplicate copies, broken or incomplete files, upgrade candidates and missing subtitles.">
          <button onClick={() => closeSettingsAnd(() => useLibraryStore.getState().setOverlay('health'))} className={BTN}>
            <HeartPulse className="h-4 w-4" /> Open
          </button>
        </Row>
        <Row label="Rename files Plex-style" description="Movie (Year)/Movie (Year).mkv and Show/Season 01/Show - S01E01.mkv, with a preview and undo.">
          <button onClick={() => closeSettingsAnd(() => useLibraryStore.getState().setOverlay('rename'))} disabled={scanning} className={BTN}>
            <FilePen className="h-4 w-4" /> Open
          </button>
        </Row>
      </Group>

      <Group title="Danger zone">
        <Row label="Clear library" description="Removes every title and all watch progress from TruongFlix. Your files stay on disk.">
          <button onClick={() => void wipe()} disabled={scanning} className={BTN_DANGER}>
            <Trash2 className="h-4 w-4" /> Clear
          </button>
        </Row>
      </Group>
    </Page>
  );
}

/** Media folders on network shares: status, Wake-on-LAN address and reconnect. */
function NetworkShares() {
  const dirs = useLibraryStore((s) => s.settings.media_directories);
  const shares = useLibraryStore((s) => s.settings.network_shares);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // One entry per share, even when several media folders live on it.
  const list = [...new Map(dirs.filter((d) => shares[d]).map((d) => [shares[d].url, d])).values()];

  const check = useCallback(async () => {
    const res = await invoke<boolean[]>('check_paths', { paths: list }).catch(() => list.map(() => false));
    setOnline(Object.fromEntries(list.map((d, i) => [d, res[i]])));
  }, [list.join('|')]);
  useEffect(() => {
    void refreshShares().then(check);
  }, [check]);

  const setMac = (url: string, mac: string | null) =>
    void updateSettings({
      network_shares: Object.fromEntries(Object.entries(shares).map(([d, info]) => [d, info.url === url ? { ...info, mac } : info])),
    });

  if (!list.length) return null;
  return (
    <Group
      title="Network shares"
      footer="Disconnected shares reconnect automatically, and a sleeping NAS is woken up when you press Play. Changes made from other devices show up within 15 minutes."
    >
      {list.map((dir) => {
        const s = shares[dir];
        return (
          <Row
            key={dir}
            label={
              <span className="flex items-center gap-2">
                {s.host}
                <StatusText tone={online[dir] ? 'good' : 'muted'}>{online[dir] ? '● Connected' : '○ Offline'}</StatusText>
              </span>
            }
            description={<span className="selectable">{s.url}</span>}
          >
            <input
              defaultValue={s.mac ?? ''}
              placeholder="Wake-on-LAN address"
              title="The NAS’s network address, used to wake it from sleep. Detected automatically while it’s connected."
              onBlur={(e) => {
                const mac = e.target.value.trim().toLowerCase();
                if (mac === (s.mac ?? '') || (mac && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/.test(mac))) return;
                setMac(s.url, mac || null);
              }}
              className={`${INPUT} w-44 font-mono text-xs`}
            />
            {!online[dir] && (
              <button
                onClick={async () => {
                  setBusy(dir);
                  await connectShare(dir, { wake: true });
                  setBusy(null);
                  await check();
                }}
                disabled={busy != null}
                className={BTN}
              >
                {busy === dir && <Loader2 className="h-4 w-4 animate-spin" />}
                {s.mac ? 'Wake & connect' : 'Connect'}
              </button>
            )}
          </Row>
        );
      })}
    </Group>
  );
}
