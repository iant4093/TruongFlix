import { describe, expect, it } from 'vitest';
import { check, type Target, type Release } from '../src/services/browseSelection';

const base = { imdbId: 'tt12590266', title: 'Example Show', year: 2024, quality: '1080p' as const };
const episode: Target = { ...base, kind: 'episode', season: 1, episode: 3 };
const season: Target = { ...base, kind: 'season', season: 1, expected: [1, 2, 3], complete: true };
const movie: Target = { ...base, imdbId: 'tt1234567', title: 'Example Film', kind: 'movie' };
const release = (name: string, paths: string[], patch: Partial<Release> = {}): Release => ({
  id: name, imdbId: base.imdbId, title: name, seeders: 100, metadataReady: true,
  files: paths.map((path, index) => ({ index, path, video: /\.(mkv|mp4)$/i.test(path) })), ...patch,
});
const ep = release('Example.Show.2024.S01E03.1080p.WEB-DL', ['Example.Show.2024.S01E03.1080p.mkv']);
const pack = release('Example.Show.2024.S01.COMPLETE.1080p.WEB-DL', [1, 2, 3].map((n) => `Example.Show.2024.S01E0${n}.1080p.mkv`));

describe('explicit episode requests', () => {
  it('accepts an exact episode', () => expect(check(episode, ep).ok).toBe(true));
  it.each([
    ['wrong season', ep.title.replace('S01E03', 'S02E03'), ['Example.Show.2024.S02E03.1080p.mkv']],
    ['wrong episode', ep.title.replace('E03', 'E04'), ['Example.Show.2024.S01E04.1080p.mkv']],
    ['episode prefix collision', ep.title.replace('E03', 'E030'), ['Example.Show.2024.S01E030.1080p.mkv']],
    ['combined episode', ep.title.replace('E03', 'E03E04'), ['Example.Show.2024.S01E03E04.1080p.mkv']],
    ['wrong show', ep.title, ['Other.Show.2024.S01E03.1080p.mkv']],
    ['wrong year', ep.title, ['Example.Show.2025.S01E03.1080p.mkv']],
  ])('rejects %s', (_label, name, paths) => expect(check(episode, release(name, paths)).ok).toBe(false));
  it('does not silently choose an entire season for an episode', () => expect(check(episode, pack).ok).toBe(false));
  it('does not trust a season label containing only the requested episode', () => expect(check(episode, { ...pack, files: ep.files }).ok).toBe(false));
});
describe('season coverage', () => {
  it('accepts exact complete coverage and excludes extras', () => {
    const result = check(season, { ...pack, files: [...pack.files, { index: 3, path: 'Extras/Trailer.1080p.mkv', video: true }] });
    expect(result).toEqual({ ok: true, reason: 'season', indices: [0, 1, 2] });
  });
  it.each([
    ['missing episode', [1, 3]],
    ['duplicate episode', [1, 2, 2]],
    ['extra episode', [1, 2, 3, 4]],
  ])('rejects %s', (_label, numbers) => expect(check(season, release(pack.title, numbers.map((n) => `Example.Show.2024.S01E0${n}.1080p.mkv`))).ok).toBe(false));
  it('does not mistake one episode for a season', () => expect(check(season, ep).ok).toBe(false));
  it('requires known completed-season information', () => expect(check({ ...season, complete: false }, pack).ok).toBe(false));
  it('requires expected episodes', () => expect(check({ ...season, expected: [] }, pack).ok).toBe(false));
  it('rejects a multi-season release', () => expect(check(season, { ...pack, title: 'Example.Show.2024.S01-S02.1080p' }).ok).toBe(false));
  it('rejects another season hidden in the file list', () => expect(check(season, { ...pack, files: [...pack.files, { index: 3, path: 'Example.Show.2024.S02E01.1080p.mkv', video: true }] }).ok).toBe(false));
});
describe('known movies and quality', () => {
  const film = release('Example.Film.2024.1080p.BluRay', ['Example.Film.2024.1080p.mkv', 'Extras/Trailer.mkv', 'Extras/Featurette.mkv'], { imdbId: movie.imdbId });
  it('keeps a movie with three videos a movie and selects only the feature', () => expect(check(movie, film)).toEqual({ ok: true, reason: 'movie', indices: [0] }));
  it('requires a single unambiguous main feature', () => expect(check(movie, { ...film, files: [...film.files, { index: 3, path: 'Example.Film.2024.1080p.mp4', video: true }] }).ok).toBe(false));
  it.each(['720p', '1080i', 'unknown'])('rejects %s for an exact 1080p request', (q) => expect(check(episode, { ...ep, title: ep.title.replace('1080p', q) }).ok).toBe(false));
  it('does not downgrade a 4K request to 1080p', () => expect(check({ ...episode, quality: '4K' }, ep).ok).toBe(false));
  it('accepts an explicitly labelled 2160p release', () => expect(check({ ...episode, quality: '4K' }, { ...ep, title: ep.title.replace('1080p', '2160p'), files: ep.files.map((f) => ({ ...f, path: f.path.replace('1080p', '2160p') })) }).ok).toBe(true));
  it('rejects a 4K listing whose files are explicitly 1080p', () => expect(check({ ...episode, quality: '4K' }, { ...ep, title: ep.title.replace('1080p', '2160p') }).ok).toBe(false));
  it('rejects a mixed-quality season', () => expect(check(season, { ...pack, files: pack.files.map((f, i) => i === 1 ? { ...f, path: f.path.replace('1080p', '720p') } : f) }).ok).toBe(false));
});
describe('unavailable metadata and identity', () => {
  it.each([null, 0, -1, NaN])('does not auto-select an unseeded or unknown release: %s', (seeders) => expect(check(episode, { ...ep, seeders }).ok).toBe(false));
  it('requires resolved metadata before starting', () => expect(check(episode, { ...ep, metadataReady: false }).reason).toBe('metadata-required'));
  it('requires the requested IMDb association', () => expect(check(episode, { ...ep, imdbId: 'tt9999999' }).ok).toBe(false));

});
