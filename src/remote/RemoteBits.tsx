import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronRight, Info, Play, Plus } from 'lucide-react';
import CriticScores from '../components/common/CriticScores';
import ProgressBar from '../components/common/ProgressBar';
import { backdropSrcSet } from '../lib/images';
import { useRowScroll } from './scrollMemory';
import { api } from './api';
import type { RemoteItem, RemoteRow } from './types';

/** The pieces the browser app's screens are built from: images, cards, rows, the billboard. */

export type RemoteWho = { id: number; key?: string };

/** An image that fades in once it has loaded (instead of drawing in line by line). */
export function Img({ src, srcSet, sizes, alt = '', className = '', eager = false, style }: { src: string; srcSet?: string; sizes?: string; alt?: string; className?: string; eager?: boolean; style?: CSSProperties }) {
  const ref = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(!!ref.current?.complete && ref.current.naturalWidth > 0);
  }, [src]);
  return (
    <img
      ref={ref}
      src={src}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      onLoad={() => setLoaded(true)}
      style={style}
      className={`nf-img ${loaded ? 'nf-loaded' : ''} ${className}`}
    />
  );
}

const stinger = (s: RemoteItem['stinger']) => (s === 'during' ? 'Scene during the credits' : s === 'after' ? 'Scene after the credits' : s === 'both' ? 'Scenes during & after the credits' : null);

export function runtimeLabel(item: RemoteItem): string | null {
  if (item.kind === 'tv') return item.seasonCount ? `${item.seasonCount} Season${item.seasonCount === 1 ? '' : 's'}` : null;
  if (!item.runtime) return null;
  const h = Math.floor(item.runtime / 60);
  return h ? `${h}h ${item.runtime % 60}m` : `${item.runtime}m`;
}

