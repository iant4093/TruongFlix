import { useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { CheckCircle2, Download, ExternalLink, Eye, EyeOff, FolderPlus, Folder, Loader2, Search, Trash2, XCircle } from 'lucide-react';
import { detectVlc, installVlc } from '../../services/player';
import { validateApiKey } from '../../services/tmdb';
import { verifyOpenSubtitles } from '../../services/subtitles';
import { LanguageSelect } from './SubtitlesPanel';

const IS_MAC = navigator.userAgent.includes('Mac');

// ---------------------------------------------------------------------------
// TMDB key
// ---------------------------------------------------------------------------

interface KeyProps {
  value: string;
  onChange: (v: string) => void;
  onValidated?: (ok: boolean) => void;
}

export function TmdbKeyField({ value, onChange, onValidated }: KeyProps) {
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'bad' | 'offline'>('idle');

  const check = async () => {
    if (!value.trim()) return;
    setStatus('checking');
    try {
      const ok = await validateApiKey(value);
      setStatus(ok ? 'ok' : 'bad');
      onValidated?.(ok);
    } catch {
      setStatus('offline');
      onValidated?.(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              setStatus('idle');
            }}
            onKeyDown={(e) => e.key === 'Enter' && check()}
            placeholder="TMDB API key (v3) or Read Access Token"
            spellCheck={false}
            className="nf-input pr-10 font-mono text-sm"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-nf-muted hover:text-white"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <button type="button" onClick={check} disabled={!value.trim() || status === 'checking'} className="nf-btn-ghost">
          {status === 'checking' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
        </button>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span>
          {status === 'ok' && (
            <span className="flex items-center gap-1 text-nf-green">
              <CheckCircle2 className="h-3.5 w-3.5" /> Key verified
            </span>
          )}
          {status === 'bad' && (
            <span className="flex items-center gap-1 text-nf-red">
              <XCircle className="h-3.5 w-3.5" /> TMDB rejected this key
            </span>
          )}
          {status === 'offline' && <span className="text-[#e87c03]">Couldn’t reach TMDB — check your connection</span>}
        </span>
        <button
          type="button"
          onClick={() => openExternal('https://www.themoviedb.org/settings/api')}
          className="flex items-center gap-1 text-nf-secondary hover:text-white hover:underline"
        >
          Get a free key <ExternalLink className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VLC
// ---------------------------------------------------------------------------

interface VlcProps {
  value: string;
  onChange: (path: string) => void;
}

export function VlcSetup({ value, onChange }: VlcProps) {
  const [status, setStatus] = useState<'checking' | 'found' | 'missing' | 'installing'>(value ? 'found' : 'checking');
  const [error, setError] = useState<string | null>(null);

  const detect = async () => {
    setStatus('checking');
    setError(null);
    const path = await detectVlc();
    if (path) {
      onChange(path);
      setStatus('found');
    } else setStatus(value ? 'found' : 'missing');
  };

  useEffect(() => {
    if (!value) void detect();
  }, []);

  const install = async () => {
    setStatus('installing');
    setError(null);
    try {
      const path = await installVlc();
      if (path) {
        onChange(path);
        setStatus('found');
      } else {
        setStatus('missing');
        setError('Installer finished but VLC was not found. Try “Locate manually”.');
      }
    } catch (e) {
      setStatus('missing');
      setError(String(e));
    }
  };

  const locate = async () => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      title: 'Locate VLC',
      filters: IS_MAC ? undefined : [{ name: 'VLC', extensions: ['exe'] }],
      defaultPath: IS_MAC ? '/Applications' : 'C:\\Program Files',
    });
    if (typeof picked === 'string') {
      const path = picked.endsWith('.app') ? `${picked}/Contents/MacOS/VLC` : picked;
      onChange(path);
      setStatus('found');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded border border-white/10 bg-black/30 px-4 py-3">
        {status === 'checking' || status === 'installing' ? (
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-nf-secondary" />
        ) : status === 'found' ? (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-nf-green" />
        ) : (
          <XCircle className="h-5 w-5 shrink-0 text-nf-red" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {status === 'checking' && 'Looking for VLC…'}
            {status === 'installing' && `Installing VLC via ${IS_MAC ? 'Homebrew' : 'winget'}… this can take a few minutes`}
            {status === 'found' && 'VLC Media Player detected'}
            {status === 'missing' && 'VLC was not found on this computer'}
          </div>
          {status === 'found' && value && <div className="selectable truncate font-mono text-[11px] text-nf-muted">{value}</div>}
        </div>
      </div>
      {error && <p className="text-xs text-nf-red">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {status === 'missing' && (
          <button type="button" onClick={install} className="nf-btn-red px-4 py-2 text-sm">
            <Download className="h-4 w-4" /> Auto-Install VLC
          </button>
        )}
        <button type="button" onClick={detect} disabled={status === 'installing'} className="nf-btn-ghost">
          <Search className="h-4 w-4" /> Re-detect
        </button>
        <button type="button" onClick={locate} disabled={status === 'installing'} className="nf-btn-ghost">
          <Folder className="h-4 w-4" /> Locate manually
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OpenSubtitles (optional)
// ---------------------------------------------------------------------------

export interface SubtitleSettingsValue {
  apiKey: string;
  language: string;
  username: string;
  password: string;
}

interface SubtitleFieldsProps {
  value: SubtitleSettingsValue;
  onChange: (patch: Partial<SubtitleSettingsValue>) => void;
  /** Show the optional account login (Settings only; setup keeps it simple). */
  showAccount?: boolean;
}

export function OpenSubtitlesFields({ value, onChange, showAccount }: SubtitleFieldsProps) {
  const [status, setStatus] = useState<{ kind: 'idle' | 'checking' | 'ok' | 'bad'; text?: string }>({ kind: 'idle' });

  const verify = async () => {
    setStatus({ kind: 'checking' });
    try {
      const r = await verifyOpenSubtitles(value.apiKey, showAccount ? value.username : '', showAccount ? value.password : '');
      setStatus({
        kind: 'ok',
        text: r.logged_in
          ? `Signed in${r.allowed_downloads != null ? ` · ${r.allowed_downloads} downloads per day` : ''}`
          : 'Key verified · 5 downloads per day without an account',
      });
    } catch (e) {
      setStatus({ kind: 'bad', text: String(e) });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="password"
          value={value.apiKey}
          onChange={(e) => {
            onChange({ apiKey: e.target.value });
            setStatus({ kind: 'idle' });
          }}
          placeholder="OpenSubtitles API key (optional)"
          spellCheck={false}
          className="nf-input font-mono text-sm"
        />
        <button
          type="button"
          onClick={verify}
          disabled={!value.apiKey.trim() || status.kind === 'checking'}
          className="nf-btn-ghost"
        >
          {status.kind === 'checking' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
        </button>
      </div>

      {showAccount && (
        <div className="grid grid-cols-2 gap-2">
          <input
            value={value.username}
            onChange={(e) => {
              onChange({ username: e.target.value });
              setStatus({ kind: 'idle' });
            }}
            placeholder="Username (optional)"
            spellCheck={false}
            autoComplete="off"
            className="nf-input text-sm"
          />
          <input
            type="password"
            value={value.password}
            onChange={(e) => {
              onChange({ password: e.target.value });
              setStatus({ kind: 'idle' });
            }}
            placeholder="Password (optional)"
            autoComplete="off"
            className="nf-input text-sm"
          />
        </div>
      )}

      <div className="flex items-center gap-3">
        <span className="text-sm text-nf-secondary">Preferred language</span>
        <LanguageSelect value={value.language} onChange={(language) => onChange({ language })} className="flex-1" />
      </div>

      <div className="flex items-start justify-between gap-3 text-xs">
        <span>
          {status.kind === 'ok' && (
            <span className="flex items-center gap-1 text-nf-green">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> {status.text}
            </span>
          )}
          {status.kind === 'bad' && (
            <span className="flex items-center gap-1 text-nf-red">
              <XCircle className="h-3.5 w-3.5 shrink-0" /> {status.text}
            </span>
          )}
          {status.kind === 'idle' && showAccount && (
            <span className="text-nf-muted">Without an account you get 5 downloads per day; a free account raises this.</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => openExternal('https://www.opensubtitles.com/en/consumers')}
          className="flex shrink-0 items-center gap-1 text-nf-secondary hover:text-white hover:underline"
        >
          Get a free key <ExternalLink className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Media folders
// ---------------------------------------------------------------------------

interface FolderProps {
  value: string[];
  onChange: (dirs: string[]) => void;
}

export function FolderList({ value, onChange }: FolderProps) {
  const add = async () => {
    const picked = await openDialog({ directory: true, multiple: true, title: 'Choose Movie / TV folders' });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    onChange([...new Set([...value, ...list])]);
  };

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <ul className="space-y-1.5">
          {value.map((dir) => (
            <li key={dir} className="group flex items-center gap-3 rounded border border-white/10 bg-black/30 px-3 py-2.5">
              <Folder className="h-4 w-4 shrink-0 text-nf-secondary" />
              <span className="selectable min-w-0 flex-1 truncate font-mono text-xs">{dir}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((d) => d !== dir))}
                title="Remove folder"
                className="text-nf-muted opacity-60 transition hover:text-nf-red group-hover:opacity-100"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded border border-dashed border-white/15 px-4 py-5 text-center text-sm text-nf-muted">
          No folders yet. Add the folders containing your movies and TV shows.
        </p>
      )}
      <button type="button" onClick={add} className="nf-btn-ghost">
        <FolderPlus className="h-4 w-4" /> Add Folder
      </button>
    </div>
  );
}
