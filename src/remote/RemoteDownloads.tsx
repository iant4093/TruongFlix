import { leavingClass, useLeaving } from '../lib/leaving';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, CircleCheck, Download, Loader2, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import ProgressBar from '../components/common/ProgressBar';
import { formatBytes } from '../lib/format';
import { errorMessage } from '../lib/errors';
import { QUALITY_LEVELS, levelLabel, qualityLabel, type Quality } from '../lib/quality';
import { api, qs } from './api';
import { deleteDownload, pauseDownload, resumeDownload, saveForOffline, storageInfo, useOfflineItems } from './offline';
import { downloadFraction, downloadId, statusText, type OfflineItem, type SpaceEstimate } from './offlineLogic';
import { savedQuality, saveQuality } from './qualityPref';
import type { RemoteQualities } from './types';

type Who = { id: number; key?: string };
export interface DownloadTarget {
  type: 'movie' | 'episode';
  id: number;
  title: string;
  subtitle: string | null;
  itemKey: string | null;
}

/** The saved copy of a title for this profile, if any. */
export function useOfflineItem(who: Who, type: 'movie' | 'episode', id: number): OfflineItem | undefined {
  const items = useOfflineItems();
  return items.find((i) => i.id === downloadId(who.id, type, id));
}

/** Picks a quality and adds the title to this browser's downloads. */
export function DownloadSheet({ who, target, onClose, closing = false }: { who: Who; target: DownloadTarget; onClose: () => void; closing?: boolean }) {
  const [data, setData] = useState<RemoteQualities | null>(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState<Quality | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<RemoteQualities>(`/qualities${qs({ profile: who.id, key: who.key, type: target.type, id: target.id })}`)
      .then((d) => {
        setData(d);
        const saved = savedQuality('download');
        const steps = d.options.map((o) => o.res);
        setPick(saved && steps.includes(saved.res) ? saved : d.default);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [who.id, who.key, target.type, target.id]);

  const start = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      saveQuality(pick, 'download');
      await saveForOffline(who, target, pick);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`nf-fade fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center ${leavingClass(closing)}`} onClick={onClose}>
      <div
        role="dialog"
        aria-label="Download"
        className="nf-sheet-up w-full max-w-md rounded-t-2xl border border-white/15 bg-[#181818] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-bold">Download</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1 text-white/70 hover:bg-white/10 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-4 truncate text-sm text-nf-secondary">{target.subtitle ? `${target.title} · ${target.subtitle}` : target.title}</p>
        {!data && !error && <Loader2 className="mx-auto my-6 h-8 w-8 animate-spin text-nf-red" />}
        {data && pick && (
          <div className="space-y-1">
            {data.options.map((o) => {
              const active = pick.res === o.res;
              const size = o.sizes[o.res === 'original' ? 'high' : active ? pick.level : 'high'];
              const detail = o.res === 'original' ? (o.asIs ? 'The file as it is' : 'Converted on your PC at full resolution') : null;
              return (
                <div key={o.res} className={`rounded px-2.5 py-2 ${active ? 'bg-white/15' : ''}`}>
                  <button
                    onClick={() => setPick({ res: o.res, level: active ? pick.level : 'high' })}
                    className={`flex w-full items-center gap-2 text-left text-sm ${active ? 'font-semibold text-white' : 'text-nf-secondary'}`}
                  >
                    <Check className={`h-4 w-4 shrink-0 ${active ? 'opacity-100' : 'opacity-0'}`} />
                    <div className="min-w-0 flex-1">
                      <div>{o.label}</div>
                      {detail && <div className="text-[11px] font-normal text-nf-muted">{detail}</div>}
                    </div>
                    {size ? <span className="shrink-0 text-xs font-normal text-nf-muted">about {formatBytes(size)}</span> : null}
                  </button>
                  {active && o.res !== 'original' && (
                    <div className="mt-2 flex gap-1.5 pl-6" role="group" aria-label="Bitrate">
                      {QUALITY_LEVELS.map((level) => (
                        <button
                          key={level}
                          onClick={() => setPick({ res: o.res, level })}
                          aria-pressed={pick.level === level}
                          className={`flex-1 rounded py-1.5 text-xs font-medium ${pick.level === level ? 'bg-white text-black' : 'bg-white/10 text-nf-secondary'}`}
                        >
                          {levelLabel(level)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {error && <p className="mt-3 text-sm text-nf-red">{error}</p>}
        <button onClick={() => void start()} disabled={!pick || busy} className="nf-btn-red mt-5 w-full py-3 disabled:opacity-50">
          <Download className="h-5 w-5" /> Download
        </button>
        <p className="mt-2 text-center text-[11px] text-nf-muted">Saved in this browser for watching without a connection.</p>
      </div>
    </div>
  );
}

/** "Download" on a title page, or its progress / "Downloaded" once it is in the list. */
export function DownloadButton({
  who,
  target,
  compact = false,
  onOpenDownloads,
}: {
  who: Who;
  target: DownloadTarget;
  compact?: boolean;
  onOpenDownloads: () => void;
}) {
  const item = useOfflineItem(who, target.type, target.id);
  const [sheet, setSheet] = useState(false);
  const picker = useLeaving(sheet);
  const pct = item ? Math.round(downloadFraction(item) * 100) : 0;
  const busy = item && item.state !== 'done' && item.state !== 'failed';
  const label = !item || item.state === 'failed' ? 'Download' : item.state === 'done' ? 'Downloaded' : `${pct}%`;
  const Icon = item?.state === 'done' ? CircleCheck : busy ? Loader2 : Download;
  const onClick = () => (item && item.state !== 'failed' ? onOpenDownloads() : setSheet(true));
  return (
    <>
      {compact ? (
        <button
          onClick={onClick}
          aria-label={`${label}: ${target.subtitle ?? target.title}`}
          title={label}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-nf-secondary active:bg-white/10"
        >
          {busy ? <span className="text-[11px] font-semibold">{pct}%</span> : <Icon className={`h-5 w-5 ${item?.state === 'done' ? 'text-white' : ''}`} />}
        </button>
      ) : (
        <button onClick={onClick} className="nf-btn-info w-full justify-center py-3 text-lg sm:w-auto sm:px-8">
          <Icon className={`h-6 w-6 ${busy && item?.state === 'preparing' ? 'animate-spin' : ''}`} />
          {label}
        </button>
      )}
      {picker.shown && <DownloadSheet who={who} target={target} onClose={() => setSheet(false)} closing={picker.closing} />}
    </>
  );
}

/** Everything this profile saved in this browser. */
export function DownloadsPage({ who, back, play }: { who: Who; back: () => void; play: (item: OfflineItem) => void }) {
  const all = useOfflineItems();
  const items = useMemo(() => all.filter((i) => i.profile === who.id).sort((a, b) => b.createdAt - a.createdAt), [all, who.id]);
  // Other profiles' downloads (including profiles since deleted on the PC) use this phone's space
  // too: they can be cleared here without showing what they are.
  const others = useMemo(() => all.filter((i) => i.profile !== who.id), [all, who.id]);
  const othersBytes = others.reduce((n, i) => n + (i.bytes || 0), 0);
  const [space, setSpace] = useState<SpaceEstimate | null>(null);
  useEffect(() => {
    void storageInfo().then(setSpace);
  }, [all]);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);

  return (
    <div className="nf-push min-h-[100dvh] pb-16">
      <header className="sticky top-0 z-30 flex items-center gap-3 bg-gradient-to-b from-black/90 to-transparent px-4 pb-6 pt-[max(1rem,env(safe-area-inset-top))]">
        <button onClick={back} aria-label="Back" className="rounded-full p-1.5 hover:bg-white/10">
          <ArrowLeft className="h-6 w-6" />
        </button>
        <h1 className="text-2xl font-bold">Downloads</h1>
      </header>
      <div className="mx-auto max-w-3xl px-4">
        {!online && <p className="mb-4 rounded bg-white/10 px-3 py-2 text-sm text-nf-secondary">You’re offline. Downloaded titles still play.</p>}
        {space?.quota != null && (
          <p className="mb-4 text-xs text-nf-muted">
            {formatBytes(space.usage ?? 0)} used · {formatBytes(Math.max(0, space.quota - (space.usage ?? 0)))} free in this browser
          </p>
        )}
        {items.length === 0 && <p className="py-10 text-center text-nf-secondary">Titles you download show up here and play without a connection to your PC.</p>}
        <ul className="divide-y divide-white/10">
          {items.map((item) => (
            <DownloadRow key={item.id} item={item} play={play} />
          ))}
        </ul>
        {others.length > 0 && (
          <div className="mt-6 flex items-center justify-between gap-3 rounded bg-white/5 px-3 py-3 text-sm">
            <span className="text-nf-secondary">
              Other profiles: {others.length} download{others.length === 1 ? '' : 's'} · {formatBytes(othersBytes)}
            </span>
            <button
              onClick={() => {
                if (window.confirm(`Delete ${others.length} download${others.length === 1 ? '' : 's'} saved by other profiles on this phone?`)) {
                  void (async () => {
                    for (const i of others) await deleteDownload(i.id).catch(() => {});
                  })();
                }
              }}
              className="nf-press shrink-0 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
            >
              Delete them
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DownloadRow({ item, play }: { item: OfflineItem; play: (item: OfflineItem) => void }) {
  const active = item.state === 'queued' || item.state === 'preparing' || item.state === 'downloading';
  const canResume = item.state === 'paused' || item.state === 'failed';
  const problem = (item.state === 'paused' || item.state === 'failed') && item.error;
  return (
    <li className="flex items-center gap-3 py-3">
      <button
        onClick={() => item.state === 'done' && play(item)}
        disabled={item.state !== 'done'}
        aria-label={item.state === 'done' ? `Play ${item.title}` : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
      >
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-white/10">
          {item.state === 'done' ? <Play className="h-6 w-6 fill-white" strokeWidth={0} /> : <Download className="h-5 w-5 text-nf-secondary" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{item.title}</div>
          {item.subtitle && <div className="truncate text-xs text-nf-secondary">{item.subtitle}</div>}
          <div className={`truncate text-xs ${problem ? 'text-nf-red' : 'text-nf-muted'}`}>
            {item.quality ? `${qualityLabel(item.quality)} · ` : ''}
            {statusText(item)}
          </div>
          {active && <ProgressBar value={downloadFraction(item)} height={3} tone="download" rounded label="Download progress" className="mt-1.5" />}
        </div>
      </button>
      {active && (
        <button onClick={() => void pauseDownload(item.id)} aria-label="Pause download" className="rounded-full p-2 text-nf-secondary hover:bg-white/10 hover:text-white">
          <Pause className="h-5 w-5" />
        </button>
      )}
      {canResume && (
        <button onClick={() => void resumeDownload(item.id)} aria-label="Resume download" className="rounded-full p-2 text-nf-secondary hover:bg-white/10 hover:text-white">
          <RotateCcw className="h-5 w-5" />
        </button>
      )}
      <button
        onClick={() => {
          if (window.confirm(`Delete the download of ${item.subtitle ?? item.title}?`)) void deleteDownload(item.id);
        }}
        aria-label="Delete download"
        className="rounded-full p-2 text-nf-secondary hover:bg-white/10 hover:text-white"
      >
        <Trash2 className="h-5 w-5" />
      </button>
    </li>
  );
}
