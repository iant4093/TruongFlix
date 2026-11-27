import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Download, FolderOpen, History, Upload } from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { basename } from '../../lib/path';
import { exportBackup, FOLDER_LABELS, type BackupInfo, type BackupPath } from '../../services/backup';
import { BTN, BTN_DANGER, Group, Row, ToggleRow } from './ui';
import Spinner from '../common/Spinner';

const filters = [{ name: 'TruongFlix backup', extensions: ['truongflix-backup'] }];

function folderStatus(folder: BackupPath, relinked: string | undefined) {
  if (relinked) return `Now: ${relinked}`;
  if (folder.exists) return 'Found on this computer';
  if (folder.share) return 'On a network share';
  return 'Not on this computer. Relink it, or set it later in Settings.';
}

export default function BackupSettings({ restoreOnly = false }: { restoreOnly?: boolean }) {
  const confirm = useLibraryStore((s) => s.confirm);
  const toast = useLibraryStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [withSecrets, setWithSecrets] = useState(false);
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

  const exportFile = () => run(async () => {
    const day = new Date().toLocaleDateString('sv-SE');
    const path = await save({ defaultPath: `TruongFlix ${day}.truongflix-backup`, filters });
    if (!path) return;
    await exportBackup(path, withSecrets);
    toast(withSecrets ? 'Backup saved, with passwords and keys. Keep it private.' : 'TruongFlix backup saved', 'success');
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
      message: `TruongFlix will restart with the setup from this backup${candidate.secrets ? ', including its passwords and keys' : ''}. Your current data is saved as a recovery backup first.`,
      confirmLabel: 'Restore and restart',
      danger: true,
    });
    if (!ok) return;
    await invoke('backup_stage_restore', {
      token: candidate.token,
      mappings: Object.entries(mappings).map(([from, to]) => ({ from, to })),
    });
  });

  const missing = candidate?.paths.filter((p) => !p.exists && !p.share && !mappings[p.path]).length ?? 0;

  return (
    <Group
      title="Backup & restore"
      description="Move your whole setup to another computer, or keep a copy: profiles, watch history, library, playlists, folders and settings. Video and music files aren’t included."
    >
      {!restoreOnly && (
        <>
          <ToggleRow
            label="Include passwords and keys"
            description={
              withSecrets
                ? 'The file will hold your API keys, passwords and Soulseek account. Anyone with it can read them, so keep it private.'
                : 'Off: you enter them again after restoring.'
            }
            checked={withSecrets}
            onChange={setWithSecrets}
          />
          <Row label="Create a backup" description="Torrent transfers and file operation history stay on this computer.">
            <button type="button" className={BTN} disabled={busy} onClick={() => void exportFile()}>
              <Download className="h-4 w-4" /> Export
            </button>
          </Row>
        </>
      )}
      <Row label="Restore a backup" description="Review the backup, and relink any folders that moved.">
        <button type="button" className={BTN} disabled={busy} onClick={() => void selectBackup()}>
          <Upload className="h-4 w-4" /> Choose backup
        </button>
      </Row>
      {recovery && (
        <Row label="Previous data" description="The copy saved before your last restore.">
          <button type="button" className={BTN} disabled={busy} onClick={() => void selectBackup(recovery)}>
            <History className="h-4 w-4" /> Review recovery backup
          </button>
        </Row>
      )}
      {candidate && (
        <>
          <Row
            label={basename(candidate.path) || 'Selected backup'}
            description={[
              `${candidate.profiles} ${candidate.profiles === 1 ? 'profile' : 'profiles'}`,
              `${candidate.titles} library ${candidate.titles === 1 ? 'title' : 'titles'}`,
              candidate.secrets ? 'includes passwords and keys' : 'no passwords or keys',
            ].join(' · ')}
          >
            <button type="button" className={BTN} disabled={busy} onClick={() => setCandidate(null)}>Cancel</button>
          </Row>
          {candidate.paths.map((folder) => (
            <Row
              key={folder.path}
              label={<span className="break-all">{folder.path}</span>}
              description={
                <>
                  <span className="text-nf-secondary">{FOLDER_LABELS[folder.key] ?? 'Folder'}</span>
                  {' · '}
                  <span className={!folder.exists && !folder.share && !mappings[folder.path] ? 'text-amber-300' : undefined}>
                    {folderStatus(folder, mappings[folder.path])}
                  </span>
                </>
              }
            >
              {mappings[folder.path] && (
                <button type="button" className={BTN} disabled={busy} onClick={() => setMappings(({ [folder.path]: _, ...rest }) => rest)}>Reset</button>
              )}
              <button type="button" className={BTN} disabled={busy} onClick={() => void replaceFolder(folder.path)}>
                <FolderOpen className="h-4 w-4" /> Relink
              </button>
            </Row>
          ))}
          <Row
            label="Apply backup"
            description={missing ? `${missing} ${missing === 1 ? 'folder isn’t' : 'folders aren’t'} on this computer. They’re kept as they are, so you can relink them later.` : undefined}
          >
            <button type="button" className={BTN_DANGER} disabled={busy} onClick={() => void restore()}>
              {busy && <Spinner className="h-4 w-4" tone="inherit" />} Restore and restart
            </button>
          </Row>
        </>
      )}
    </Group>
  );
}
