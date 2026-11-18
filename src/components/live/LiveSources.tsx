import { useRef, useState } from 'react';
import { Globe, Plus, Radio, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { cancelChecks, importPlaylist, removePlaylist, useLiveStore } from '../../services/live';
import type { LivePlaylist } from '../../types/live';
import Modal from './LiveDialog';
import Spinner from '../common/Spinner';
import SegmentedControl from '../common/SegmentedControl';
import { button, sourceKind } from './ui';
import { errorMessage } from '../../lib/errors';

type Kind = 'm3u' | 'web';

export default function Sources({ onClose }: { onClose: () => void }) {
  const playlists = useLiveStore((s) => s.playlists);
  const confirm = useLibraryStore((s) => s.confirm);
  const [kind, setKind] = useState<Kind>('m3u');
  const [name, setName] = useState('');
  const [input, setInput] = useState('');
  const [editing, setEditing] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const web = kind === 'web';
  const reset = () => {
    setEditing(undefined);
    setName('');
    setInput('');
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await cancelChecks();
      await importPlaylist(name, input, editing, kind);
      reset();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const edit = (p: LivePlaylist) => {
    setKind(p.kind ?? 'm3u');
    setName(p.name);
    setInput(p.input);
    setEditing(p.id);
    setError('');
  };
  return (
    <Modal
      title="Live TV sources"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="mb-6 space-y-2">
        {playlists.map((p) => {
          const Icon = p.kind === 'web' ? Globe : Radio;
          return (
            <div key={p.id} className="flex items-center gap-3 rounded bg-white/5 p-3">
              <Icon className="h-5 w-5 text-nf-muted" aria-hidden />
              <button className="min-w-0 flex-1 text-left" disabled={busy} onClick={() => edit(p)}>
                <span className="block truncate text-sm font-bold">{p.name}</span>
                <span className="text-xs text-nf-muted">
                  {sourceKind(p)} · {p.channels.length.toLocaleString()} {p.channels.length === 1 ? 'channel' : 'channels'} · Updated{' '}
                  {new Date(p.updatedAt).toLocaleDateString()}
                </span>
              </button>
              <button
                aria-label={`Refresh ${p.name}`}
                disabled={busy}
                className="p-2 hover:text-white"
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await cancelChecks();
                    await importPlaylist(p.name, p.input, p.id, p.kind ?? 'm3u');
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <button
                aria-label={`Remove ${p.name}`}
                disabled={busy}
                className="p-2 text-nf-muted hover:text-red-400"
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Remove ${p.name}?`,
                      message: `This removes the saved ${p.kind === 'web' ? 'channel list' : 'playlist'} from TruongFlix.`,
                      confirmLabel: 'Remove',
                      danger: true,
                    })
                  )
                    await removePlaylist(p.id);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-bold">
          {editing ? (web ? 'Edit web channel list' : 'Edit playlist') : web ? 'Add web channel list' : 'Add playlist'}
        </h3>
        {!editing && (
          <SegmentedControl
            ariaLabel="Source type"
            size="sm"
            value={kind}
            onChange={(next) => {
              setKind(next);
              setError('');
            }}
            options={[
              { value: 'm3u', label: 'M3U playlist', icon: <Radio className="h-3.5 w-3.5" aria-hidden /> },
              { value: 'web', label: 'Web channel list', icon: <Globe className="h-3.5 w-3.5" aria-hidden /> },
            ]}
          />
        )}
      </div>
      <label className="mb-4 block text-xs text-nf-secondary">
        {web ? 'Source name' : 'Playlist name'}
        <input
          className="nf-input mt-2 w-full"
          value={name}
          maxLength={100}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          placeholder={web ? 'My web channels' : 'My sports channels'}
        />
      </label>
      {web ? (
        <label className="block text-xs text-nf-secondary">
          Channel list URL (JSON)
          <input
            className="nf-input mt-2 w-full font-mono text-xs"
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://example.com/embed/manifest.json"
            spellCheck={false}
          />
          <span className="mt-2 block text-nf-muted">
            A JSON list with a web player link for each channel. Channels play in that player inside TruongFlix, styled to match.
          </span>
        </label>
      ) : (
        <label className="block text-xs text-nf-secondary">
          Playlist URL, stream URL or M3U text
          <textarea
            className="nf-input mt-2 min-h-32 w-full resize-y font-mono text-xs"
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://example.com/playlist.m3u"
            spellCheck={false}
          />
        </label>
      )}
      <input
        ref={file}
        type="file"
        accept=".m3u,.m3u8,text/plain,audio/x-mpegurl"
        className="hidden"
        onChange={async (e) => {
          const selected = e.target.files?.[0];
          if (selected) {
            if (selected.size > 8 * 1024 * 1024) {
              setError('Playlist must be smaller than 8 MB');
              return;
            }
            setInput(await selected.text());
            if (!name) setName(selected.name.replace(/\.m3u8?$/i, ''));
          }
          e.target.value = '';
        }}
      />
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        {web ? (
          <span />
        ) : (
          <button className={button} disabled={busy} onClick={() => file.current?.click()}>
            <Upload className="h-4 w-4" /> Choose M3U file
          </button>
        )}
        <div className="flex gap-3">
          {editing && (
            <button className={button} disabled={busy} onClick={reset}>
              Cancel edit
            </button>
          )}
          <button className="nf-btn-red" disabled={busy || !input.trim()} onClick={() => void save()}>
            {busy ? <Spinner className="h-4 w-4" tone="inherit" /> : <Plus className="h-4 w-4" />}
            {busy ? 'Importing…' : editing ? (web ? 'Save channel list' : 'Save playlist') : web ? 'Add channel list' : 'Add playlist'}
          </button>
        </div>
      </div>
      <p className="mt-5 text-xs text-nf-muted">
        Sources stay on this device. Refreshing keeps saved favorites and matches where channel identity is preserved.
      </p>
    </Modal>
  );
}
