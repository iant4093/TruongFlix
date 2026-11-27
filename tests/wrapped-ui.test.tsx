import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Profile, WatchLogRow } from '../src/types/media';
import type { MusicPlayRow } from '../src/services/musicdb';
import type { PlaySession } from '../src/games/library';
import { listWatchLog } from '../src/services/db';
import { listMusicPlays } from '../src/services/musicdb';
import { listPlaySessions } from '../src/games/library';
import { useLibraryStore } from '../src/store/useLibraryStore';
import WrappedModal from '../src/components/modals/WrappedModal';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => { throw new Error('no backend'); }), convertFileSrc: (p: string) => p }));
vi.mock('../src/services/db');
vi.mock('../src/services/musicdb', () => ({ listMusicPlays: vi.fn() }));
vi.mock('../src/games/library', () => ({ listPlaySessions: vi.fn() }));

const Y = new Date().getFullYear();
const day = (m: number, d: number) => `${Y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const episode = (d: string, seconds = 2400): WatchLogRow => ({
  profile_id: 1, media_type: 'episode', media_id: Number(d.replace(/-/g, '')), day: d, seconds, title: 'Pilot', series_id: 7,
  series_title: 'Harbour Watch', genres: '["Drama"]', season_number: 1, episode_number: 1, poster: null,
} as WatchLogRow);

const play = (title: string, m: number, d: number, extra: Partial<MusicPlayRow> = {}): MusicPlayRow => ({
  trackId: title.charCodeAt(0), title, artist: 'Luma Vale', artistId: 1, album: 'Neon Harbour', albumId: 1, albumArtist: 'Luma Vale',
  genre: 'Synth Pop', art: null, duration: 200, playedAt: new Date(Y, m - 1, d, 21).getTime(), seconds: 200, ...extra,
});

const session = (slug: string, m: number, d: number, seconds: number, profileId: number | null = 1): PlaySession => ({
  gameId: 1, slug, title: slug.toUpperCase(), cover: null, startedAt: new Date(Y, m - 1, d, 20).toISOString(), seconds, estimated: false, profileId, genres: ['Action'],
});

function setup({ log = [], plays = [], sessions = [], maturity = 'all' }: { log?: WatchLogRow[]; plays?: MusicPlayRow[]; sessions?: PlaySession[]; maturity?: Profile['maturity'] }) {
  vi.mocked(listWatchLog).mockResolvedValue(log);
  vi.mocked(listMusicPlays).mockResolvedValue(plays);
  vi.mocked(listPlaySessions).mockResolvedValue(sessions);
  useLibraryStore.setState({ activeProfile: { id: 1, name: 'Ian', color: '#E50914', maturity } as Profile });
  render(<WrappedModal />);
}

const heading = (name: string) => screen.queryByRole('heading', { level: 2, name });

beforeEach(() => {
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
});
afterEach(cleanup);

describe('Wrapped sections', () => {
  it('shows the empty card, and no sections, with nothing watched, played or listened to', async () => {
    setup({});
    expect(await screen.findByText(`Nothing to wrap up for ${Y} yet.`)).toBeTruthy();
    expect(heading('Music')).toBeNull();
    expect(heading('Games')).toBeNull();
    expect(screen.queryByText(/minutes? of music/)).toBeNull();
  });

  it('shows Music alone for someone who only listens, without any empty stat', async () => {
    setup({ plays: [play('Glass Tides', 3, 1, { seconds: 240, genre: null })] });
    expect(await screen.findByRole('heading', { level: 2, name: 'Music' })).toBeTruthy();
    expect(screen.getByText('minutes of music')).toBeTruthy();
    expect(screen.getByText('Your artist of the year')).toBeTruthy();
    expect(screen.getByText('Your song of the year')).toBeTruthy();
    // A single play has no streak, repeat, albums list, first song, busiest day or month chart.
    for (const missing of ['Top albums', 'On repeat', 'Longest streak', `First song of ${Y}`, 'Biggest listening day', 'Month by month', 'Your time of day', 'Top genres']) {
      expect(screen.queryByText(missing)).toBeNull();
    }
    expect(screen.queryByText(new RegExp(`In ${Y} you watched`))).toBeNull();
    expect(heading('Movies & TV')).toBeNull();
    expect(heading('Games')).toBeNull();
    expect(screen.queryByText(/Nothing to wrap up/)).toBeNull();
  });

  it('fills in the richer music cards when there is enough listening', async () => {
    setup({
      plays: [
        play('Glass Tides', 3, 1), play('Glass Tides', 3, 2), play('Glass Tides', 3, 2), play('Glass Tides', 3, 2),
        play('Copper Moon', 5, 3, { artist: 'The Quiet Orbit', artistId: 2, album: 'Paper Satellites', albumId: 2, albumArtist: 'The Quiet Orbit' }),
      ],
    });
    await screen.findByRole('heading', { level: 2, name: 'Music' });
    for (const shown of ['Top artists', 'Top songs', 'Top albums', 'On repeat', 'Longest streak', `First song of ${Y}`, 'Biggest listening day', 'Month by month', 'Your time of day', 'Top genres']) {
      expect(screen.getByText(shown)).toBeTruthy();
    }
    expect(screen.getByText('3 times')).toBeTruthy();
  });

  it('shows every section with headings when there is watching, music and games', async () => {
    setup({ log: [episode(day(2, 1)), episode(day(2, 2))], plays: [play('Glass Tides', 3, 1)], sessions: [session('a', 4, 1, 3600), session('b', 4, 2, 1800)] });
    expect(await screen.findByRole('heading', { level: 2, name: 'Movies & TV' })).toBeTruthy();
    expect(heading('Music')).toBeTruthy();
    expect(heading('Games')).toBeTruthy();
    // Only episodes were watched: no "0 movies" tile and no movie list.
    expect(screen.getByText('Episodes')).toBeTruthy();
    expect(screen.queryByText('Movies')).toBeNull();
    expect(screen.queryByText('Top movies')).toBeNull();
    // Sessions all belong to this profile.
    expect(screen.queryByText('On this PC')).toBeNull();
  });

  it('hides Games for profiles that can’t play them, and for sessions another profile played', async () => {
    setup({ plays: [play('Glass Tides', 3, 1)], sessions: [session('a', 4, 1, 3600)], maturity: 'kids' });
    await screen.findByRole('heading', { level: 2, name: 'Music' });
    expect(heading('Games')).toBeNull();
    expect(listPlaySessions).not.toHaveBeenCalled();
    cleanup();

    setup({ log: [episode(day(2, 1))], sessions: [session('a', 4, 1, 3600, 2)] });
    await screen.findByText(new RegExp(`In ${Y} you watched`));
    await waitFor(() => expect(listPlaySessions).toHaveBeenCalled());
    expect(heading('Games')).toBeNull();
    expect(heading('Movies & TV')).toBeNull();
  });

  it('marks games time from before sessions noted who played', async () => {
    setup({ sessions: [session('a', 4, 1, 3600, null)] });
    expect(await screen.findByRole('heading', { level: 2, name: 'Games' })).toBeTruthy();
    expect(screen.getByText('On this PC')).toBeTruthy();
  });
});
