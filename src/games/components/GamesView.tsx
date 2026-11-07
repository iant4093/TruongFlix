import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, Loader2, Settings2, ShieldCheck } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { validateSourceUrl } from '../../services/browse';
import Modal from '../../components/live/LiveDialog';
import { Switch } from '../../components/settings/ui';
import { initGames, updateGameSettings, useGamesStore } from '../jobs';
import { resetSourceCache } from '../source';
import type { GameSettings } from '../types';
import GameBrowse from './GameBrowse';
import GameLibrary from './GameLibrary';

type Tab = 'browse' | 'library';

function FolderField({ id, label, hint, value, onChange }: { id: string; label: string; hint: string; value: string; onChange: (v: string) => void }) {
  const pick = async () => {
    const picked = await open({ directory: true, title: label, defaultPath: value || undefined });
    if (typeof picked === 'string') onChange(picked);
  };
  return <div className="mb-5">
    <label className="mb-1.5 block text-sm" htmlFor={id}>{label}</label>
    <div className="flex gap-2">
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Choose a folder" className="min-w-0 flex-1 rounded border border-white/20 bg-black/50 px-3 py-2.5 text-sm outline-none focus:border-white/60" />
      <button type="button" className="nf-btn-ghost" onClick={() => void pick()}><FolderOpen className="h-4 w-4" />Browse</button>
    </div>
    <p className="mt-1.5 text-xs text-white/45">{hint}</p>
  </div>;
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <div className="flex items-start justify-between gap-6 py-2.5">
    <div><p className="text-sm">{label}</p>{hint && <p className="mt-0.5 text-xs text-white/45">{hint}</p>}</div>
    <Switch checked={checked} onChange={onChange} label={label} />
  </div>;
}

export function GameSettingsDialog({ onClose }: { onClose: () => void }) {
  const current = useGamesStore((s) => s.settings);
  const [draft, setDraft] = useState<GameSettings>(current);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof GameSettings>(key: K, value: GameSettings[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const sourceUrl = draft.sourceUrl.trim() ? validateSourceUrl(draft.sourceUrl) : '';
      await updateGameSettings({ ...draft, sourceUrl, downloadDir: draft.downloadDir.trim(), installDir: draft.installDir.trim() });
      if (sourceUrl !== current.sourceUrl) resetSourceCache();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return <Modal title="Games settings" onClose={onClose}>
    <label className="mb-1.5 block text-sm" htmlFor="game-source">Game source</label>
    <input id="game-source" type="url" value={draft.sourceUrl} onChange={(e) => set('sourceUrl', e.target.value)} placeholder="https://your-game-source.example" className="w-full rounded border border-white/20 bg-black/50 px-3 py-2.5 text-sm outline-none focus:border-white/60" />
    <p className="mb-6 mt-1.5 flex items-center gap-1.5 text-xs text-white/45"><ShieldCheck className="h-3.5 w-3.5" />The website you get games from. Only its game list is read.</p>
    <FolderField id="game-downloads" label="Download installers to" hint="Each game's installer is downloaded into its own folder here." value={draft.downloadDir} onChange={(v) => set('downloadDir', v)} />
    <FolderField id="game-installs" label="Install games to" hint="Each game is installed into its own folder here." value={draft.installDir} onChange={(v) => set('installDir', v)} />
    <div className="divide-y divide-white/10 border-y border-white/10">
      <Toggle label="Install automatically after downloading" checked={draft.autoInstall} onChange={(v) => set('autoInstall', v)} />
      <Toggle label="Delete installers after installing" hint="Seeding stops when an installer is deleted." checked={draft.deleteInstaller} onChange={(v) => set('deleteInstaller', v)} />
      <Toggle label="Install DirectX, Visual C++ and other system components" hint="Off by default — most PCs already have them." checked={draft.installRedists} onChange={(v) => set('installRedists', v)} />
      <Toggle label="Create desktop shortcuts" checked={draft.desktopShortcut} onChange={(v) => set('desktopShortcut', v)} />
    </div>
    {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
    <div className="mt-7 flex justify-end gap-3"><button className="nf-btn-ghost" onClick={onClose}>Cancel</button><button className="nf-btn-red" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button></div>
  </Modal>;
}

export default function GamesView() {
  const profile = useLibraryStore((s) => s.activeProfile);
  const profileGate = useLibraryStore((s) => s.profileGate);
  const ready = useGamesStore((s) => s.ready);
  const source = useGamesStore((s) => s.settings.sourceUrl);
  const activeCount = useGamesStore((s) => s.games.filter((g) => g.status === 'downloading' || g.status === 'installing' || g.status === 'verifying').length);
  const [tab, setTab] = useState<Tab>('browse');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    initGames().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (profile?.maturity !== 'all' || profileGate) {
    return <div className="px-[4%] pt-32"><h1 className="text-4xl font-bold">Games</h1><p className="mt-5 text-nf-secondary">Switch to an unrestricted profile to browse and install games.</p></div>;
  }

  return <div className="min-h-screen pt-[88px]">
    <div className="relative z-20 mb-6 flex flex-wrap items-center gap-4 px-[4%]">
      <h1 className="text-3xl font-bold">Games</h1>
      <div className="flex rounded border border-white/20 bg-black/30 p-1" role="tablist" aria-label="Games">
        {(['browse', 'library'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
          className={`flex items-center gap-2 rounded px-4 py-1.5 text-sm font-medium ${tab === t ? 'bg-white text-black' : 'text-white/65 hover:text-white'}`}>
          {t === 'browse' ? 'Browse' : 'Library'}
          {t === 'library' && activeCount > 0 && <span className="rounded-full bg-nf-red px-1.5 text-[10px] font-bold text-white">{activeCount}</span>}
        </button>)}
      </div>
      <button className="nf-btn-ghost ml-auto text-sm" onClick={() => setSettingsOpen(true)}><Settings2 className="h-4 w-4" />Games settings</button>
    </div>
    {error && <p role="alert" className="mx-[4%] mb-6 rounded border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-200">{error}</p>}
    {!ready && !error
      ? <div role="status" className="flex justify-center gap-3 py-24 text-white/60"><Loader2 className="h-5 w-5 animate-spin" />Loading games…</div>
      : ready && (tab === 'browse'
        ? <GameBrowse origin={source} onOpenSettings={() => setSettingsOpen(true)} onOpenLibrary={() => setTab('library')} />
        : <GameLibrary onBrowse={() => setTab('browse')} />)}
    {settingsOpen && <GameSettingsDialog onClose={() => setSettingsOpen(false)} />}
  </div>;
}
