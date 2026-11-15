export interface LiveTransport {
  url: string;
  referrer: string;
  userAgent: string;
}

/** A channel from a web channel list: it plays in the list's own web player. */
export interface WebChannelInfo {
  url: string;
  region: string;
  quality: string;
  live: boolean;
}

export interface LiveChannel {
  id: string;
  tvgId: string;
  name: string;
  logo: string;
  group: string;
  transport: LiveTransport;
  web?: WebChannelInfo;
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
  /** `web`: a JSON channel list whose channels play in a web player. Missing means M3U. */
  kind?: 'm3u' | 'web';
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
  /** `rank` is the poll ranking (1-25, college sports) when the team is ranked. */
  teams: { id: string; name: string; abbreviation: string; score: string; color: string; logo: string; rank?: number }[];
  broadcasts: string[];
}

export interface MultiviewPane {
  playlistId: string;
  id: string;
  title: string;
  subtitle: string;
  event?: SportsEvent;
  web?: { url: string; source: string };
}

/** Multiview shows up to four channels; at most two of them can be native (M3U) channels. */
export const MULTIVIEW_MAX = 4;
export const MULTIVIEW_NATIVE_MAX = 2;

export interface LivePlayerSession {
  event?: SportsEvent;
  /** Set when the channel plays in its source's web player instead of the native one. */
  web?: { url: string; source: string };
  /** The second multiview pane. */
  multiview?: MultiviewPane;
  /** The third and fourth multiview panes. */
  more?: MultiviewPane[];
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

export interface LiveMultiviewState {
  loadId: string;
  paneId: string;
  loaded: boolean;
  paused: boolean;
  buffering: boolean;
  failed: boolean;
}
