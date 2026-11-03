import { useEffect, useState } from 'react';
import { Download, RefreshCw, RotateCcw } from 'lucide-react';
import type { EngineStatus } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { appVersion, availableUpdate, checkForUpdate, installUpdate, onUpdateChange, type AvailableUpdate } from '../../services/updates';
import { engineStatus } from '../../services/player';
import { formatBytes } from '../../services/files';
import { Block, BTN, BTN_PRIMARY, Group, Page, Row, StatusText, ToggleRow } from './ui';
import { closeSettingsAnd } from './nav';

export default function AboutPage() {
  const autoCheck = useLibraryStore((s) => s.settings.updates_auto_check);
  const lastCheck = useLibraryStore((s) => s.settings.updates_last_check);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const [version, setVersion] = useState('');
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [update, setUpdate] = useState<AvailableUpdate | null>(availableUpdate());
  const [phase, setPhase] = useState<'idle' | 'checking' | 'uptodate' | 'error' | 'installing'>('idle');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number | null }>({ done: 0, total: null });

  useEffect(() => {
    void appVersion().then(setVersion);
    void engineStatus().then(setEngine);
    const off = onUpdateChange(setUpdate);
    return () => void off();
  }, []);

  const runCheck = async () => {
    setPhase('checking');
    setError('');
    try {
      const u = await checkForUpdate();
      setUpdate(u);
      setPhase(u ? 'idle' : 'uptodate');
    } catch (e) {
      setError(String(e));
      setPhase('error');
    }
  };

  const install = async () => {
    setPhase('installing');
    try {
      await installUpdate((done, total) => setProgress({ done, total }));
    } catch (e) {
      setError(String(e));
      setPhase('error');
    }
  };

  const mpv = engine?.mpv_version?.replace(/^mpv\s*v?/i, '');
  const ffmpeg = engine?.ffmpeg_version?.replace(/^n?(\d+(\.\d+)*).*/, '$1');

  return (
    <Page title="About">
      <Group title="TruongFlix">
        <Row label="Version">
          <span className="text-sm tabular-nums text-nf-secondary">{version ? `v${version}` : '…'}</span>
        </Row>
        <Row label="Player engine">
          <span className="text-sm tabular-nums text-nf-secondary">{engine?.available ? `mpv ${mpv} · FFmpeg ${ffmpeg}` : 'VLC (external)'}</span>
        </Row>
      </Group>

      <Group title="Updates">
        {update ? (
          <Block className="space-y-3">
            <div className="text-sm font-semibold">TruongFlix {update.version} is available</div>
            {update.notes && <p className="selectable whitespace-pre-line text-xs leading-relaxed text-nf-secondary">{update.notes}</p>}
            {phase === 'installing' ? (
              <div className="space-y-1">
                <div className="h-1 overflow-hidden rounded bg-white/15">
                  <div className="h-full bg-nf-red transition-[width]" style={{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : '15%' }} />
                </div>
                <div className="text-xs text-nf-muted">
                  {progress.total ? `Downloading ${formatBytes(progress.done)} of ${formatBytes(progress.total)}…` : 'Downloading…'} The app restarts when done.
                </div>
              </div>
            ) : (
              <button onClick={() => void install()} className={BTN_PRIMARY}>
                <Download className="h-4 w-4" /> Download & Restart
              </button>
            )}
          </Block>
        ) : (
          <Row
            label="Check for updates"
            description={
              phase === 'checking'
                ? 'Checking…'
                : phase === 'uptodate'
                  ? 'You’re up to date.'
                  : lastCheck
                    ? `Last checked ${new Date(lastCheck).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
                    : 'Never checked'
            }
          >
            <button onClick={() => void runCheck()} disabled={phase === 'checking'} className={BTN}>
              <RefreshCw className={`h-4 w-4 ${phase === 'checking' ? 'animate-spin' : ''}`} /> Check now
            </button>
          </Row>
        )}
        {phase === 'error' && (
          <Block>
            <StatusText tone="bad">Couldn’t update: {error}</StatusText>
          </Block>
        )}
        <ToggleRow
          label="Check automatically"
          description="Once a day at launch. Updates are signed, and the player engine is updated along with the app."
          checked={autoCheck}
          onChange={(v) => void updateSettings({ updates_auto_check: v })}
        />
      </Group>

      <Group title="Setup">
        <Row label="Setup wizard" description="Walk through the API keys, VLC and media folders again.">
          <button onClick={() => closeSettingsAnd(() => useLibraryStore.getState().setOnboardingOpen(true))} className={BTN}>
            <RotateCcw className="h-4 w-4" /> Run again
          </button>
        </Row>
      </Group>
    </Page>
  );
}
