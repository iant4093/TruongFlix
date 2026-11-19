import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Users } from 'lucide-react';
import { api } from './api';
import { errorMessage } from '../lib/errors';
import type { RemotePlayable, RemoteProfile } from './types';
import type { TogetherRoomSummary, TogetherState, TogetherTitle } from './together';
import { TogetherClient, type TogetherTransport } from './togetherClient';
import { TogetherPanel, TogetherToasts } from './TogetherPanel';

type Who = { id: number; key?: string; profile: RemoteProfile };

/** Event toasts that fade after a few seconds. */
export function useTogetherToasts() {
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const next = useRef(0);
  const push = useCallback((text: string) => {
    const id = ++next.current;
    setToasts((t) => [...t.slice(-2), { id, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return { toasts, push };
}

/**
 * "Watch together" for the browser player: a top-bar button with the party popover, a
 * participants chip, and the sync loop that makes this `<video>` follow the party.
 */
export default function WatchTogether({
  who,
  target,
  video,
  offset,
  seek,
  onSwitch,
}: {
  who: Who;
  target: RemotePlayable;
  video: RefObject<HTMLVideoElement>;
  /** Stream offset: absolute position = offset + video.currentTime. */
  offset: number;
  seek: (absolute: number) => void;
  onSwitch: (t: RemotePlayable) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TogetherState | null>(null);
  const [rooms, setRooms] = useState<TogetherRoomSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { toasts, push } = useTogetherToasts();

  const live = useRef({ target, offset, seek, onSwitch, who });
  live.current = { target, offset, seek, onSwitch, who };
  const base = () => ({ profile: live.current.who.id, key: live.current.who.key });

  const client = useRef<TogetherClient | null>(null);
  if (!client.current) {
    const transport: TogetherTransport = {
      poll: (code, r) => api<TogetherState>('/together/poll', { body: { code, ...r } }),
      act: (code, action, value, since) =>
        api<TogetherState>('/together/report', {
          body: { ...base(), code, action, since, position: value.position, rate: value.rate, on: value.on, type: value.title?.type, id: value.title?.id },
        }),
      leave: (code) => api('/together/leave', { body: { code } }),
    };
    client.current = new TogetherClient(
      transport,
      {
        title: () => ({ type: live.current.target.type, id: live.current.target.id }),
        position: () => live.current.offset + (video.current?.currentTime ?? 0),
        playing: () => !!video.current && !video.current.paused && !video.current.ended,
        buffering: () => !video.current || video.current.seeking || video.current.readyState < 3,
        rate: () => video.current?.playbackRate ?? 1,
        play: () => {
          const el = video.current;
          if (el) void Promise.resolve(el.play()).catch(() => {});
        },
        pause: () => video.current?.pause(),
        seek: (t) => live.current.seek(t),
        setRate: (r) => {
          if (video.current) video.current.playbackRate = r;
        },
        switchTitle: (t: TogetherTitle, position, label) => live.current.onSwitch({ type: t.type, id: t.id, label, resume: position }),
      },
      {
        onState: setState,
        onEvent: (e) => push(e.text),
        onEnded: (reason) => {
          if (reason) push(reason);
        },
      },
    );
  }

  // The player's root element, for the popover and toasts.
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(video.current?.parentElement ?? document.body), [video]);

  // Report this player's own play / pause / seek / speed changes.
  useEffect(() => {
    const el = video.current;
    const c = client.current!;
    if (!el) return;
    const onPlay = () => c.localPlaying(true);
    // A phone pauses its video when it locks or the page goes to the background: that isn't this
    // viewer pausing the party for everyone.
    const onPause = () => !document.hidden && c.localPlaying(false);
    const onSeeked = () => c.localSeek();
    const onRate = () => c.localRate(el.playbackRate);
    const onLoad = () => c.settle();
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('ratechange', onRate);
    el.addEventListener('loadstart', onLoad);
    el.addEventListener('emptied', onLoad);
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('ratechange', onRate);
      el.removeEventListener('loadstart', onLoad);
      el.removeEventListener('emptied', onLoad);
    };
  }, [video]);

  // Next episode (or another title) picked here: the party follows.
  useEffect(() => {
    client.current?.localTitle({ type: target.type, id: target.id });
  }, [target.type, target.id]);

  // Leaving the player leaves the party.
  useEffect(() => () => void client.current?.leave(), []);

  // Back from the background: catch up with the room, or join it again if this phone was dropped
  // while it was away.
  const lastCode = useRef<string | null>(null);
  if (state?.code) lastCode.current = state.code;
  const rejoinable = useRef(false);
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) {
        rejoinable.current = !!client.current?.code;
        return;
      }
      const c = client.current!;
      if (c.code) {
        c.settle();
        void c.tick();
      } else if (rejoinable.current && lastCode.current) {
        rejoinable.current = false;
        void api<TogetherState>('/together/join', { body: { ...base(), code: lastCode.current } })
          .then((s) => c.start(s))
          .catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(() => {
    setRooms(null);
    api<TogetherRoomSummary[]>(`/together/rooms?profile=${who.id}${who.key ? `&key=${encodeURIComponent(who.key)}` : ''}`)
      .then(setRooms)
      .catch((e) => {
        setRooms([]);
        setError(errorMessage(e));
      });
  }, [who.id, who.key]);

  const run = async (fn: () => Promise<TogetherState>) => {
    setBusy(true);
    setError('');
    try {
      const s = await fn();
      client.current!.start(s);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(() => {
      const el = video.current;
      return api<TogetherState>('/together/create', {
        body: {
          ...base(),
          type: target.type,
          id: target.id,
          position: offset + (el?.currentTime ?? 0),
          playing: !!el && !el.paused,
          rate: el?.playbackRate ?? 1,
        },
      });
    });
  const join = (code: string) => run(() => api<TogetherState>('/together/join', { body: { ...base(), code } }));

  const count = state?.members.length ?? 0;

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={state ? `Watch together: ${count} watching` : 'Watch together'}
        title="Watch together"
        className={`flex items-center gap-1.5 rounded-full p-1.5 hover:bg-white/10 ${state ? 'bg-white/15 px-3' : ''}`}
      >
        <Users className="h-6 w-6" />
        {state && <span className="text-sm font-semibold tabular-nums">{count}</span>}
      </button>
      {open && host && createPortal(
        // In the player root (not the auto-hiding chrome) so it stays put while typing, and in full screen.
        <div className="absolute right-3 top-[calc(max(1rem,env(safe-area-inset-top))+3.5rem)] z-40" onClick={(e) => e.stopPropagation()}>
          <TogetherPanel
            state={state}
            rooms={rooms}
            busy={busy}
            error={error}
            onCreate={() => void create()}
            onJoin={(code) => void join(code)}
            onLeave={() => {
              lastCode.current = null;
              void client.current!.leave();
            }}
            onWait={(on) => client.current!.setWaitForAll(on)}
            onRefresh={refresh}
            onClose={() => setOpen(false)}
          />
        </div>,
        host,
      )}
      {host && createPortal(<TogetherToasts toasts={toasts} />, host)}
    </div>
  );
}
