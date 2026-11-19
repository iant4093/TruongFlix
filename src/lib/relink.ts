/**
 * Files that moved or were renamed between scans: a file that vanished and a new one with the same
 * name and the exact same size are taken to be the same file. They keep their library entry (and
 * its watch history, playlists and favourites) under the new path, instead of being deleted and
 * added again as a stranger. Only unambiguous pairs count: never two candidates for one file.
 */
export interface SizedPath {
  path: string;
  size: number;
}

const leaf = (p: string) => (p.split(/[\\/]/).pop() ?? p).toLowerCase();

export function pairMoved(vanished: SizedPath[], found: SizedPath[]): { from: string; to: string }[] {
  const key = (f: SizedPath) => `${leaf(f.path)}|${f.size}`;
  const count = (list: SizedPath[]) => {
    const m = new Map<string, SizedPath[]>();
    for (const f of list) if (f.size > 0) m.set(key(f), [...(m.get(key(f)) ?? []), f]);
    return m;
  };
  const gone = count(vanished);
  const fresh = count(found);
  const pairs: { from: string; to: string }[] = [];
  for (const [k, olds] of gone) {
    const news = fresh.get(k);
    if (olds.length === 1 && news?.length === 1) pairs.push({ from: olds[0].path, to: news[0].path });
  }
  return pairs;
}
