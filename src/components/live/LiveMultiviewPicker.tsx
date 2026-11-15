import { useMemo, useState } from 'react';
import { Globe, Plus, Star, X } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { channelKey, findLiveChannel, useLiveStore, type LiveFeed } from '../../services/live';
import { playLiveMultiview } from '../../services/player';
import type { LivePlayerSession } from '../../types/live';
import { LiveArtwork } from './LiveArtwork';
import SearchField from '../common/SearchField';
import MultiviewTray, { multiviewBlock } from './LiveMultiviewTray';

/**
 * Opened from the player: keeps the channel that is playing in slot 1 and adds up to three more,
 * then switches straight into multiview.
 */
export default function MultiviewPicker({ session, onClose }: { session: LivePlayerSession; onClose: () => void }) {
  const playlists = useLiveStore((s) => s.playlists);
  const favourites = useLiveStore((s) => s.preferences.favourites);
  const toast = useLibraryStore((s) => s.toast);
  const current = useMemo<LiveFeed | null>(() => {
    const match = findLiveChannel(session.target.playlistId, session.target.id);
    return match ? { match, event: session.event } : null;
  }, [session.loadId]);
  const [feeds, setFeeds] = useState<LiveFeed[]>(current ? [current] : []);
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState(false);
  const channels = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return playlists
      .flatMap((playlist) => playlist.channels.map((channel) => ({ playlist, channel, key: channelKey(playlist.id, channel.id) })))
      .filter((m) => m.playlist.health[m.channel.id]?.state !== 'unavailable')
      .filter((m) => !needle || `${m.channel.name} ${m.channel.group} ${m.playlist.name}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => Number(favourites.includes(b.key)) - Number(favourites.includes(a.key)))
      .slice(0, 120);
  }, [playlists, query, favourites]);
  const add = (feed: LiveFeed) => {
    const blocked = multiviewBlock(feeds, feed);
    if (blocked) return toast(blocked, 'info');
    setFeeds((list) => [...list, feed]);
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Start multiview"
      className="absolute inset-0 z-30 flex flex-col bg-nf-bg/[0.98] px-[4%] pb-6 pt-6 text-white"
      onClick={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
    >
      <div className="mb-4 flex items-center gap-3">
        <h2 className="flex-1 text-2xl font-bold">Start multiview</h2>
        <button className="rounded-full p-2 hover:bg-white/10" aria-label="Close multiview picker" onClick={onClose}>
          <X className="h-5 w-5" />
        </button>
      </div>
      <MultiviewTray
        feeds={feeds}
        fixed={current ? 1 : 0}
        opening={opening}
        hint="The channel you’re watching stays in slot 1. Add up to three more."
        onRemove={(key) => setFeeds((list) => list.filter((f) => f.match.key !== key))}
        onWatch={async () => {
          if (feeds.length < 2 || opening) return;
          setOpening(true);
          try {
            await playLiveMultiview(feeds);
          } finally {
            setOpening(false);
          }
        }}
      />
      <SearchField
        className="mt-5"
        inputClassName="w-full"
        ariaLabel="Search channels for multiview"
        placeholder="Search channels…"
        value={query}
        onChange={setQuery}
      />
      <div className="mt-4 grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto pr-1 lg:grid-cols-3 2xl:grid-cols-4">
        {channels.map((match) => {
          const chosen = feeds.some((f) => f.match.key === match.key);
          return (
            <button
              key={match.key}
              disabled={chosen}
              aria-label={`Add ${match.channel.name} to multiview`}
              onClick={() => add({ match })}
              className="flex min-w-0 items-center gap-3 rounded-md border border-white/10 bg-nf-hover p-3 text-left transition hover:border-white/30 disabled:opacity-40"
            >
              <LiveArtwork url={match.channel.logo} className="h-10 w-14 rounded bg-black/25 p-1" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate text-sm font-bold">
                  {favourites.includes(match.key) && <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" aria-hidden />}
                  <span className="truncate">{match.channel.name}</span>
                </span>
                <span className="flex items-center gap-1 truncate text-xs text-nf-muted">
                  {match.channel.web && <Globe className="h-3 w-3 shrink-0" aria-hidden />}
                  <span className="truncate">{match.playlist.name} · {match.channel.web ? 'Web player' : 'M3U'}</span>
                </span>
              </span>
              {!chosen && <Plus className="h-4 w-4 shrink-0 text-nf-muted" aria-hidden />}
            </button>
          );
        })}
        {!channels.length && <p className="col-span-full py-10 text-center text-nf-secondary">No channels match your search.</p>}
      </div>
    </div>
  );
}
