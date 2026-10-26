import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Search, X } from 'lucide-react';
import type { WatchLogRow } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { deleteWatchLogEntry, listWatchLog } from '../../services/db';
import { formatDuration } from '../../services/wrapped';
import ProfileAvatar from '../common/ProfileAvatar';

const PAGE = 100;

function label(r: WatchLogRow) {
  if (r.media_type === 'movie') return { title: r.title ?? 'Unknown', sub: '' };
  const code = r.season_number != null ? `Season ${r.season_number}: Episode ${r.episode_number}` : '';
  return { title: r.series_title ?? 'Unknown show', sub: [code, r.title ? `“${r.title}”` : ''].filter(Boolean).join(' ') };
}

/** Netflix's "Viewing Activity": everything this profile watched, newest first. */
export default function HistoryModal() {
  const setOverlay = useLibraryStore((s) => s.setOverlay);
  const profile = useLibraryStore((s) => s.activeProfile);
  const items = useLibraryStore((s) => s.items);
  const openDetail = useLibraryStore((s) => s.openDetail);
  const [log, setLog] = useState<WatchLogRow[]>([]);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    void listWatchLog().then(setLog);
  }, [profile?.id]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? log.filter((r) => `${r.title} ${r.series_title}`.toLowerCase().includes(q)) : log;
    return [...rows].sort((a, b) => b.day.localeCompare(a.day));
  }, [log, query]);
  const total = filtered.reduce((n, r) => n + r.seconds, 0);

  const open = (r: WatchLogRow) => {
    const key = r.media_type === 'movie' ? items.find((i) => i.kind === 'movie' && i.versions.some((v) => v.id === r.media_id))?.key : `tv-${r.series_id}`;
    if (key && items.some((i) => i.key === key)) {
      setOverlay(null);
      openDetail(key);
    }
  };

  const remove = async (r: WatchLogRow) => {
    await deleteWatchLogEntry(r.media_type, r.media_id, r.day);
    setLog((l) => l.filter((x) => !(x.media_type === r.media_type && x.media_id === r.media_id && x.day === r.day)));
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[140] overflow-y-auto bg-nf-bg"
    >
      <div className="mx-auto max-w-4xl px-8 pb-20 pt-10">
        <div className="mb-8 flex items-center gap-4">
          {profile && <ProfileAvatar color={profile.color} maturity={profile.maturity} size={44} />}
          <div className="flex-1">
            <h1 className="text-4xl font-semibold">Viewing Activity</h1>
            <p className="text-sm text-nf-secondary">
              {profile?.name} · {filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'} · {formatDuration(total)} watched
            </p>
          </div>
          <button onClick={() => setOverlay(null)} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-4 flex items-center gap-2 border border-white/20 bg-black/40 px-3 py-2">
          <Search className="h-4 w-4 text-nf-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your history"
            className="w-full bg-transparent text-sm outline-none placeholder:text-nf-muted"
          />
        </div>

        {filtered.length === 0 ? (
          <p className="py-16 text-center text-nf-secondary">{log.length ? 'No matches.' : 'Nothing here yet. Titles appear after you watch them in the built-in player or VLC.'}</p>
        ) : (
          <div className="divide-y divide-white/10 border-y border-white/10">
            {filtered.slice(0, limit).map((r) => {
              const l = label(r);
              return (
                <div key={`${r.media_type}-${r.media_id}-${r.day}`} className="group flex items-center gap-6 py-3 text-sm">
                  <span className="w-24 shrink-0 tabular-nums text-nf-secondary">
                    {new Date(`${r.day}T12:00:00`).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' })}
                  </span>
                  <button onClick={() => open(r)} className="min-w-0 flex-1 truncate text-left hover:underline">
                    <span className="font-semibold">{l.title}</span>
                    {l.sub && <span className="text-nf-secondary">: {l.sub}</span>}
                  </button>
                  <span className="w-16 shrink-0 text-right tabular-nums text-nf-muted">{formatDuration(r.seconds)}</span>
                  <button
                    onClick={() => void remove(r)}
                    title="Hide from viewing history"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-nf-muted opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {filtered.length > limit && (
          <div className="mt-6 text-center">
            <button onClick={() => setLimit(limit + PAGE)} className="border border-white/30 px-6 py-2 text-sm hover:border-white">
              Show more
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
