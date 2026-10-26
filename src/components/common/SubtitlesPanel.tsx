import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Captions, Check, Download, Ear, Loader2, Search, ShieldCheck, Trash2, Zap } from 'lucide-react';
import type { SubtitleRow } from '../../types/media';
import Dropdown from './Dropdown';
import { useLibraryStore } from '../../store/useLibraryStore';
import { listSubtitles, selectSubtitle } from '../../services/db';
import {
  SUBTITLE_LANGUAGES,
  downloadSubtitle,
  languageName,
  listLocalSubtitles,
  removeSubtitle,
  searchSubtitles,
  selectLocalSubtitle,
  subtitlesEnabled,
  type LocalSubtitle,
  type SubtitleResult,
  type SubtitleTarget,
} from '../../services/subtitles';

const LANGUAGE_OPTIONS = SUBTITLE_LANGUAGES.map((l) => ({ value: l.code, label: l.name }));

export function LanguageSelect({ value, onChange, className = '' }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <Dropdown
      value={value}
      options={LANGUAGE_OPTIONS}
      onChange={onChange}
      align="right"
      ariaLabel="Subtitle language"
      className={`min-w-[170px] ${className}`}
    />
  );
}

function OptionRow({
  selected,
  onSelect,
  title,
  detail,
  badges,
  action,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail?: string | null;
  badges?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      className={`group flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 transition-colors ${
        selected ? 'bg-white/10' : 'hover:bg-white/5'
      }`}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
          selected ? 'border-white bg-white text-black' : 'border-white/40'
        }`}
      >
        {selected && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {title}
          {badges}
        </div>
        {detail && <div className="selectable truncate font-mono text-[11px] text-nf-muted">{detail}</div>}
      </div>
      {action}
    </div>
  );
}

const Badge = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'green' | 'neutral' }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-[3px] px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide ${
      tone === 'green' ? 'bg-nf-green/15 text-nf-green' : 'border border-white/25 text-white/70'
    }`}
  >
    {children}
  </span>
);

/**
 * Subtitle picker for one movie/episode. The selected file is handed to VLC with --sub-file.
 * Renders nothing when no OpenSubtitles API key is configured (feature disabled).
 */
export default function SubtitlesPanel({ target }: { target: SubtitleTarget }) {
  const settings = useLibraryStore((s) => s.settings);
  const toast = useLibraryStore((s) => s.toast);
  const enabled = subtitlesEnabled(settings);

  const [rows, setRows] = useState<SubtitleRow[]>([]);
  const [local, setLocal] = useState<LocalSubtitle[]>([]);
  const [language, setLanguage] = useState(settings.subtitle_language);
  const [results, setResults] = useState<SubtitleResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const [r, l] = await Promise.all([
      listSubtitles(target.type, target.id),
      listLocalSubtitles(target.filePath).catch(() => [] as LocalSubtitle[]),
    ]);
    setRows(r);
    setLocal(l);
  }, [target.type, target.id, target.filePath]);

  useEffect(() => {
    if (!enabled) return;
    setResults(null);
    setError(null);
    void refresh();
  }, [enabled, refresh]);

  // Sidecar files on disk that aren't tracked yet.
  const untracked = useMemo(() => local.filter((l) => !rows.some((r) => r.file_path === l.path)), [local, rows]);
  const selected = rows.find((r) => r.selected);

  if (!enabled) return null;

  const choose = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast(String(e), 'error');
    }
  };

  const search = async () => {
    setSearching(true);
    setError(null);
    try {
      setResults(await searchSubtitles(settings, target, language));
    } catch (e) {
      setError(String(e));
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  const download = async (r: SubtitleResult) => {
    setDownloading(r.fileId);
    try {
      const res = await downloadSubtitle(settings, target, r);
      await refresh();
      toast(
        `${languageName(r.language)} subtitles downloaded${res.remaining != null ? ` · ${res.remaining} downloads left today` : ''}`,
        'success',
      );
    } catch (e) {
      toast(`Subtitle download failed: ${String(e)}`, 'error');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <section className="px-12 pb-8">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h3 className="flex items-center gap-2 text-2xl font-bold">
          <Captions className="h-6 w-6" /> Subtitles
        </h3>
        <div className="flex items-center gap-2">
          <LanguageSelect value={language} onChange={setLanguage} />
          <button onClick={search} disabled={searching} className="nf-btn-ghost h-10 py-0">
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Find Subtitles
          </button>
        </div>
      </div>

      <div className="space-y-0.5 rounded-md bg-black/20 p-1.5">
        <OptionRow selected={!selected} onSelect={() => choose(() => selectSubtitle(target.type, target.id, null))} title="Off" />
        {rows.map((r) => (
          <OptionRow
            key={r.id}
            selected={!!r.selected}
            onSelect={() => choose(() => selectSubtitle(target.type, target.id, r.id))}
            title={languageName(r.language)}
            detail={r.release_name ?? r.file_path}
            badges={
              <>
                <Badge>{r.source === 'opensubtitles' ? 'Downloaded' : 'In folder'}</Badge>
                {!!r.hash_match && (
                  <Badge tone="green">
                    <Zap className="h-2.5 w-2.5" /> Perfect sync
                  </Badge>
                )}
              </>
            }
            action={
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void choose(() => removeSubtitle(r));
                }}
                title={r.source === 'opensubtitles' ? 'Delete downloaded subtitle' : 'Remove from list (file is kept)'}
                className="text-white/30 opacity-0 transition hover:text-nf-red group-hover:opacity-100"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            }
          />
        ))}
        {untracked.map((l) => (
          <OptionRow
            key={l.path}
            selected={false}
            onSelect={() => choose(() => selectLocalSubtitle(target, l))}
            title={languageName(l.language)}
            detail={l.file_name}
            badges={<Badge>In folder</Badge>}
          />
        ))}
      </div>

      {error && <p className="mt-3 text-sm text-nf-red">{error}</p>}

      {results && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-nf-muted">
            {results.length ? `OpenSubtitles · ${languageName(language)}` : `No ${languageName(language)} subtitles found`}
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
            {results.map((r) => {
              const have = rows.some((row) => row.opensubtitles_file_id === r.fileId);
              return (
                <div key={r.fileId} className="flex items-center gap-3 rounded-md bg-[#2a2a2a] px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {r.hashMatch ? (
                        <Badge tone="green">
                          <Zap className="h-2.5 w-2.5" /> Perfect sync
                        </Badge>
                      ) : (
                        <Badge>May need adjusting</Badge>
                      )}
                      {r.trusted && (
                        <Badge>
                          <ShieldCheck className="h-2.5 w-2.5" /> Trusted
                        </Badge>
                      )}
                      {r.hearingImpaired && (
                        <Badge>
                          <Ear className="h-2.5 w-2.5" /> SDH
                        </Badge>
                      )}
                      {r.aiTranslated && <Badge>AI translated</Badge>}
                    </div>
                    <div className="mt-1 truncate text-sm" title={r.release}>
                      {r.release}
                    </div>
                    <div className="text-[11px] text-nf-muted">
                      {r.downloads.toLocaleString()} downloads{r.uploader ? ` · by ${r.uploader}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => download(r)}
                    disabled={downloading != null || have}
                    className="nf-btn-ghost shrink-0 py-1.5"
                  >
                    {downloading === r.fileId ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : have ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    {have ? 'Added' : 'Use'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
