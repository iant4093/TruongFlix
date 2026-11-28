import { describe, expect, it } from 'vitest';
import { mergeChapterSegments, sameSegments, segmentsFromChapters, withAudioIntro } from '../src/services/mediainfo';
import type { MediaInfo, Segment } from '../src/types/media';

const info = (duration: number, chapters: [string, number][]): MediaInfo => ({
  duration,
  width: 1920,
  height: 1080,
  video_codec: 'h264',
  video_profile: null,
  gamma: null,
  primaries: null,
  dv_profile: null,
  audio: [],
  subs: [],
  chapters: chapters.map(([title, time]) => ({ title, time })),
});

/** A real episode: the "Previously on…" recap and the title sequence are both named "Intro". */
const recapNamedIntro = info(3234.023, [
  ['Scene 1', 0],
  ['Intro', 10.157],
  ['Scene 2', 86.86],
  ['Intro', 93.771],
  ['Scene 3', 144.56],
  ['Credits', 3187.574],
]);

describe('markers from chapters', () => {
  it('keeps an intro at the start as it was', () => {
    expect(segmentsFromChapters(info(1800, [['Opening', 0], ['Part A', 90], ['Ending', 1700]]))).toEqual([
      { kind: 'intro', start: 0, end: 90, source: 'chapter' },
      { kind: 'credits', start: 1700, end: 1800, source: 'chapter' },
    ]);
  });

  it('reads a named recap before the intro', () => {
    expect(segmentsFromChapters(info(2600, [['Previously On', 0], ['Cold Open', 70], ['Main Title', 300], ['Act 1', 340]]))).toEqual([
      { kind: 'recap', start: 0, end: 70, source: 'chapter' },
      { kind: 'intro', start: 300, end: 340, source: 'chapter' },
    ]);
  });

  it('takes the last of two "Intro" chapters as the intro and the first as the recap', () => {
    expect(segmentsFromChapters(recapNamedIntro)).toEqual([
      { kind: 'recap', start: 10.157, end: 86.86, source: 'chapter' },
      { kind: 'intro', start: 93.771, end: 144.56, source: 'chapter' },
      { kind: 'credits', start: 3187.574, end: 3234.023, source: 'chapter' },
    ]);
  });

  it('joins back-to-back chapters of one kind', () => {
    expect(segmentsFromChapters(info(1500, [['Cold open', 0], ['Opening Part 1', 60], ['Opening Part 2', 90], ['Story', 120]]))).toEqual([
      { kind: 'intro', start: 60, end: 120, source: 'chapter' },
    ]);
  });
});

describe('audio and chapter markers together', () => {
  const chapters = segmentsFromChapters(recapNamedIntro);

  it('takes the exact edges from the audio when it finds the intro chapter', () => {
    // The title sequence runs past the chapter's end; the audio shared with other episodes shows where.
    const next = withAudioIntro(chapters, [93.8, 191.1]);
    expect(next).toContainEqual({ kind: 'intro', start: 93.8, end: 191.1, source: 'audio' });
    expect(next).toContainEqual({ kind: 'recap', start: 10.157, end: 86.86, source: 'chapter' });
    // Working the chapters out again later keeps it.
    expect(sameSegments(mergeChapterSegments(next!, chapters), next!)).toBe(true);
  });

  it('keeps the intro chapter when the audio matched something else', () => {
    expect(withAudioIntro(chapters, [20, 60])).toBeNull();
  });

  it('uses the audio intro when the file has no intro chapter', () => {
    expect(withAudioIntro([], [150, 190])).toEqual([{ kind: 'intro', start: 150, end: 190, source: 'audio' }]);
  });

  it('ends a recap where the intro starts', () => {
    const recap: Segment = { kind: 'recap', start: 0, end: 120, source: 'chapter' };
    expect(withAudioIntro([recap], [100, 150])).toEqual([
      { ...recap, end: 100 },
      { kind: 'intro', start: 100, end: 150, source: 'audio' },
    ]);
  });

  it('fixes markers stored by the old rules', () => {
    const old: Segment[] = [
      { kind: 'intro', start: 10.157, end: 86.86, source: 'chapter' },
      { kind: 'credits', start: 3187.574, end: 3234.023, source: 'chapter' },
    ];
    const next = mergeChapterSegments(old, chapters);
    expect(next.find((s) => s.kind === 'intro')).toMatchObject({ start: 93.771 });
    expect(next.find((s) => s.kind === 'recap')).toMatchObject({ start: 10.157, end: 86.86 });
  });

  it('never replaces markers set by hand', () => {
    const manual: Segment = { kind: 'intro', start: 95, end: 190, source: 'manual' };
    expect(mergeChapterSegments([manual], chapters).find((s) => s.kind === 'intro')).toEqual(manual);
  });
});
