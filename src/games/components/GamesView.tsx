import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { fade, spring } from '../../lib/motion';
import { useSectionState } from '../../lib/sectionMemory';
import { scrollBehavior } from '../../lib/scroll';
import { SkeletonStatus } from '../../components/common/Skeleton';
import { FolderOpen, Gamepad2, Loader2, Search, Settings2, ShieldCheck, X } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { validateSourceUrl } from '../../services/browse';
import { errorMessage } from '../../lib/errors';
import Badge from '../../components/common/Badge';
import { ErrorBanner, RestrictedProfileNotice } from '../../components/common/States';
import { Switch } from '../../components/settings/ui';
import { initGames, updateGameSettings, useGamesStore } from '../jobs';
import { resetSourceCache } from '../source';
import type { GameCard, GameDetail, GameSettings, LibraryGame } from '../types';
import { CARD, CARD_ROWS, DialogIcon, GameDialog, pickFolder, Section } from './dialogParts';
import DownloadDialog from './DownloadDialog';
import GameBrowse from './GameBrowse';
import { GameBillboardSkeleton } from './GameBillboard';
import GameDetailDialog from './GameDetailDialog';
import GameLibrary from './GameLibrary';
import { GameLibrarySkeleton, LibraryLayoutToggle } from './LibraryViews';
import { GameRowSkeleton } from './GamePoster';
import InstallDialog from './InstallDialog';

type Tab = 'browse' | 'library';

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-nf-muted">{hint}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export function GameSettingsDialog({ onClose }: { onClose: () => void }) {
  const current = useGamesStore((s) => s.settings);
  const [draft, setDraft] = useState<GameSettings>(current);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof GameSettings>(key: K, value: GameSettings[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const pick = async (key: 'downloadDir' | 'installDir', title: string) => {
    const picked = await pickFolder(title, draft[key]);
    if (picked) set(key, picked);
  };
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const sourceUrl = draft.sourceUrl.trim() ? validateSourceUrl(draft.sourceUrl) : '';
      await updateGameSettings({ ...draft, sourceUrl, downloadDir: draft.downloadDir.trim(), installDir: draft.installDir.trim() });
      if (sourceUrl !== current.sourceUrl) resetSourceCache();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <GameDialog
      title="Games settings"
      subtitle="Where games come from and where they're saved"
      art={<DialogIcon><Gamepad2 className="h-5 w-5" /></DialogIcon>}
      onClose={onClose}
      footer={<>
        <button className="nf-btn-ghost h-10 px-4 text-sm" onClick={onClose}>Cancel</button>
        <button className="nf-btn-red h-10 px-5 text-sm" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
      </>}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wider text-nf-muted" htmlFor="game-source">Game source</label>
          <input id="game-source" type="url" value={draft.sourceUrl} onChange={(e) => set('sourceUrl', e.target.value)} placeholder="https://your-game-source.example" className="nf-input text-sm" />
          <p className="flex items-center gap-1.5 text-xs text-nf-muted"><ShieldCheck className="h-3.5 w-3.5" />The website you get games from. Only its game list is read.</p>
        </div>
        <Section title="Folders" id="game-folders">
          <div className={`${CARD} divide-y divide-white/[0.08]`}>
            {([['downloadDir', 'game-downloads', 'Download installers to'], ['installDir', 'game-installs', 'Install games to']] as const).map(([key, id, label]) => (
              <div key={key} className="space-y-1.5 px-4 py-3">
                <label htmlFor={id} className="block text-sm font-semibold">{label}</label>
                <div className="flex gap-2">
                  <input id={id} value={draft[key]} onChange={(e) => set(key, e.target.value)} placeholder="Choose a folder" spellCheck={false}
                    className="nf-input h-9 min-w-0 flex-1 px-3 py-0 font-mono text-xs" />
                  <button type="button" className="nf-btn-ghost h-9 shrink-0 px-3 py-0 text-xs" onClick={() => void pick(key, label)}><FolderOpen className="h-3.5 w-3.5" />Browse</button>
                </div>
              </div>
            ))}
          </div>
          <p className="px-1 text-xs text-nf-muted">Each game gets its own folder inside these.</p>
        </Section>
        <Section title="Defaults" id="game-defaults">
          <div className={CARD_ROWS}>
            <ToggleRow label="Install automatically after downloading" checked={draft.autoInstall} onChange={(v) => set('autoInstall', v)} />
            <ToggleRow label="Delete installers after installing" hint="Seeding stops when an installer is deleted." checked={draft.deleteInstaller} onChange={(v) => set('deleteInstaller', v)} />
            <ToggleRow label="Install DirectX, Visual C++ and other system components" hint="Off by default — most PCs already have them." checked={draft.installRedists} onChange={(v) => set('installRedists', v)} />
            <ToggleRow label="Create desktop shortcuts" checked={draft.desktopShortcut} onChange={(v) => set('desktopShortcut', v)} />
          </div>
        </Section>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      </div>
    </GameDialog>
  );
}

