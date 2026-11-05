type TrailerTracks = {
  videoUrl: string;
  audioUrl: string;
  videoCodec: string;
  audioCodec: string;
};

const MAX_TRACK_BYTES = 256 * 1024 * 1024;
const FIRST_RANGE_BYTES = 512 * 1024;
const RANGE_BYTES = 2 * 1024 * 1024;
const BUFFER_AHEAD = 30;
const BUFFER_BEHIND = 20;

function waitForEvent(target: EventTarget, event: string, signal: AbortSignal, start?: () => void) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(event, complete);
      target.removeEventListener('error', fail);
      target.removeEventListener('abort', fail);
      signal.removeEventListener('abort', fail);
    };
    const complete = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Trailer buffering was interrupted')); };
    if (signal.aborted) { fail(); return; }
    target.addEventListener(event, complete);
    target.addEventListener('error', fail);
    target.addEventListener('abort', fail);
    signal.addEventListener('abort', fail);
    try { start?.(); }
    catch (error) { cleanup(); reject(error); }
  });
}

async function fetchRange(url: string, offset: number, total: number | null, signal: AbortSignal) {
  const limit = offset + (offset === 0 ? FIRST_RANGE_BYTES : RANGE_BYTES) - 1;
  const response = await fetch(url, { headers: { Range: `bytes=${offset}-${limit}` }, signal });
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
  if (response.status !== 206 || !range || !response.body) throw new Error('Trailer byte range is unavailable');
  const start = Number(range[1]);
  const end = Number(range[2]);
  const size = Number(range[3]);
  if (start !== offset || end < start || end > limit || end >= size || size > MAX_TRACK_BYTES ||
    (total !== null && size !== total)) throw new Error('Invalid trailer byte range');

  const bytes = new Uint8Array(end - start + 1);
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (received + value.length > bytes.length) throw new Error('Trailer byte range exceeded its length');
      bytes.set(value, received);
      received += value.length;
    }
    if (received !== bytes.length) throw new Error('Incomplete trailer byte range');
  } finally {
    reader.releaseLock();
  }
  return { bytes, size };
}

async function appendTrack(video: HTMLVideoElement, buffer: SourceBuffer, url: string, signal: AbortSignal) {
  let offset = 0;
  let total: number | null = null;
  do {
    while (buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) - video.currentTime >= BUFFER_AHEAD) {
      await waitForEvent(video, 'timeupdate', signal);
    }
    const evictBefore = video.currentTime - BUFFER_BEHIND;
    if (buffer.buffered.length && buffer.buffered.start(0) + 5 < evictBefore) {
      await waitForEvent(buffer, 'updateend', signal, () => buffer.remove(0, evictBefore));
    }
    // Finish each small request before waiting for playback. A paused video can
    // otherwise leave an upstream request idle long enough for the relay to time out.
    const { bytes, size } = await fetchRange(url, offset, total, signal);
    await waitForEvent(buffer, 'updateend', signal, () => buffer.appendBuffer(bytes));
    offset += bytes.length;
    total = size;
  } while (offset < total);
}

/** Give fragmented H.264 and AAC tracks a shared clock in the banner's video element. */
export function attachTrailerMedia(video: HTMLVideoElement, tracks: TrailerTracks, onError: () => void) {
  const videoType = `video/mp4; codecs="${tracks.videoCodec}"`;
  const audioType = `audio/mp4; codecs="${tracks.audioCodec}"`;
  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(videoType) || !MediaSource.isTypeSupported(audioType)) {
    throw new Error('This device cannot play the trailer formats');
  }
  const source = new MediaSource();
  const controller = new AbortController();
  const { signal } = controller;
  const url = URL.createObjectURL(source);
  const dispose = () => {
    if (signal.aborted) return;
    controller.abort();
    source.removeEventListener('sourceopen', open);
    source.removeEventListener('sourceclose', dispose);
    URL.revokeObjectURL(url);
  };
  const open = async () => {
    try {
      // Each track can fetch independently. The media element waits for playable
      // data in both buffers and presents the original timestamps together.
      const picture = source.addSourceBuffer(videoType);
      const sound = source.addSourceBuffer(audioType);
      await Promise.all([
        appendTrack(video, picture, tracks.videoUrl, signal),
        appendTrack(video, sound, tracks.audioUrl, signal),
      ]);
      if (!signal.aborted && source.readyState === 'open') source.endOfStream();
    } catch {
      if (signal.aborted) return;
      dispose();
      onError();
    }
  };
  source.addEventListener('sourceopen', open, { once: true });
  source.addEventListener('sourceclose', dispose, { once: true });
  return { url, dispose };
}
