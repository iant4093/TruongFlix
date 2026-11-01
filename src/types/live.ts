export interface LiveTransport {
  url: string;
  referrer: string;
  userAgent: string;
}

export interface LiveChannel {
  id: string;
  tvgId: string;
  name: string;
  logo: string;
  group: string;
  transport: LiveTransport;
}

export interface ChannelHealth {
  state: 'unknown' | 'reachable' | 'verified' | 'suspect' | 'unavailable';
  reason: string;
  checkedAt: number;
  retryAt: number;
  failures: number;
}

export interface LivePlaylist {
  id: string;
  name: string;
  input: string;
  channels: LiveChannel[];
  updatedAt: number;
  health: Record<string, ChannelHealth>;
}

export interface LivePreferences {
  playlist: string;
  favourites: string[];
  teams: string[];
  matches: Record<string, string>;
  showUnavailable: boolean;
}

export interface SportsEvent {
  id: string;
  name: string;
  league: string;
  sport: string;
  date: string;
  status: 'live' | 'upcoming' | 'finished';
  detail: string;
  teams: { id: string; name: string; abbreviation: string; score: string; color: string; logo: string }[];
  broadcasts: string[];
}

export interface LivePlayerSession {
  event?: SportsEvent;
  channels?: { playlistId: string; id: string }[];
  loadId?: string;
  target: { type: 'live'; id: string; playlistId: string; label: string };
  itemKey: null;
  title: string;
  subtitle: string | null;
  overview: string | null;
  logo: null;
  next: null;
  nextLabel: null;
}
