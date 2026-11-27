import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import BackupSettings from '../src/components/settings/BackupSettings';

vi.mock('../src/services/db');
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

afterEach(cleanup);

const preview = {
  token: 't',
  version: 2,
  secrets: false,
  profiles: 2,
  titles: 40,
  paths: [
    { path: 'D:\\Movies', key: 'media_directories', exists: true, share: false },
    { path: 'E:\\Music', key: 'music_directories', exists: false, share: false },
    { path: '\\\\nas\\TV', key: 'media_directories', exists: false, share: true },
  ],
};

it('exports without passwords and keys unless ticked', async () => {
  vi.mocked(invoke).mockImplementation(async () => null);
  vi.mocked(save).mockResolvedValue('C:\\Backups\\TruongFlix.truongflix-backup');
  render(<BackupSettings />);
  fireEvent.click(screen.getByText('Export'));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('backup_export', expect.objectContaining({ includeSecrets: false })));

  fireEvent.click(screen.getByRole('switch', { name: 'Include passwords and keys' }));
  expect(screen.getByText(/Anyone with it can read them/)).toBeTruthy();
  fireEvent.click(screen.getByText('Export'));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('backup_export', expect.objectContaining({ includeSecrets: true })));
});

it('shows which folders need relinking before a restore', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === 'backup_inspect' ? preview : null));
  vi.mocked(open).mockResolvedValue('C:\\Backups\\Old.truongflix-backup');
  render(<BackupSettings restoreOnly />);
  expect(screen.queryByText('Export')).toBeNull();
  fireEvent.click(screen.getByText('Choose backup'));
  await screen.findByText('E:\\Music');
  expect(screen.getByText(/no passwords or keys/)).toBeTruthy();
  expect(screen.getByText('Found on this computer')).toBeTruthy();
  expect(screen.getByText(/Not on this computer/)).toBeTruthy();
  expect(screen.getByText('On a network share')).toBeTruthy();
  expect(screen.getByText(/1 folder isn’t on this computer/)).toBeTruthy();
});
