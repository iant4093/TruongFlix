import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, Monitor, Play, Star } from 'lucide-react';
import ProgressBar from '../components/common/ProgressBar';
import { backdropSrcSet } from '../lib/images';
import { errorMessage } from '../lib/errors';
import { api, qs } from './api';
import type { NowPlaying } from './RemoteControl';
import { DownloadButton } from './RemoteDownloads';
import { Img, MetaLine, MyListButton, Poster, StingerNote, type RemoteWho } from './RemoteBits';
import type { RemoteEpisode, RemotePerson, RemotePlayable, RemoteTitle } from './types';

/**
 * A title in the browser app, with what the desktop's detail window shows: the artwork, scores
 * and picture/sound badges, Play / Resume / Play on PC / My List / Download, tagline and story,
 * the cast with photos, seasons with their IMDb ratings, episodes, the collection and More Like This.
 */
export default function TitlePage({
  who,
  itemKey,
  back,
  open,
  play,
  now,
  pad,
  openRemote,
  openDownloads,
}: {
  who: RemoteWho;
  itemKey: string;
  back: () => void;
  open: (key: string) => void;
  play: (t: RemotePlayable) => void;
  now: NowPlaying;
  pad: string;
  openRemote: () => void;
  openDownloads: () => void;
}) {
  const [data, setData] = useState<RemoteTitle | null>(null);
  const [error, setError] = useState('');
  const [season, setSeason] = useState<number | null>(null);
  const [pcBusy, setPcBusy] = useState(false);
  const [pcError, setPcError] = useState('');
  const playOnPc = async (t: RemotePlayable) => {
    setPcBusy(true);
    setPcError('');
    try {
      await api('/remote/play', { body: { profile: who.id, key: who.key, type: t.type, id: t.id } });
      now.refresh();
      openRemote();
    } catch (e) {
      setPcError(errorMessage(e));
    } finally {
      setPcBusy(false);
    }
  };
  useEffect(() => {
    setData(null);
    setError('');
    api<RemoteTitle>(`/title${qs({ profile: who.id, key: who.key, item: itemKey })}`)
      .then((d) => {
        setData(d);
        const current = d.episodes.find((e) => e.id === d.play?.id);
        setSeason(current?.season ?? d.episodes[0]?.season ?? null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [who.id, who.key, itemKey]);

  // A title always opens at its top (the page you came from may have been scrolled far down).
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [itemKey, !!data]);

  const seasons = useMemo(() => [...new Set((data?.episodes ?? []).map((e) => e.season))], [data]);

  if (!data)
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 text-nf-secondary">
        {error ? <p className="text-nf-red">{error}</p> : <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" aria-label="Loading" />}
        <button onClick={back} className="text-sm underline">
          Back
        </button>
      </div>
    );

  const { item } = data;
  const list = data.episodes.filter((e) => e.season === season);
  const resume = data.play && data.play.resume > 0;
  const current = data.episodes.find((e) => e.id === data.play?.id);
  const people = data.people ?? data.cast.map((name) => ({ name, role: null, photo: null }));
  const crew = data.crew ?? [];
  const delay = (n: number) => ({ animationDelay: `${120 + n * 70}ms` });

  return (
    <div key={itemKey} className={`nf-push min-h-[100dvh] ${pad}`}>
      <div className="relative aspect-video max-h-[62vh] w-full overflow-hidden md:max-h-[70vh]">
        {item.backdrop && <img src={item.backdrop} srcSet={backdropSrcSet(item.backdrop)} sizes="100vw" alt="" className="nf-zoom-in h-full w-full object-cover object-top" />}
        <div className="absolute inset-0 bg-gradient-to-t from-nf-bg via-nf-bg/10 to-black/30" />
        <button onClick={back} aria-label="Back" className="nf-press absolute left-3 top-[max(0.75rem,env(safe-area-inset-top))] rounded-full bg-black/60 p-2 backdrop-blur-sm">
          <ArrowLeft className="h-6 w-6" />
        </button>
      </div>

      <div className="relative mx-auto -mt-16 max-w-4xl space-y-4 px-4 md:-mt-28">
        <div className="nf-rise" style={delay(0)}>
          {item.logo ? <img src={item.logo} alt={item.title} className="max-h-24 max-w-[75%] object-contain object-left drop-shadow-[0_2px_10px_rgba(0,0,0,0.7)] md:max-h-32" /> : <h1 className="text-4xl font-black">{item.title}</h1>}
        </div>

        <div className="nf-rise space-y-1.5" style={delay(1)}>
          <MetaLine item={item} />
          {item.kind === 'tv' && (item.status || item.nextAir) && (
            <p className="text-sm text-white/65">
              {item.status}
              {item.status && item.nextAir ? ' · ' : ''}
              {item.nextAir && <span className="text-white/85">Next episode {item.nextAir}</span>}
            </p>
          )}
          <StingerNote item={item} />
        </div>

        {data.play && (
          <div className="nf-rise space-y-2" style={delay(2)}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <button onClick={() => play(data.play!)} className="nf-press nf-btn-play w-full justify-center py-3 text-lg sm:w-auto sm:px-10">
                <Play className="h-6 w-6 fill-black" strokeWidth={0} />
                {resume ? 'Resume' : 'Play'}
                {item.kind === 'tv' && <span className="text-base font-medium text-black/60">{data.play.label.match(/S\d+:E\d+/)?.[0]}</span>}
              </button>
              <button onClick={() => void playOnPc(data.play!)} disabled={pcBusy} className="nf-press nf-btn-info w-full justify-center py-3 text-lg disabled:opacity-60 sm:w-auto sm:px-8">
                <Monitor className="h-6 w-6" />
                {pcBusy ? 'Starting…' : `Play on ${now.pc ?? 'PC'}`}
              </button>
              <div className="flex items-center justify-center gap-3">
                <MyListButton who={who} item={item} />
                {item.kind === 'movie' && data.play.type === 'movie' && (
                  <DownloadButton who={who} target={{ type: 'movie', id: data.play.id, title: item.title, subtitle: null, itemKey: item.key }} onOpenDownloads={openDownloads} />
                )}
              </div>
            </div>
            {resume && item.progress != null && (
              <div className="flex items-center gap-3 text-xs text-nf-secondary">
                <ProgressBar value={item.progress} height={3} className="max-w-[220px] flex-1 rounded-sm" />
                {current ? `S${current.season}:E${current.episode}` : null}
              </div>
            )}
          </div>
        )}
        {pcError && <p className="text-sm text-nf-red">{pcError}</p>}

        <div className="nf-rise space-y-2" style={delay(3)}>
          {item.tagline && <p className="italic text-white/70">{item.tagline}</p>}
          <p className="leading-relaxed text-white/90">{item.overview}</p>
          {crew.length > 0 && (
            <p className="text-sm text-white/60">
              <span className="text-white/45">{crew[0].role === 'Creator' ? 'Created by' : 'Directed by'} </span>
              {crew.map((c) => c.name).join(', ')}
            </p>
          )}
          {item.genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {item.genres.map((g) => (
                <span key={g} className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white/80">
                  {g}
                </span>
              ))}
            </div>
          )}
        </div>

        {people.length > 0 && <Cast people={people} style={delay(4)} />}

        {seasons.length > 0 && (
          <section className="nf-rise pt-2" style={delay(5)}>
            <h2 className="mb-3 text-xl font-bold">Episodes</h2>
            {seasons.length > 1 && (
              <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none]">
                {seasons.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSeason(s)}
                    aria-pressed={season === s}
                    className={`nf-press flex shrink-0 items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${season === s ? 'bg-white text-black' : 'bg-white/10 text-white/80'}`}
                  >
                    {s === 0 ? 'Specials' : `Season ${s}`}
                    {data.seasonRatings?.[s] != null && (
                      <span className={`flex items-center gap-0.5 text-xs ${season === s ? 'text-black/60' : 'text-[#f5c518]'}`}>
                        <Star className="h-3 w-3 fill-current" strokeWidth={0} />
                        {data.seasonRatings[s].toFixed(1)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            <div key={season} className="nf-fade divide-y divide-white/10">
              {list.map((e) => (
                <EpisodeRow key={e.id} e={e} itemTitle={item.title} itemKey={item.key} who={who} pc={now.pc ?? 'PC'} busy={pcBusy} play={play} playOnPc={playOnPc} openDownloads={openDownloads} />
              ))}
            </div>
          </section>
        )}

        {data.collection && (
          <section className="nf-rise pt-4" style={delay(6)}>
            <h2 className="mb-3 text-xl font-bold">{data.collection.name}</h2>
            <div className="-mx-4 flex gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
              {data.collection.items.map((i) => (
                <Poster key={i.key} item={i} onClick={() => i.key !== item.key && open(i.key)} className={`w-28 sm:w-32 ${i.key === item.key ? 'opacity-50' : ''}`} />
              ))}
            </div>
          </section>
        )}

        {data.similar && data.similar.length > 0 && (
          <section className="nf-rise pb-4 pt-4" style={delay(7)}>
            <h2 className="mb-3 text-xl font-bold">More Like This</h2>
            <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-6">
              {data.similar.map((i) => (
                <Poster key={i.key} item={i} onClick={() => open(i.key)} className="w-full" />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

function Cast({ people, style }: { people: RemotePerson[]; style: React.CSSProperties }) {
  return (
    <section className="nf-rise pt-2" style={style}>
      <h2 className="mb-3 text-xl font-bold">Cast</h2>
      <div className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {people.map((p) => (
          <div key={`${p.name}-${p.role}`} className="w-20 shrink-0 text-center">
            <div className="mx-auto flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-white/10 text-lg font-semibold text-white/60">
              {p.photo ? <Img src={p.photo} alt="" className="h-full w-full object-cover" /> : initials(p.name)}
            </div>
            <div className="mt-1.5 line-clamp-2 text-xs font-medium leading-tight">{p.name}</div>
            {p.role && <div className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-white/50">{p.role}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

function EpisodeRow({
  e,
  itemTitle,
  itemKey,
  who,
  pc,
  busy,
  play,
  playOnPc,
  openDownloads,
}: {
  e: RemoteEpisode;
  itemTitle: string;
  itemKey: string;
  who: RemoteWho;
  pc: string;
  busy: boolean;
  play: (t: RemotePlayable) => void;
  playOnPc: (t: RemotePlayable) => Promise<void>;
  openDownloads: () => void;
}) {
  const target: RemotePlayable = { type: 'episode', id: e.id, label: `S${e.season}:E${e.episode} · ${e.title}`, resume: -1 };
  return (
    <div className="flex items-center">
      <button onClick={() => play(target)} className="nf-press flex min-w-0 flex-1 gap-3 py-3 text-left">
        <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-md bg-white/10 sm:w-40">
          {e.still && <Img src={e.still} alt="" className="h-full w-full object-cover" />}
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-white/70 bg-black/45">
              <Play className="ml-0.5 h-4 w-4 fill-white" strokeWidth={0} />
            </span>
          </span>
          {e.progress > 0 && <ProgressBar value={e.progress} height={3} className="absolute inset-x-0 bottom-0" />}
        </div>
        <div className="min-w-0 py-0.5">
          <div className="flex items-center gap-1.5 font-semibold">
            <span className="truncate">
              {e.episode}. {e.title}
            </span>
            {e.watched && <CheckCircle2 className="h-4 w-4 shrink-0 text-white/50" aria-label="Watched" />}
          </div>
          <div className="text-xs text-nf-muted">{e.runtime ? `${e.runtime}m` : ''}</div>
          {e.overview && <p className="mt-1 line-clamp-2 text-sm text-nf-secondary">{e.overview}</p>}
        </div>
      </button>
      <DownloadButton compact who={who} target={{ type: 'episode', id: e.id, title: itemTitle, subtitle: target.label, itemKey }} onOpenDownloads={openDownloads} />
      <button
        onClick={() => void playOnPc(target)}
        disabled={busy}
        aria-label={`Play episode ${e.episode} on ${pc}`}
        title={`Play on ${pc}`}
        className="nf-press ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-nf-secondary active:bg-white/10 disabled:opacity-40"
      >
        <Monitor className="h-5 w-5" />
      </button>
    </div>
  );
}
