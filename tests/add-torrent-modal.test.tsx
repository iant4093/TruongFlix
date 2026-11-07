import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AddTorrentModal from '../src/components/torrents/AddTorrentModal';
import { initiateTorrent, inspectTorrent, inspectTorrentFilesLive } from '../src/services/torrents';
import { useLibraryStore } from '../src/store/useLibraryStore';
import type { InspectTorrentRes } from '../src/types/media';

vi.mock('../src/services/torrents', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/torrents')>(),
  initiateTorrent: vi.fn(),
  inspectTorrent: vi.fn(),
  inspectTorrentFilesLive: vi.fn(),
}));

const first = 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111';
const second = 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222';

function metadata(name: string, files: number[]): InspectTorrentRes {
  return {
    info_hash: name,
    name,
    total_bytes: files.length * 100,
    is_magnet: true,
    metadata_ready: files.length > 0,
    files: files.map((index) => ({
      index,
      name: `${name}-${index}.mkv`,
      relative_path: `${name}-${index}.mkv`,
      size: 100,
      is_video: true,
    })),
    trackers: [],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  useLibraryStore.setState(useLibraryStore.getInitialState(), true);
  useLibraryStore.setState((s) => ({
    addTorrentModal: { open: true, initialSource: first },
    settings: { ...s.settings, media_directories: ['/Movies'], torrent_default_mode: 'download' },
  }));
});

afterEach(cleanup);

it('waits for the current source and discards a file list that arrives after a source change', async () => {
  let finishOldInspection!: (result: InspectTorrentRes) => void;
  vi.mocked(inspectTorrent)
    .mockResolvedValueOnce(metadata('Old', []))
    .mockResolvedValueOnce(metadata('New', [6]));
  vi.mocked(inspectTorrentFilesLive).mockImplementationOnce(() => new Promise((resolve) => {
    finishOldInspection = resolve;
  }));

  render(<AddTorrentModal />);
  const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start Download' });
  await screen.findByText('Discovering file list from peers…');
  expect(start.disabled).toBe(true);

  fireEvent.change(screen.getByRole('textbox', { name: 'Torrent Source' }), { target: { value: second } });
  expect(start.disabled).toBe(true);
  await screen.findByRole('checkbox', { name: /New-6\.mkv/ });
  await act(async () => finishOldInspection(metadata('Old', [1])));

  expect(screen.queryByRole('checkbox', { name: /Old-1\.mkv/ })).toBeNull();
  expect(start.disabled).toBe(false);
});

it('requires a selected file and submits the current selection only once', async () => {
  vi.mocked(inspectTorrent).mockResolvedValueOnce(metadata('Episode', [2, 5]));
  vi.mocked(initiateTorrent).mockImplementationOnce(() => new Promise(() => {}));
  render(<AddTorrentModal />);

  const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start Download' });
  const firstFile = await screen.findByRole('checkbox', { name: /Episode-2\.mkv/ });
  const secondFile = screen.getByRole('checkbox', { name: /Episode-5\.mkv/ });
  await waitFor(() => expect(start.disabled).toBe(false));
  fireEvent.click(firstFile);
  fireEvent.click(secondFile);
  expect(start.disabled).toBe(true);
  expect(screen.getByText('Select at least one file to continue.')).toBeTruthy();

  fireEvent.click(secondFile);
  fireEvent.click(start);
  fireEvent.click(start);
  expect(initiateTorrent).toHaveBeenCalledTimes(1);
  expect(initiateTorrent).toHaveBeenCalledWith(expect.objectContaining({ source: first, onlyFiles: [5] }));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Close' }).disabled).toBe(true);
});
