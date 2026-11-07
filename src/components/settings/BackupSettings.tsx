import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Download, FolderOpen, History, Upload } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { basename } from '../../lib/path';
import { BTN, BTN_DANGER, Group, Row } from './ui';
import Spinner from '../common/Spinner';

type BackupInfo = { token: string; folders: string[]; profiles: number; titles: number };
const filters = [{ name: 'TruongFlix backup', extensions: ['truongflix-backup'] }];

export default function BackupSettings({ restoreOnly = false }: { restoreOnly?: boolean }) {
  const confirm = useLibraryStore((s) => s.confirm);
  const toast = useLibraryStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<(BackupInfo & { path: string }) | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const running = useRef(false);

  useEffect(() => {
    let active = true;
    void invoke<string | null>('backup_recovery_path').then((path) => {
      if (active) setRecovery(path);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast(String(error), 'error');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const exportBackup = () => run(async () => {
    const day = new Date().toLocaleDateString('sv-SE');
    const path = await save({ defaultPath: `TruongFlix ${day}.truongflix-backup`, filters });
    if (!path) return;
    await invoke('backup_export', { path });
    toast('TruongFlix backup saved', 'success');
  });

  const selectBackup = (recoveryPath?: string) => run(async () => {
    const path = recoveryPath ?? await open({ filters, multiple: false });
    if (typeof path !== 'string') return;
    const info = await invoke<BackupInfo>('backup_inspect', { path });
    setMappings({});
    setCandidate({ ...info, path });
  });

  const replaceFolder = (from: string) => run(async () => {
    const to = await open({ directory: true, multiple: false });
    if (typeof to === 'string') setMappings((current) => ({ ...current, [from]: to }));
  });

  const restore = () => run(async () => {
    if (!candidate) return;
    const ok = await confirm({
      title: 'Restore this TruongFlix backup?',
      message: 'TruongFlix will restart with the library and settings from this backup. Your current data will be saved as a recovery backup.',
      confirmLabel: 'Restore and restart',
      danger: true,
    });
    if (!ok) return;
    await invoke('backup_stage_restore', {
      token: candidate.token,
      mappings: Object.entries(mappings).map(([from, to]) => ({ from, to })),
    });
  });

  return (
    <Group
      title="Backup & restore"
      description="Backups include profiles, watch history, library matches, Browse saves, Live TV playlists and settings. Keep the file private because it contains API keys and profile PINs."
    >
      {!restoreOnly && <Row label="Create a backup" description="Media files, torrent transfers and file operation history stay on this device.">
        <button type="button" className={BTN} disabled={busy} onClick={() => void exportBackup()}>
          <Download className="h-4 w-4" /> Export
        </button>
      </Row>}
      <Row label="Restore a backup" description="Review the backup and choose replacement media folders if your files moved.">
        <button type="button" className={BTN} disabled={busy} onClick={() => void selectBackup()}>
          <Upload className="h-4 w-4" /> Choose backup
        </button>
      </Row>
      {recovery && (
        <Row label="Previous data" description="The recovery copy created before your last restore.">
          <button type="button" className={BTN} disabled={busy} onClick={() => void selectBackup(recovery)}>
            <History className="h-4 w-4" /> Review recovery backup
          </button>
        </Row>
      )}
      {candidate && (
        <>
          <Row
            label={basename(candidate.path) || 'Selected backup'}
            description={`${candidate.profiles} ${candidate.profiles === 1 ? 'profile' : 'profiles'} · ${candidate.titles} library ${candidate.titles === 1 ? 'title' : 'titles'}`}
          >
            <button type="button" className={BTN} disabled={busy} onClick={() => setCandidate(null)}>Cancel</button>
          </Row>
          {[...new Set(candidate.folders)].map((folder) => (
            <Row key={folder} label={<span className="break-all">{folder}</span>} description={mappings[folder] || 'Use the original folder'}>
              {mappings[folder] && (
                <button type="button" className={BTN} disabled={busy} onClick={() => setMappings(({ [folder]: _, ...rest }) => rest)}>Reset</button>
              )}
              <button type="button" className={BTN} disabled={busy} onClick={() => void replaceFolder(folder)}>
                <FolderOpen className="h-4 w-4" /> Relink
              </button>
            </Row>
          ))}
          <Row label="Apply backup">
            <button type="button" className={BTN_DANGER} disabled={busy} onClick={() => void restore()}>
              {busy && <Spinner className="h-4 w-4" tone="inherit" />} Restore and restart
            </button>
          </Row>
        </>
      )}
    </Group>
  );
}
