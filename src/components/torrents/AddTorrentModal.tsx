import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  Check,
  Clock,
  Download,
  FileUp,
  Film,
  FolderOpen,
  HardDriveDownload,
  Magnet,
  Play,
  Search,
  Sparkles,
  Star,
  Tv,
} from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import type { InspectTorrentRes, MediaKind, TorrentMode } from '../../types/media';
import {
  fileToBase64TorrentSource,
  formatHoursLabel,
  initiateTorrent,
  inspectTorrent,
  inspectTorrentFilesLive,
  matchTorrentMetadata,
  pickDestinationFolder,
} from '../../services/torrents';
import { searchTitles, type SearchResult } from '../../services/tmdb';
import Artwork from '../common/Artwork';
import { Switch } from '../settings/ui';
import Dialog, { DialogIcon } from '../common/Dialog';
import Spinner from '../common/Spinner';
import { formatBytes } from '../../lib/format';
import { errorMessage } from '../../lib/errors';
import { basename } from '../../lib/path';

const CACHE_PRESETS: { hours: number; label: string }[] = [
  { hours: 6, label: '6 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
];

export default function AddTorrentModal() {
  const modal = useLibraryStore((s) => s.addTorrentModal);
  const close = useLibraryStore((s) => s.closeAddTorrent);
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const toast = useLibraryStore((s) => s.toast);

  const [source, setSource] = useState(modal?.initialSource ?? '');
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [mode, setMode] = useState<TorrentMode>(settings.torrent_default_mode);
  const [cacheHours, setCacheHours] = useState<number>(settings.torrent_stream_cache_hours || 72);
  const [deleteOnComplete, setDeleteOnComplete] = useState<boolean>(settings.torrent_delete_after_complete);

  const [inspecting, setInspecting] = useState(false);
  const [resolvingFiles, setResolvingFiles] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<{ revision: number; result: InspectTorrentRes } | null>(null);
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());

  // Smart metadata matching state
  const [matching, setMatching] = useState(false);
  const [match, setMatch] = useState<SearchResult | null>(null);
  const [matchOrigin, setMatchOrigin] = useState<'auto' | 'manual' | 'none'>('auto');
  const [fallbackKind, setFallbackKind] = useState<MediaKind>('movie');
  const [fallbackTitle, setFallbackTitle] = useState('');
  const [fallbackYear, setFallbackYear] = useState<number | null>(null);

  // Destination folder state
  const [destFolder, setDestFolder] = useState<string>(settings.media_directories[0] ?? '');
  const folderTouched = useRef(false);
  const matchTouched = useRef(false);
  const [autoFolderReason, setAutoFolderReason] = useState<'movie' | 'tv' | null>(null);

  // Inline manual TMDB search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchKind, setSearchKind] = useState<MediaKind>('movie');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchYear, setSearchYear] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const sourceRevision = useRef(0);
  const [revision, setRevision] = useState(0);
  const sourceInputRef = useRef<HTMLInputElement>(null);

  const changeSource = useCallback((value: string, label: string | null = null) => {
    setRevision(++sourceRevision.current);
    setSource(value);
    setSourceLabel(label);
    folderTouched.current = false;
    matchTouched.current = false;
  }, []);

  // Sync when another link opens while the modal is already visible.
  useLayoutEffect(() => {
    if (modal?.open) changeSource(modal.initialSource ?? '');
  }, [modal, changeSource]);

  const trimmedSource = source.trim();
  const catalogMatch = trimmedSource === modal?.initialSource?.trim() ? modal?.catalogMatch : undefined;
  const inspected = inspection?.revision === revision ? inspection.result : null;

  useEffect(() => {
    setInspecting(false);
    setResolvingFiles(false);
    setInspectError(null);
    setMatching(false);
    setMatch(null);
    setMatchOrigin('auto');
    setFallbackKind('movie');
    setFallbackTitle('');
    setFallbackYear(null);
    setAutoFolderReason(null);
    setDestFolder(useLibraryStore.getState().settings.media_directories[0] ?? '');
    setSearchOpen(false);
    setSearchResults([]);
    setSearching(false);
    if (!trimmedSource || !modal?.open) return;

    let cancelled = false;
    const isCurrent = () => !cancelled && sourceRevision.current === revision;
    const acceptFiles = (result: InspectTorrentRes) => {
      setInspection({ revision, result });
      const videos = result.files.filter((f) => f.is_video);
      setSelectedFiles(new Set((videos.length ? videos : result.files).map((f) => f.index)));
    };
    const applyDestination = (folder: string | null, kind: MediaKind) => {
      if (folderTouched.current || !folder) return;
      setDestFolder(folder);
      setAutoFolderReason(kind);
    };
    const debounceMs = /^(magnet:|base64:)|\.torrent$/i.test(trimmedSource) ? 60 : 350;
    const timer = window.setTimeout(async () => {
      setInspecting(true);
      try {
        const res = await inspectTorrent(trimmedSource);
        if (!isCurrent()) return;
        acceptFiles(res);
        setInspecting(false);
        setMatching(true);

        const proposal = catalogMatch ? {
          detectedKind: catalogMatch.kind, parsedTitle: catalogMatch.title, parsedYear: catalogMatch.year,
          match: catalogMatch, candidates: [catalogMatch], recommendedFolder: pickDestinationFolder(catalogMatch.kind),
        } : await matchTorrentMetadata(res.name, res.files);
        if (!isCurrent()) return;

        setFallbackKind(proposal.detectedKind);
        setFallbackTitle(proposal.parsedTitle);
        setFallbackYear(proposal.parsedYear);
        setMatch(proposal.match);
        setMatchOrigin(proposal.match ? (catalogMatch ? 'manual' : 'auto') : 'none');
        setSearchKind(proposal.detectedKind);
        setSearchQuery(proposal.parsedTitle);
        setSearchYear(proposal.parsedYear ? String(proposal.parsedYear) : '');
        setSearchResults(proposal.candidates);
        setSearchOpen(!proposal.match);
        applyDestination(proposal.recommendedFolder, proposal.detectedKind);
        setMatching(false);

        if (res.is_magnet && !res.metadata_ready) {
          setResolvingFiles(true);
          try {
            const liveRes = await inspectTorrentFilesLive(trimmedSource);
            if (!isCurrent()) return;
            if (liveRes.metadata_ready) {
              acceptFiles(liveRes);
              if (!catalogMatch && !matchTouched.current) {
                const refined = await matchTorrentMetadata(liveRes.name, liveRes.files);
                if (!isCurrent()) return;
                if (!matchTouched.current) {
                  setFallbackKind(refined.detectedKind);
                  setFallbackTitle(refined.parsedTitle);
                  setFallbackYear(refined.parsedYear);
                  if (!proposal.match && refined.match) {
                    setMatch(refined.match);
                    setMatchOrigin('auto');
                    setSearchOpen(false);
                  }
                  applyDestination(refined.recommendedFolder, refined.detectedKind);
                }
              }
            }
          } catch {
            // A magnet can still start when its file list could not be fetched.
          } finally {
            if (isCurrent()) setResolvingFiles(false);
          }
        }
        if (isCurrent()) setReviewedRevision(revision);
      } catch (e) {
        if (isCurrent()) {
          setInspection(null);
          setInspectError(errorMessage(e));
        }
      } finally {
        if (isCurrent()) {
          setInspecting(false);
          setMatching(false);
        }
      }
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmedSource, revision, catalogMatch, modal?.open]);

  // Interactive manual TMDB search inside modal
  useEffect(() => {
    if (!searchOpen || !inspected) return;
    const q = searchQuery.trim();
    if (!q || !settings.tmdb_api_key) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = window.setTimeout(async () => {
      try {
        const y = /^\d{4}$/.test(searchYear.trim()) ? parseInt(searchYear.trim(), 10) : null;
        const r = await searchTitles(searchKind, q, y);
        if (!cancelled) setSearchResults(r);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [searchOpen, searchKind, searchQuery, searchYear, settings.tmdb_api_key, revision, inspected]);

  if (!modal?.open) return null;

  const pickTorrentFile = async () => {
    const startedAt = sourceRevision.current;
    const picked = await openDialog({
      multiple: false,
      title: 'Open .torrent file',
      filters: [{ name: 'BitTorrent file', extensions: ['torrent'] }],
    });
    if (typeof picked === 'string' && picked && startedAt === sourceRevision.current && !submittingRef.current) {
      changeSource(picked, basename(picked));
    }
  };

  const browseCustomFolder = async () => {
    const startedAt = sourceRevision.current;
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: 'Choose download library folder',
    });
    if (typeof picked === 'string' && picked && startedAt === sourceRevision.current && !submittingRef.current) {
      if (!settings.media_directories.includes(picked)) {
        await updateSettings({ media_directories: [...settings.media_directories, picked] });
      }
      if (startedAt !== sourceRevision.current || submittingRef.current) return;
      setDestFolder(picked);
      folderTouched.current = true;
      setAutoFolderReason(null);
    }
  };

  const chooseManualMatch = (r: SearchResult) => {
    matchTouched.current = true;
    setMatch(r);
    setMatchOrigin('manual');
    setFallbackKind(r.kind);
    setSearchOpen(false);
    if (!folderTouched.current) {
      const rec = pickDestinationFolder(r.kind, settings);
      if (rec) {
        setDestFolder(rec);
        setAutoFolderReason(r.kind);
      }
    }
  };

  const clearMatch = (kindChoice: MediaKind) => {
    matchTouched.current = true;
    setMatch(null);
    setMatchOrigin('none');
    setFallbackKind(kindChoice);
    setSearchOpen(false);
    if (!folderTouched.current) {
      const rec = pickDestinationFolder(kindChoice, settings);
      if (rec) {
        setDestFolder(rec);
        setAutoFolderReason(kindChoice);
      }
    }
  };

  const toggleFile = (idx: number) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const noSelectedFiles = !!inspected?.metadata_ready && selectedFiles.size === 0;
  const canSubmit = !!inspected && reviewedRevision === revision && !noSelectedFiles && !submitting;

  const submit = async (playImmediately: boolean) => {
    if (!inspected || !canSubmit || submittingRef.current || sourceRevision.current !== revision) return;
    if (mode === 'download' && !destFolder) {
      toast('Choose a destination library folder first.', 'error');
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const allSelected = inspected.files.length > 0 && selectedFiles.size === inspected.files.length;
      const onlyFiles =
        inspected.metadata_ready && !allSelected ? [...selectedFiles].sort((a, b) => a - b) : undefined;

      await initiateTorrent({
        source: trimmedSource,
        name: inspected.name,
        mode,
        destinationRoot: destFolder,
        deleteOnComplete,
        cacheHours,
        onlyFiles,
        match,
        fallbackKind,
        fallbackTitle: fallbackTitle || inspected.name,
        fallbackYear,
        playImmediately: playImmediately && mode === 'stream',
      });
      if (sourceRevision.current === revision) close();
    } catch (e) {
      toast(`Could not start torrent: ${errorMessage(e)}`, 'error');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const effectiveKind: MediaKind = match?.kind ?? fallbackKind;
  const folderOptions = settings.media_directories;

  const footer = (
    <>
      <button type="button" onClick={close} disabled={submitting} className="nf-btn-ghost h-10 px-4 text-sm">
        Cancel
      </button>
      {mode === 'stream' ? (
        <>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit(false)}
            className="nf-btn-ghost h-10 px-4 text-sm disabled:opacity-40"
          >
            <Download className="h-4 w-4" />
            Pre-cache ({formatHoursLabel(cacheHours)})
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit(true)}
            className="nf-btn-red h-10 px-5 text-sm font-semibold disabled:opacity-40"
          >
            {submitting ? <Spinner className="h-4 w-4" tone="inherit" /> : <Play className="h-4 w-4 fill-current" />}
            Stream now
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={!canSubmit || !destFolder}
          onClick={() => void submit(false)}
          className="nf-btn-red h-10 px-5 text-sm font-semibold disabled:opacity-40"
        >
          {submitting ? <Spinner className="h-4 w-4" tone="inherit" /> : <Download className="h-4 w-4" />}
          Start download
        </button>
      )}
    </>
  );

  return (
    <Dialog
      onClose={() => { if (!submittingRef.current) close(); }}
      priority={160}
      size="md"
      divided
      initialFocus={sourceInputRef}
      closeDisabled={submitting}
      bodyClassName="min-h-0 flex-1 overflow-y-auto"
      icon={<DialogIcon><Magnet className="h-5 w-5" /></DialogIcon>}
      title="Stream or download a torrent"
      description={<span className="text-xs">Paste a magnet link, drop a .torrent file, or browse from disk</span>}
      backdropProps={{ onDragOver: (e) => e.preventDefault(), onDrop: async (e) => {
        e.preventDefault();
        const f = Array.from(e.dataTransfer.files).find((x) => x.name.toLowerCase().endsWith('.torrent'));
        if (!f || submittingRef.current) return;
        changeSource('');
        const startedAt = sourceRevision.current;
        try {
          const encoded = await fileToBase64TorrentSource(f);
          if (sourceRevision.current === startedAt) changeSource(encoded, f.name);
        } catch (e) {
          if (sourceRevision.current === startedAt) setInspectError(errorMessage(e));
        }
      } }}
      footer={footer}
    >
        <fieldset disabled={submitting} className="min-w-0 space-y-5 px-6 py-5">
          {/* Source Input */}
          <div className="space-y-2">
            <label htmlFor="torrent-source" className="block text-xs font-semibold uppercase tracking-wider text-nf-muted">Torrent source</label>
            <div className="flex gap-2">
              <input
                ref={sourceInputRef}
                id="torrent-source"
                value={source.startsWith('base64:') ? `[Loaded file] ${sourceLabel ?? 'torrent'}` : source}
                onChange={(e) => changeSource(e.target.value)}
                placeholder="magnet:?xt=urn:btih:… or https://…/file.torrent"
                className="nf-input flex-1 text-sm"
              />
              <button type="button" onClick={pickTorrentFile} className="nf-btn-ghost h-11 shrink-0 px-3.5 text-sm">
                <FileUp className="h-4 w-4" />
                .torrent file
              </button>
            </div>
            {inspecting && (
              <div className="flex items-center gap-2 text-xs text-nf-secondary">
                <Spinner className="h-3.5 w-3.5" /> Reading torrent metadata…
              </div>
            )}
            {inspectError && <p className="text-xs text-nf-red">{inspectError}</p>}
          </div>

          {/* Mode Selector: Stream vs Download */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-nf-muted">Transfer mode</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setMode('stream')}
                className={`flex flex-col items-start gap-1.5 rounded-lg border p-3.5 text-left transition-all ${
                  mode === 'stream'
                    ? 'border-nf-red bg-nf-red/10 ring-1 ring-nf-red/50'
                    : 'border-white/15 bg-white/[0.02] hover:border-white/30 hover:bg-white/[0.05]'
                }`}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="flex items-center gap-2 font-semibold text-white">
                    <Play className="h-4 w-4 fill-current text-nf-red" /> Stream
                  </span>
                  {mode === 'stream' && <Check className="h-4 w-4 text-nf-red" />}
                </div>
                <span className="text-xs leading-relaxed text-nf-secondary">
                  Downloads pieces sequentially for instant viewing. Auto-clears after cache timer expires.
                </span>
              </button>

              <button
                type="button"
                onClick={() => setMode('download')}
                className={`flex flex-col items-start gap-1.5 rounded-lg border p-3.5 text-left transition-all ${
                  mode === 'download'
                    ? 'border-nf-red bg-nf-red/10 ring-1 ring-nf-red/50'
                    : 'border-white/15 bg-white/[0.02] hover:border-white/30 hover:bg-white/[0.05]'
                }`}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="flex items-center gap-2 font-semibold text-white">
                    <HardDriveDownload className="h-4 w-4 text-nf-red" /> Download
                  </span>
                  {mode === 'download' && <Check className="h-4 w-4 text-nf-red" />}
                </div>
                <span className="text-xs leading-relaxed text-nf-secondary">
                  Saves permanently into your chosen library folder and never expires.
                </span>
              </button>
            </div>
          </div>

          {/* Mode-specific controls: Cache Retention (Stream) OR Library Folder Picker (Download) */}
          {mode === 'stream' ? (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Clock className="h-4 w-4 text-nf-warn" />
                  Keep stream cache for
                </div>
                <span className="text-xs text-nf-secondary">
                  The poster and info page show a countdown before cleanup
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {CACHE_PRESETS.map((p) => (
                  <button
                    key={p.hours}
                    type="button"
                    onClick={() => setCacheHours(p.hours)}
                    className={`rounded border px-3 py-1.5 text-xs font-medium transition-colors ${
                      cacheHours === p.hours
                        ? 'border-white bg-white font-semibold text-black'
                        : 'border-white/20 text-nf-secondary hover:border-white/40 hover:text-white'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <div className="ml-auto flex items-center gap-1.5 text-xs text-nf-secondary">
                  <span>Custom (hours):</span>
                  <input
                    type="number"
                    min={1}
                    max={8760}
                    value={cacheHours}
                    onChange={(e) => setCacheHours(Math.max(1, Number(e.target.value) || 1))}
                    className="h-8 w-20 rounded border border-white/20 bg-black/40 px-2 text-center text-xs text-white outline-none focus:border-white/50"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2.5 rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <FolderOpen className="h-4 w-4 text-nf-secondary" />
                  Library folder
                </span>
                {autoFolderReason && !folderTouched.current && (
                  <span className="flex items-center gap-1 rounded-full bg-nf-green/15 px-2.5 py-0.5 text-[11px] font-semibold text-nf-green">
                    <Sparkles className="h-3 w-3" />
                    Auto-selected for {autoFolderReason === 'tv' ? 'TV shows' : 'movies'}
                  </span>
                )}
              </div>

              {folderOptions.length > 0 ? (
                <div className="space-y-1.5">
                  {folderOptions.map((dir) => {
                    const selected = destFolder === dir;
                    const leaf = basename(dir);
                    return (
                      <button
                        key={dir}
                        type="button"
                        onClick={() => {
                          setDestFolder(dir);
                          folderTouched.current = true;
                        }}
                        className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                          selected
                            ? 'border-white bg-white/10 text-white'
                            : 'border-white/10 bg-black/25 text-nf-secondary hover:border-white/25 hover:text-white'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="font-semibold text-white">{leaf}</div>
                          <div className="truncate font-mono text-[11px] text-nf-muted">{dir}</div>
                        </div>
                        {selected && <Check className="h-4 w-4 shrink-0 text-nf-green" />}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-nf-secondary">No library folders configured yet. Browse to pick a destination folder.</p>
              )}

              <div className="pt-1">
                <button type="button" onClick={browseCustomFolder} className="nf-btn-ghost h-8 px-3 py-0 text-xs">
                  <FolderOpen className="h-3.5 w-3.5" /> Choose another folder…
                </button>
              </div>
            </div>
          )}

          {/* Smart Library Match Card + Inline Manual TMDB Search */}
          {inspected && (
            <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-nf-muted">Library match</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSearchOpen((o) => !o)}
                    disabled={matching}
                    className="text-xs font-semibold text-white underline underline-offset-2 hover:text-nf-secondary"
                  >
                    {searchOpen ? 'Hide search' : match ? 'Change match' : 'Find match manually'}
                  </button>
                </div>
              </div>

              {matching ? (
                <div className="flex items-center gap-2.5 py-3 text-xs text-nf-secondary">
                  <Spinner className="h-4 w-4" /> Matching “{inspected.name}” against TMDB…
                </div>
              ) : match ? (
                <div className="flex items-start gap-3.5">
                  <div className="aspect-[2/3] w-14 shrink-0 overflow-hidden rounded bg-black/40">
                    <Artwork src={match.poster} alt={match.title} fallbackTitle={match.title} className="h-full w-full" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-bold text-white">{match.title}</span>
                      {match.year && <span className="text-xs text-nf-secondary">({match.year})</span>}
                      <span className="inline-flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white">
                        {match.kind === 'tv' ? <Tv className="h-3 w-3" /> : <Film className="h-3 w-3" />}
                        {match.kind === 'tv' ? 'TV series' : 'Movie'}
                      </span>
                      <span className="rounded bg-nf-green/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-nf-green">
                        {matchOrigin === 'manual' ? 'Manual match' : 'Auto-matched'}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-nf-secondary">
                      {match.overview || 'Matched on TMDB.'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded bg-black/30 px-3 py-2.5 text-xs">
                  <div>
                    <span className="font-semibold text-white">{fallbackTitle || inspected.name}</span>
                    <span className="ml-2 text-nf-muted">
                      ({effectiveKind === 'tv' ? 'Unmatched TV show' : 'Unmatched movie'})
                    </span>
                  </div>
                  <div className="flex rounded border border-white/20 p-0.5">
                    {(['movie', 'tv'] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => clearMatch(k)}
                        className={`rounded-sm px-2.5 py-0.5 text-[11px] font-semibold ${
                          effectiveKind === k ? 'bg-white text-black' : 'text-nf-secondary hover:text-white'
                        }`}
                      >
                        {k === 'movie' ? 'Movie' : 'TV show'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Expandable Manual TMDB Search */}
              {searchOpen && (
                <div className="space-y-2.5 border-t border-white/10 pt-3">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-nf-muted" />
                      <input
                        aria-label="Search TMDB"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search TMDB…"
                        className="h-9 w-full rounded border border-white/20 bg-black/40 pl-9 pr-3 text-xs text-white outline-none focus:border-white/50"
                      />
                    </div>
                    <input
                      value={searchYear}
                      onChange={(e) => setSearchYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      aria-label="Year"
                      placeholder="Year"
                      className="h-9 w-20 rounded border border-white/20 bg-black/40 px-2 text-center text-xs text-white outline-none focus:border-white/50"
                    />
                    <div className="flex rounded border border-white/20 p-0.5">
                      {(['movie', 'tv'] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setSearchKind(k)}
                          className={`rounded-sm px-2.5 text-xs font-semibold ${
                            searchKind === k ? 'bg-white text-black' : 'text-nf-secondary hover:text-white'
                          }`}
                        >
                          {k === 'movie' ? 'Movie' : 'TV'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
                    {searching && (
                      <div className="flex justify-center py-4">
                        <Spinner className="h-4 w-4" />
                      </div>
                    )}
                    {!searching &&
                      searchResults.map((r) => (
                        <button
                          key={`${r.kind}-${r.id}`}
                          type="button"
                          onClick={() => chooseManualMatch(r)}
                          className={`flex w-full items-center gap-3 rounded px-2.5 py-2 text-left text-xs transition-colors hover:bg-white/10 ${
                            match?.id === r.id && match.kind === r.kind ? 'bg-white/10 ring-1 ring-nf-green/60' : ''
                          }`}
                        >
                          <div className="aspect-[2/3] w-8 shrink-0 overflow-hidden rounded bg-black/40">
                            <Artwork src={r.poster} alt={r.title} className="h-full w-full" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-semibold text-white">{r.title}</span>
                              {r.year && <span className="text-nf-secondary">({r.year})</span>}
                            </div>
                            <div className="flex items-center gap-1 text-[11px] text-nf-muted">
                              <Star className="h-2.5 w-2.5 fill-current" />
                              {r.voteAverage ? r.voteAverage.toFixed(1) : '–'} · {r.kind === 'tv' ? 'TV series' : 'Movie'}
                            </div>
                          </div>
                        </button>
                      ))}
                    {!searching && searchQuery.trim() && !searchResults.length && (
                      <p className="py-3 text-center text-xs text-nf-muted">
                        {settings.tmdb_api_key ? 'No TMDB matches found. Try another title or keep unmatched.' : 'Configure your TMDB API key in Settings › Ratings & data to search.'}
                      </p>
                    )}
                  </div>

                  {match && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => clearMatch(searchKind)}
                        className="text-[11px] text-nf-muted underline hover:text-white"
                      >
                        Clear match (add as unmatched {searchKind === 'tv' ? 'TV show' : 'movie'})
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* File List / Magnet Peer Status */}
          {inspected && (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold uppercase tracking-wider text-nf-muted">
                  {inspected.metadata_ready
                    ? `Files (${inspected.files.length}) · ${formatBytes(inspected.total_bytes)}`
                    : 'Magnet metadata'}
                </span>
                {resolvingFiles && (
                  <span className="flex items-center gap-1.5 text-nf-secondary">
                    <Spinner className="h-3 w-3" /> Discovering file list from peers…
                  </span>
                )}
              </div>

              {inspected.metadata_ready && inspected.files.length > 0 ? (
                <div className="mt-2.5 max-h-36 space-y-1 overflow-y-auto pr-1">
                  {inspected.files.map((f) => (
                    <label
                      key={f.index}
                      className="flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1 text-xs hover:bg-white/5"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(f.index)}
                          onChange={() => toggleFile(f.index)}
                          className="accent-nf-red"
                        />
                        <span className={`truncate ${f.is_video ? 'text-white' : 'text-nf-muted'}`}>{f.relative_path}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-nf-muted">{formatBytes(f.size)}</span>
                    </label>
                  ))}
                </div>
              ) : inspected.metadata_ready ? (
                <p className="mt-1.5 text-xs text-nf-secondary">This torrent contains no files.</p>
              ) : !resolvingFiles && reviewedRevision === revision ? (
                <p className="mt-1.5 text-xs text-nf-secondary">
                  The file list is unavailable. Starting this torrent will download all files.
                </p>
              ) : null}
              {noSelectedFiles && inspected.files.length > 0 && (
                <p className="mt-1.5 text-xs text-nf-secondary">Select at least one file to continue.</p>
              )}
            </div>
          )}

          {/* Seeding toggle */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-white/15 bg-black/35 px-4 py-3.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white">
                Remove torrent after download completes (stop seeding)
              </div>
              <div className="mt-0.5 text-xs leading-relaxed text-nf-secondary">
                {deleteOnComplete
                  ? 'Hit-and-run enabled: torrent stops seeding immediately at 100%, keeping your downloaded video files.'
                  : 'Seeding enabled: continues sharing with peers after download finishes (or until your seed limit).'}
              </div>
            </div>
            <Switch
              checked={deleteOnComplete}
              onChange={setDeleteOnComplete}
              label="Remove torrent after download completes"
            />
          </div>
        </fieldset>
    </Dialog>
  );
}
