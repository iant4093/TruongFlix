import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, Loader2, Play, X } from 'lucide-react';
import { useModalDialog } from '../../hooks/useModalDialog';
import { useLibraryStore } from '../../store/useLibraryStore';
import { fetchGame } from '../source';
import { launchGame, useGamesStore } from '../jobs';
import type { GameCard, GameDetail } from '../types';
import GameCover, { useCachedImage } from './GameCover';
import DownloadDialog from './DownloadDialog';
import { gameStatusLabel } from './status';

function Screenshot({ shot, onOpen }: { shot: { thumb: string; full: string }; onOpen: () => void }) {
  const src = useCachedImage(shot.thumb);
  return <button type="button" onClick={onOpen} aria-label="Enlarge screenshot"
    className="aspect-video overflow-hidden rounded bg-white/5 ring-white/70 transition hover:ring-2 focus-visible:ring-2">
    {src && <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />}
  </button>;
}

function Lightbox({ shot, onClose }: { shot: { thumb: string; full: string }; onClose: () => void }) {
  const src = useCachedImage(shot.full, shot.thumb);
  const ref = useRef<HTMLDivElement>(null);
  const { onBackdropMouseDown } = useModalDialog(ref, { onClose, priority: 120 });
  return <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/90 p-8" onMouseDown={onBackdropMouseDown}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Screenshot" className="relative outline-none">
      {src ? <img src={src} alt="" className="max-h-[85vh] max-w-[90vw] rounded" /> : <Loader2 className="h-8 w-8 animate-spin text-white/60" />}
      <button onClick={onClose} aria-label="Close screenshot" className="absolute -right-3 -top-3 rounded-full bg-black/80 p-2 hover:bg-black"><X className="h-5 w-5" /></button>
    </div>
  </div>;
}

export default function GameDetailDialog({ origin, game, onClose, onOpenLibrary }: {
  origin: string;
  game: GameCard | GameDetail;
  onClose: () => void;
  onOpenLibrary: () => void;
}) {
  const [detail, setDetail] = useState<GameDetail | null>('magnet' in game ? game : null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [shot, setShot] = useState<{ thumb: string; full: string } | null>(null);
  const [showAllFeatures, setShowAllFeatures] = useState(false);
  const owned = useGamesStore((s) => s.games.find((g) => g.slug === game.slug));
  const job = useGamesStore((s) => (owned ? s.jobs[owned.id] : undefined));
  const torrent = useLibraryStore((s) => (owned?.infoHash ? s.torrents.find((t) => t.infoHash === owned.infoHash) : undefined));
  const ref = useRef<HTMLDivElement>(null);
  const { onBackdropMouseDown } = useModalDialog(ref, { onClose, active: !downloading && !shot, priority: 100 });

  useEffect(() => {
    if (detail) return;
    let active = true;
    fetchGame(origin, game.slug)
      .then((d) => { if (active) d ? setDetail(d) : setError('This game is no longer on the source.'); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [origin, game.slug, detail]);

  const info = detail ?? game;
  const facts = detail ? [
    ['Company', detail.companies.join(', ')],
    ['Languages', detail.languages],
    ['Original size', detail.originalSize],
    ['Download size', detail.repackSize + (detail.selective ? ' · optional files' : '')],
  ].filter(([, v]) => v) : [];
  const features = detail?.features ?? [];

  let action: React.ReactNode;
  if (owned?.status === 'installed' || owned?.status === 'verify_failed') {
    action = <button className="nf-btn-play" onClick={() => void launchGame(owned.id).catch((e) => useLibraryStore.getState().toast(String(e), 'error'))}><Play className="h-5 w-5 fill-current" />Play</button>;
  } else if (owned) {
    action = <button className="nf-btn-info" onClick={() => { onClose(); onOpenLibrary(); }}>
      {gameStatusLabel(owned, job, torrent)}
    </button>;
  } else {
    action = <button className="nf-btn-red" disabled={!detail?.magnet} onClick={() => setDownloading(true)}><Download className="h-5 w-5" />Download</button>;
  }

  return <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/80 px-6 py-10" onMouseDown={onBackdropMouseDown}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={info.title}
      className="relative w-full max-w-5xl overflow-hidden rounded-lg bg-[#181818] shadow-2xl outline-none">
      <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 z-10 rounded-full bg-black/70 p-2 hover:bg-black"><X className="h-5 w-5" /></button>
      <div className="flex flex-col gap-8 p-8 md:flex-row">
        <GameCover url={info.cover} title={info.title} className="aspect-[3/4] w-48 shrink-0 self-start rounded-md shadow-card md:w-60" />
        <div className="min-w-0 flex-1">
          <h2 className="pr-10 text-3xl font-bold leading-tight">{info.title}</h2>
          {info.subtitle && <p className="mt-2 text-sm text-white/60">{info.subtitle}</p>}
          {detail && detail.genres.length > 0 && <div className="mt-4 flex flex-wrap gap-2">
            {detail.genres.slice(0, 8).map((g) => <span key={g} className="rounded-full border border-white/20 px-2.5 py-0.5 text-xs text-white/75">{g}</span>)}
          </div>}
          {facts.length > 0 && <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            {facts.map(([label, value]) => <div key={label}><dt className="text-white/45">{label}</dt><dd className="mt-0.5 text-white/90">{value}</dd></div>)}
          </dl>}
          <div className="mt-7 flex flex-wrap items-center gap-3">
            {!detail && !error ? <span className="flex items-center gap-2 text-sm text-white/60"><Loader2 className="h-4 w-4 animate-spin" />Loading details…</span> : action}
          </div>
          {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
        </div>
      </div>
      {detail && detail.screenshots.length > 0 && <section className="px-8 pb-6">
        <h3 className="mb-3 text-lg font-semibold">Screenshots</h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {detail.screenshots.map((s) => <Screenshot key={s.thumb} shot={s} onOpen={() => setShot(s)} />)}
        </div>
      </section>}
      {detail?.description && <section className="px-8 pb-6">
        <h3 className="mb-3 text-lg font-semibold">About this game</h3>
        <p className="selectable whitespace-pre-line text-sm leading-relaxed text-white/75">{detail.description}</p>
      </section>}
      {features.length > 0 && <section className="px-8 pb-8">
        <h3 className="mb-3 text-lg font-semibold">Download details</h3>
        <ul className="selectable list-disc space-y-1.5 pl-5 text-sm text-white/70">
          {(showAllFeatures ? features : features.slice(0, 5)).map((f) => <li key={f}>{f}</li>)}
        </ul>
        {features.length > 5 && <button className="mt-3 flex items-center gap-1 text-sm text-white/60 hover:text-white" onClick={() => setShowAllFeatures((v) => !v)}>
          <ChevronDown className={`h-4 w-4 transition ${showAllFeatures ? 'rotate-180' : ''}`} />{showAllFeatures ? 'Show less' : `Show all ${features.length}`}
        </button>}
      </section>}
    </div>
    {downloading && detail && <DownloadDialog detail={detail} onClose={() => setDownloading(false)} onStarted={() => { onClose(); onOpenLibrary(); }} />}
    {shot && <Lightbox shot={shot} onClose={() => setShot(null)} />}
  </div>;
}
