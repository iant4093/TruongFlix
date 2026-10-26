import type { Profile } from '../types/media';
import { secondsWatchedToday } from './db';

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
};

/** Inside the profile's bedtime window (which may run past midnight). */
export function inBedtime(profile: Pick<Profile, 'bedtime' | 'wake_time'>, now = new Date()): boolean {
  const start = profile.bedtime ? minutesOf(profile.bedtime) : null;
  const end = minutesOf(profile.wake_time || '07:00');
  if (start == null || end == null || start === end) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export interface LimitStatus {
  blocked: 'bedtime' | 'limit' | null;
  /** Seconds of viewing left today (null = no daily limit). */
  remaining: number | null;
}

/** `unsaved`: seconds watched in this session that aren't in the log yet. */
export async function limitStatus(profile: Profile | null, unsaved = 0): Promise<LimitStatus> {
  if (!profile) return { blocked: null, remaining: null };
  if (inBedtime(profile)) return { blocked: 'bedtime', remaining: null };
  if (!profile.daily_limit) return { blocked: null, remaining: null };
  const used = (await secondsWatchedToday(profile.id)) + unsaved;
  const remaining = Math.max(0, profile.daily_limit * 60 - used);
  return { blocked: remaining <= 0 ? 'limit' : null, remaining };
}

export const formatLeft = (seconds: number) => {
  const m = Math.ceil(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${m} min`;
};

export const blockedMessage = (profile: Profile, why: 'bedtime' | 'limit') =>
  why === 'bedtime'
    ? `It’s past bedtime for ${profile.name}. TruongFlix will be ready again at ${profile.wake_time || '07:00'}.`
    : `That’s all the TV for ${profile.name} today. See you tomorrow!`;

/** A kids/teen profile is active and some adult profile has a PIN: adult actions need that PIN. */
export function adultPinRequired(profiles: Profile[], active: Profile | null) {
  return !!active && active.maturity !== 'all' && profiles.some((p) => p.maturity === 'all' && p.pin);
}
