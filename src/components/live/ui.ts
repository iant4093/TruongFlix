import { LEAGUES } from '../../services/live';

export const button =
  'inline-flex items-center justify-center gap-2 rounded bg-white/10 px-4 py-2 text-sm font-semibold transition hover:bg-white/20 disabled:cursor-wait disabled:opacity-50';
export const leagueLabel = (league: string) => LEAGUES.find(([id]) => id === league)?.[1] ?? league;
export const timeLabel = (date: string) =>
  new Date(date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
