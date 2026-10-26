import { Users } from 'lucide-react';
import type { Profile } from '../../types/media';
import { useLibraryStore } from '../../store/useLibraryStore';
import { MATURITY_LABEL } from '../../store/selectors';
import ProfileAvatar from '../common/ProfileAvatar';
import { BTN, Group, Page, Row, ToggleRow } from './ui';
import { closeSettingsAnd } from './nav';

function summary(p: Profile) {
  const parts: string[] = [MATURITY_LABEL[p.maturity]];
  if (p.daily_limit) parts.push(p.daily_limit >= 60 ? `${p.daily_limit / 60} h a day` : `${p.daily_limit} min a day`);
  if (p.bedtime) parts.push(`bedtime ${p.bedtime}–${p.wake_time || '07:00'}`);
  if (p.pin) parts.push('PIN lock');
  return parts.join(' · ');
}

export default function ProfilesPage() {
  const settings = useLibraryStore((s) => s.settings);
  const updateSettings = useLibraryStore((s) => s.updateSettings);
  const profiles = useLibraryStore((s) => s.profiles);
  const active = useLibraryStore((s) => s.activeProfile);
  const manage = () => closeSettingsAnd(() => useLibraryStore.getState().setProfileGate('manage'));

  return (
    <Page title="Profiles" description="Separate Continue Watching, My List and history for each person, plus age ratings and limits for kids.">
      <Group title="Profiles">
        {profiles.map((p) => (
          <Row
            key={p.id}
            label={
              <span className="flex items-center gap-3">
                <ProfileAvatar color={p.color} maturity={p.maturity} size={28} />
                {p.name}
                {p.id === active?.id && <span className="text-xs font-normal text-nf-muted">(you)</span>}
              </span>
            }
            description={<span className="pl-10">{summary(p)}</span>}
          />
        ))}
        <Row label="Add or edit profiles" description="Name, colour, age rating, daily viewing limit, bedtime and PIN.">
          <button onClick={manage} className={BTN}>
            <Users className="h-4 w-4" /> Manage profiles
          </button>
        </Row>
      </Group>
      <Group title="At launch">
        <ToggleRow
          label="Ask who’s watching"
          description="Shows the profile picker when the app opens (when there’s more than one profile). PIN-locked profiles always ask for their PIN."
          checked={settings.ask_profile}
          onChange={(v) => void updateSettings({ ask_profile: v })}
        />
      </Group>
    </Page>
  );
}