/** Year · rating · length · scores · picture and sound badges, like the desktop's detail line. */
export function MetaLine({ item, className = '', badges = true }: { item: RemoteItem; className?: string; badges?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm text-white/75 ${className}`}>
      {item.imdbRating != null && (
        <span className="flex items-center gap-1">
          <span className="rounded-[3px] bg-[#f5c518] px-1 text-[10px] font-black leading-[15px] text-black">IMDb</span>
          <span className="font-semibold text-white">{item.imdbRating.toFixed(1)}</span>
        </span>
      )}
      <CriticScores rt={item.rtScore ?? null} metacritic={item.metacritic ?? null} />
      {item.year && <span>{item.year}</span>}
      {item.certification && <span className="rounded-[3px] border border-white/40 px-1 text-xs leading-4">{item.certification}</span>}
      {runtimeLabel(item) && <span>{runtimeLabel(item)}</span>}
      {badges &&
        item.badges?.slice(0, 4).map((b) => (
          <span key={b} className="whitespace-nowrap rounded-[3px] border border-white/40 px-[5px] text-[10px] font-medium uppercase leading-4 tracking-wide text-white/85">
            {b}
          </span>
        ))}
    </div>
  );
}

export function StingerNote({ item }: { item: RemoteItem }) {
  const text = stinger(item.stinger ?? null);
  return text ? <span className="text-xs text-[#ffd76a]">✦ {text}</span> : null;
}

/** Adds or removes a title from My List on the PC; the icon morphs between + and ✓. */
export function MyListButton({ who, item, round = false, onChange }: { who: RemoteWho; item: RemoteItem; round?: boolean; onChange?: (on: boolean) => void }) {
  const [on, setOn] = useState(!!item.myList);
  useEffect(() => setOn(!!item.myList), [item.myList, item.key]);
  const toggle = async () => {
    const next = !on;
    setOn(next);
    try {
      await api('/mylist', { body: { profile: who.id, key: who.key, kind: item.kind, id: Number(item.key.split('-')[1]), value: next } });
      item.myList = next;
      onChange?.(next);
    } catch {
      setOn(!next);
    }
  };
  const icon = (
    <span className="relative inline-block h-6 w-6">
      <Plus className={`absolute inset-0 h-6 w-6 transition-[opacity,transform] duration-200 ${on ? 'rotate-90 scale-50 opacity-0' : 'opacity-100'}`} />
      <Check className={`absolute inset-0 h-6 w-6 transition-[opacity,transform] duration-200 ${on ? 'opacity-100' : '-rotate-90 scale-50 opacity-0'}`} />
    </span>
  );
  if (round)
    return (
      <button type="button" onClick={() => void toggle()} aria-pressed={on} className="nf-press flex flex-col items-center gap-1 text-xs text-white/85">
        {icon}
        My List
      </button>
    );
  return (
    <button type="button" onClick={() => void toggle()} aria-pressed={on} aria-label={on ? 'Remove from My List' : 'Add to My List'} title={on ? 'Remove from My List' : 'Add to My List'} className="nf-press nf-circle-btn h-12 w-12 shrink-0">
      {icon}
    </button>
  );
}

/** A poster card: fades in, dips when pressed, shows how far through you are. */
export function Poster({ item, onClick, className = 'w-28 sm:w-36' }: { item: RemoteItem; onClick: () => void; className?: string }) {
  const art = item.poster ?? item.backdrop;
  return (
    <button onClick={onClick} className={`nf-press shrink-0 text-left ${className}`} aria-label={item.title}>
      <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-white/[0.07] shadow-lg">
        {art ? <Img src={art} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-end p-2 text-sm font-bold">{item.title}</div>}
        {item.progress != null && <ProgressBar value={item.progress} height={3} className="absolute inset-x-0 bottom-0" />}
      </div>
      {item.hint && <div className="mt-1 truncate text-xs text-nf-secondary">{item.hint}</div>}
    </button>
  );
}

/** A wide card (Continue Watching): the backdrop, the title's logo, progress and what's next. */
export function WideCard({ item, onClick }: { item: RemoteItem; onClick: () => void }) {
  const art = item.backdrop ?? item.poster;
  return (
    <button onClick={onClick} className="nf-press w-64 shrink-0 text-left sm:w-72" aria-label={`${item.title}${item.hint ? `, ${item.hint}` : ''}`}>
      <div className="relative aspect-video overflow-hidden rounded-md bg-white/[0.07] shadow-lg">
        {art && <Img src={art} srcSet={backdropSrcSet(item.backdrop)} sizes="(max-width: 640px) 70vw, 300px" alt="" className="h-full w-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent" />
        {item.logo ? (
          <Img src={item.logo} alt="" className="absolute bottom-3 left-3 max-h-9 max-w-[55%] object-contain object-left drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]" />
        ) : (
          <span className="absolute bottom-3 left-3 max-w-[70%] truncate text-sm font-bold">{item.title}</span>
        )}
        <span className="absolute bottom-2.5 right-2.5 flex h-8 w-8 items-center justify-center rounded-full border border-white/70 bg-black/40">
          <Play className="ml-0.5 h-4 w-4 fill-white" strokeWidth={0} />
        </span>
        {item.progress != null && <ProgressBar value={item.progress} height={3} className="absolute inset-x-0 bottom-0" />}
      </div>
      {item.hint && <div className="mt-1.5 truncate text-xs text-nf-secondary">{item.hint}</div>}
    </button>
  );
}

/** A titled, sideways-scrolling row that rises in; Continue Watching uses wide cards. */
export function Row({ row, open, scope, index = 0 }: { row: RemoteRow; open: (key: string) => void; scope: string; index?: number }) {
  const memory = useRowScroll(`${scope}:${row.title}`);
  const wide = row.title === 'Continue Watching';
  return (
    <section className="nf-rise mb-7" style={{ animationDelay: `${Math.min(index, 6) * 60}ms` }}>
      <h2 className="mb-2 flex items-center gap-1 px-4 text-lg font-bold">
        {row.title}
        <ChevronRight className="h-5 w-5 text-white/40" />
      </h2>
      <div ref={memory.ref} onScroll={memory.onScroll} className="flex snap-x gap-2.5 overflow-x-auto scroll-px-4 px-4 pb-1 [scrollbar-width:none] [&>*]:snap-start">
        {row.items.map((i) => (wide ? <WideCard key={`${row.title}-${i.key}`} item={i} onClick={() => open(i.key)} /> : <Poster key={`${row.title}-${i.key}`} item={i} onClick={() => open(i.key)} />))}
      </div>
    </section>
  );
}

/**
 * The billboard: the artwork drifts in, then the logo, details and buttons rise in. Portrait phones
 * get the poster (a widescreen still cropped to a phone looks odd); wider screens the backdrop.
 */
export function Featured({ who, item, open, play }: { who: RemoteWho; item: RemoteItem; open: (key: string) => void; play: (key: string) => void }) {
  const wide = item.backdrop ?? item.poster ?? '';
  return (
    <section className="relative -mt-36 mb-6 aspect-[2/3] max-h-[82vh] min-h-[28rem] w-full overflow-hidden sm:aspect-video md:-mt-[5.5rem] md:max-h-[85vh] md:min-h-[30rem]">
      <picture>
        {item.poster && <source media="(max-aspect-ratio: 4/5)" srcSet={item.poster} />}
        <img src={wide} srcSet={backdropSrcSet(item.backdrop)} sizes="100vw" alt="" className="nf-zoom-in absolute inset-0 h-full w-full object-cover object-top" />
      </picture>
      <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/70 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-nf-bg via-nf-bg/20 to-transparent" />
      <div className="absolute inset-0 hidden bg-gradient-to-r from-black/60 via-transparent to-transparent md:block" />
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-6 pb-6 text-center md:items-start md:px-[4%] md:pb-[8%] md:text-left">
        <div className="nf-rise" style={{ animationDelay: '150ms' }}>
          {item.logo ? <img src={item.logo} alt={item.title} className="max-h-[min(7rem,16vh)] max-w-[75vw] object-contain drop-shadow-[0_2px_10px_rgba(0,0,0,0.7)] md:max-w-[38vw]" /> : <h1 className="text-4xl font-black md:text-6xl">{item.title}</h1>}
        </div>
        <div className="nf-rise flex flex-col items-center gap-2 md:items-start" style={{ animationDelay: '260ms' }}>
          <MetaLine item={item} className="justify-center md:justify-start" />
          {item.genres.length > 0 && <p className="text-sm text-white/80">{item.genres.slice(0, 3).join(' • ')}</p>}
          {item.overview && <p className="hidden max-w-xl text-base leading-snug text-white/90 [text-shadow:0_1px_6px_rgba(0,0,0,0.6)] md:line-clamp-3">{item.overview}</p>}
        </div>
        {/* Phones: My List · Play · Info, like the Netflix app. Wider screens: Play and More Info. */}
        <div className="nf-rise flex w-full max-w-sm items-center justify-between md:hidden" style={{ animationDelay: '360ms' }}>
          <MyListButton who={who} item={item} round />
          <button onClick={() => play(item.key)} className="nf-press nf-btn-play px-8 py-2.5">
            <Play className="h-5 w-5 fill-black" strokeWidth={0} /> Play
          </button>
          <button onClick={() => open(item.key)} className="nf-press flex flex-col items-center gap-1 text-xs text-white/85">
            <Info className="h-6 w-6" />
            Info
          </button>
        </div>
        <div className="nf-rise hidden items-center gap-3 md:flex" style={{ animationDelay: '360ms' }}>
          <button onClick={() => play(item.key)} className="nf-press nf-btn-play px-8 py-2.5 text-lg">
            <Play className="h-6 w-6 fill-black" strokeWidth={0} /> Play
          </button>
          <button onClick={() => open(item.key)} className="nf-press nf-btn-info px-6 py-2.5 text-lg">
            <Info className="h-6 w-6" /> More Info
          </button>
          <MyListButton who={who} item={item} />
        </div>
      </div>
    </section>
  );
}
