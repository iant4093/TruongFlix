import { FolderPlus } from 'lucide-react';
import MusicLibrary from '../../music/components/MusicLibrary';
import { useLibraryStore } from '../../store/useLibraryStore';

/** The Music section of the desktop app. */
export default function MusicView() {
  const openSettings = useLibraryStore((s) => s.setSettingsOpen);
  return (
    <MusicLibrary
      variant="desktop"
      emptyAction={
        <button type="button" onClick={() => openSettings(true, 'library')} className="nf-btn-red mt-2 px-6">
          <FolderPlus className="h-5 w-5" /> Add a music folder
        </button>
      }
    />
  );
}
