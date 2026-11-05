import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useBannerTrailer } from '../src/components/home/useBannerTrailer';
import HeroBillboard from '../src/components/home/HeroBillboard';
import DiscoverHero from '../src/components/browse/DiscoverHero';
import { resolveTrailer, type TrailerSource } from '../src/services/trailers';
import { getCatalogDetail } from '../src/services/tmdb';
import { cachedTitleRating } from '../src/services/imdb';
import { cachedCriticScores } from '../src/services/omdb';
import { playItem } from '../src/services/player';
import { useLibraryStore } from '../src/store/useLibraryStore';
import { buildItems } from '../src/store/selectors';
import type { MediaItem } from '../src/types/media';
import { movie } from './fixtures';

vi.mock('../src/services/trailers', () => ({ resolveTrailer: vi.fn() }));
vi.mock('../src/services/player', () => ({ playItem: vi.fn() }));
vi.mock('../src/services/tmdb', async (original) => ({ ...await original<typeof import('../src/services/tmdb')>(), getCatalogDetail: vi.fn() }));
vi.mock('../src/services/imdb', async (original) => ({ ...await original<typeof import('../src/services/imdb')>(), cachedTitleRating: vi.fn() }));
vi.mock('../src/services/omdb', async (original) => ({ ...await original<typeof import('../src/services/omdb')>(), cachedCriticScores: vi.fn() }));
const item = { ...buildItems([movie], [], new Map())[0], tmdbId: 603, trailerKey: 'abcdefghijk' };
const source: TrailerSource = { videoUrl: 'http://127.0.0.1:1234/video', audioUrl: 'http://127.0.0.1:1234/audio', width: 1920, height: 1080 };
let paused: WeakMap<HTMLMediaElement, boolean>;
function Harness({ playing = true, enabled = true, title = item }: { playing?: boolean; enabled?: boolean; title?: MediaItem }) {
  const t = useBannerTrailer(title, enabled, playing);
  return <>
    {t.source && <><video data-testid="video" ref={t.videoRef} src={t.source.videoUrl} /><audio data-testid="audio" ref={t.audioRef} src={t.source.audioUrl ?? ''} /></>}
    <output data-testid="active">{String(t.active)}</output><output data-testid="phase">{t.phase}</output>
    <button onClick={t.toggleMute}>{t.phase === 'failed' ? 'Retry' : t.phase === 'ended' ? 'Replay' : t.muted ? 'Unmute' : 'Mute'}</button>
  </>;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  paused = new WeakMap();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) { paused.set(this, false); return Promise.resolve(); });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) { paused.set(this, true); });
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) { return paused.get(this) ?? true; });
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.mocked(resolveTrailer).mockResolvedValue(source);
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function start() {
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  const video = screen.getByTestId('video') as HTMLVideoElement;
  fireEvent.playing(video);
  return video;
}
it('prefetches HD media but waits for both the banner delay and a decoded frame before revealing', async () => {
  render(<Harness />);
  await act(async () => { await Promise.resolve(); });
  const video = screen.getByTestId('video') as HTMLVideoElement;
  let reveal!: VideoFrameRequestCallback;
  video.requestVideoFrameCallback = vi.fn((callback) => { reveal = callback; return 1; });
  await act(async () => { await vi.advanceTimersByTimeAsync(3999); });
  expect(video.play).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  fireEvent.playing(video);
  expect(screen.getByTestId('active').textContent).toBe('false');
  act(() => reveal(0, {} as VideoFrameCallbackMetadata));
  expect(screen.getByTestId('active').textContent).toBe('true');
  fireEvent.waiting(video);
  expect(screen.getByTestId('active').textContent).toBe('false');
});
it('pauses and covers both tracks under a modal or full player, then resumes', async () => {
  const view = render(<Harness />);
  const video = await start();
  expect(screen.getByTestId('active').textContent).toBe('true');
  view.rerender(<Harness playing={false} />);
  expect(video.paused).toBe(true);
  expect((screen.getByTestId('audio') as HTMLAudioElement).paused).toBe(true);
  expect(screen.getByTestId('active').textContent).toBe('false');
  view.rerender(<Harness />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.playing(video);
  expect(screen.getByTestId('active').textContent).toBe('true');
});
it('unmutes in the user gesture and corrects drift without seeking or restarting the sound', async () => {
  render(<Harness />);
  const video = await start();
  const audio = screen.getByTestId('audio') as HTMLAudioElement;
  video.currentTime = 12;
  fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
  expect(audio.muted).toBe(false);
  expect(audio.currentTime).toBe(12);
  expect(audio.paused).toBe(false);
  await act(async () => { await Promise.resolve(); });
  fireEvent.playing(video);
  video.currentTime = 12.5;
  await act(async () => { await vi.advanceTimersByTimeAsync(1250); });
  expect(audio.currentTime).toBe(12);
  expect(audio.paused).toBe(false);
  expect(video.playbackRate).toBeLessThan(1);
  audio.currentTime = 13.03;
  video.currentTime = 13;
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(video.playbackRate).toBe(1);
  expect(vi.mocked(audio.play).mock.contexts.filter((media) => media === audio)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
  expect(audio.muted).toBe(true);
  expect(audio.paused).toBe(true);
});

it('keeps the audio position through buffering and resumes only after video playback resumes', async () => {
  render(<Harness />);
  const video = await start();
  const audio = screen.getByTestId<HTMLAudioElement>('audio');
  video.currentTime = 3;
  fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.playing(video);
  const ready = vi.spyOn(audio, 'readyState', 'get').mockReturnValue(2);
  video.currentTime = 3.6;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(audio.currentTime).toBe(3);
  expect(video.playbackRate).toBe(1);
  ready.mockReturnValue(4);
  fireEvent.waiting(video);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(audio.paused).toBe(true);
  fireEvent.playing(video);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(audio.currentTime).toBe(3);
  expect(audio.paused).toBe(false);
});

it('holds the displayed frame at the sound cue until a delayed unmute starts playing', async () => {
  render(<Harness />);
  const video = await start();
  const audio = screen.getByTestId<HTMLAudioElement>('audio');
  let startSound!: () => void;
  vi.spyOn(audio, 'play').mockReturnValueOnce(new Promise((resolve) => { startSound = resolve; }));
  video.currentTime = 9.5;
  fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
  fireEvent.pause(video);
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  expect(video.paused).toBe(true);
  expect(screen.getByTestId('active').textContent).toBe('true');
  expect(audio.currentTime).toBe(video.currentTime);
  expect(vi.mocked(audio.play).mock.contexts.filter((media) => media === audio)).toHaveLength(1);
  await act(async () => startSound());
  expect(video.paused).toBe(false);
  expect(video.currentTime).toBe(9.5);
});

it('returns to muted playback if the sound never starts', async () => {
  render(<Harness />);
  const video = await start();
  const audio = screen.getByTestId<HTMLAudioElement>('audio');
  vi.spyOn(audio, 'play').mockReturnValueOnce(new Promise(() => {}));
  fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
  expect(video.paused).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(video.paused).toBe(false);
  expect(audio.muted).toBe(true);
  expect(screen.getByRole('button', { name: 'Unmute' })).toBeTruthy();
});
it('replays an ended trailer and retries a failed or stalled source without an iframe fallback', async () => {
  render(<Harness />);
  const video = await start();
  fireEvent.ended(video);
  expect(screen.getByTestId('phase').textContent).toBe('ended');
  fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
  expect(video.currentTime).toBe(0);
  fireEvent.error(video);
  expect(screen.getByTestId('phase').textContent).toBe('failed');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await act(async () => { await Promise.resolve(); });
  expect(resolveTrailer).toHaveBeenLastCalledWith(item, true);
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(25_001); });
  expect(screen.getByTestId('phase').textContent).toBe('failed');
  expect(document.querySelector('iframe')).toBeNull();
});
it('ignores late resolution for a previous title and honours autoplay being disabled', async () => {
  let resolveOld!: (value: TrailerSource) => void;
  vi.mocked(resolveTrailer).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
  const view = render(<Harness />);
  const next = { ...item, key: 'movie-2', trailerKey: '12345678901' };
  view.rerender(<Harness title={next} />);
  await act(async () => { await Promise.resolve(); resolveOld({ ...source, videoUrl: 'http://127.0.0.1:1234/old' }); });
  expect(screen.getByTestId('video').getAttribute('src')).toBe(source.videoUrl);
  view.rerender(<Harness title={next} enabled={false} />);
  expect(screen.queryByTestId('video')).toBeNull();
});
it('does not mark a trailer failed when covering it cancels a pending play', async () => {
  let rejectPlay!: (error: Error) => void;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise((_, reject) => { rejectPlay = reject; }));
  const view = render(<Harness />);
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  view.rerender(<Harness playing={false} />);
  await act(async () => rejectPlay(new Error('AbortError')));
  expect(screen.getByTestId('phase').textContent).not.toBe('failed');
});
it('renders a real video without third-party controls or caption tracks in the banner', async () => {
  render(<HeroBillboard item={item} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  const video = screen.getByLabelText('Sintel trailer') as HTMLVideoElement;
  expect(video.controls).toBe(false);
  expect(video.querySelector('track')).toBeNull();
  expect(document.querySelector('iframe')).toBeNull();
});

it('sets the crop before the trailer appears and keeps it as the shots change', async () => {
  const pixels = new Uint8ClampedArray(160 * 90 * 4);
  const drawImage = vi.fn();
  const getImageData = vi.fn(() => ({ data: pixels }));
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1920);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, getImageData } as unknown as CanvasRenderingContext2D);
  for (let y = 0; y < 90; y++) pixels.fill(150, (y * 160 + 20) * 4, (y * 160 + 140) * 4);
  render(<HeroBillboard item={item} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  const video = screen.getByLabelText('Sintel trailer') as HTMLVideoElement;
  fireEvent.playing(video);
  const width = video.style.width;
  expect(parseFloat(width)).toBeGreaterThan(100);
  pixels.fill(150);
  video.currentTime = 5;
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  fireEvent.waiting(video);
  fireEvent.playing(video);
  expect(video.style.width).toBe(width);
  expect(drawImage).toHaveBeenCalledOnce();
});

