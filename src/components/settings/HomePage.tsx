import { useLibraryStore } from '../../store/useLibraryStore';
import type { TvModeSetting } from '../../lib/tvMode';
import { Group, Page, Row, Segmented, ToggleRow } from './ui';

export default function HomePage() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  return (
    <Page title="Home" description="The home screen and what you see when TruongFlix opens.">
      <Group title="Home screen">
        <ToggleRow
          label="Play trailers on the banner"
          description="After a few seconds the banner fades into the title’s muted trailer (streamed from YouTube)."
          checked={settings.trailers_autoplay}
          onChange={(v) => void updateSettings({ trailers_autoplay: v })}
        />
        <ToggleRow
          label="Preview stills on hover"
          description="Hover cards cycle through frames from your actual file."
          checked={settings.hover_stills}
          onChange={(v) => void updateSettings({ hover_stills: v })}
        />
      </Group>
      <Group
        title="TV mode"
        footer="Arrows or D-pad move · Enter/A select · Esc/Backspace/B back · X My List · Y search · LB/RB switch sections. In the player: ←/→ seek 10 s, ↑/↓ volume, A or Start play/pause, triggers seek."
      >
        <Row
          label="TV mode"
          description="Bigger cards and text, a clear focus outline and a hidden mouse cursor for the couch, a remote or a game controller. Auto turns it on when you navigate with the arrow keys or a controller."
        >
          <Segmented<TvModeSetting>
            value={settings.tv_mode}
            options={[['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]}
            onChange={(v) => void updateSettings({ tv_mode: v })}
          />
        </Row>
      </Group>
      <Group title="When the app opens">
        <ToggleRow
          label="Launch animation"
          description="A short TruongFlix intro. Click or press any key to skip it."
          checked={settings.launch_intro}
          onChange={(v) => void updateSettings({ launch_intro: v })}
        />
        {settings.launch_intro && (
          <ToggleRow
            label="Launch sound"
            description="Plays the intro sound with the animation."
            checked={settings.launch_intro_sound}
            onChange={(v) => void updateSettings({ launch_intro_sound: v })}
          />
        )}
      </Group>
    </Page>
  );
}
