import { describe, expect, it } from 'vitest';
import { classifyFiles, missingOptional, setupFileIndex, type GameFile } from '../src/games/files';

const dir = 'Some Game [Repack]/';
const files: GameFile[] = [
  'fg-01.bin',
  'fg-02.bin',
  'fg-optional-bonus-content.bin',
  'fg-selective-english.bin',
  'fg-selective-german.part1.bin',
  'fg-selective-german.part2.bin',
  'optional-japanese-voiceover-part1.bin',
  'optional-japanese-voiceover-part2.bin',
  'setup.exe',
  'MD5/QuickSFV.EXE',
  'Verify BIN files before installation.bat',
].map((p, index) => ({ index, relative_path: dir + p, size: 100 + index }));

describe('classifyFiles', () => {
  const { required, optional } = classifyFiles(files);

  it('splits required and optional files', () => {
    expect(required.map((f) => f.index)).toEqual([0, 1, 8, 9, 10]);
    expect(optional.map((g) => g.key)).toEqual([
      'fg-optional-bonus-content',
      'fg-selective-english',
      'fg-selective-german',
      'optional-japanese-voiceover',
    ]);
  });

  it('groups parts and sums sizes', () => {
    const german = optional.find((g) => g.key === 'fg-selective-german')!;
    expect(german.files.map((f) => f.index)).toEqual([4, 5]);
    expect(german.size).toBe(104 + 105);
    expect(optional.find((g) => g.key === 'optional-japanese-voiceover')!.files).toHaveLength(2);
  });

  it('labels and detects languages', () => {
    expect(optional.map((g) => [g.label, g.kind])).toEqual([
      ['Bonus Content', 'extra'],
      ['English', 'language'],
      ['German', 'language'],
      ['Japanese Voiceover', 'language'],
    ]);
  });
});

describe('setupFileIndex', () => {
  it('finds setup.exe', () => expect(setupFileIndex(files)).toBe(8));

  it('prefers a fixed setup', () => {
    const extra = [...files, { index: 50, relative_path: dir + 'setup-fixed.exe', size: 1 }];
    expect(setupFileIndex(extra)).toBe(50);
  });

  it('returns null without an installer', () => expect(setupFileIndex(files.slice(0, 3))).toBeNull());
});

describe('missingOptional', () => {
  it('lists groups not fully selected', () => {
    const { optional } = classifyFiles(files);
    expect(missingOptional(optional, [0, 1, 2, 3, 4, 6, 7])).toEqual(['fg-selective-german']);
    expect(missingOptional(optional, [])).toHaveLength(4);
  });
});