const featured = [
  { id: 603, kind: 'movie' as const, title: 'Featured movie', year: 2024, overview: 'A movie.', poster: null, backdrop: '/movie.jpg', voteAverage: 8 },
  { id: 17, kind: 'tv' as const, title: 'Featured show', year: 2025, overview: 'A show.', poster: null, backdrop: '/show.jpg', voteAverage: 8 },
];

it('plays Browse trailers from their catalog IDs and advances once playback finishes', async () => {
  const onSelect = vi.fn();
  const view = render(<DiscoverHero titles={featured} blocked={false} onSelect={onSelect} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(resolveTrailer).toHaveBeenCalledWith(expect.objectContaining({ kind: 'movie', tmdbId: 603, trailerKey: null }), false);
  const video = screen.getByLabelText('Featured movie trailer') as HTMLVideoElement;
  fireEvent.playing(video);
  fireEvent.click(screen.getByRole('button', { name: 'Unmute trailer' }));
  const audio = document.querySelector('audio')!;
  expect(audio.paused).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(46_000); });
  expect(screen.getByRole('heading', { name: 'Featured movie' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'More Info' }));
  expect(onSelect).toHaveBeenCalledWith(featured[0]);
  view.rerender(<DiscoverHero titles={featured} blocked onSelect={onSelect} />);
  expect(video.paused).toBe(true);
  expect(audio.paused).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(46_000); });
  expect(screen.getByRole('heading', { name: 'Featured movie' })).toBeTruthy();
  view.rerender(<DiscoverHero titles={featured} blocked={false} onSelect={onSelect} />);
  fireEvent.ended(video);
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(screen.queryByLabelText('Featured movie trailer')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Featured show' })).toBeTruthy();
  expect(resolveTrailer).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'tv', tmdbId: 17 }), false);
  expect(screen.getByLabelText<HTMLVideoElement>('Featured show trailer').muted).toBe(true);
});

