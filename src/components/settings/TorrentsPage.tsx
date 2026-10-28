import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Clock,
  FolderOpen,
  HardDriveDownload,
  Magnet,
  Pause,
  Play,
  Plus,
  Shuffle,
  Square,
  Trash2,
} from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import type { OsHandlerStatus, TorrentItem, TorrentMode } from '../../types/media';
import {
  checkOsHandlerStatus,
  formatBytes,
  formatEta,
  formatExpiryRemaining,
  formatSpeed,
  keepStreamPermanently,
  pauseAllTorrents,
  pauseTorrent,
  playTorrentByHash,
  registerOsHandler,
  removeTorrent,
  resumeAllTorrents,
  resumeTorrent,
  setTorrentDeleteOnComplete,
  stopSeedingTorrent,
} from '../../services/torrents';
import { FILE_MANAGER_NAME, revealInFileManager } from '../../services/files';
import Dropdown from '../common/Dropdown';
import { Block, BTN, BTN_DANGER, BTN_PRIMARY, Group, INPUT, Page, Row, Segmented, StatusText, Switch, ToggleRow } from './ui';

type TransferFilter = 'all' | 'downloading' | 'streams' | 'seeding' | 'completed';

const CACHE_OPTIONS: [number, string][] = [
  [6, '6h'],
  [24, '24h'],
  [72, '3d'],
  [168, '7d'],
  [720, '30d'],
];

const RATIO_OPTIONS: [number, string][] = [
  [0, 'Unlimited'],
  [0.5, '0.5×'],
  [1, '1.0×'],
  [2, '2.0×'],
];

const SEED_TIME_OPTIONS: [number, string][] = [
  [0, 'Unlimited'],
  [60, '1h'],
  [360, '6h'],
  [1440, '24h'],
];

