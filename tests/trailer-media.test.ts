import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attachTrailerMedia } from '../src/services/trailerMedia';

class BufferFixture extends EventTarget {
  buffered = { length: 0 };
  appendBuffer = vi.fn();
}

class MediaSourceFixture extends EventTarget {
  static isTypeSupported = vi.fn(() => true);
  static current: MediaSourceFixture;
  readyState = 'open';
  buffers: BufferFixture[] = [];
  endOfStream = vi.fn();

  constructor() {
    super();
    MediaSourceFixture.current = this;
  }

  addSourceBuffer() {
    const buffer = new BufferFixture();
    this.buffers.push(buffer);
    return buffer;
  }
}

const tracks = {
  videoUrl: 'http://127.0.0.1:1234/video', audioUrl: 'http://127.0.0.1:1234/audio',
  videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2',
};
const request = vi.fn<typeof fetch>();
const createObjectURL = vi.fn(() => 'blob:fixture');
const revokeObjectURL = vi.fn();

function range(start: number, end: number, total: number) {
  return new Response(new Uint8Array(end - start + 1), {
    status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${total}` },
  });
}

function openMedia() {
  const onError = vi.fn();
  const media = attachTrailerMedia(document.createElement('video'), tracks, onError);
  const source = MediaSourceFixture.current;
  source.dispatchEvent(new Event('sourceopen'));
  return { ...media, source, onError };
}

beforeEach(() => {
  vi.clearAllMocks();
  request.mockReset();
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('MediaSource', MediaSourceFixture);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
});
afterEach(() => vi.unstubAllGlobals());

it('rejects an oversized track before reading its first range', async () => {
  const response = range(0, 7, 256 * 1024 * 1024 + 1);
  request.mockResolvedValue(response);
  const { source, onError } = openMedia();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(response.bodyUsed).toBe(false);
  expect(source.buffers.every((buffer) => buffer.appendBuffer.mock.calls.length === 0)).toBe(true);
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:fixture');
});

it('fetches contiguous bounded ranges and waits for both tracks to finish appending', async () => {
  request.mockImplementation(async (url, options) => {
    if (url === tracks.audioUrl) return range(0, 0, 1);
    if (new Headers(options?.headers).get('Range') === 'bytes=0-524287') return range(0, 1, 3);
    return range(2, 2, 3);
  });
  const { source, dispose, onError } = openMedia();
  const [picture, sound] = source.buffers;
  await vi.waitFor(() => expect(picture.appendBuffer).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(sound.appendBuffer).toHaveBeenCalledOnce());
  expect(source.endOfStream).not.toHaveBeenCalled();
  sound.dispatchEvent(new Event('updateend'));
  picture.dispatchEvent(new Event('updateend'));
  await vi.waitFor(() => expect(picture.appendBuffer).toHaveBeenCalledTimes(2));
  expect(request.mock.calls.map(([, options]) => new Headers(options?.headers).get('Range'))).toEqual([
    'bytes=0-524287', 'bytes=0-524287', 'bytes=2-2097153',
  ]);
  expect(source.endOfStream).not.toHaveBeenCalled();
  picture.dispatchEvent(new Event('updateend'));
  await vi.waitFor(() => expect(source.endOfStream).toHaveBeenCalledOnce());
  expect(onError).not.toHaveBeenCalled();
  dispose();
});

it('aborts both outstanding requests and ignores their rejections when disposed', async () => {
  const signals: AbortSignal[] = [];
  request.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    const signal = options!.signal!;
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const { source, dispose, onError } = openMedia();
  expect(signals).toHaveLength(2);
  dispose();
  dispose();
  await Promise.allSettled(request.mock.results.map((result) => result.value));
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(onError).not.toHaveBeenCalled();
  expect(source.endOfStream).not.toHaveBeenCalled();
  expect(revokeObjectURL).toHaveBeenCalledOnce();
});
