import { describe, expect, it } from 'vitest';
import { formatBytes, formatClock, formatDuration, formatPercent, formatSpeed } from '../src/lib/format';
import { errorMessage } from '../src/lib/errors';
import { basename } from '../src/lib/path';

describe('formatBytes', () => {
  it('uses whole numbers below a gigabyte and one decimal from there up', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(700 * 1024 ** 2)).toBe('700 MB');
    expect(formatBytes(1.42 * 1024 ** 3)).toBe('1.4 GB');
    expect(formatBytes(15 * 1024 ** 3)).toBe('15.0 GB');
    expect(formatBytes(2.5 * 1024 ** 4)).toBe('2.5 TB');
  });

  it('rolls over to the next unit instead of showing 1024', () => {
    expect(formatBytes(1023.7 * 1024 ** 2)).toBe('1.0 GB');
  });

  it('treats missing, negative and non-finite sizes as zero', () => {
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('formatSpeed', () => {
  it('shows KB/s whole and MB/s with one decimal', () => {
    expect(formatSpeed(0)).toBe('0 KB/s');
    expect(formatSpeed(300)).toBe('1 KB/s');
    expect(formatSpeed(850 * 1024)).toBe('850 KB/s');
    expect(formatSpeed(4.24 * 1024 ** 2)).toBe('4.2 MB/s');
  });
});

describe('formatClock', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(3723)).toBe('1:02:03');
  });

  it('never shows 60 seconds after rounding', () => {
    expect(formatClock(119.6)).toBe('1:59');
    expect(formatClock(59.9)).toBe('0:59');
  });

  it('clamps negative and invalid times', () => {
    expect(formatClock(-4)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});

describe('formatDuration', () => {
  it('rounds to minutes', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(42 * 60 + 20)).toBe('42m');
    expect(formatDuration(102 * 60)).toBe('1h 42m');
    expect(formatDuration(3599.9)).toBe('1h 0m');
  });
});

describe('formatPercent', () => {
  it('clamps to 0–100 with optional decimals', () => {
    expect(formatPercent(42.4)).toBe('42%');
    expect(formatPercent(42.45, 1)).toBe('42.5%');
    expect(formatPercent(140)).toBe('100%');
    expect(formatPercent(-3)).toBe('0%');
  });
});

describe('helpers', () => {
  it('reads messages from anything thrown', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(404)).toBe('404');
  });

  it('takes the last path segment on any platform', () => {
    expect(basename('C:\\Media\\Movies\\')).toBe('Movies');
    expect(basename('/srv/media/film.mkv')).toBe('film.mkv');
    expect(basename('file.torrent')).toBe('file.torrent');
  });
});
