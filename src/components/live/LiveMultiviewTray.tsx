import { Globe, PanelsTopLeft, Plus, X } from 'lucide-react';
import type { LiveFeed } from '../../services/live';
import { MULTIVIEW_MAX, MULTIVIEW_NATIVE_MAX } from '../../types/live';
import { LiveArtwork } from './LiveArtwork';
import Spinner from '../common/Spinner';
import { button } from './ui';

/** Which feeds can still be added: four channels in all, at most two of them M3U. */
export function multiviewBlock(feeds: LiveFeed[], next: LiveFeed): string {
  if (feeds.some((f) => f.match.key === next.match.key)) return 'That channel is already selected for multiview.';
  if (feeds.length >= MULTIVIEW_MAX) return 'Remove a channel before adding another one.';
  if (!next.match.channel.web && feeds.filter((f) => !f.match.channel.web).length >= MULTIVIEW_NATIVE_MAX)
    return 'Multiview can show up to two M3U channels. Add web channels for the rest.';
  return '';
}

/** The four multiview slots, filled in the order they will appear (left to right, top to bottom). */
export default function MultiviewTray({
  feeds,
  fixed = 0,
  opening,
  hint = 'Pick channels from Sports or Channels. You choose which one to hear while watching.',
  onRemove,
  onClear,
  onWatch,
}: {
  feeds: LiveFeed[];
  /** Slots at the start that can't be removed (the channel already playing). */
  fixed?: number;
  opening: boolean;
  hint?: string;
  onRemove: (key: string) => void;
  onClear?: () => void;
  onWatch: () => void;
}) {
  const natives = feeds.filter((f) => !f.match.channel.web).length;
  return (
    <section aria-label="Multiview selection" className="rounded-lg border border-white/10 bg-nf-hover p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <PanelsTopLeft className="h-5 w-5 text-nf-red" aria-hidden />
        <div className="mr-auto min-w-0">
          <h2 className="font-semibold">Watch up to four channels</h2>
          <p className="text-sm text-nf-secondary">{hint}</p>
        </div>
        <span className="text-xs text-nf-muted">
          {feeds.length}/{MULTIVIEW_MAX} channels · {natives}/{MULTIVIEW_NATIVE_MAX} M3U
        </span>
        {onClear && feeds.length > fixed && (
          <button className={button} onClick={onClear}>
            Clear
          </button>
        )}
        <button className="nf-btn-red" disabled={feeds.length < 2 || opening} onClick={onWatch}>
          {opening ? <Spinner className="h-4 w-4" tone="inherit" /> : <PanelsTopLeft className="h-4 w-4" />} Watch multiview
        </button>
      </div>
      <ol className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: MULTIVIEW_MAX }, (_, slot) => {
          const feed = feeds[slot];
          if (!feed)
            return (
              <li key={slot} className="flex min-h-[72px] items-center gap-3 rounded-md border border-dashed border-white/15 p-3 text-sm text-nf-muted">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/5 text-xs font-bold">{slot + 1}</span>
                <Plus className="h-4 w-4 shrink-0" aria-hidden />
                <span>{slot < 2 ? 'Add a channel' : 'Optional'}</span>
              </li>
            );
          const { match, event } = feed;
          return (
            <li key={match.key} className="flex min-h-[72px] min-w-0 items-center gap-3 rounded-md border border-white/15 bg-black/30 p-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-nf-red text-xs font-bold">{slot + 1}</span>
              <LiveArtwork url={match.channel.logo} className="h-10 w-12 rounded bg-black/40 p-1" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold" title={match.channel.name}>{match.channel.name}</span>
                <span className="flex min-w-0 items-center gap-1 truncate text-xs text-nf-secondary" title={event?.name ?? match.playlist.name}>
                  {match.channel.web && <Globe className="h-3 w-3 shrink-0" aria-hidden />}
                  <span className="truncate">{event?.name ?? `${match.playlist.name} · ${match.channel.web ? 'Web player' : 'M3U'}`}</span>
                </span>
              </span>
              {slot < fixed ? (
                <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-nf-muted">Playing</span>
              ) : (
                <button
                  className="shrink-0 rounded p-1 text-nf-muted hover:bg-white/10 hover:text-white"
                  aria-label={`Remove ${match.channel.name} from multiview`}
                  onClick={() => onRemove(match.key)}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