function stateBadge(t: TorrentItem): { label: string; cls: string } {
  if (t.error) return { label: 'Error', cls: 'border-nf-red/40 bg-nf-red/15 text-red-300' };
  switch (t.state) {
    case 'resolving':
      return { label: 'Fetching metadata', cls: 'border-amber-400/40 bg-amber-500/15 text-amber-200' };
    case 'initializing':
      return { label: 'Checking files', cls: 'border-sky-400/40 bg-sky-500/15 text-sky-200' };
    case 'downloading':
      return { label: 'Downloading', cls: 'border-sky-400/40 bg-sky-500/15 text-sky-200' };
    case 'seeding':
      return { label: 'Seeding', cls: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200' };
    case 'stopped_seeding':
      return { label: 'Complete · Not seeding', cls: 'border-white/20 bg-white/10 text-nf-secondary' };
    case 'completed':
      return { label: 'Completed', cls: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200' };
    case 'paused':
      return { label: 'Paused', cls: 'border-white/20 bg-white/10 text-nf-secondary' };
    default:
      return { label: t.state, cls: 'border-white/20 bg-white/10 text-nf-secondary' };
  }
}

export default function TorrentsPage() {
  const settings = useLibraryStore((s) => s.settings);
  const update = useLibraryStore((s) => s.updateSettings);
  const torrents = useLibraryStore((s) => s.torrents);
  const items = useLibraryStore((s) => s.items);
  const openAddTorrent = useLibraryStore((s) => s.openAddTorrent);
  const openDetail = useLibraryStore((s) => s.openDetail);
  const setSettingsOpen = useLibraryStore((s) => s.setSettingsOpen);
  const confirm = useLibraryStore((s) => s.confirm);
  const toast = useLibraryStore((s) => s.toast);

  const [filter, setFilter] = useState<TransferFilter>('all');
  const [osStatus, setOsStatus] = useState<OsHandlerStatus | null>(null);
  const [registeringOs, setRegisteringOs] = useState(false);
  const [, setTick] = useState(0);

  // Refresh countdown labels every 30s
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    checkOsHandlerStatus()
      .then(setOsStatus)
      .catch(() => {});
  }, []);

  const totals = useMemo(() => {
    let dl = 0;
    let ul = 0;
    let boundPort: number | null = null;
    for (const t of torrents) {
      dl += t.downloadSpeedBps || 0;
      ul += t.uploadSpeedBps || 0;
      if (t.listenPort && !boundPort) boundPort = t.listenPort;
    }
    return { dl, ul, boundPort };
  }, [torrents]);

  const filtered = useMemo(() => {
    return torrents.filter((t) => {
      if (filter === 'downloading') return !t.finished && t.state !== 'error';
      if (filter === 'streams') return t.mode === 'stream';
      if (filter === 'seeding') return t.state === 'seeding';
      if (filter === 'completed') return t.finished;
      return true;
    });
  }, [torrents, filter]);

  const folderOptions = useMemo(
    () => [
      { value: '', label: 'Auto-detect from library' },
      ...settings.media_directories.map((dir) => ({
        value: dir,
        label: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir,
        hint: dir,
      })),
    ],
    [settings.media_directories],
  );

  const openMatchedTitle = (t: TorrentItem) => {
    const libItem =
      (t.movieId != null ? items.find((i) => i.kind === 'movie' && (i.id === t.movieId || i.versions.some((v) => v.id === t.movieId))) : null) ??
      (t.seriesId != null ? items.find((i) => i.kind === 'tv' && i.id === t.seriesId) : null);
    if (libItem) {
      setSettingsOpen(false);
      openDetail(libItem.key);
    }
  };

  const handleSetDefaultHandler = async () => {
    setRegisteringOs(true);
    try {
      const res = await registerOsHandler();
      setOsStatus(res);
      toast('TruongFlix registered as default handler for magnet links and .torrent files', 'success');
    } catch (e) {
      toast(`Couldn’t register default handler: ${String(e)}`, 'error');
    } finally {
      setRegisteringOs(false);
    }
  };

  const handleDeleteWithFiles = async (t: TorrentItem) => {
    const ok = await confirm({
      title: 'Delete torrent & downloaded files?',
      message: `This will remove “${t.name}” from TruongFlix and permanently delete its downloaded video files from disk.`,
      confirmLabel: 'Delete Files',
      danger: true,
    });
    if (!ok) return;
    await removeTorrent(t.infoHash, true);
    toast(`Deleted “${t.name}” and its files`, 'info');
  };

  return (
    <Page
      title="Torrents"
      description="Stream sequentially or download directly into your Movies and TV libraries with full BitTorrent controls."
    >
      {/* 1. Transfers List */}
      <Group
        title="Transfers"
        description="Active downloads, sequential streams, and completed transfers."
      >
        <Block className="flex flex-wrap items-center justify-between gap-3 bg-black/20">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ['all', `All (${torrents.length})`],
                ['downloading', 'Downloading'],
                ['streams', 'Streams'],
                ['seeding', 'Seeding'],
                ['completed', 'Completed'],
              ] as [TransferFilter, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  filter === id ? 'bg-white text-black' : 'bg-white/5 text-nf-secondary hover:bg-white/10 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(totals.dl > 0 || totals.ul > 0) && (
              <div className="mr-1 flex items-center gap-2.5 rounded-full border border-white/10 bg-black/40 px-3 py-1 text-xs tabular-nums">
                <span className="flex items-center gap-1 text-sky-300">
                  <ArrowDown className="h-3 w-3" /> {formatSpeed(totals.dl)}
                </span>
                <span className="flex items-center gap-1 text-emerald-300">
                  <ArrowUp className="h-3 w-3" /> {formatSpeed(totals.ul)}
                </span>
              </div>
            )}
            {torrents.some((t) => t.inSession) && (
              <>
                <button type="button" onClick={() => void pauseAllTorrents()} className={BTN} title="Pause all active torrents">
                  <Pause className="h-3.5 w-3.5" /> Pause All
                </button>
                <button type="button" onClick={() => void resumeAllTorrents()} className={BTN} title="Resume paused torrents">
                  <Play className="h-3.5 w-3.5" /> Resume All
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => openAddTorrent()}
              className={BTN_PRIMARY}
            >
              <Plus className="h-4 w-4" /> Add Magnet / .torrent
            </button>
          </div>
        </Block>

        {filtered.length === 0 ? (
          <Block className="py-10 text-center">
            <Magnet className="mx-auto mb-2.5 h-8 w-8 text-white/25" />
            <p className="text-sm font-semibold text-white">
              {torrents.length === 0 ? 'No torrents yet' : 'No transfers match this filter'}
            </p>
            <p className="mx-auto mt-1 max-w-md text-xs text-nf-muted">
              Paste a magnet link, open a <code className="text-white/80">.torrent</code> file, or drag and drop one anywhere into TruongFlix to stream or download into your library.
            </p>
          </Block>
        ) : (
          filtered.map((t) => {
            const badge = stateBadge(t);
            const expiry = t.mode === 'stream' ? formatExpiryRemaining(t.expiresAt, false) : null;
            const revealTarget = t.filePaths[0] || t.savePath;

            return (
              <Block key={t.infoHash} className="space-y-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openMatchedTitle(t)}
                        className="truncate text-left text-sm font-semibold text-white hover:underline"
                        title="Open in library"
                      >
                        {t.name}
                      </button>
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badge.cls}`}>
                        {badge.label}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          t.mode === 'stream'
                            ? 'border-amber-400/35 bg-amber-500/10 text-amber-200'
                            : 'border-white/15 bg-white/5 text-nf-secondary'
                        }`}
                      >
                        {t.mode === 'stream' ? 'Stream' : 'Download'}
                      </span>
                      {expiry && (
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium ${
                            expiry.urgent
                              ? 'border-nf-red/50 bg-nf-red/15 text-red-200'
                              : 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                          }`}
                        >
                          <Clock className="h-3 w-3" /> {expiry.label}
                        </span>
                      )}
                    </div>
                    {t.error && <p className="mt-1 text-xs text-nf-red">{t.error}</p>}
                  </div>

                  <span className="shrink-0 font-mono text-xs tabular-nums text-white/85">
                    {t.progressPct.toFixed(1)}%
                  </span>
                </div>

                {/* Progress bar */}
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full transition-all duration-300 ${
                      t.error ? 'bg-nf-red' : t.finished ? 'bg-nf-green' : 'bg-sky-400'
                    }`}
                    style={{ width: `${Math.max(t.state === 'resolving' ? 4 : 0, Math.min(100, t.progressPct))}%` }}
                  />
                </div>

                {/* Live speed / peers / ETA / ratio */}
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-nf-muted">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
                    <span>
                      {formatBytes(t.progressBytes)} / {t.totalBytes > 0 ? formatBytes(t.totalBytes) : '—'}
                    </span>
                    {!t.finished && t.inSession && !t.paused && (
                      <>
                        <span className="text-sky-300">↓ {formatSpeed(t.downloadSpeedBps)}</span>
                        <span>ETA {formatEta(t.etaSecs)}</span>
                      </>
                    )}
                    {t.inSession && !t.paused && (
                      <>
                        <span className="text-emerald-300">↑ {formatSpeed(t.uploadSpeedBps)}</span>
                        <span>
                          Peers {t.peersLive}
                          {t.peersSeen > 0 ? ` (${t.peersSeen})` : ''}
                        </span>
                      </>
                    )}
                    <span>Ratio {t.ratio.toFixed(2)}</span>
                  </div>

                  {!t.seedingStopped && (
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-nf-secondary select-none">
                      <input
                        type="checkbox"
                        checked={t.deleteOnComplete}
                        onChange={(e) => void setTorrentDeleteOnComplete(t.infoHash, e.target.checked)}
                        className="h-3.5 w-3.5 accent-nf-red"
                      />
                      Stop seeding when complete
                    </label>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      setSettingsOpen(false);
                      void playTorrentByHash(t.infoHash);
                    }}
                    className="nf-btn-red h-8 px-3 py-0 text-xs"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    {t.finished ? 'Play' : 'Stream Now'}
                  </button>

                  {t.inSession && !t.seedingStopped && (
                    t.paused ? (
                      <button type="button" onClick={() => void resumeTorrent(t.infoHash)} className="nf-btn-ghost h-8 px-2.5 py-0 text-xs">
                        <Play className="h-3.5 w-3.5" /> Resume
                      </button>
                    ) : (
                      <button type="button" onClick={() => void pauseTorrent(t.infoHash)} className="nf-btn-ghost h-8 px-2.5 py-0 text-xs">
                        <Pause className="h-3.5 w-3.5" /> Pause
                      </button>
                    )
                  )}

                  {t.mode === 'stream' && (
                    <button
                      type="button"
                      onClick={() => void keepStreamPermanently(t.infoHash)}
                      className="nf-btn-ghost h-8 px-2.5 py-0 text-xs text-amber-200 hover:!border-amber-300/60"
                      title="Move to your permanent library folder and clear the expiration timer"
                    >
                      <HardDriveDownload className="h-3.5 w-3.5" /> Keep in Library
                    </button>
                  )}

                  {t.finished && t.inSession && !t.seedingStopped && (
                    <button
                      type="button"
                      onClick={() => void stopSeedingTorrent(t.infoHash)}
                      className="nf-btn-ghost h-8 px-2.5 py-0 text-xs"
                      title="Remove from BitTorrent session and stop uploading while keeping downloaded files"
                    >
                      <Square className="h-3 w-3" /> Stop Seeding
                    </button>
                  )}

                  {revealTarget && (
                    <button
                      type="button"
                      onClick={() => revealInFileManager(revealTarget).catch((e) => toast(String(e), 'error'))}
                      className="nf-btn-ghost h-8 px-2.5 py-0 text-xs"
                      title={`Show in ${FILE_MANAGER_NAME}`}
                    >
                      <FolderOpen className="h-3.5 w-3.5" /> {FILE_MANAGER_NAME}
                    </button>
                  )}

                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void removeTorrent(t.infoHash, false)}
                      className="nf-btn-ghost h-8 px-2.5 py-0 text-xs"
                      title="Remove transfer entry from this list without deleting files"
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteWithFiles(t)}
                      className={`${BTN_DANGER} !h-8 !px-2.5 !text-xs`}
                      title="Remove torrent and delete downloaded files from disk"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete + Files
                    </button>
                  </div>
                </div>
              </Block>
            );
          })
        )}
      </Group>

      {/* 2. Seeding, Stream Cache & Default Folders */}
      <Group
        title="Downloads, Stream Cache & Seeding"
        description="Choose how new torrents behave, how long temporary streams stay cached, and whether to seed after completion."
      >
        <Row label="Default mode when opening torrents" description="Stream prioritizes pieces sequentially with an expiration timer; Download saves permanently.">
          <Segmented<TorrentMode>
            value={settings.torrent_default_mode}
            options={[
              ['download', 'Download'],
              ['stream', 'Stream'],
            ]}
            onChange={(v) => void update({ torrent_default_mode: v })}
          />
        </Row>

        <ToggleRow
          label="Remove torrent after download completes (stop seeding)"
          description="Automatically removes finished downloads from the BitTorrent session so seeding stops, while keeping all downloaded video files in your library."
          checked={settings.torrent_delete_after_complete}
          onChange={(v) => void update({ torrent_delete_after_complete: v })}
        />

        <Row
          label="Stream cache retention"
          description="How long streamed titles stay in your library before being automatically cleared (shown as a countdown on posters and info pages)."
        >
          <Segmented<number>
            value={settings.torrent_stream_cache_hours}
            options={CACHE_OPTIONS}
            onChange={(v) => void update({ torrent_stream_cache_hours: v })}
          />
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              max={8760}
              value={settings.torrent_stream_cache_hours}
              onChange={(e) => {
                const n = Math.max(1, Math.min(8760, Number(e.target.value) || 1));
                void update({ torrent_stream_cache_hours: n });
              }}
              aria-label="Stream cache hours"
              className={`${INPUT} w-20 text-right tabular-nums`}
            />
            <span className="text-xs text-nf-muted">hr</span>
          </div>
        </Row>

        <Row
          label="Maximum share ratio"
          description="Stop seeding automatically once a torrent reaches this upload/download ratio (0 = unlimited)."
        >
          <Segmented<number>
            value={settings.torrent_seed_ratio_limit}
            options={RATIO_OPTIONS}
            onChange={(v) => void update({ torrent_seed_ratio_limit: v })}
          />
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={settings.torrent_seed_ratio_limit}
            onChange={(e) => void update({ torrent_seed_ratio_limit: Math.max(0, Number(e.target.value) || 0) })}
            aria-label="Max share ratio"
            className={`${INPUT} w-20 text-right tabular-nums`}
          />
        </Row>

        <Row
          label="Maximum seeding time"
          description="Stop seeding automatically after this many minutes following completion (0 = unlimited)."
        >
          <Segmented<number>
            value={settings.torrent_seed_time_mins}
            options={SEED_TIME_OPTIONS}
            onChange={(v) => void update({ torrent_seed_time_mins: v })}
          />
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              max={525600}
              value={settings.torrent_seed_time_mins}
              onChange={(e) => void update({ torrent_seed_time_mins: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              aria-label="Max seeding minutes"
              className={`${INPUT} w-20 text-right tabular-nums`}
            />
            <span className="text-xs text-nf-muted">min</span>
          </div>
        </Row>

        <Row
          label="Default Movies library folder"
          description="Used automatically when a torrent matches a movie."
        >
          <Dropdown
            value={settings.torrent_movies_dir}
            options={folderOptions}
            onChange={(v) => void update({ torrent_movies_dir: v })}
            align="right"
            ariaLabel="Default Movies library folder"
            className="min-w-[240px]"
          />
        </Row>

        <Row
          label="Default TV Shows library folder"
          description="Used automatically when a torrent matches a TV series or season pack."
        >
          <Dropdown
            value={settings.torrent_tv_dir}
            options={folderOptions}
            onChange={(v) => void update({ torrent_tv_dir: v })}
            align="right"
            ariaLabel="Default TV Shows library folder"
            className="min-w-[240px]"
          />
        </Row>
      </Group>

      {/* 3. Speed Limits & Connection (qBittorrent-level control) */}
      <Group
        title="Speed & Connection"
        description="Global bandwidth limits, incoming TCP/uTP listening port, and peer connection caps."
      >
        <Row
          label="Global download rate limit"
          description="Maximum download speed across all torrents in KB/s (0 = unlimited). Applied immediately."
        >
          <Segmented<number>
            value={settings.torrent_max_download_kbps}
            options={[
              [0, 'Unlimited'],
              [5120, '5 MB/s'],
              [20480, '20 MB/s'],
            ]}
            onChange={(v) => void update({ torrent_max_download_kbps: v })}
          />
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              step={100}
              value={settings.torrent_max_download_kbps}
              onChange={(e) => void update({ torrent_max_download_kbps: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              aria-label="Download rate limit KB/s"
              className={`${INPUT} w-24 text-right tabular-nums`}
            />
            <span className="text-xs text-nf-muted">KB/s</span>
          </div>
        </Row>

        <Row
          label="Global upload rate limit"
          description="Maximum upload (seeding) speed across all torrents in KB/s (0 = unlimited). Applied immediately."
        >
          <Segmented<number>
            value={settings.torrent_max_upload_kbps}
            options={[
              [0, 'Unlimited'],
              [512, '512 KB/s'],
              [2048, '2 MB/s'],
              [10240, '10 MB/s'],
            ]}
            onChange={(v) => void update({ torrent_max_upload_kbps: v })}
          />
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              step={100}
              value={settings.torrent_max_upload_kbps}
              onChange={(e) => void update({ torrent_max_upload_kbps: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              aria-label="Upload rate limit KB/s"
              className={`${INPUT} w-24 text-right tabular-nums`}
            />
            <span className="text-xs text-nf-muted">KB/s</span>
          </div>
        </Row>

        <Row
          label="Incoming listening port"
          description={
            <>
              Port used for incoming peer connections (<code className="text-white/80">0</code> selects an available port automatically
              {totals.boundPort ? `; currently listening on port ${totals.boundPort}` : ''}).
            </>
          }
        >
          <input
            type="number"
            min={0}
            max={65535}
            value={settings.torrent_listen_port}
            onChange={(e) => {
              const p = Math.max(0, Math.min(65535, Math.round(Number(e.target.value) || 0)));
              void update({ torrent_listen_port: p });
            }}
            aria-label="Listening port"
            className={`${INPUT} w-28 text-right tabular-nums`}
          />
          <button
            type="button"
            onClick={() => {
              const randomPort = Math.floor(15000 + Math.random() * 45000);
              void update({ torrent_listen_port: randomPort });
            }}
            className={BTN}
          >
            <Shuffle className="h-3.5 w-3.5" /> Random
          </button>
        </Row>

        <ToggleRow
          label="Use UPnP / NAT-PMP port forwarding"
          description="Automatically forward the listening port on your router for faster peer connections."
          checked={settings.torrent_upnp}
          onChange={(v) => void update({ torrent_upnp: v })}
        />

        <Row
          label="Maximum peers per torrent"
          description="Upper bound on simultaneous peer connections per active torrent."
        >
          <input
            type="number"
            min={10}
            max={500}
            value={settings.torrent_peer_limit}
            onChange={(e) => {
              const n = Math.max(10, Math.min(500, Math.round(Number(e.target.value) || 128)));
              void update({ torrent_peer_limit: n });
            }}
            aria-label="Max peers per torrent"
            className={`${INPUT} w-24 text-right tabular-nums`}
          />
        </Row>
      </Group>

      {/* 4. BitTorrent Protocol & Discovery */}
      <Group
        title="BitTorrent Protocol & Discovery"
        description="Control decentralized peer discovery and tracker announces."
      >
        <ToggleRow
          label="Enable DHT (Distributed Hash Table)"
          description="Find peers and resolve magnet links without relying on centralized trackers."
          checked={settings.torrent_dht}
          onChange={(v) => void update({ torrent_dht: v })}
        />
        <ToggleRow
          label="Enable Local Peer Discovery (LSD)"
          description="Discover BitTorrent peers on your local network to transfer at LAN speeds."
          checked={settings.torrent_lsd}
          onChange={(v) => void update({ torrent_lsd: v })}
        />
        <ToggleRow
          label="Enable BitTorrent Trackers"
          description="Announce to HTTP and UDP trackers embedded in magnets and .torrent files."
          checked={settings.torrent_trackers}
          onChange={(v) => void update({ torrent_trackers: v })}
        />
      </Group>

      {/* 5. System & Browser Integration */}
      <Group
        title="System & Browser Integration"
        description="Open magnet links from your browser and double-click .torrent files directly in TruongFlix."
      >
        <Row
          label="Default torrent & magnet application"
          description={
            osStatus ? (
              osStatus.magnet_registered && osStatus.torrent_file_registered ? (
                <StatusText tone="good">
                  <span className="inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" /> TruongFlix is your default handler for magnet: links and .torrent files.
                  </span>
                </StatusText>
              ) : (
                <StatusText tone="muted">
                  Magnet links: {osStatus.magnet_registered ? 'Default' : 'Not default'} · .torrent files:{' '}
                  {osStatus.torrent_file_registered ? 'Default' : 'Not default'}
                </StatusText>
              )
            ) : (
              'Register TruongFlix to handle magnet: URLs and .torrent files across your system.'
            )
          }
        >
          <Switch
            checked={Boolean(osStatus?.magnet_registered && osStatus?.torrent_file_registered)}
            onChange={() => void handleSetDefaultHandler()}
            label="Default magnet and torrent handler"
          />
          <button
            type="button"
            disabled={registeringOs}
            onClick={() => void handleSetDefaultHandler()}
            className={BTN_PRIMARY}
          >
            {registeringOs
              ? 'Registering…'
              : osStatus?.magnet_registered && osStatus?.torrent_file_registered
                ? 'Re-apply Default'
                : 'Set as Default'}
          </button>
        </Row>
      </Group>
    </Page>
  );
}
