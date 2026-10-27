import { useState } from 'react';
import type { SubtitleStyle } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { OpenSubtitlesFields, type SubtitleSettingsValue } from '../common/SetupControls';
import { Loader2, RefreshCw } from 'lucide-react';
import { runAutoSubtitles } from '../../services/autosubs';
import { languageName } from '../../services/subtitles';
import { Block, BTN, BTN_PRIMARY, Group, Page, Row, Segmented, StatusText, ToggleRow } from './ui';

const PREVIEW_SIZE: Record<SubtitleStyle['size'], string> = { small: '13px', medium: '16px', large: '20px', xlarge: '25px' };
const PREVIEW_COLOR: Record<SubtitleStyle['color'], string> = { white: '#fff', yellow: '#FFE600', cyan: '#3DE1FF', green: '#4CFF6B', magenta: '#FF5CF2' };
const PREVIEW_FONT: Record<SubtitleStyle['font'], string> = { sans: '"Helvetica Neue", "Segoe UI", sans-serif', serif: 'Georgia, serif', mono: 'Menlo, Consolas, monospace' };

export default function SubtitlesPage() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const toast = useLibraryStore((s) => s.toast);
  const style = settings.subtitle_style;
  const set = (patch: Partial<SubtitleStyle>) => void updateSettings({ subtitle_style: { ...style, ...patch } });

  const [subs, setSubs] = useState<SubtitleSettingsValue>({
    apiKey: settings.opensubtitles_api_key,
    language: settings.subtitle_language,
    username: settings.opensubtitles_username,
    password: settings.opensubtitles_password,
  });
  const dirty =
    subs.apiKey.trim() !== settings.opensubtitles_api_key ||
    subs.language !== settings.subtitle_language ||
    subs.username.trim() !== settings.opensubtitles_username ||
    subs.password !== settings.opensubtitles_password;
  const save = async () => {
    await updateSettings({
      opensubtitles_api_key: subs.apiKey.trim(),
      subtitle_language: subs.language,
      opensubtitles_username: subs.username.trim(),
      opensubtitles_password: subs.password,
    });
    toast(subs.apiKey.trim() ? 'Subtitle settings saved' : 'Subtitle downloads turned off', 'success');
  };

  const bg = style.background;
  const textShadow = bg === 'none' ? '0 0 2px #000, 0 0 2px #000' : bg === 'shadow' ? '0 0 3px #000, 0 0 3px #000, 2px 2px 3px rgba(0,0,0,0.8)' : 'none';
  const boxBg = bg === 'translucent' ? 'rgba(0,0,0,0.62)' : bg === 'solid' ? '#000' : 'transparent';

  return (
    <Page title="Subtitles" description="How subtitles look in the built-in player, and where to download them.">
      <Group title="Appearance" footer="Applies to text subtitles (SRT and similar), even while playing. Styled and image subtitles keep their own look.">
        <Block>
          <div className="relative flex h-36 items-end justify-center overflow-hidden rounded-md bg-[linear-gradient(135deg,#355c7d,#6c5b7b_45%,#c06c84)] pb-5">
            <span
              className="px-1.5 font-semibold leading-snug"
              style={{ fontSize: PREVIEW_SIZE[style.size], color: PREVIEW_COLOR[style.color], fontFamily: PREVIEW_FONT[style.font], textShadow, background: boxBg }}
            >
              This is how your subtitles will look.
            </span>
          </div>
        </Block>
        <Row label="Size">
          <Segmented value={style.size} onChange={(size) => set({ size })} options={[['small', 'S'], ['medium', 'M'], ['large', 'L'], ['xlarge', 'XL']]} />
        </Row>
        <Row label="Colour">
          <Segmented
            value={style.color}
            onChange={(color) => set({ color })}
            options={[['white', 'White'], ['yellow', 'Yellow'], ['cyan', 'Cyan'], ['green', 'Green'], ['magenta', 'Pink']]}
          />
        </Row>
        <Row label="Background">
          <Segmented
            value={style.background}
            onChange={(background) => set({ background })}
            options={[['none', 'None'], ['shadow', 'Shadow'], ['translucent', 'Box'], ['solid', 'Solid']]}
          />
        </Row>
        <Row label="Font">
          <Segmented value={style.font} onChange={(font) => set({ font })} options={[['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']]} />
        </Row>
      </Group>

      <AutoDownloads />

      <Group
        title="Downloads · OpenSubtitles"
        footer={settings.opensubtitles_api_key ? 'Search from any title page, or from the player.' : 'Subtitle search is off until an API key is added.'}
      >
        <Row
          label="Account"
          description="An API key turns on subtitle search. Signing in to a free account raises the daily download limit."
          stacked
        >
          <OpenSubtitlesFields value={subs} onChange={(patch) => setSubs((s) => ({ ...s, ...patch }))} showAccount />
          {dirty && (
            <button onClick={() => void save()} className={`${BTN_PRIMARY} mt-3`}>
              Save
            </button>
          )}
        </Row>
      </Group>
    </Page>
  );
}

function AutoDownloads() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const enabled = !!settings.opensubtitles_api_key;
  const run = async () => {
    setBusy(true);
    setResult(null);
    const r = await runAutoSubtitles(true);
    setBusy(false);
    setResult(r.message);
  };
  return (
    <Group
      title="Automatic downloads"
      footer={`Works through the titles missing ${languageName(settings.subtitle_language || 'en')} subtitles (see Library Health), in-progress ones first, within OpenSubtitles’ daily allowance.`}
    >
      <ToggleRow
        label="Download missing subtitles automatically"
        description={enabled ? 'Runs quietly after scans and at launch, never while you’re watching.' : 'Needs an OpenSubtitles API key (below).'}
        checked={settings.subtitles_auto}
        onChange={(v) => {
          void updateSettings({ subtitles_auto: v });
          if (v && enabled) void run();
        }}
      />
      <ToggleRow
        label="Fix the timing of inexact matches"
        description="When the subtitle isn’t made for your exact file, it’s lined up with the dialogue after downloading."
        checked={settings.subtitles_auto_sync}
        onChange={(v) => void updateSettings({ subtitles_auto_sync: v })}
      />
      <Row
        label="Run now"
        description={
          result ? (
            <StatusText tone="muted">{result}</StatusText>
          ) : settings.subtitles_auto_paused ? (
            `Daily allowance ran out on ${settings.subtitles_auto_paused}.`
          ) : (
            'Checks your library for missing subtitles right away.'
          )
        }
      >
        <button onClick={() => void run()} disabled={busy || !enabled} className={BTN}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Run now
        </button>
      </Row>
    </Group>
  );
}
