import { describe, expect, it } from 'vitest';
import { activeIndex, lyricTimeline, parseLrc, progressOf } from '../src/music/lrc';

describe('LRC parsing', () => {
  it('reads line timestamps, metadata and sorts lines', () => {
    const l = parseLrc('\uFEFF[ar:Someone]\n[ti:Song]\n[00:12.50]Second\n[00:05.00]First\n[01:02.345]Third', 90);
    expect(l.synced).toBe(true);
    expect(l.meta).toMatchObject({ ar: 'Someone', ti: 'Song' });
    expect(l.lines.map((x) => [x.time, x.text])).toEqual([
      [5, 'First'],
      [12.5, 'Second'],
      [62.345, 'Third'],
    ]);
    expect(l.lines[0].end).toBe(12.5);
    expect(l.lines[2].end).toBe(90); // the last line lasts until the song ends
  });

  it('accepts short, colon and missing fractions', () => {
    const l = parseLrc('[1:02]A\n[00:03:50]B\n[00:04.5]C');
    expect(l.lines.map((x) => x.time)).toEqual([3.5, 4.5, 62]);
  });

  it('repeats a line for every timestamp it has', () => {
    const l = parseLrc('[00:10.00][00:40.00]Chorus\n[00:20.00]Verse');
    expect(l.lines.map((x) => [x.time, x.text])).toEqual([
      [10, 'Chorus'],
      [20, 'Verse'],
      [40, 'Chorus'],
    ]);
  });

  it('applies [offset] (positive shows lyrics sooner)', () => {
    const l = parseLrc('[offset:+500]\n[00:10.00]Hi');
    expect(l.lines[0].time).toBe(9.5);
  });

  it('parses enhanced word timing', () => {
    const l = parseLrc('[00:10.00]<00:10.00>Hello <00:10.80>bright <00:11.60>world<00:12.40>\n[00:14.00]Next');
    const [line] = l.lines;
    expect(line.text).toBe('Hello bright world');
    expect(line.words!.map((w) => [w.time, w.end, w.text])).toEqual([
      [10, 10.8, 'Hello '],
      [10.8, 11.6, 'bright '],
      [11.6, 12.4, 'world'],
    ]);
    expect(progressOf(line.words![1], 11.2)).toBeCloseTo(0.5);
    expect(progressOf(line.words![0], 9)).toBe(0);
    expect(progressOf(line.words![2], 13)).toBe(1);
  });

  it('gives the last word an end when the line has no closing stamp', () => {
    const l = parseLrc('[00:01.00]<00:01.00>One <00:02.00>two\n[00:06.00]x');
    const last = l.lines[0].words!.at(-1)!;
    expect(last.time).toBe(2);
    expect(last.end).toBeGreaterThan(2);
    expect(last.end).toBeLessThanOrEqual(6);
  });

  it('keeps text before the first word stamp', () => {
    const l = parseLrc('[00:05.00]Oh <00:06.00>yes<00:07.00>');
    expect(l.lines[0].words!.map((w) => [w.time, w.text])).toEqual([
      [5, 'Oh'],
      [6, 'yes'],
    ]);
  });

  it('treats text without timestamps as plain lyrics', () => {
    const l = parseLrc('\n\nVerse one\nline two\n\nChorus\n\n');
    expect(l.synced).toBe(false);
    expect(l.lines.map((x) => x.text)).toEqual(['Verse one', 'line two', '', 'Chorus']);
  });
});

describe('lyrics timeline', () => {
  it('adds instrumental breaks for the intro, blank lines and long pauses', () => {
    const l = parseLrc(
      [
        '[00:10.00]<00:10.00>Start <00:11.00>here<00:12.00>', // intro of 10 s before it
        '[00:13.00]Second line',
        '[00:16.00]', // blank: break until 00:30
        '[00:30.00]<00:30.00>Back<00:31.00>',
        '[00:45.00]After a long pause', // 14 s after the last word ends
      ].join('\n'),
      60,
    );
    const t = lyricTimeline(l);
    expect(t.map((e) => [e.kind, e.time, e.end])).toEqual([
      ['gap', 0, 10],
      ['line', 10, 13],
      ['line', 13, 16],
      ['gap', 16, 30],
      ['line', 30, 31],
      ['gap', 31, 45],
      ['line', 45, 60],
    ]);
  });

  it('skips short breaks', () => {
    const l = parseLrc('[00:02.00]A\n[00:05.00]\n[00:07.00]B');
    expect(lyricTimeline(l).map((e) => e.kind)).toEqual(['line', 'line']);
  });

  it('finds the current entry', () => {
    const entries = [{ time: 0 }, { time: 10 }, { time: 20 }];
    expect(activeIndex(entries, -1)).toBe(-1);
    expect(activeIndex(entries, 0)).toBe(0);
    expect(activeIndex(entries, 9.99)).toBe(0);
    expect(activeIndex(entries, 10)).toBe(1);
    expect(activeIndex(entries, 500)).toBe(2);
    expect(activeIndex([{ time: 5 }], 1)).toBe(-1);
  });
});
