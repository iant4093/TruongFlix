import { describe, expect, it } from 'vitest';
import { albumFolder, guessFromPath, nameKey, primaryArtist, resolveTags, settleAlbumArtist, splitDisc, VARIOUS_ARTISTS } from '../src/music/match';
import { musicQuality } from '../src/music/library';

const tags = (file_path: string, t: Partial<Parameters<typeof resolveTags>[0]> = {}) => ({
  file_path,
  title: null,
  artist: null,
  album_artist: null,
  album: null,
  track_no: null,
  disc_no: null,
  year: null,
  ...t,
});

describe('music matching', () => {
  it('reads artist, album, year, disc and track from folders and file names', () => {
    const g = guessFromPath('D:\\Music\\Daft Punk\\Discovery (2001) [FLAC]\\CD1\\03 - Digital Love.flac', ['D:\\Music']);
    expect(g).toMatchObject({ title: 'Digital Love', album: 'Discovery', albumArtist: 'Daft Punk', trackNo: 3, discNo: 1, year: 2001 });
  });

  it('never uses the music folder itself as an artist', () => {
    const g = guessFromPath('/Volumes/Media/Music/Some Album/01 Song.mp3', ['/Volumes/Media/Music']);
    expect(g.album).toBe('Some Album');
    expect(g.albumArtist).toBeNull();
  });

  it('splits "Artist - Album" folders and "Artist - Title" files', () => {
    expect(guessFromPath('/m/Radiohead - OK Computer/02 Paranoid Android.mp3', ['/m'])).toMatchObject({ albumArtist: 'Radiohead', album: 'OK Computer', trackNo: 2, title: 'Paranoid Android' });
    expect(guessFromPath('/m/Singles/Lorde - Royals.mp3', ['/m'])).toMatchObject({ artist: 'Lorde', title: 'Royals', album: 'Singles' });
    expect(guessFromPath('/m/x/1-05 Track.flac', ['/m'])).toMatchObject({ discNo: 1, trackNo: 5, title: 'Track' });
  });

  it('does not read a year-like name as a track number', () => {
    expect(guessFromPath('/m/x/1999.mp3', ['/m']).title).toBe('1999');
  });

  it('keeps tags over guesses and fills only the gaps', () => {
    const r = resolveTags(tags('/m/Folder Artist/Folder Album/07 file name.mp3', { title: 'Real Title', artist: 'Real Artist' }), ['/m']);
    expect(r).toMatchObject({ title: 'Real Title', artist: 'Real Artist', album: 'Folder Album', trackNo: 7, albumArtistTagged: false });
  });

  it('joins per-disc album names', () => {
    expect(splitDisc('The Wall (Disc 2)')).toEqual({ album: 'The Wall', disc: 2 });
    expect(splitDisc('Mellon Collie [CD1]')).toEqual({ album: 'Mellon Collie', disc: 1 });
    expect(splitDisc('Discovery')).toEqual({ album: 'Discovery', disc: null });
    expect(resolveTags(tags('/m/a.mp3', { album: 'Greatest Hits - Disc 2' })).discNo).toBe(2);
  });

  it('ignores featured artists and keeps band names with "&"', () => {
    expect(primaryArtist('Calvin Harris feat. Rihanna')).toBe('Calvin Harris');
    expect(primaryArtist('Drake (ft. Rihanna)')).toBe('Drake');
    expect(primaryArtist('Simon & Garfunkel')).toBe('Simon & Garfunkel');
    expect(primaryArtist('Artist A; Artist B')).toBe('Artist A');
  });

  it('settles one album artist per album', () => {
    expect(settleAlbumArtist(['Calvin Harris', 'Calvin Harris feat. Rihanna', 'Calvin Harris ft. Ellie Goulding'])).toBe('Calvin Harris');
    expect(settleAlbumArtist(['A', 'B', 'C', 'D'])).toBe(VARIOUS_ARTISTS);
    expect(settleAlbumArtist(['A', 'B'], ['A', 'A'])).toBe('A');
    expect(settleAlbumArtist(['A', 'B'], [], 'B')).toBe('B');
  });

  it('matches artist names regardless of case, accents, spacing and "The"', () => {
    expect(nameKey('Beyoncé')).toBe(nameKey('beyonce '));
    expect(nameKey('The  Beatles')).toBe(nameKey('Beatles'));
    expect(nameKey('The The')).toBe('the');
  });

  it('groups disc folders under their album folder', () => {
    expect(albumFolder('C:\\Music\\Album\\CD2\\01.flac')).toBe(albumFolder('C:\\Music\\Album\\01.flac'));
  });
});

describe('music quality', () => {
  it('labels lossless and hi-res lossless like Apple Music', () => {
    expect(musicQuality({ codec: 'flac', bitDepth: 16, sampleRate: 44100 })).toMatchObject({ label: 'Lossless', detail: '16-bit/44.1 kHz FLAC', hiRes: false });
    expect(musicQuality({ codec: 'alac', bitDepth: 24, sampleRate: 96000 })).toMatchObject({ label: 'Hi-Res Lossless', detail: '24-bit/96 kHz ALAC', hiRes: true });
  });

  it('shows codec and bitrate for lossy files', () => {
    expect(musicQuality({ codec: 'aac', bitrate: 256 })).toMatchObject({ label: 'High Quality', detail: 'AAC 256 kbps', lossless: false });
    expect(musicQuality({ codec: 'mp3', bitrate: 128 })).toMatchObject({ label: '', detail: 'MP3 128 kbps' });
    expect(musicQuality({ codec: 'unknown' })).toMatchObject({ label: '', detail: '' });
  });
});
