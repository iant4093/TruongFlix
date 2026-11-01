import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const page = readFileSync('src-tauri/src/trailer.html', 'utf8');
const script = page.match(/<script>([\s\S]*?)<\/script>/)![1];
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function wrapper(unloading = true) {
  let modules = ['captions'];
  const messages: { event: string; info: unknown }[] = [];
  const handlers: Record<string, (event?: unknown) => void> = {};
  let events!: { onReady: () => void; onApiChange: () => void; onStateChange: (event: { data: number }) => void };
  const player = {
    getOptions: () => modules,
    unloadModule: unloading
      ? vi.fn(() => {
          modules = [];
        })
      : undefined,
    playVideo: vi.fn(),
    pauseVideo: vi.fn(),
  };
  const win = {
    parent: { postMessage: (message: string) => messages.push(JSON.parse(message)) },
    location: { origin: 'http://127.0.0.1:1234' },
    addEventListener: (name: string, fn: (e?: unknown) => void) => {
      handlers[name] = fn;
    },
    onYouTubeIframeAPIReady: () => {},
  };
  const context = {
    window: win,
    setTimeout,
    YT: {
      Player: function (_id: string, options: { events: typeof events }) {
        events = options.events;
        return player;
      },
    },
  };
  runInNewContext(script, context);
  win.onYouTubeIframeAPIReady();
  return {
    events,
    messages,
    player,
    win,
    handlers,
    reload: () => {
      modules = ['captions'];
      events.onApiChange();
    },
  };
}

it('reveals only after captions have been unloaded and checked', () => {
  const w = wrapper();
  w.events.onReady();
  expect(w.messages).toContainEqual({ event: 'captionSafe', info: false });
  expect(w.messages).not.toContainEqual({ event: 'captionSafe', info: true });
  vi.advanceTimersByTime(150);
  expect(w.player.unloadModule).toHaveBeenCalledWith('captions');
  expect(w.messages.at(-1)).toEqual({ event: 'captionSafe', info: true });
});

it('uses artwork fallback when caption suppression is unavailable', () => {
  const w = wrapper(false);
  w.events.onReady();
  vi.advanceTimersByTime(1000);
  expect(w.messages).not.toContainEqual({ event: 'captionSafe', info: true });
});

it('covers a late caption module immediately and ignores stale safety callbacks', () => {
  const w = wrapper();
  w.events.onReady();
  vi.advanceTimersByTime(100);
  w.reload();
  expect(w.messages.at(-1)).toEqual({ event: 'captionSafe', info: false });
  vi.advanceTimersByTime(50);
  expect(w.messages.at(-1)).toEqual({ event: 'captionSafe', info: false });
  vi.advanceTimersByTime(100);
  expect(w.messages.at(-1)).toEqual({ event: 'captionSafe', info: true });
});

it('forwards paused and buffering states and accepts only parent playback commands', () => {
  const w = wrapper();
  w.events.onStateChange({ data: 2 });
  w.events.onStateChange({ data: 3 });
  expect(w.messages).toEqual([
    { event: 'onStateChange', info: 2 },
    { event: 'onStateChange', info: 3 },
  ]);
  w.handlers.message({ source: {}, data: JSON.stringify({ event: 'command', func: 'playVideo', args: [] }) });
  expect(w.player.playVideo).not.toHaveBeenCalled();
  w.handlers.message({ source: w.win.parent, data: JSON.stringify({ event: 'command', func: 'playVideo', args: [] }) });
  expect(w.player.playVideo).toHaveBeenCalledOnce();
});
