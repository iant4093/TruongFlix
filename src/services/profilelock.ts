import { useLibraryStore } from '../store/useLibraryStore';
import { adultPinRequired } from './limits';

/** Switches profile, asking for that profile's PIN first when it has one. */
export function switchProfileGuarded(id: number) {
  const { profiles, activeProfile, switchProfile, setPinRequest, profileGate } = useLibraryStore.getState();
  const target = profiles.find((p) => p.id === id);
  if (!target) return;
  // At the "Who's watching?" screen the current profile hasn't been confirmed yet.
  const alreadyIn = target.id === activeProfile?.id && !profileGate;
  if (!target.pin || alreadyIn) return void switchProfile(id);
  setPinRequest({
    title: `Enter ${target.name}’s PIN`,
    subtitle: 'This profile is locked.',
    check: (pin) => pin === target.pin,
    then: () => void switchProfile(id),
  });
}

/**
 * Runs `action` (open Settings, manage profiles…) — asking for a parent's PIN when a kids/teen
 * profile is active, or always at the profile screen, if any adult profile has a PIN.
 */
export function guardAdult(action: () => void, opts: { atGate?: boolean } = {}) {
  const { profiles, activeProfile, setPinRequest } = useLibraryStore.getState();
  const adults = profiles.filter((p) => p.maturity === 'all' && p.pin);
  const needed = opts.atGate ? adults.length > 0 : adultPinRequired(profiles, activeProfile);
  if (!needed) return action();
  setPinRequest({
    title: 'Enter a parent’s PIN',
    subtitle: adults.length === 1 ? `${adults[0].name}’s profile PIN` : 'The PIN of any adult profile',
    check: (pin) => adults.some((p) => p.pin === pin),
    then: action,
  });
}
