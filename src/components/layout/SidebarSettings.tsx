import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { CheckCircle2, DatabaseZap, Download, Loader2, RefreshCw, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import { appVersion, availableUpdate, checkForUpdate, installUpdate, onUpdateChange, type AvailableUpdate } from '../../services/updates';
import type { EngineStatus, TrashRow } from '../../types/media';
import { engineStatus } from '../../services/player';
import Dropdown from '../common/Dropdown';
import { useLibraryStore } from '../../store/useLibraryStore';
import { runImdbSync, runScan } from '../../services/scanner';
import { clearLibrary } from '../../services/db';
import { daysLeft, emptyTrash, formatBytes, listTrash, purgeTrash, restoreTrash, TRASH_RETENTION_DAYS } from '../../services/files';
import { resize } from '../../services/tmdb';
import Artwork from '../common/Artwork';
import {
  FolderList,
  OpenSubtitlesFields,
  TmdbKeyField,
  VlcSetup,
  type SubtitleSettingsValue,
} from '../common/SetupControls';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-b border-white/10 px-7 py-6 last:border-b-0">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-nf-muted">{title}</h3>
      {children}
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-4 rounded-md bg-black/20 p-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{label}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-nf-muted">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-nf-red' : 'bg-[#4d4d4d]'}`}
      >
        <span
          className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
        />
      </button>
    </label>
  );
}

function PlaybackEngine() {
  const engine = useLibraryStore((s) => s.settings.player_engine);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  useEffect(() => {
    void engineStatus().then(setStatus);
  }, []);

  const version = status?.mpv_version?.replace(/^mpv\s*v?/i, '');
  const ffmpeg = status?.ffmpeg_version?.replace(/^n?(\d+(\.\d+)*).*/, '$1');

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-nf-secondary">Player</span>
        <Dropdown
          value={engine}
          onChange={(v) => updateSettings({ player_engine: v })}
          align="right"
          options={[
            { value: 'builtin', label: 'Built-in player', hint: status && !status.available ? 'unavailable' : undefined },
            { value: 'vlc', label: 'VLC (external)' },
          ]}
          className="min-w-[200px]"
        />
      </div>
      <div className="rounded bg-black/25 px-3 py-2.5 text-xs leading-relaxed">
        {!status ? (
          <span className="text-nf-muted">Checking player engine…</span>
        ) : status.available ? (
          <>
            <div className="flex items-center gap-1.5 font-semibold text-nf-green">
              <CheckCircle2 className="h-3.5 w-3.5" /> Built-in engine ready
            </div>
            <div className="mt-0.5 text-nf-muted">
              mpv {version} · FFmpeg {ffmpeg} · hardware decoding, HDR tone mapping, all common formats
            </div>
          </>
        ) : (
          <>
            <div className="font-semibold text-[#e87c03]">Built-in player unavailable</div>
            <div className="mt-0.5 text-nf-muted">{status.reason} Playback uses VLC instead.</div>
          </>
        )}
      </div>
    </div>
  );
}

