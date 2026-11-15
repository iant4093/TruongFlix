import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import WatchTogether from '../src/remote/WatchTogether';
import type { TogetherState } from '../src/remote/together';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

const room: TogetherState = {
  code: 'K7QX2M',
  title: { type: 'movie', id: 2 },
  label: 'Family film',
  playing: true,
  held: false,
  position: 0,
  rate: 1,
  serverTime: 0,
  waitForAll: true,
  members: [
    { id: 'b:a', name: 'Ian', device: 'iPhone · Safari', kind: 'browser', buffering: false, host: true, you: true },
    { id: 'desktop', name: 'Mai', device: 'PC app', kind: 'desktop', buffering: true, host: false, you: false },
  ],
  events: [],
  seq: 1,
};

function Harness() {
  const video = useRef<HTMLVideoElement>(null);
  return (
    <div>
      <video ref={video} />
      <WatchTogether
        who={{ id: 1, profile: { id: 1, name: 'Ian', color: '#E50914', maturity: 'all', locked: false } }}
        target={{ type: 'movie', id: 2, label: 'Family film', resume: 0 }}
        video={video}
        offset={0}
        seek={() => {}}
        onSwitch={() => {}}
      />
    </div>
  );
}

it('starts a party from the browser player and shows its code and who’s watching', async () => {
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^\/api/, '');
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      const data = path.startsWith('/together/rooms') ? [{ code: 'ABCDEF', label: 'Other film', title: { type: 'movie', id: 3 }, members: ['Mai · PC app'] }] : room;
      return new Response(JSON.stringify(data), { status: 200 });
    }),
  );
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Watch together' }));
  expect(await screen.findByText('Other film')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Start a watch party/ }));
  });
  await waitFor(() => expect(screen.getByText('K7QX2M')).toBeTruthy());
  expect(calls.find((c) => c.path === '/together/create')?.body).toMatchObject({ profile: 1, type: 'movie', id: 2 });
  expect(screen.getByText(/Mai · PC app/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Watch together: 2 watching' })).toBeTruthy();
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', true);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Leave party/ }));
  });
  expect(calls.some((c) => c.path === '/together/leave')).toBe(true);
  expect(screen.getByRole('button', { name: 'Watch together' })).toBeTruthy();
});
