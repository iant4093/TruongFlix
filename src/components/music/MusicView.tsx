import { useEffect } from 'react';
import { FolderPlus } from 'lucide-react';
import MusicLibrary from '../../music/components/MusicLibrary';
import { setBarHidden } from '../../music/player';
import { useLibraryStore } from '../../store/useLibraryStore';

/** The Music section of the desktop app. */
export default function MusicView() {
  const openSettings = useLibraryStore((s) => s.setSettingsOpen);
  // Coming back to Music brings back a bar that was closed.
  useEffect(() => setBarHidden(false), []);
  return (
    <MusicLibrary
      variant="desktop"
      emptyAction={
        <button type="button" onClick={() => openSettings(true, 'music')} className="nf-btn-red mt-2 px-6">
          <FolderPlus className="h-5 w-5" /> Add a music folder
        </button>
      }
    />
  );
}