function AboutUpdates() {
  const autoCheck = useLibraryStore((s) => s.settings.updates_auto_check);
  const lastCheck = useLibraryStore((s) => s.settings.updates_last_check);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const [version, setVersion] = useState('');
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [update, setUpdate] = useState<AvailableUpdate | null>(availableUpdate());
  const [phase, setPhase] = useState<'idle' | 'checking' | 'uptodate' | 'error' | 'installing'>('idle');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number | null }>({ done: 0, total: null });

  useEffect(() => {
    void appVersion().then(setVersion);
    void engineStatus().then(setEngine);
    const off = onUpdateChange(setUpdate);
    return () => void off();
  }, []);

  const runCheck = async () => {
    setPhase('checking');
    setError('');
    try {
      const u = await checkForUpdate();
      setUpdate(u);
      setPhase(u ? 'idle' : 'uptodate');
    } catch (e) {
      setError(String(e));
      setPhase('error');
    }
  };

  const install = async () => {
    setPhase('installing');
    try {
      await installUpdate((done, total) => setProgress({ done, total }));
    } catch (e) {
      setError(String(e));
      setPhase('error');
    }
  };

  const mpv = engine?.mpv_version?.replace(/^mpv\s*v?/i, '');
  const ffmpeg = engine?.ffmpeg_version?.replace(/^n?(\d+(\.\d+)*).*/, '$1');

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded bg-black/25 px-3 py-2.5 text-sm">
        <span className="text-nf-muted">TruongFlix</span>
        <span className="tabular-nums">{version ? `v${version}` : '…'}</span>
        <span className="text-nf-muted">Player engine</span>
        <span className="tabular-nums">{engine?.available ? `mpv ${mpv} · FFmpeg ${ffmpeg}` : 'VLC (external)'}</span>
      </div>

      {update ? (
        <div className="space-y-2.5 rounded-md border border-nf-red/40 bg-nf-red/10 p-3">
          <div className="text-sm font-semibold">TruongFlix {update.version} is available</div>
          {update.notes && <p className="selectable whitespace-pre-line text-xs leading-relaxed text-nf-secondary">{update.notes}</p>}
          {phase === 'installing' ? (
            <div className="space-y-1">
              <div className="h-1 overflow-hidden rounded bg-white/15">
                <div
                  className="h-full bg-nf-red transition-[width]"
                  style={{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : '15%' }}
                />
              </div>
              <div className="text-xs text-nf-muted">
                {progress.total ? `Downloading ${formatBytes(progress.done)} of ${formatBytes(progress.total)}…` : 'Downloading…'} The app restarts when done.
              </div>
            </div>
          ) : (
            <button onClick={install} className="nf-btn-red h-9 px-4 py-0 text-sm">
              <Download className="h-4 w-4" /> Download & Restart
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-nf-muted">
            {phase === 'checking'
              ? 'Checking…'
              : phase === 'uptodate'
                ? 'You’re up to date.'
                : lastCheck
                  ? `Last checked ${new Date(lastCheck).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
                  : 'Never checked'}
          </span>
          <button onClick={runCheck} disabled={phase === 'checking'} className="nf-btn-ghost h-9 py-0">
            <RefreshCw className={`h-4 w-4 ${phase === 'checking' ? 'animate-spin' : ''}`} /> Check for Updates
          </button>
        </div>
      )}
      {phase === 'error' && <p className="text-xs text-nf-red">Couldn’t check for updates: {error}</p>}

      <ToggleRow
        label="Check for updates automatically"
        description="Looks for a new version once a day at launch. Updates are signed, and the player engine is updated along with the app."
        checked={autoCheck}
        onChange={(v) => updateSettings({ updates_auto_check: v })}
      />
    </div>
  );
}

const KIND_LABEL: Record<TrashRow['kind'], string> = { movie: 'Movie', tv: 'TV Show', episode: 'Episode' };

function RecentlyDeleted() {
  const toast = useLibraryStore((s) => s.toast);
  const confirm = useLibraryStore((s) => s.confirm);
  const libraryVersion = useLibraryStore((s) => s.libraryVersion);
  const [rows, setRows] = useState<TrashRow[] | null>(null);
  const [busy, setBusy] = useState<number | 'all' | null>(null);

  const refresh = useCallback(() => listTrash().then(setRows), []);
  useEffect(() => {
    void refresh();
  }, [refresh, libraryVersion]);

  const run = async (key: number | 'all', fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const purge = async (row: TrashRow) => {
    const ok = await confirm({
      title: `Permanently delete “${row.label}”?`,
      message: `${formatBytes(row.size_bytes)} will be erased from disk. This can’t be undone.`,
      confirmLabel: 'Delete Forever',
      danger: true,
    });
    if (ok) await run(row.id, async () => {
      await purgeTrash(row);
      toast(`Permanently deleted “${row.label}”`, 'success');
    });
  };

  const empty = async () => {
    const total = (rows ?? []).reduce((n, r) => n + r.size_bytes, 0);
    const ok = await confirm({
      title: 'Empty Recently Deleted?',
      message: `${rows?.length} item${rows?.length === 1 ? '' : 's'} (${formatBytes(total)}) will be erased from disk. This can’t be undone.`,
      confirmLabel: 'Empty',
      danger: true,
    });
    if (ok) await run('all', emptyTrash);
  };

  if (!rows) return null;
  if (!rows.length) {
    return (
      <p className="rounded border border-dashed border-white/15 px-4 py-5 text-center text-sm text-nf-muted">
        Nothing here. Deleted titles stay for {TRASH_RETENTION_DAYS} days before they’re permanently removed.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <AnimatePresence initial={false}>
        {rows.map((row) => {
          const left = daysLeft(row);
          return (
            <motion.div
              key={row.id}
              layout
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 30 }}
              className="flex items-center gap-3 rounded-md bg-black/25 p-2.5"
            >
              <div className="h-14 w-10 shrink-0 overflow-hidden rounded-sm">
                <Artwork src={resize(row.poster_path, 'w92')} alt={row.label} className="h-full w-full" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold" title={row.label}>
                  {row.label}
                </div>
                <div className="text-[11px] text-nf-muted">
                  {KIND_LABEL[row.kind]} · {formatBytes(row.size_bytes)} ·{' '}
                  <span className={left <= 3 ? 'text-[#e87c03]' : ''}>
                    {left} day{left === 1 ? '' : 's'} left
                  </span>
                </div>
              </div>
              <button
                onClick={() => run(row.id, () => restoreTrash(row))}
                disabled={busy != null}
                title="Restore"
                className="nf-btn-ghost h-8 px-2.5 text-xs"
              >
                {busy === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
                Restore
              </button>
              <button
                onClick={() => purge(row)}
                disabled={busy != null}
                title="Delete forever"
                className="flex h-8 w-8 items-center justify-center rounded text-white/50 transition hover:bg-nf-red/20 hover:text-nf-red disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
      <button onClick={empty} disabled={busy != null} className="nf-btn-ghost hover:!bg-nf-red/20">
        {busy === 'all' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        Empty Recently Deleted
      </button>
    </div>
  );
}

/** Slide-in settings panel: TMDB key, VLC path, media folders, library maintenance. */
export default function SidebarSettings() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const setOpen = useLibraryStore((s) => s.setSettingsOpen);
  const reload = useLibraryStore((s) => s.reload);
  const toast = useLibraryStore((s) => s.toast);
  const confirm = useLibraryStore((s) => s.confirm);
  const scanning = useLibraryStore((s) => s.scan.running);
  const counts = useLibraryStore(
    useShallow((s) => ({ movies: s.movies.length, series: s.series.length, episodes: s.episodes.length })),
  );

  const [apiKey, setApiKey] = useState(settings.tmdb_api_key);
  const [subs, setSubs] = useState<SubtitleSettingsValue>({
    apiKey: settings.opensubtitles_api_key,
    language: settings.subtitle_language,
    username: settings.opensubtitles_username,
    password: settings.opensubtitles_password,
  });
  const subsDirty =
    subs.apiKey.trim() !== settings.opensubtitles_api_key ||
    subs.language !== settings.subtitle_language ||
    subs.username.trim() !== settings.opensubtitles_username ||
    subs.password !== settings.opensubtitles_password;

  const saveSubs = async () => {
    await updateSettings({
      opensubtitles_api_key: subs.apiKey.trim(),
      subtitle_language: subs.language,
      opensubtitles_username: subs.username.trim(),
      opensubtitles_password: subs.password,
    });
    toast(subs.apiKey.trim() ? 'Subtitle settings saved' : 'Subtitles turned off', 'success');
  };

  const saveKey = async () => {
    await updateSettings({ tmdb_api_key: apiKey.trim() });
    toast('TMDB API key saved', 'success');
  };

  const saveDirs = async (dirs: string[]) => {
    await updateSettings({ media_directories: dirs });
  };

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
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => setOpen(false)}
        className="fixed inset-0 z-[65] bg-black/60"
      />
      <motion.aside
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'tween', duration: 0.3, ease: [0.21, 0, 0.27, 1] }}
        className="fixed bottom-0 right-0 top-0 z-[66] flex w-[440px] max-w-full flex-col bg-nf-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-7 py-5">
          <h2 className="text-2xl font-bold">Settings</h2>
          <button onClick={() => setOpen(false)} className="rounded-full p-1.5 text-white/70 hover:bg-white/10 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <Section title="Media Folders">
            <FolderList value={settings.media_directories} onChange={saveDirs} />
          </Section>

          <Section title="Library">
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                ['Movies', counts.movies],
                ['Shows', counts.series],
                ['Episodes', counts.episodes],
              ].map(([label, n]) => (
                <div key={label} className="rounded bg-black/30 py-3">
                  <div className="text-2xl font-bold tabular-nums">{n}</div>
                  <div className="text-xs text-nf-muted">{label}</div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => runScan()} disabled={scanning} className="nf-btn-red px-4 py-2 text-sm">
                <RefreshCw className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} /> Scan for changes
              </button>
              <button onClick={() => runScan({ force: true })} disabled={scanning} className="nf-btn-ghost" title="Re-download metadata for every file">
                <DatabaseZap className="h-4 w-4" /> Refresh all metadata
              </button>
              <button onClick={wipe} disabled={scanning} className="nf-btn-ghost hover:!bg-nf-red/20">
                <Trash2 className="h-4 w-4" /> Clear library
              </button>
            </div>
            <ToggleRow
              label="Organize loose files into folders"
              description="During scans, videos sitting directly in a media folder are moved into their own folder (named after the file), along with their subtitles."
              checked={settings.organize_loose_files}
              onChange={(v) => updateSettings({ organize_loose_files: v })}
            />
          </Section>

          <Section title="IMDb Ratings">
            <ToggleRow
              label="Show IMDb ratings"
              description="Ratings for movies, shows, seasons and episodes, from IMDb’s official public datasets (about 65 MB, refreshed at most once a day when you scan). For personal, non-commercial use."
              checked={settings.imdb_enabled}
              onChange={async (v) => {
                await updateSettings({ imdb_enabled: v });
                if (v) void runImdbSync();
              }}
            />
            {settings.imdb_enabled && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-nf-muted">
                  {settings.imdb_last_sync
                    ? `Last updated ${new Date(settings.imdb_last_sync).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
                    : 'Not downloaded yet'}
                </span>
                <button onClick={() => runImdbSync({ force: true })} disabled={scanning} className="nf-btn-ghost h-9 py-0">
                  <RefreshCw className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} /> Refresh ratings
                </button>
              </div>
            )}
          </Section>

          <Section title="Recently Deleted">
            <RecentlyDeleted />
          </Section>

          <Section title="TMDB API Key">
            <TmdbKeyField value={apiKey} onChange={setApiKey} />
            {apiKey.trim() !== settings.tmdb_api_key && (
              <button onClick={saveKey} className="nf-btn-red px-4 py-2 text-sm">
                Save key
              </button>
            )}
          </Section>

          <Section title="Subtitles · OpenSubtitles (optional)">
            <OpenSubtitlesFields value={subs} onChange={(patch) => setSubs((s) => ({ ...s, ...patch }))} showAccount />
            {subsDirty && (
              <button onClick={saveSubs} className="nf-btn-red px-4 py-2 text-sm">
                Save subtitle settings
              </button>
            )}
            {!settings.opensubtitles_api_key && !subsDirty && (
              <p className="text-xs text-nf-muted">Subtitle search is turned off until an API key is added.</p>
            )}
          </Section>

          <Section title="Playback">
            <PlaybackEngine />
          </Section>

          <Section title="VLC Player">
            <VlcSetup value={settings.vlc_executable_path} onChange={(p) => updateSettings({ vlc_executable_path: p })} />
          </Section>

          <Section title="About & Updates">
            <AboutUpdates />
          </Section>

          <Section title="Setup">
            <button
              onClick={() => {
                setOpen(false);
                useLibraryStore.getState().setOnboardingOpen(true);
              }}
              className="nf-btn-ghost"
            >
              <RotateCcw className="h-4 w-4" /> Re-run setup wizard
            </button>
          </Section>
        </div>
      </motion.aside>
    </>
  );
}
