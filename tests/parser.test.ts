import { describe, expect, it } from 'vitest';
import { parseVideoFile, toRawFile } from '../src/services/parser';

const parse = (path: string) => parseVideoFile(toRawFile(path, 0));
const ep = (path: string) => {
  const p = parse(path);
  return p.kind === 'tv' ? { show: p.showTitle, year: p.year, s: p.season, e: p.episodes } : { movie: p.title, year: p.year };
};

describe('episode names', () => {
  it.each([
    ['/TV/Severance/Season 1/Severance - S01E01.mkv', { show: 'Severance', s: 1, e: [1] }],
    ['/TV/Severance/Season 1/Severance - S01E01.avi', { show: 'Severance', s: 1, e: [1] }],
    ['/TV/Severance/Season 1/Severance - S01E01 - Good News About Hell.mkv', { show: 'Severance', s: 1, e: [1] }],
    ["/TV/Grey's Anatomy (2005)/Season 1/Grey's Anatomy (2005) - s01e01.mkv", { show: "Grey's Anatomy", year: 2005, s: 1, e: [1] }],
    ['/TV/Breaking Bad/Season 1/Breaking Bad - S01E01E02.mkv', { show: 'Breaking Bad', s: 1, e: [1, 2] }],
    ['/TV/Show/Season 2/Show - 2x05.mkv', { show: 'Show', s: 2, e: [5] }],
    ['/TV/Shogun/Shogun.2024.S01E05.1080p.WEB-DL.mkv', { show: 'Shogun', year: 2024, s: 1, e: [5] }],
    ['/TV/Sherlock/Specials/Sherlock - S00E01 - The Abominable Bride.mkv', { show: 'Sherlock', s: 0, e: [1] }],
    ['/TV/1923/Season 1/1923.S01E01.mkv', { show: '1923', s: 1, e: [1] }],
    ['/TV/24/Season 1/24 - S01E01.mkv', { show: '24', s: 1, e: [1] }],
    ['/TV/Frieren/Season 1/Frieren - 05.mkv', { show: 'Frieren', s: 1, e: [5] }],
    ['/TV/One Piece/Season 1/[SubsPlease] One Piece - 1085 (1080p) [ABCD1234].mkv', { show: 'One Piece', s: 1, e: [1085] }],
    ['/Anime/One Piece/[SubsPlease] One Piece - 1085 (1080p) [ABCD1234].mkv', { show: 'One Piece', s: 1, e: [1085] }],
    ['/TV/Show/Season 1/Show.S01E01-E03.1080p.mkv', { show: 'Show', s: 1, e: [1, 2, 3] }],
    ['/TV/The Office (US)/Season 3/The Office (US) - S03E05 - Initiation.mkv', { show: 'The Office (US)', s: 3, e: [5] }],
    ['/TV/The Office (UK)/Season 1/S01E01.mkv', { show: 'The Office (UK)', s: 1, e: [1] }],
    ['/TV/Lost/Season 2/01 - Man of Science.mkv', { show: 'Lost', s: 2, e: [1] }],
    ['/TV/Lost/Season 2/E05.mkv', { show: 'Lost', s: 2, e: [5] }],
    ['/TV/The Simpsons/Season 1/the.simpsons.105.hdtv.mkv', { show: 'The Simpsons', s: 1, e: [5] }],
    ['/TV/Chernobyl/Season 1/Chernobyl Part 2.mkv', { show: 'Chernobyl', s: 1, e: [2] }],
    ['/Anime/[Erai-raws] Frieren - S01E05 [1080p].mkv', { s: 1, e: [5] }],
    ['/TV/The Daily Show/Season 2024/The Daily Show - 2024-03-15 - Guest.mkv', { show: 'The Daily Show', s: 2024, e: [315] }],
    ['/TV/Last Week Tonight/Last.Week.Tonight.with.John.Oliver.2024.03.17.1080p.mkv', { s: 2024, e: [317] }],
  ])('%s', (path, want) => {
    expect(ep(path)).toMatchObject(want);
  });
});

describe('movie names', () => {
  it.each([
    ['/Movies/2001 A Space Odyssey (1968)/2001.A.Space.Odyssey.1968.1080p.mkv', { movie: '2001 A Space Odyssey', year: 1968 }],
    ['/Movies/Blade Runner 2049 (2017)/Blade.Runner.2049.2017.2160p.mkv', { movie: 'Blade Runner 2049', year: 2017 }],
    ['/Movies/Dune (2021)/Dune.mkv', { movie: 'Dune', year: 2021 }],
    ['/Movies/1917 (2019)/1917.2019.mkv', { movie: '1917', year: 2019 }],
    ['/Movies/Spider-Man No Way Home (2021).mkv', { movie: 'Spider-Man No Way Home', year: 2021 }],
  ])('%s', (path, want) => {
    expect(ep(path)).toMatchObject(want);
  });
});
