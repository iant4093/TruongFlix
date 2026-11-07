import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, FolderOpen, Loader2, RotateCw } from 'lucide-react';
import Modal from '../../components/live/LiveDialog';
import { Switch } from '../../components/settings/ui';
import { formatBytes, inspectTorrentFilesLive } from '../../services/torrents';
import { useLibraryStore } from '../../store/useLibraryStore';
import { classifyFiles, type GameFile, type OptionalGroup } from '../files';
import { downloadGame, updateGameSettings, useGamesStore } from '../jobs';
import type { GameDetail } from '../types';
import { CHECKBOX, pickFolder, Section, useDiskFree } from './dialogParts';

const LANGUAGE_WORDS: Record<string, string[]> = {
  en: ['english'], de: ['german'], fr: ['french'], es: ['spanish', 'latam', 'castilian', 'mexican'], it: ['italian'],
  ru: ['russian'], ja: ['japanese'], ko: ['korean'], zh: ['chinese'], pt: ['portuguese', 'brazilian'], pl: ['polish'],
  tr: ['turkish'], ar: ['arabic'], cs: ['czech'], nl: ['dutch'], hu: ['hungarian'], sv: ['swedish'], uk: ['ukrainian'],
  th: ['thai'], da: ['danish'], fi: ['finnish'], no: ['norwegian'], nb: ['norwegian'], el: ['greek'], ro: ['romanian'],
  vi: ['vietnamese'], he: ['hebrew'], id: ['indonesian'],
};

function matchesUserLanguage(group: OptionalGroup): boolean {
  const code = (navigator.language || 'en').toLowerCase().split(/[-_]/)[0];
  const wanted = LANGUAGE_WORDS[code] ?? [];
  const words = group.label.toLowerCase().split(/\s+/);
  return wanted.some((w) => words.includes(w));
}

function defaultSelection(groups: OptionalGroup[]): Set<string> {
  return new Set(groups.filter((g) => g.kind === 'extra' || matchesUserLanguage(g)).map((g) => g.key));
}

function folderButtonLabel(path: string) {
  return path ? 'Change' : 'Choose';
}