/** Netflix-style secondary navigation over the billboard: section title, Browse/Library, search and settings. */
function SubNav({ tab, onTab, query, onQuery, searching, onSettings }: {
  tab: Tab;
  onTab: (tab: Tab) => void;
  query: string;
  onQuery: (q: string) => void;
  searching: boolean;
  onSettings: () => void;
}) {
  const activeCount = useGamesStore((s) => s.games.filter((g) => g.status === 'downloading' || g.status === 'installing' || g.status === 'verifying').length);
  return (
    <div className="absolute inset-x-0 top-[68px] z-20 flex items-center gap-x-8 px-[4%] py-3">
      <h1 className="text-shadow text-[clamp(1.5rem,2.4vw,2.4rem)] font-bold leading-none">Games</h1>
      <nav aria-label="Games" className="flex items-center gap-5 text-[15px]">
        {(['browse', 'library'] as const).map((t) => (
          <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => onTab(t)}
            className={`text-shadow relative flex items-center gap-1.5 whitespace-nowrap py-1 transition-colors duration-300 ${tab === t ? 'text-white' : 'text-[#e5e5e5] hover:text-[#b3b3b3]'}`}>
            {/* Bold text is laid out for both states so switching never shifts the row. */}
            <span className="grid">
              <span aria-hidden="true" className="invisible col-start-1 row-start-1 font-semibold">{t === 'browse' ? 'Browse' : 'Library'}</span>
              <span className={`col-start-1 row-start-1 ${tab === t ? 'font-semibold' : ''}`}>{t === 'browse' ? 'Browse' : 'Library'}</span>
            </span>
            {t === 'library' && activeCount > 0 && <Badge tone="download" pill label={`${activeCount} in progress`}>{activeCount}</Badge>}
            {tab === t && <motion.span aria-hidden="true" layoutId="games-tab" transition={spring.highlight} className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-nf-red" />}
          </button>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        {tab === 'library' && <LibraryLayoutToggle />}
        <label className="flex h-9 w-[min(260px,32vw)] items-center gap-2 rounded border border-white/25 bg-black/60 px-3 transition-colors focus-within:border-white">
          {searching ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-nf-secondary" /> : <Search className="h-4 w-4 shrink-0 text-nf-secondary" />}
          <input aria-label="Search games" value={query} onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); onQuery(''); } }}
            placeholder={tab === 'browse' ? 'Search games' : 'Search your games'} className="min-w-0 flex-1 scroll-mt-24 bg-transparent text-sm text-white outline-none placeholder:text-nf-muted" />
          {query && <button type="button" aria-label="Clear search" onClick={() => onQuery('')} className="p-0.5 text-white/70 hover:text-white"><X className="h-4 w-4" /></button>}
        </label>
        <button onClick={onSettings} aria-label="Games settings" title="Games settings"
          className="flex h-9 w-9 items-center justify-center rounded-full text-[#e5e5e5] transition-colors hover:bg-white/10 hover:text-white">
          <Settings2 className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

export default function GamesView() {
  const profile = useLibraryStore((s) => s.activeProfile);
  const profileGate = useLibraryStore((s) => s.profileGate);
  const ready = useGamesStore((s) => s.ready);
  const source = useGamesStore((s) => s.settings.sourceUrl);
  const [tab, setTab] = useSectionState<Tab>('tab', 'browse');
  const [query, setQuery] = useSectionState('query', '');
  const [searching, setSearching] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selected, setSelected] = useState<GameCard | null>(null);
  const [downloading, setDownloading] = useState<GameDetail | null>(null);
  const [installing, setInstalling] = useState<LibraryGame | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    initGames().catch((e) => setError(errorMessage(e)));
  }, []);

  const switchTab = useCallback((next: Tab) => {
    setTab(next);
    setQuery('');
    setSearching(false);
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  }, []);
  const openLibrary = useCallback(() => switchTab('library'), [switchTab]);
  const openers = { onOpen: setSelected, onDownload: setDownloading, onInstall: setInstalling };

  if (profile?.maturity !== 'all' || profileGate) {
    return <RestrictedProfileNotice title="Games" action="browse and install games" />;
  }

  return (
    <div className="relative min-h-screen">
      <SubNav tab={tab} onTab={switchTab} query={query} onQuery={setQuery} searching={searching} onSettings={() => setSettingsOpen(true)} />
      {error && <ErrorBanner className="relative z-20 mx-[4%] mb-6 mt-[136px]">{error}</ErrorBanner>}
      {!ready && !error
        ? <SkeletonStatus label="Loading games">
          {tab === 'library' ? <GameLibrarySkeleton /> : <><GameBillboardSkeleton /><div className="relative z-10 -mt-32"><GameRowSkeleton /><GameRowSkeleton /></div></>}
        </SkeletonStatus>
        : ready && (
          // The outgoing tab fades out over the incoming one instead of blanking the page.
          <div className="relative">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={tab} variants={fade} initial="initial" animate="animate" exit="exit" className="w-full">
                {tab === 'browse'
                  ? <GameBrowse origin={source} query={query} blocked={!!selected || !!downloading || !!installing || settingsOpen}
                    onOpenSettings={() => setSettingsOpen(true)} onSearching={setSearching} {...openers} />
                  : <GameLibrary query={query} onBrowse={() => switchTab('browse')} {...openers} />}
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      <AnimatePresence>
        {selected && <GameDetailDialog key={selected.slug} origin={source} game={selected} onClose={() => setSelected(null)} onOpenLibrary={openLibrary} />}
      </AnimatePresence>
      {downloading && <DownloadDialog detail={downloading} onClose={() => setDownloading(null)} onStarted={openLibrary} />}
      {installing && <InstallDialog game={installing} onClose={() => setInstalling(null)} />}
      {settingsOpen && <GameSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
