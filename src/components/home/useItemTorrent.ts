import type { MediaItem, TorrentItem } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { torrentForItem } from '../../services/torrents';

/** The torrent attached to a library item; re-renders only when that torrent record changes. */
export function useItemTorrent(item: MediaItem): TorrentItem | null {
  return useLibraryStore((s) => torrentForItem(item, s.torrents));
}
