import { useState } from 'react';
import { Check, Play } from 'lucide-react';
import type { LivePlaylist, SportsEvent } from '../../types/live';
import { channelKey, eventMatches, eventMappingKey, setLivePreferences, useLiveStore } from '../../services/live';
import { playLive } from '../../services/player';
import Modal from './LiveDialog';
import { LiveArtwork } from './LiveArtwork';
import { button, leagueLabel } from './ui';

export default function EventFeeds({
  event,
  playlists,
  onClose,
}: {
  event: SportsEvent;
  playlists: LivePlaylist[];
  onClose: () => void;
}) {
  const preferences = useLiveStore((s) => s.preferences);
  const key = eventMappingKey(event);
  const [manual, setManual] = useState(false);
  const [filter, setFilter] = useState('');
  const automatic = eventMatches(event, playlists, preferences.showUnavailable, preferences.matches);
  const matches = manual
    ? playlists.flatMap((playlist) =>
        playlist.channels
          .filter(
            (channel) =>
              (preferences.showUnavailable || playlist.health[channel.id]?.state !== 'unavailable') &&
              channel.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
          )
          .map((channel) => ({ playlist, channel, key: channelKey(playlist.id, channel.id) })),
      )
    : automatic;
  const preferred = preferences.matches[key];
  const [choice, setChoice] = useState(
    matches.some((m) => m.key === preferred) ? preferred : matches.length === 1 ? matches[0].key : '',
  );
  const chosen = playlists
    .flatMap((playlist) =>
      playlist.channels.map((channel) => ({ playlist, channel, key: channelKey(playlist.id, channel.id) })),
    )
    .find(
      (m) =>
        m.key === choice && (preferences.showUnavailable || m.playlist.health[m.channel.id]?.state !== 'unavailable'),
    );
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={event.name} onClose={onClose}>
      <p className="mb-2 text-sm text-nf-secondary">
        {leagueLabel(event.league)} · {new Date(event.date).toLocaleString()}
      </p>
      <p className="mb-5 text-sm">Broadcast: {event.broadcasts.join(' · ') || 'Not listed by the sports provider'}</p>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button className={button} onClick={() => setManual(!manual)}>
          {manual ? 'Show suggested channels' : 'Choose any channel'}
        </button>
        {manual && (
          <input
            aria-label="Find a channel to match"
            className="nf-input min-w-48 flex-1"
            placeholder="Search all selected channels…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </div>
      {matches.length ? (
        <>
          <p className="mb-3 text-xs text-nf-muted">
            Choose the feed carrying this game in your region. Local affiliates may carry different programming.
          </p>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {matches.slice(0, 100).map((m) => (
              <button
                key={m.key}
                aria-label={`Choose ${m.channel.name} from ${m.playlist.name}`}
                onClick={() => setChoice(m.key)}
                className={`flex w-full items-center gap-3 rounded border p-3 text-left ${choice === m.key ? 'border-white bg-white/10' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
              >
                <LiveArtwork url={m.channel.logo} className="h-9 w-12" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{m.channel.name}</span>
                  <span className="block text-xs text-nf-muted">
                    {m.playlist.name} · {m.channel.tvgId || 'Custom channel'}
                    {m.playlist.health[m.channel.id]?.state === 'unavailable' ? ' · Unavailable' : ''}
                  </span>
                </span>
                {choice === m.key && <Check className="h-4 w-4" />}
              </button>
            ))}
          </div>
          <button
            className="nf-btn-primary mt-5 w-full"
            disabled={!chosen || busy}
            onClick={async () => {
              if (!chosen) return;
              setBusy(true);
              try {
                await setLivePreferences({ matches: { ...preferences.matches, [key]: chosen.key } });
                await playLive(chosen, event, matches);
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            <Play className="h-4 w-4 fill-current" /> Watch channel
            {event.status === 'upcoming' ? ' · Event starts later' : ''}
          </button>
        </>
      ) : (
        <p className="rounded bg-white/5 p-5 text-sm text-nf-secondary">
          {event.broadcasts.length
            ? 'No available channel in the selected playlist matches this broadcaster. Try another playlist, add a source, or check unavailable channels.'
            : 'You can browse Channels to choose a feed manually.'}
        </p>
      )}
    </Modal>
  );
}
