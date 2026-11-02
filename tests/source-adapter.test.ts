import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const adapter = readFileSync('src-tauri/src/source_browser/adapter.js', 'utf8');
const config = { requestId: 'fixture-request', imdbId: 'tt1234567' };
let messages: { kind: string; releases?: { id: string; title: string; seeders: number }[] }[];
beforeEach(() => {
  messages = [];
  document.title = 'Torrents with IMDb ID:1234567 (1 Results)';
  document.body.innerHTML = `<table><thead><tr><th>TORRENT NAME</th><th>SIZE</th><th>FILES</th><th>AGE</th><th>SEEDS</th><th>LEECHS</th></tr></thead><tbody><tr><td><a href="/example-film-1/" title="Example Film 2024 1080p">Example Film 2024 1080p</a><a class="search-magnet-btn" href="javascript:void(0);" data-id="123">Download</a></td><td>1.5 GB</td><td>3</td><td>1 day ago</td><td>1,234</td><td>10</td><td>Source</td></tr></tbody></table>`;
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });
function run(url = 'https://source.example/browse/?imdb_id=tt1234567', platform: 'mac' | 'windows' = 'mac') {
  const window = { top: null as unknown, self: null as unknown,
    webkit: platform === 'mac' ? { messageHandlers: { truongflixSource: { postMessage: (data: string) => messages.push(JSON.parse(data)) } } } : undefined,
    chrome: platform === 'windows' ? { webview: { postMessage: (data: string) => messages.push(JSON.parse(data)) } } : undefined };
  window.top = window; window.self = window;
  const location = { get href() { return url; }, set href(_: string) { throw new Error('The adapter must not navigate the page'); } };
  runInNewContext(adapter.replace('__SOURCE_CONFIG__', JSON.stringify(config)), {
    window, document, location, URL, setTimeout: () => 0, clearTimeout: () => {}, MutationObserver: class { observe() {} },
  });
}
it.each(['mac', 'windows'] as const)('collects rendered releases over the %s message channel without navigation', (platform) => {
  run(undefined, platform);
  expect(messages).toMatchObject([{ requestId: config.requestId, kind: 'results', page: 1, releases: [{ id: '123', title: 'Example Film 2024 1080p', seeders: 1234, size: '1.5 GB', imdbId: config.imdbId }] }]);
});
it('leaves security verification pages untouched', () => {
  document.title = 'Just a moment...'; const html = document.body.innerHTML; run(); expect(messages).toMatchObject([{ kind: 'challenge' }]); expect(document.body.innerHTML).toBe(html);
});
it('does not attribute results from another title to the selected title', () => {
  run('https://source.example/browse/?imdb_id=tt9999999'); expect(messages.filter((m) => m.kind === 'results')).toEqual([]);
});
it('rejects malformed release ids instead of invoking arbitrary page elements', () => {
  document.querySelector('.search-magnet-btn')!.setAttribute('data-id', '1] script'); run();
  expect(messages.filter((m) => m.kind === 'results')).toEqual([]);
});
it('reports an empty result page promptly instead of leaving a quick search waiting', () => {
  document.body.innerHTML = '<p>No torrents found</p>'; document.title = 'Torrents (0 Results)'; run();
  expect(messages).toMatchObject([{ kind: 'results', releases: [] }]);
});
it('uses named columns when a source adds a leading table column', () => {
  document.querySelector('thead tr')!.insertAdjacentHTML('afterbegin', '<th>Extra</th>');
  document.querySelector('tbody tr')!.insertAdjacentHTML('afterbegin', '<td>Other data</td>');
  run(); expect(messages[0].releases?.[0].seeders).toBe(1234);
});
it('does not invent seed counts when the source layout is unrecognized', () => {
  document.querySelector('thead')!.remove(); run();
  expect(messages[0].releases?.[0].seeders).toBeNull();
});
it('uses the release link instead of a category icon or author link', () => {
  const cell = document.querySelector('tbody td')!;
  cell.insertAdjacentHTML('afterbegin', '<a href="/browse/?cat=1">local_movies</a>');
  cell.insertAdjacentHTML('beforeend', '<a href="/user/long-author-name/">A very long uploader name</a>');
  run(); expect(messages[0].releases?.[0].title).toBe('Example Film 2024 1080p');
});
it('handles a title column that spans two logical columns', () => {
  document.querySelector('thead th')!.setAttribute('colspan', '2');
  document.querySelector('tbody td')!.setAttribute('colspan', '2');
  run(); expect(messages[0].releases?.[0].seeders).toBe(1234);
});

it('ignores hidden responsive labels inside seed and size cells', () => {
  const cells = document.querySelectorAll('tbody td');
  cells[1].innerHTML = '<div class="add-block-wrapper"><span class="add-block">Size</span><span>1.5 GB</span></div>';
  cells[4].innerHTML = '<div class="add-block-wrapper"><span class="add-block">Seeds</span><span class="text-success">1,234</span></div>';
  run();
  expect(messages[0].releases?.[0]).toMatchObject({ seeders: 1234, size: '1.5 GB' });
});
