import { useLibraryStore } from '../../store/useLibraryStore';
import { Group, Page, ToggleRow } from './ui';

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
