import { describe, expect, it } from 'vitest';
import { pairMoved } from './relink';

describe('pairMoved', () => {
  it('pairs a vanished file with a new file of the same name and size', () => {
    expect(pairMoved([{ path: 'D:\\Movies\\Heat (1995).mkv', size: 100 }], [{ path: 'E:\\Films\\Heat (1995).mkv', size: 100 }])).toEqual([
      { from: 'D:\\Movies\\Heat (1995).mkv', to: 'E:\\Films\\Heat (1995).mkv' },
    ]);
  });

  it('ignores different sizes, unknown sizes and ambiguous matches', () => {
    expect(pairMoved([{ path: '/a/x.mkv', size: 100 }], [{ path: '/b/x.mkv', size: 101 }])).toEqual([]);
    expect(pairMoved([{ path: '/a/x.mkv', size: 0 }], [{ path: '/b/x.mkv', size: 0 }])).toEqual([]);
    expect(pairMoved([{ path: '/a/x.mkv', size: 5 }], [{ path: '/b/x.mkv', size: 5 }, { path: '/c/x.mkv', size: 5 }])).toEqual([]);
    expect(pairMoved([{ path: '/a/x.mkv', size: 5 }, { path: '/b/x.mkv', size: 5 }], [{ path: '/c/x.mkv', size: 5 }])).toEqual([]);
  });
});
