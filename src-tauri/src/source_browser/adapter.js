// Executed only in the isolated source window. The bridge carries untrusted release data;
// it grants no access to Tauri IPC, files, the library, or the torrent engine.
(() => {
  if (window.top !== window.self) return;
  const config = __SOURCE_CONFIG__;
  const send = (event) => {
    const message = JSON.stringify({ ...event, requestId: config.requestId });
    if (window.webkit?.messageHandlers?.truongflixSource) window.webkit.messageHandlers.truongflixSource.postMessage(message);
    else window.chrome?.webview?.postMessage(message);
  };
  let previous = '';
  let cosmetics = '';
  let cosmeticTimer;
  let lastPage = '';
  let challengeReported = false;
  const isChallenge = () => /just a moment|security verification|attention required/i.test(document.title)
    || !!document.querySelector('#challenge-running, #challenge-stage, form#challenge-form');
  const collect = () => {
    if (isChallenge()) { if (!challengeReported) { challengeReported = true; send({ kind: 'challenge' }); } return; }
    const current = new URL(location.href);
    const imdb = current.searchParams.get('imdb_id');
    if (imdb !== config.imdbId) return;
    const rows = [...document.querySelectorAll('.search-magnet-btn[data-id]')].slice(0, 100).flatMap((button) => {
      const row = button.closest('tr');
      const cells = row ? [...row.querySelectorAll(':scope > td')] : [];
      if (cells.length < 6) return [];
      const titleCell = button.closest('td') || cells[0];
      const links = [...titleCell.querySelectorAll('a[href]:not([href^="javascript:"]):not(.search-magnet-btn)')];
      const titleLink = links.find((link) => {
        try {
          const raw = link.getAttribute('href');
          const url = new URL(raw, current);
          return !raw.startsWith('#') && url.origin === current.origin && !/^\/(?:browse|advanced|users?|profile|search)(?:\/|$)|^\/$/.test(url.pathname);
        } catch { return false; }
      }) || links.find((link) => !/^(?:IMDb|local_movies|movie|play_arrow|file_download)$/i.test(link.textContent.trim()));
      const title = (titleLink?.textContent || button.getAttribute('data-name') || titleLink?.getAttribute('title') || '').trim();
      if (title) { button.setAttribute('role', 'button'); button.setAttribute('tabindex', '0'); button.setAttribute('aria-label', `Download torrent: ${title}`); }
      const expand = (items) => items.flatMap((cell) => Array(Math.min(cell.colSpan || 1, 20)).fill(cell));
      const header = row.closest('table').querySelector('thead tr') || row.closest('table').querySelector('tr');
      const headers = expand([...header.children].filter((cell) => /^(TH|TD)$/.test(cell.tagName)));
      const values = expand(cells);
      const seedIndex = headers.findIndex((cell) => /\b(?:seeds|seeders)\b/i.test(cell.textContent));
      const sizeIndex = headers.findIndex((cell) => /\bsize\b/i.test(cell.textContent));
      // Responsive labels remain in textContent even when the desktop layout hides them.
      const cellText = (cell) => {
        if (!cell) return '';
        const copy = cell.cloneNode(true);
        copy.querySelectorAll('.add-block').forEach((label) => label.remove());
        return copy.textContent.trim();
      };
      const count = cellText(values[seedIndex]).replace(/,/g, '');
      const seedMatch = count.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
      const seeders = seedMatch ? Math.round(Number(seedMatch[1]) * ({ k: 1000, m: 1000000, b: 1000000000 }[seedMatch[2]?.toLowerCase()] || 1)) : null;
      return /^\d+$/.test(button.dataset.id || '') && title ? [{
        id: button.dataset.id, title: title.slice(0, 600), imdbId: imdb,
        seeders, size: cellText(values[sizeIndex]).slice(0, 80),
      }] : [];
    });
    const noResults = /(?:\(|\b)0\s+results\b/i.test(document.title);
    if (!rows.length && !noResults) return;
    const key = JSON.stringify(rows);
    if (key === previous && lastPage === current.href) return;
    previous = key;
    lastPage = current.href;
    send({ kind: 'results', releases: rows, page: Number(current.searchParams.get('page') || 1) });
  };
  const clean = () => {
    if (isChallenge()) return;
    const elements = [...document.querySelectorAll('[class],[id]')].slice(0, 5000);
    const classes = [...new Set(elements.flatMap((e) => [...e.classList]))].slice(0, 3000);
    const ids = [...new Set(elements.map((e) => e.id).filter(Boolean))].slice(0, 3000);
    const key = JSON.stringify([classes, ids]);
    if (key === cosmetics) return;
    cosmetics = key;
    send({ kind: 'cosmetic', classes, ids });
  };
  const start = () => {
    let timer;
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(collect, 200); clearTimeout(cosmeticTimer); cosmeticTimer = setTimeout(clean, 350); })
      .observe(document.documentElement, { childList: true, subtree: true });
    collect();
    cosmeticTimer = setTimeout(clean, 350);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
