import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { AudioDevice } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { listAudioDevices, setAudioDevice, setPassthrough } from '../../services/player';
import Dropdown from '../common/Dropdown';
import { Group, Page, Row, ToggleRow } from './ui';

const IS_MAC = navigator.userAgent.includes('Mac');

export default function AudioPage() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  useEffect(() => {
    void listAudioDevices(true).then(setDevices);
  }, []);
  const deviceName = (key: string) => devices.find((d) => d.name === key)?.description || key.replace(/^(coreaudio|wasapi)\//, '');
  const remembered = Object.entries(settings.audio_delays).filter(([, v]) => v !== 0);

  return (
    <Page title="Audio" description="Speakers, receivers and sound settings for the built-in player.">
      <Group title="Output">
        <Row label="Speaker" description="“System default” follows your computer’s sound output, e.g. switching to AirPods when they connect.">
          <Dropdown
            value={settings.audio_device || 'auto'}
            onChange={(v) => void setAudioDevice(v)}
            align="right"
            options={(devices.length ? devices : [{ name: 'auto', description: '' }]).map((d) => ({
              value: d.name,
              label: d.name === 'auto' ? 'System default' : d.description || d.name,
            }))}
            className="min-w-[220px]"
          />
        </Row>
        <ToggleRow
          label="Receiver passthrough"
          description={`Sends Dolby Digital, Dolby TrueHD/Atmos and DTS untouched to an AV receiver or soundbar (HDMI or optical). Volume, night mode and dialogue boost are then handled by the receiver.${
            IS_MAC ? ' On a Mac this takes exclusive use of the speaker while playing.' : ''
          }`}
          checked={settings.audio_passthrough}
          onChange={(v) => void setPassthrough(v)}
        />
      </Group>

      <Group
        title="Audio timing per speaker"
        footer="Adjust it while watching (Audio & Subtitles › Audio timing). Each speaker keeps its own value, which helps with Bluetooth lag."
      >
        {remembered.length ? (
          remembered.map(([key, value]) => (
            <Row key={key} label={deviceName(key)}>
              <span className="text-sm tabular-nums text-nf-secondary">
                {value > 0 ? '+' : ''}
                {value.toFixed(1)} s
              </span>
              <button
                onClick={() => {
                  const next = { ...settings.audio_delays };
                  delete next[key];
                  void updateSettings({ audio_delays: next });
                }}
                title="Reset to 0"
                className="flex h-8 w-8 items-center justify-center rounded text-nf-muted hover:bg-white/10 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </Row>
          ))
        ) : (
          <Row label="No adjustments yet" description="Every speaker plays in sync with the picture." />
        )}
      </Group>

      <Group title="Sound">
        <ToggleRow
          label="Dialogue boost"
          description="Lifts the centre channel on surround tracks (or speech frequencies on stereo) so voices are easier to follow."
          checked={settings.audio_dialogue}
          onChange={(v) => void updateSettings({ audio_dialogue: v })}
        />
        <ToggleRow
          label="Night mode"
          description="Evens out loudness: quiet dialogue gets louder and explosions get softer."
          checked={settings.audio_night}
          onChange={(v) => void updateSettings({ audio_night: v })}
        />
      </Group>
    </Page>
  );
}
