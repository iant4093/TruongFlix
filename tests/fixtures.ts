import type { MovieRow, TorrentRecord, TorrentStatus } from '../src/types/media';

export const movie = {
  id: 1, tmdb_id: null, title: 'Sintel', year: 2010,
  file_path: '/Movies/Sintel/Sintel.mp4', raw_filename: 'Sintel.mp4', file_mtime: 1,
  file_size: 262144, runtime: null, progress_seconds: 60, duration_seconds: 0,
  watched: 0, my_list: 0, last_watched_at: null, created_at: '2026-10-01',
  resolution: null, video_codec: null, hdr_format: null, audio_codec: null,
  media_info: null, genres: '[]', cast_crew: '[]',
} as MovieRow;

export function torrentRecord(patch: Partial<TorrentRecord> = {}): TorrentRecord {
  return {
    info_hash: 'abc123', name: 'Sintel', source: 'magnet:?xt=urn:btih:abc123', mode: 'download',
    save_path: '/Movies/Sintel', delete_on_complete: 0, cache_hours: null, expires_at: null,
    media_kind: 'movie', tmdb_id: null, series_id: null, movie_id: 1,
    file_paths: JSON.stringify([movie.file_path]), total_bytes: 262144, completed_at: null,
    seeding_stopped: 0, created_at: '2026-10-01', ...patch,
  };
}

export function torrentStatus(patch: Partial<TorrentStatus> = {}): TorrentStatus {
  return {
    info_hash: 'abc123', name: 'Sintel', state: 'seeding', progress_bytes: 262144, total_bytes: 262144,
    uploaded_bytes: 0, progress_pct: 100, download_speed_bps: 0, upload_speed_bps: 1024,
    eta_secs: null, peers_live: 1, peers_connecting: 0, peers_seen: 1, finished: true,
    paused: false, error: null, output_folder: '/Movies/Sintel', listen_port: null,
    files: [{ index: 0, name: 'Sintel.mp4', relative_path: 'Sintel.mp4', full_path: movie.file_path,
      size: 262144, downloaded_bytes: 262144, included: true, is_video: true }], ...patch,
  };
}
