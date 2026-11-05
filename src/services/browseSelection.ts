import { parseVideoFile, toRawFile } from './parser';

import type { BrowseTarget } from '../types/browse';
export type Target = BrowseTarget;
export type Release = {
  id: string; imdbId: string; title: string; seeders: number | null;
  metadataReady: boolean; files: { index: number; path: string; video: boolean }[];
};
const norm = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
export const advertisedQuality = (s: string) => {
  const name = s.replace(/_/g, '.');
  if (/\b(?:1080i|720p|576p|480p|8k|4320p)\b/i.test(name)) return 'other';
  const uhd = /\b2160p\b/i.test(name);
  const hd = /\b1080p\b/i.test(name);
  if (uhd && hd) return 'other';
  if (uhd) return '4K';
  if (hd) return '1080p';
  if (/\b(?:4k|uhd)\b/i.test(name)) return '4K';
  return null;
};
const extra = /(?:^|[/. _-])(?:extras?|samples?|trailers?|featurettes?|interviews?|behind[ ._-]*the[ ._-]*scenes)(?:$|[/. _-])/i;

export function check(target: Target, release: Release) {
  const reject = (reason: string) => ({ ok: false, reason, indices: [] as number[] });
  if (release.imdbId !== target.imdbId) return reject('wrong-title-id');
  if (release.seeders == null || !Number.isFinite(release.seeders) || release.seeders <= 0) return reject('no-reported-seeders');
  if (!release.metadataReady) return reject('metadata-required');
  const releaseQuality = advertisedQuality(release.title);
  if (releaseQuality !== target.quality) return reject('wrong-or-unknown-quality');
  if (release.files.length > 2000 || release.files.filter((f) => f.video).length > 500) return reject('too-many-files');
  const files = release.files.filter((f) => f.video && !extra.test(f.path));
  if (!files.length) return reject('no-main-video');
  const parsed = files.map((file) => ({ file, parsed: parseVideoFile(toRawFile(`${release.title}/${file.path}`, 0)) }));
  if (parsed.some(({ file }) => advertisedQuality(file.path) != null && advertisedQuality(file.path) !== target.quality)) return reject('mixed-or-wrong-file-quality');
  if (target.kind === 'movie') {
    if (parsed.length !== 1) return reject('ambiguous-movie-files');
    const p = parsed[0].parsed;
    if (p.kind !== 'movie' || norm(p.title) !== norm(target.title) || (p.year != null && p.year !== target.year)) return reject('movie-identity-mismatch');
    return { ok: true, reason: 'movie', indices: [files[0].index] };
  }
  if (/\bComplete[ ._-]*(?:Series|Collection)\b|\bS\d{1,2}[ ._-]*-[ ._-]*S?\d{1,2}\b/i.test(release.title)) return reject('multi-season-or-series-pack');
  const episodes: number[] = [];
  for (const { parsed: p } of parsed) {
    if (p.kind !== 'tv' || norm(p.showTitle) !== norm(target.title) || (p.year != null && p.year !== target.year)) return reject('show-identity-mismatch');
    if (p.season !== target.season) return reject('wrong-season');
    if (p.episodes.length !== 1) return reject('combined-or-ambiguous-episodes');
    if (episodes.includes(p.episodes[0])) return reject('duplicate-episode-files');
    episodes.push(p.episodes[0]);
  }
  if (target.kind === 'episode') {
    const name = release.title.replace(/_/g, '.');
    const declaredPack = !/\bS\d{1,2}[ ._-]?E\d{1,3}\b/i.test(name)
      && /\bS\d{1,2}\b|\bSeason[ ._-]*\d{1,2}\b/i.test(name);
    if (declaredPack || episodes.length !== 1 || episodes[0] !== target.episode) return reject('not-exact-single-episode');
    return { ok: true, reason: 'episode', indices: [files[0].index] };
  }
  if (!target.complete || !target.expected.length) return reject('season-completeness-unknown');
  const wanted = [...new Set(target.expected)].sort((a, b) => a - b);
  const found = episodes.sort((a, b) => a - b);
  if (wanted.length !== found.length || wanted.some((ep, i) => ep !== found[i])) return reject('incomplete-or-unexpected-coverage');
  return { ok: true, reason: 'season', indices: files.map((f) => f.index) };
}
