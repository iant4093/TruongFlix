import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import Dialog from '../common/Dialog';
import { errorMessage } from '../../lib/errors';
import { deleteMedia, type DeleteTarget } from '../../services/files';
import { episodeVersions, versionLabel } from '../../store/selectors';
import { useLibraryStore } from '../../store/useLibraryStore';
import type { EpisodeRow } from '../../types/media';

export default function DeleteMediaButton({ target, versionId, episodes = [], onDeleted }: {
  target: DeleteTarget;
  versionId?: number;
  episodes?: readonly EpisodeRow[];
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | 'all'>(0);
  const cancel = useRef<HTMLButtonElement>(null);
  const group = useId();
  const copies = target.kind === 'episode' ? episodeVersions(target.episode, episodes) : [];
  const versions = target.kind === 'movie' ? target.item.versions : copies.map((copy) => ({
    id: copy.id, label: versionLabel(copy), filePath: copy.file_path,
  }));
  const chooseVersion = versions.length > 1;
  const label = `Delete ${target.kind === 'tv' ? 'show' : target.kind}`;
  const close = () => { if (!busy) setOpen(false); };

  const remove = async (selection: DeleteTarget) => {
    setBusy(true);
    try {
      if (await deleteMedia(selection)) {
        setOpen(false);
        onDeleted();
      }
    } catch (error) {
      useLibraryStore.getState().toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirmSelection = () => {
    if (target.kind === 'movie') {
      void remove({ ...target, versionId: selected === 'all' ? undefined : selected });
    } else if (target.kind === 'episode') {
      const episode = selected === 'all' ? target.episode : copies.find((copy) => copy.id === selected);
      if (episode) void remove({ ...target, episode, allVersions: selected === 'all' });
    }
  };

  return <>
    <button type="button" disabled={busy} aria-label={label} title={label}
      onClick={() => {
        if (!chooseVersion) { void remove(target); return; }
        setSelected(target.kind === 'episode' ? target.episode.id : versionId ?? versions[0].id);
        setOpen(true);
      }}
      className="nf-circle-btn h-11 w-11 hover:!border-nf-red hover:!bg-nf-red/20">
      <Trash2 className="h-4 w-4" />
    </button>
    {open && createPortal(<Dialog
      onClose={close}
      closeDisabled={busy}
      title="Choose versions to delete"
      description={target.kind === 'episode' ? target.episode.title : target.item.title}
      priority={85}
      size="sm"
      initialFocus={cancel}
      footer={<>
        <button ref={cancel} type="button" className="nf-btn-ghost" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="nf-btn-play" disabled={busy || (selected !== 'all' && !versions.some((version) => version.id === selected))}
          onClick={confirmSelection}>Continue</button>
      </>}
    >
      <fieldset aria-label="Versions" disabled={busy} className="space-y-2">
        {versions.map((version) => (
          <label key={version.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-white/15 px-3 py-2.5 hover:bg-white/5">
            <input type="radio" name={group} checked={selected === version.id} onChange={() => setSelected(version.id)} className="mt-1 shrink-0 accent-nf-red" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{version.label}</span>
              <span className="block break-all text-xs text-nf-secondary">{version.filePath}</span>
            </span>
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-3 rounded-md border border-white/15 px-3 py-2.5 hover:bg-white/5">
          <input type="radio" name={group} checked={selected === 'all'} onChange={() => setSelected('all')} className="shrink-0 accent-nf-red" />
          <span className="text-sm font-medium">All {versions.length} versions</span>
        </label>
      </fieldset>
    </Dialog>, document.getElementById('app-shell') ?? document.body)}
  </>;
}