export default function DownloadDialog({ detail, onClose, onStarted }: { detail: GameDetail; onClose: () => void; onStarted?: () => void }) {
  const settings = useGamesStore((s) => s.settings);
  const torrentSettings = useLibraryStore((s) => s.settings);

  const [files, setFiles] = useState<GameFile[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [downloadDir, setDownloadDir] = useState(settings.downloadDir);
  const [installDir, setInstallDir] = useState(settings.installDir);
  const [autoInstall, setAutoInstall] = useState(settings.autoInstall);
  const [deleteInstaller, setDeleteInstaller] = useState(settings.deleteInstaller);
  const [stopSeeding, setStopSeeding] = useState(torrentSettings.torrent_delete_after_complete);

  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    setListError(null);
    (async () => {
      try {
        if (!detail.magnet) throw new Error('This game has no torrent download.');
        const res = await inspectTorrentFilesLive(detail.magnet);
        if (cancelled) return;
        if (!res.metadata_ready || !res.files.length) throw new Error('The file list is not available yet.');
        const list = res.files.map((f) => ({ index: f.index, relative_path: f.relative_path, size: f.size }));
        setFiles(list);
        setSelected(defaultSelection(classifyFiles(list).optional));
      } catch (e) {
        if (!cancelled) {
          setFiles(null);
          setListError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detail.magnet, attempt]);

  const groups = useMemo(() => (files ? classifyFiles(files) : null), [files]);
  const requiredSize = groups?.required.reduce((sum, f) => sum + f.size, 0) ?? 0;
  const totalSize = groups ? requiredSize + groups.optional.filter((g) => selected.has(g.key)).reduce((s, g) => s + g.size, 0) : null;
  const languages = groups?.optional.filter((g) => g.kind === 'language') ?? [];
  const extras = groups?.optional.filter((g) => g.kind === 'extra') ?? [];

  const free = useDiskFree(downloadDir);
  const notEnoughSpace = totalSize != null && free != null && totalSize > free;

  const toggleGroup = (key: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const changeDownloadDir = useCallback(async () => {
    const picked = await pickFolder('Choose where to save game installers', downloadDir);
    if (!picked) return;
    setDownloadDir(picked);
    await updateGameSettings({ downloadDir: picked }).catch(() => {});
  }, [downloadDir]);

  const changeInstallDir = useCallback(async () => {
    const picked = await pickFolder('Choose where to install games', installDir);
    if (!picked) return;
    setInstallDir(picked);
    await updateGameSettings({ installDir: picked }).catch(() => {});
  }, [installDir]);

  const onlyFiles = (): number[] | null => {
    if (!groups) return null;
    if (groups.optional.every((g) => selected.has(g.key))) return null;
    const picked = [...groups.required, ...groups.optional.filter((g) => selected.has(g.key)).flatMap((g) => g.files)];
    return picked.map((f) => f.index).sort((a, b) => a - b);
  };

  const canDownload = !working && !loadingList && !!downloadDir && (!autoInstall || !!installDir) && !!detail.magnet;

  const start = async () => {
    if (!canDownload) return;
    setWorking(true);
    setError(null);
    try {
      await downloadGame({
        detail,
        downloadDir,
        onlyFiles: onlyFiles(),
        autoInstall,
        deleteInstaller,
        stopSeedingWhenDone: stopSeeding,
      });
      onStarted?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const ratio = torrentSettings.torrent_seed_ratio_limit;
  const seedMins = torrentSettings.torrent_seed_time_mins;
  const limits = [ratio > 0 ? `a ratio of ${ratio}` : null, seedMins > 0 ? `${seedMins} minutes` : null].filter(Boolean).join(' or ');

  const groupList = (items: OptionalGroup[], label: string, id: string) =>
    items.length > 0 && (
      <Section title={label} id={id}>
        <ul className="divide-y divide-white/[0.08] rounded border border-white/15">
          {items.map((g) => (
            <li key={g.key}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-white/5">
                <input type="checkbox" className={CHECKBOX} checked={selected.has(g.key)} onChange={(e) => toggleGroup(g.key, e.target.checked)} />
                <span className="min-w-0 flex-1 truncate">{g.label}</span>
                <span className="shrink-0 tabular-nums text-xs text-white/50">{formatBytes(g.size)}</span>
              </label>
            </li>
          ))}
        </ul>
      </Section>
    );

  return (
    <Modal title={`Download ${detail.title}`} onClose={working ? () => {} : onClose}>
      <fieldset disabled={working} className="min-w-0 space-y-6">
        {loadingList ? (
          <p role="status" className="flex items-center gap-2 text-sm text-white/70">
            <Loader2 className="h-4 w-4 animate-spin text-nf-red" /> Getting the file list…
          </p>
        ) : listError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded border border-white/15 bg-white/[0.03] px-3 py-2.5 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 text-[#e87c03]" />
            <span className="min-w-0 flex-1 text-white/70">
              Couldn't get the file list ({listError}). You can still download everything.
            </span>
            <button type="button" className="nf-btn-ghost h-8 px-3 py-0 text-xs" onClick={() => setAttempt((n) => n + 1)}>
              <RotateCw className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        ) : (
          groups && (
            <div className="space-y-5">
              <div className="flex items-center justify-between rounded border border-white/15 px-3 py-2.5 text-sm">
                <span>Game files (required)</span>
                <span className="tabular-nums text-white/60">{formatBytes(requiredSize)}</span>
              </div>
              {groupList(languages, 'Languages', 'download-languages')}
              {groupList(extras, 'Extras', 'download-extras')}
              <p className="text-sm">
                Total download: <strong className="tabular-nums" data-testid="download-total">{formatBytes(totalSize ?? 0)}</strong>
              </p>
            </div>
          )
        )}

        <Section title="Save installer to" id="download-folder">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate rounded border border-white/15 bg-black/40 px-3 py-2 font-mono text-xs" title={downloadDir}>
              {downloadDir || <span className="font-sans text-white/40">No folder chosen</span>}
            </div>
            <button type="button" className="nf-btn-ghost h-9 shrink-0 px-3 py-0 text-sm" onClick={() => void changeDownloadDir()} aria-label={`${folderButtonLabel(downloadDir)} installer folder`}>
              <FolderOpen className="h-4 w-4" /> {folderButtonLabel(downloadDir)}
            </button>
          </div>
          {!downloadDir && <p className="text-xs text-white/50">Choose a folder to save the installer.</p>}
          {free != null && (
            <p className={`text-xs ${notEnoughSpace ? 'text-nf-red' : 'text-white/50'}`}>
              {formatBytes(free)} free on this drive
              {notEnoughSpace && ' — not enough space for this download.'}
            </p>
          )}
        </Section>

        <Section title="Options" id="download-options">
          <div className="divide-y divide-white/[0.08] rounded border border-white/15">
            <div className="space-y-3 px-3 py-3">
              <div className="flex items-center gap-4">
                <span className="flex-1 text-sm">Install automatically when the download finishes</span>
                <Switch checked={autoInstall} onChange={setAutoInstall} label="Install automatically when the download finishes" />
              </div>
              {autoInstall && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-xs text-white/60">Install to</span>
                    <div className="min-w-0 flex-1 truncate rounded border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-xs" title={installDir} data-testid="install-folder">
                      {installDir || <span className="font-sans text-white/40">No folder chosen</span>}
                    </div>
                    <button type="button" className="nf-btn-ghost h-8 shrink-0 px-3 py-0 text-xs" onClick={() => void changeInstallDir()} aria-label={`${folderButtonLabel(installDir)} install folder`}>
                      <FolderOpen className="h-3.5 w-3.5" /> {folderButtonLabel(installDir)}
                    </button>
                  </div>
                  {!installDir && <p className="text-xs text-nf-red">Choose a folder for installed games.</p>}
                  <p className="text-xs text-white/50">Uses your default install options. Turn this off to choose every option before installing.</p>
                </div>
              )}
            </div>
            <div className="flex items-center gap-4 px-3 py-3">
              <div className="flex-1">
                <div className="text-sm">Delete the installer after installing</div>
                <div className="text-xs text-white/50">Seeding stops when the installer is deleted.</div>
              </div>
              <Switch checked={deleteInstaller} onChange={setDeleteInstaller} label="Delete the installer after installing" />
            </div>
            <div className="flex items-center gap-4 px-3 py-3">
              <div className="flex-1">
                <div className="text-sm">Stop seeding when the download finishes</div>
                {limits && <div className="text-xs text-white/50">Otherwise seeding stops at {limits} (your torrent settings).</div>}
              </div>
              <Switch checked={stopSeeding} onChange={setStopSeeding} label="Stop seeding when the download finishes" />
            </div>
          </div>
        </Section>

        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <button type="button" className="nf-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="nf-btn-red disabled:opacity-40" disabled={!canDownload} onClick={() => void start()}>
            {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {listError ? 'Download everything' : 'Download'}
          </button>
        </div>
      </fieldset>
    </Modal>
  );
}
