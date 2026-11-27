// Reads a whole playlist from its public Spotify or Apple Music page by scrolling it, as a person
// would: the page's own code loads more songs as it scrolls. Each row's song is read from what's
// on screen, and sent back to the app in batches by "navigating" to a made-up address the app
// intercepts and cancels (nothing leaves the computer, and the page itself is never changed).
(() => {
  const CONFIG = __READER_CONFIG__;
  if (location.hostname !== CONFIG.host || window.__truongflixReader) return;
  window.__truongflixReader = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clock = (text) => {
    const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec((text || '').trim());
    if (!m) return null;
    return (m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2]) * 1000;
  };
  const text = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const spotifyRows = () =>
    [...document.querySelectorAll('[data-testid="tracklist-row"]')].map((row) => {
      const at = Number(row.closest('[aria-rowindex]')?.getAttribute('aria-rowindex'));
      const link = row.querySelector('a[href*="/track/"]')?.getAttribute('href') ?? '';
      const times = [...row.querySelectorAll('[aria-colindex]')].map(text).reverse();
      return {
        at,
        id: /\/track\/([A-Za-z0-9]{22})/.exec(link)?.[1] ?? null,
        title: text(row.querySelector('[data-testid="internal-track-link"]')),
        artists: [...row.querySelectorAll('a[href*="/artist/"]')].map(text).filter(Boolean),
        album: text(row.querySelector('a[href*="/album/"]')) || null,
        lengthMs: clock(times.find((t) => clock(t) != null)),
        explicit: !!row.querySelector('[aria-label="Explicit"]'),
      };
    });

  const appleRows = () =>
    [...document.querySelectorAll('[data-testid="track-list-item"]')].map((row) => {
      const link = row.querySelector('a[href*="/song/"]')?.getAttribute('href') ?? '';
      return {
        // A row without its number can't be placed (Number(null) would make it row 0).
        at: row.hasAttribute('data-row') ? Number(row.getAttribute('data-row')) : NaN,
        id: /\/song\/[^/]*\/(\d+)/.exec(link)?.[1] ?? /[?&]i=(\d+)/.exec(link)?.[1] ?? null,
        title: text(row.querySelector('[data-testid="track-title"]')),
        artists: [...row.querySelectorAll('[data-testid="track-title-by-line"] a[href*="/artist/"]')].map(text).filter(Boolean),
        album: text(row.querySelector('a[href*="/album/"]')) || null,
        lengthMs: clock(text(row.querySelector('[data-testid="track-duration"]'))),
        explicit: !!row.querySelector('[data-testid="explicit-badge"]'),
      };
    });

  const rows = CONFIG.service === 'spotify' ? spotifyRows : appleRows;

  // Messages to the app, one at a time: each waits until the app says it has it. Each carries the
  // key the app gave this page, so nothing else can pose as the reader.
  let acked = -1;
  let next = 0;
  window.__truongflixAck = (n) => {
    acked = Math.max(acked, n);
  };
  const send = async (kind, payload) => {
    const n = next++;
    const address = `https://truongflix-reader.invalid/${kind}?n=${n}&k=${CONFIG.key}#${encodeURIComponent(JSON.stringify(payload))}`;
    for (let attempt = 0; attempt < 6 && acked < n; attempt++) {
      try {
        location.href = address;
      } catch {
        // A cancelled navigation can throw in some engines; the ack decides.
      }
      for (let i = 0; i < 20 && acked < n; i++) await sleep(50);
    }
    return acked >= n;
  };

  // The element that scrolls the track list (the window itself on Apple Music).
  const scroller = () => {
    const row = document.querySelector('[data-testid="tracklist-row"], [data-testid="track-list-item"]');
    for (let el = row?.parentElement; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 50) return el;
    }
    return document.scrollingElement || document.documentElement;
  };

  const run = async () => {
    // The list takes a moment to appear.
    for (let i = 0; i < 100 && !rows().length; i++) await sleep(200);
    if (!rows().length) {
      await send('error', { message: 'The playlist page didn’t show any songs (is it private?)' });
      return;
    }
    const found = new Map();
    let unsent = [];
    let still = 0;
    let complete = false;
    const started = Date.now();
    while (Date.now() - started < CONFIG.limitMs) {
      const before = found.size;
      for (const song of rows()) {
        if (!song.title || !Number.isFinite(song.at) || found.has(song.at)) continue;
        found.set(song.at, song);
        unsent.push(song);
      }
      // A batch the app didn't take is kept and sent again with the next.
      if (unsent.length >= 100 && (await send('songs', unsent))) unsent = [];
      still = found.size === before ? still + 1 : 0;
      // Nothing new for a while, at the bottom of the list: that's the whole playlist.
      if (still >= 24) {
        complete = true;
        break;
      }
      const list = scroller();
      const all = document.querySelectorAll('[data-testid="tracklist-row"], [data-testid="track-list-item"]');
      all[all.length - 1]?.scrollIntoView({ block: 'end' });
      list.scrollTop = list.scrollTop + Math.max(400, list.clientHeight * 0.8);
      await sleep(350);
    }
    if (unsent.length && !(await send('songs', unsent))) complete = false;
    // The app compares the count with what reached it.
    await send('done', { count: found.size, complete });
  };

  const start = () => void run().catch((e) => send('error', { message: String(e?.message ?? e) }));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
