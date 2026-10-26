import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, ArrowUpCircle, Copy, FolderOpen, HardDrive, Loader2, MessageSquareText, Trash2, X } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { allFiles, buildHealthReport, findMissingSubtitles, type HealthFile } from '../../services/health';
import { deleteMedia, FILE_MANAGER_NAME, revealInFileManager } from '../../services/files';
import { formatSize } from '../../services/mediainfo';
import { languageName } from '../../services/subtitles';
import { resize } from '../../services/tmdb';
import Artwork from '../common/Artwork';

type Tab = 'overview' | 'duplicates' | 'problems' | 'upgrades' | 'subtitles';

/** Library maintenance: disk use, duplicate copies, broken files, upgrade candidates, missing subtitles. */
export default function HealthModal() {
  const setOverlay = useLibraryStore((s) => s.setOverlay);
  const movies = useLibraryStore((s) => s.movies);
  const series = useLibraryStore((s) => s.series);
  const episodesBySeries = useLibraryStore((s) => s.episodesBySeries);
  const items = useLibraryStore((s) => s.allItems);
  const analysis = useLibraryStore((s) => s.analysis);
  const language = useLibraryStore((s) => s.settings.subtitle_language);
  const [tab, setTab] = useState<Tab>('overview');
  const [missingSubs, setMissingSubs] = useState<HealthFile[] | null>(null);
  const [showAllUsage, setShowAllUsage] = useState(false);

  const report = useMemo(() => buildHealthReport(movies, series, episodesBySeries, items), [movies, series, episodesBySeries, items]);

  useEffect(() => {
    if (tab !== 'subtitles') return;
    let alive = true;
    setMissingSubs(null);
    const { files, infos } = allFiles(movies, series, episodesBySeries, items);
    void findMissingSubtitles(files, infos, language).then((r) => alive && setMissingSubs(r));
    return () => {
      alive = false;
    };
  }, [tab, movies, series, episodesBySeries, items, language]);

  const tabs: { id: Tab; label: string; count?: number; icon: ReactNode }[] = [
    { id: 'overview', label: 'Disk use', icon: <HardDrive className="h-4 w-4" /> },
    { id: 'problems', label: 'Problems', count: report.problems.length, icon: <AlertTriangle className="h-4 w-4" /> },
    { id: 'duplicates', label: 'Duplicates', count: report.duplicates.length, icon: <Copy className="h-4 w-4" /> },
    { id: 'upgrades', label: 'Upgrades', count: report.upgrades.length, icon: <ArrowUpCircle className="h-4 w-4" /> },
    { id: 'subtitles', label: 'Missing subtitles', count: missingSubs?.length, icon: <MessageSquareText className="h-4 w-4" /> },
  ];
  const maxUsage = report.usage[0]?.bytes || 1;
  const usage = showAllUsage ? report.usage : report.usage.slice(0, 15);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[140] overflow-y-auto bg-nf-bg"
    >
      <div className="mx-auto max-w-5xl px-8 pb-20 pt-10">
        <div className="mb-6 flex items-start gap-4">
          <div className="flex-1">
            <h1 className="text-4xl font-semibold">Library Health</h1>
            <p className="mt-1 text-sm text-nf-secondary">
              {report.fileCount} files · {formatSize(report.totalBytes) || '0 MB'}
              {report.analysed < report.fileCount && (
                <span className="text-nf-muted">
                  {' '}
                  · {report.fileCount - report.analysed} not analysed yet
                  {analysis.running ? ` (${analysis.message})` : ''}
                </span>
              )}
            </p>
          </div>
          <button onClick={() => setOverlay(null)} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-6 flex flex-wrap gap-2 border-b border-white/10 pb-3">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-sm transition-colors ${
                tab === t.id ? 'bg-white font-semibold text-black' : 'text-nf-secondary hover:bg-white/10 hover:text-white'
              }`}
            >
              {t.icon}
              {t.label}
              {t.count != null && (
                <span className={`rounded-full px-1.5 text-xs tabular-nums ${tab === t.id ? 'bg-black/15' : t.count ? 'bg-nf-red text-white' : 'bg-white/10'}`}>{t.count}</span>
              )}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <section>
            <div className="mb-6 grid grid-cols-4 gap-3">
              {[
                ['Total size', formatSize(report.totalBytes) || '—'],
                ['Files', String(report.fileCount)],
                ['Movies', String(report.usage.filter((u) => u.kind === 'movie').length)],
                ['Shows', String(report.usage.filter((u) => u.kind === 'tv').length)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-white/[0.06] px-4 py-3">
                  <div className="text-2xl font-bold tabular-nums">{value}</div>
                  <div className="text-xs text-nf-muted">{label}</div>
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              {usage.map((u) => (
                <OpenTitle key={u.itemKey} itemKey={u.itemKey} className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/5">
                  <div className="h-10 w-7 shrink-0 overflow-hidden rounded-sm bg-white/10">
                    <Artwork src={resize(u.poster, 'w92')} alt={u.title} className="h-full w-full" />
                  </div>
                  <div className="w-64 min-w-0 shrink-0">
                    <div className="truncate font-semibold">{u.title}</div>
                    <div className="text-xs text-nf-muted">
                      {u.kind === 'tv' ? `${u.files} episode${u.files === 1 ? '' : 's'}` : u.files > 1 ? `${u.files} versions` : 'Movie'}
                    </div>
                  </div>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div className={`h-full rounded-full ${u.kind === 'tv' ? 'bg-[#2E86DE]' : 'bg-nf-red'}`} style={{ width: `${Math.max(1, (u.bytes / maxUsage) * 100)}%` }} />
                  </div>
                  <span className="w-20 shrink-0 text-right tabular-nums text-nf-secondary">{formatSize(u.bytes) || '—'}</span>
                </OpenTitle>
              ))}
            </div>
            {report.usage.length > 15 && (
              <button onClick={() => setShowAllUsage(!showAllUsage)} className="mt-4 text-sm text-nf-secondary hover:text-white">
                {showAllUsage ? 'Show fewer' : `Show all ${report.usage.length}`}
              </button>
            )}
          </section>
        )}

        {tab === 'problems' && (
          <FileList
            files={report.problems}
            empty="No problems found. Every analysed file opens and plays to the end."
            hint="Files that can’t be opened, are cut off before the end, or are much shorter than the episode or movie should be."
            allowDelete
          />
        )}

        {tab === 'duplicates' && (
          <section className="space-y-4">
            <p className="text-sm text-nf-secondary">The same movie or episode stored more than once. The best copy is listed first; delete the others to free up space.</p>
            {report.duplicates.length === 0 && <Empty text="No duplicates." />}
            {report.duplicates.map((g) => (
              <div key={g.id} className="rounded-lg border border-white/10">
                <div className="border-b border-white/10 px-4 py-2.5 font-semibold">{g.title}</div>
                {g.files.map((f, i) => (
                  <FileRow key={f.path} file={f} badge={i === 0 ? 'Best copy' : undefined} allowDelete={i > 0} />
                ))}
              </div>
            ))}
          </section>
        )}

        {tab === 'upgrades' && (
          <FileList
            files={report.upgrades}
            empty="Nothing to upgrade. Everything is at least 1080p with a healthy bitrate."
            hint="SD and 720p files, and 1080p/4K files with a bitrate so low they’re likely to look soft or blocky."
            grouped
          />
        )}

        {tab === 'subtitles' &&
          (missingSubs == null ? (
            <div className="flex items-center gap-2 py-10 text-nf-secondary">
              <Loader2 className="h-5 w-5 animate-spin" /> Checking subtitle tracks and files…
            </div>
          ) : (
            <FileList
              files={missingSubs}
              empty={`Everything has ${language ? languageName(language) : ''} subtitles.`}
              hint={`No ${language ? languageName(language) + ' ' : ''}subtitles inside the file or next to it. Open a title to search OpenSubtitles.`}
              grouped
            />
          ))}
      </div>
    </motion.div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed border-white/15 px-4 py-10 text-center text-nf-secondary">{text}</p>;
}

/** Closes the health page and opens the title (and episode). */
function OpenTitle({ itemKey, episodeId, className, children }: { itemKey: string; episodeId?: number; className?: string; children: ReactNode }) {
  const open = () => {
    const s = useLibraryStore.getState();
    s.setOverlay(null);
    s.openDetail(itemKey);
    if (episodeId != null) s.openEpisode(episodeId);
  };
  return (
    <button type="button" onClick={open} className={className}>
      {children}
    </button>
  );
}

function FileList({ files, empty, hint, grouped, allowDelete }: { files: HealthFile[]; empty: string; hint: string; grouped?: boolean; allowDelete?: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!files.length) return <Empty text={empty} />;
  if (!grouped) {
    return (
      <section>
        <p className="mb-4 text-sm text-nf-secondary">{hint}</p>
        <div className="rounded-lg border border-white/10">
          {files.map((f) => (
            <FileRow key={f.path} file={f} allowDelete={allowDelete} showTitle />
          ))}
        </div>
      </section>
    );
  }
  const groups = new Map<string, HealthFile[]>();
  for (const f of files) groups.set(f.itemKey, [...(groups.get(f.itemKey) ?? []), f]);
  return (
    <section className="space-y-3">
      <p className="text-sm text-nf-secondary">{hint}</p>
      {[...groups.entries()].map(([key, list]) => {
        const expanded = open.has(key) || list.length === 1;
        const reasons = [...new Set(list.map((f) => f.reason).filter(Boolean))];
        return (
          <div key={key} className="rounded-lg border border-white/10">
            <button
              type="button"
              onClick={() => setOpen((s) => new Set(s.has(key) ? [...s].filter((k) => k !== key) : [...s, key]))}
              className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
            >
              <span className="font-semibold">{list[0].title}</span>
              <span className="text-xs text-nf-muted">
                {[list.length > 1 ? `${list.length} files` : '', reasons.length === 1 ? reasons[0] : reasons.length > 1 ? `${reasons.length} kinds of issue` : '']
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
            {expanded && list.map((f) => <FileRow key={f.path} file={f} />)}
          </div>
        );
      })}
    </section>
  );
}

/** `showTitle`: the row isn't under a heading with the title, so name the movie/show. */
function FileRow({ file, badge, allowDelete, showTitle }: { file: HealthFile; badge?: string; allowDelete?: boolean; showTitle?: boolean }) {
  const toast = useLibraryStore((s) => s.toast);
  const allItems = useLibraryStore((s) => s.allItems);
  const remove = async () => {
    const item = allItems.find((i) => i.key === file.itemKey);
    if (!item) return;
    if (file.kind === 'movie') await deleteMedia({ kind: 'movie', item, versionId: item.versions.length > 1 ? file.id : undefined });
    else if (file.episode) await deleteMedia({ kind: 'episode', episode: file.episode, series: item });
  };
  return (
    <div className="group flex items-center gap-3 border-t border-white/10 px-4 py-2.5 text-sm first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <OpenTitle itemKey={file.itemKey} episodeId={file.episode?.id} className="truncate text-left font-medium hover:underline">
            {showTitle ? (file.kind === 'movie' ? file.title : `${file.title} · ${file.detail}`) : file.kind === 'movie' ? file.detail || file.title : file.detail}
          </OpenTitle>
          {badge && <span className="shrink-0 rounded bg-nf-green/20 px-1.5 py-[1px] text-[10px] font-bold uppercase text-nf-green">{badge}</span>}
        </div>
        {showTitle && file.kind === 'movie' && file.detail && <div className="text-xs text-nf-secondary">{file.detail}</div>}
        {file.reason && <div className="text-xs text-[#e87c03]">{file.reason}</div>}
        <div className="selectable truncate font-mono text-[11px] text-nf-muted" title={file.path}>
          {file.path}
        </div>
      </div>
      <span className="w-16 shrink-0 text-right tabular-nums text-nf-secondary">{formatSize(file.size)}</span>
      <button
        onClick={() => revealInFileManager(file.path).catch((e) => toast(String(e), 'error'))}
        title={`Show in ${FILE_MANAGER_NAME}`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-white/50 hover:bg-white/10 hover:text-white"
      >
        <FolderOpen className="h-4 w-4" />
      </button>
      {allowDelete && (
        <button
          onClick={() => void remove()}
          title="Delete (moves to Recently Deleted)"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-white/50 hover:bg-nf-red/20 hover:text-nf-red"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
