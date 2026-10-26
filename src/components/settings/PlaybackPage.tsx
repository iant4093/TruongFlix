import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import type { EngineStatus } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { engineStatus } from '../../services/player';
import { startBackgroundAnalysis } from '../../services/enrich';
import Dropdown from '../common/Dropdown';
import { VlcSetup } from '../common/SetupControls';
import { Block, BTN, Group, Page, Row, StatusText, ToggleRow } from './ui';

export default function PlaybackPage() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  useEffect(() => {
    void engineStatus().then(setStatus);
  }, []);
  const mpv = status?.mpv_version?.replace(/^mpv\s*v?/i, '');
  const ffmpeg = status?.ffmpeg_version?.replace(/^n?(\d+(\.\d+)*).*/, '$1');

  return (
    <Page title="Playback" description="The player, skipping intros, and what happens between episodes.">
      <Group title="Player">
        <Row
          label="Play with"
          description={
            !status ? (
              'Checking the built-in player…'
            ) : status.available ? (
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-nf-green" /> Built-in player ready · mpv {mpv} · FFmpeg {ffmpeg}
              </span>
            ) : (
              <StatusText tone="warn">Built-in player unavailable: {status.reason} VLC is used instead.</StatusText>
            )
          }
        >
          <Dropdown
            value={settings.player_engine}
            onChange={(v) => void updateSettings({ player_engine: v })}
            align="right"
            options={[
              { value: 'builtin', label: 'Built-in player', hint: status && !status.available ? 'unavailable' : undefined },
              { value: 'vlc', label: 'VLC (external)' },
            ]}
            className="min-w-[200px]"
          />
        </Row>
        <Row label="VLC" description="Used when VLC is chosen above, for “Open in VLC” in the player, and if the built-in player can’t start." stacked>
          <VlcSetup value={settings.vlc_executable_path} onChange={(p) => void updateSettings({ vlc_executable_path: p })} />
        </Row>
      </Group>

      <Group title="Skip intro">
        <ToggleRow
          label="Find intros automatically"
          description="Uses chapter markers when a file has them, otherwise compares the opening minutes of a season’s episodes to find the theme song they share."
          checked={settings.intro_detection}
          onChange={async (v) => {
            await updateSettings({ intro_detection: v });
            if (v) void startBackgroundAnalysis();
          }}
        />
        <ToggleRow
          label="Skip intros automatically"
          description="Jumps past intros without pressing Skip Intro. Recaps still show a button."
          checked={settings.skip_intro_auto}
          onChange={(v) => void updateSettings({ skip_intro_auto: v })}
        />
        <AnalysisStatus />
      </Group>

      <Group title="Between episodes">
        <Row label="Ask “Are you still watching?”" description="Pauses after several episodes play in a row without a key press, click or media button.">
          <Dropdown
            value={settings.still_watching_after}
            onChange={(v) => void updateSettings({ still_watching_after: v })}
            align="right"
            options={[
              { value: 0, label: 'Never' },
              { value: 2, label: 'After 2 episodes' },
              { value: 3, label: 'After 3 episodes' },
              { value: 4, label: 'After 4 episodes' },
              { value: 5, label: 'After 5 episodes' },
            ]}
            className="min-w-[170px]"
          />
        </Row>
        <ToggleRow
          label="Pause when the screen locks"
          description="Also when the display or the computer goes to sleep, such as closing a laptop lid."
          checked={settings.pause_on_lock}
          onChange={(v) => void updateSettings({ pause_on_lock: v })}
        />
      </Group>
    </Page>
  );
}

function AnalysisStatus() {
  const analysis = useLibraryStore((s) => s.analysis);
  const episodes = useLibraryStore((s) => s.episodes);
  const withIntro = episodes.filter((e) => e.segments?.includes('"intro"')).length;
  return (
    <Block className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-xs text-nf-muted">
        {analysis.running ? (
          <span className="flex items-center gap-1.5 text-nf-secondary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {analysis.message}
          </span>
        ) : (
          `Intros found for ${withIntro} of ${episodes.length} episode${episodes.length === 1 ? '' : 's'}`
        )}
      </span>
      {!analysis.running && (
        <button onClick={() => void startBackgroundAnalysis()} className={BTN}>
          <RefreshCw className="h-4 w-4" /> Analyze now
        </button>
      )}
    </Block>
  );
}