it('allows manual Browse navigation and pausing rotation with trailer autoplay disabled', async () => {
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, trailers_autoplay: false } }));
  render(<DiscoverHero titles={featured} blocked={false} onSelect={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(screen.getByRole('heading', { name: 'Featured show' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Pause title rotation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next featured title' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByRole('heading', { name: 'Featured movie' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Previous featured title' }));
  expect(screen.getByRole('heading', { name: 'Featured show' })).toBeTruthy();
  expect(resolveTrailer).not.toHaveBeenCalled();
});

it('shows the catalog logo, ratings and maturity badge for the featured title and clears them when it changes', async () => {
  useLibraryStore.setState((s) => ({ settings: { ...s.settings, tmdb_api_key: 'fixture', omdb_api_key: 'fixture', trailers_autoplay: false } }));
  vi.mocked(getCatalogDetail).mockResolvedValueOnce({
    ...featured[0], logo: '/title.png', imdbId: 'tt0133093', certification: 'R',
    seasons: [], genres: [], runtime: 100, status: 'Released', nextSeason: null, lastSeason: null, lastEpisode: null,
  }).mockImplementation(() => new Promise(() => {}));
  vi.mocked(cachedTitleRating).mockResolvedValue({ rating: 8.7, votes: 200 });
  vi.mocked(cachedCriticScores).mockResolvedValue({ rt: 92, metacritic: 80 });
  render(<DiscoverHero titles={featured} blocked={false} onSelect={vi.fn()} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('img', { name: 'Featured movie' }).getAttribute('src')).toBe('/title.png');
  expect(screen.getByText('8.7')).toBeTruthy();
  expect(screen.getByText('92%')).toBeTruthy();
  expect(screen.getByText('80')).toBeTruthy();
  expect(screen.getByText('R')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Play', exact: true })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Next featured title' }));
  expect(screen.queryByText('8.7')).toBeNull();
  expect(screen.queryByRole('img', { name: 'Featured movie' })).toBeNull();
});

it('uses the Library metadata and playback action when the featured title is owned', () => {
  const owned = { ...item, logo: '/saved.png', imdbRating: 9.2 };
  useLibraryStore.setState({ items: [owned] });
  render(<DiscoverHero titles={featured} blocked={false} onSelect={vi.fn()} />);
  expect(screen.getByRole('img', { name: owned.title }).getAttribute('src')).toBe('/saved.png');
  expect(screen.getByText('9.2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  expect(playItem).toHaveBeenCalledWith(owned);
  expect(getCatalogDetail).not.toHaveBeenCalled();
});
