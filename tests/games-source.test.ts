import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import {
  SourceError,
  fetchGame,
  fetchNewest,
  fetchPopular,
  mainCategory,
  parsePost,
  resetSourceCache,
  searchGames,
  unwrapImage,
} from '../src/games/source';

const ORIGIN = 'https://games.example';
const mockInvoke = vi.mocked(invoke);

const CONTENT = `<h3><span style="color: #339966;">#6942 Updated</span> <strong>Arma Reforger: Deluxe Edition <span style="color: #808080;">v1.9.0.37 + 4 DLCs/Bonuses</span></strong></h3>
<p style="height: 200px; display: block;"><a target="_blank" href="https://info.example/games/arma-reforger/" rel="noopener"><img decoding="async" class="alignleft" width="150" src="https://img.example/out/2026/06/21/83252d.jpg" /></a><br />
Genres/Tags: <a href="https://games.example/tag/action/">Action</a>, <a href="https://games.example/tag/tactical-shooter/">Tactical shooter</a><br />
Company: <strong>Bohemia Interactive</strong><br />
Languages: <strong>RUS/ENG/MULTI13</strong><br />
Original Size: <strong>30 GB</strong><br />
Repack Size: <strong>from 14.3 GB</strong> [Selective Download]
<p></p>
<h3>Download Mirrors (Direct Links)</h3> <ul><li><a href="https://host.example/x">Host</a></li></ul>
<h3>Download Mirrors (Torrent)</h3>
<ul>
<li><a href="https://tracker.example/torrent/1/" target="_blank">Site</a> | [<a href="magnet:?xt=urn:btih:7BF66F3D8CF409972317B20BF7ED842AD1903F68&#038;dn=Arma&#038;tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce">magnet</a>] [<a href="https://paste.example/?x#y">.torrent file only</a>]</li>
<li><a href="https://other.example/t/2">Other</a> [<a href="magnet:?xt=urn:btih:7bf66f3d8cf409972317b20bf7ed842ad1903f68&#038;dn=other">magnet</a>]</li>
</ul>
<h3>Screenshots (Click to enlarge)</h3>
<p><a target="_blank" href="https://info.example/s/34/"><img decoding="async" style="width: 178px !important; height: 100px !important" src="http://shots.example/data/6d/d1/6dd18dc6.jpg.240p.jpg"></a><a href="https://info.example/s/35/"><img src="http://shots.example/data/b1/4e/b14e15fc.jpg.240p.jpg"></a><br />
<a href="https://info.example/v"><video><source src="https://video.example/x.webm" type="video/webm"></video></a></p>
<h3>Repack Features</h3>
<ul>
<li>Based on Arma.Reforger ISO release
<li>Game version: v1.9.0.37; 4 DLCs/Bonuses are included
<li>100% Lossless &#038; MD5 Perfect: all files are identical to originals after installation
</ul>
<div class="su-spoiler su-spoiler-style-fancy"><div class="su-spoiler-title" tabindex="0" role="button"><span class="su-spoiler-icon"></span>Game Description</div><div class="su-spoiler-content su-u-clearfix su-u-trim">
Arma Reforger deploys you into an authentic Cold War   military sandbox.</p>
<p>Arma Reforger is the latest installment.</p></div></div>`;

const POST = {
  id: 6942,
  slug: 'arma-reforger',
  link: 'https://games.example/arma-reforger/',
  date: '2026-06-21T10:00:00',
  title: { rendered: 'Arma Reforger: Deluxe Edition &#8211; v1.9.0.37 + 4 DLCs/Bonuses' },
  content: { rendered: CONTENT },
};

const UPCOMING = {
  id: 1,
  slug: 'upcoming-repacks',
  link: 'https://games.example/upcoming-repacks/',
  date: '2026-06-20T10:00:00',
  title: { rendered: 'Upcoming Repacks' },
  content: { rendered: '<p>Some games are coming soon.</p>' },
};

const ok = (body: unknown, totalPages: number | null = null) => ({
  status: 200,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  totalPages,
});

const CATEGORIES = [
  { id: 3, count: 12 },
  { id: 7, count: 4100 },
  { id: 9, count: 80 },
];

function route(handlers: Record<string, unknown>) {
  mockInvoke.mockImplementation(async (_cmd, args) => {
    const path = (args as { path: string }).path;
    for (const [prefix, res] of Object.entries(handlers)) if (path.startsWith(prefix)) return res;
    throw new Error(`unexpected path ${path}`);
  });
}

beforeEach(() => {
  resetSourceCache();
  mockInvoke.mockReset();
});

describe('parsePost', () => {
  it('extracts every field from a game post', () => {
    const g = parsePost(POST);
    expect(g).toMatchObject({
      slug: 'arma-reforger',
      postId: 6942,
      link: 'https://games.example/arma-reforger/',
      date: '2026-06-21T10:00:00',
      title: 'Arma Reforger: Deluxe Edition',
      subtitle: 'v1.9.0.37 + 4 DLCs/Bonuses',
      cover: 'https://img.example/out/2026/06/21/83252d.jpg',
      genres: ['Action', 'Tactical shooter'],
      companies: ['Bohemia Interactive'],
      languages: 'RUS/ENG/MULTI13',
      originalSize: '30 GB',
      repackSize: 'from 14.3 GB',
      selective: true,
    });
    expect(g.magnet).toBe(
      'magnet:?xt=urn:btih:7BF66F3D8CF409972317B20BF7ED842AD1903F68&dn=Arma&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce',
    );
    expect(g.screenshots).toEqual([
      { thumb: 'http://shots.example/data/6d/d1/6dd18dc6.jpg.240p.jpg', full: 'http://shots.example/data/6d/d1/6dd18dc6.jpg' },
      { thumb: 'http://shots.example/data/b1/4e/b14e15fc.jpg.240p.jpg', full: 'http://shots.example/data/b1/4e/b14e15fc.jpg' },
    ]);
    expect(g.features).toEqual([
      'Based on Arma.Reforger ISO release',
      'Game version: v1.9.0.37; 4 DLCs/Bonuses are included',
      '100% Lossless & MD5 Perfect: all files are identical to originals after installation',
    ]);
    expect(g.description).toBe(
      'Arma Reforger deploys you into an authentic Cold War military sandbox.\n\nArma Reforger is the latest installment.',
    );
  });

  it('falls back to the post title and never throws on empty content', () => {
    const g = parsePost({ ...UPCOMING, title: { rendered: 'Some Game &#8211; v2.0 &amp; Bonus' } });
    expect(g.title).toBe('Some Game');
    expect(g.subtitle).toBe('v2.0 & Bonus');
    expect(g).toMatchObject({ cover: null, magnet: null, genres: [], screenshots: [], features: [], description: '' });
    expect(() => parsePost({ id: 2, slug: 'x', link: '', title: { rendered: '' }, content: { rendered: '' } })).not.toThrow();
  });
});

describe('unwrapImage', () => {
  it('removes the resizing proxy and its query', () => {
    expect(unwrapImage('https://i0.wp.com/img.example/out/2026/10/19/55c8.jpg?resize=150%2C200&ssl=1')).toBe(
      'https://img.example/out/2026/10/19/55c8.jpg',
    );
    expect(unwrapImage('https://i3.wp.com/img.example/a.png')).toBe('https://img.example/a.png');
  });

  it('leaves other URLs untouched', () => {
    expect(unwrapImage('https://img.example/a.jpg?x=1')).toBe('https://img.example/a.jpg?x=1');
  });
});

describe('mainCategory', () => {
  it('picks the largest category and caches it per origin', async () => {
    route({ '/wp-json/wp/v2/categories': ok(CATEGORIES) });
    expect(await mainCategory(ORIGIN)).toBe(7);
    expect(await mainCategory(ORIGIN + '/')).toBe(7);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('games_source_get', {
      origin: ORIGIN,
      path: '/wp-json/wp/v2/categories?per_page=100&_fields=id,count',
    });
  });
});

describe('post lists', () => {
  it('fetchNewest builds the path and drops non-game posts', async () => {
    route({ '/wp-json/wp/v2/categories': ok(CATEGORIES), '/wp-json/wp/v2/posts': ok([POST, UPCOMING], 42) });
    const res = await fetchNewest(ORIGIN, 2);
    expect(res.totalPages).toBe(42);
    expect(res.games.map((g) => g.slug)).toEqual(['arma-reforger']);
    expect(mockInvoke).toHaveBeenLastCalledWith('games_source_get', {
      origin: ORIGIN,
      path: '/wp-json/wp/v2/posts?categories=7&per_page=24&page=2&_fields=id,slug,link,title,date,content',
    });
  });

  it('omits the category when none exists', async () => {
    route({ '/wp-json/wp/v2/categories': ok([]), '/wp-json/wp/v2/posts': ok([]) });
    const res = await fetchNewest(ORIGIN);
    expect(res).toEqual({ games: [], totalPages: 1 });
    expect((mockInvoke.mock.lastCall![1] as { path: string }).path).toBe(
      '/wp-json/wp/v2/posts?per_page=24&page=1&_fields=id,slug,link,title,date,content',
    );
  });

  it('searchGames encodes the query', async () => {
    route({ '/wp-json/wp/v2/categories': ok(CATEGORIES), '/wp-json/wp/v2/posts': ok([POST]) });
    await searchGames(ORIGIN, 'arma & co/3', 3);
    expect((mockInvoke.mock.lastCall![1] as { path: string }).path).toBe(
      '/wp-json/wp/v2/posts?categories=7&per_page=24&page=3&search=arma%20%26%20co%2F3&_fields=id,slug,link,title,date,content',
    );
  });

  it('fetchGame returns the first post or null', async () => {
    route({ '/wp-json/wp/v2/posts?slug=arma-reforger&': ok([POST]), '/wp-json/wp/v2/posts?slug=': ok([]) });
    expect((await fetchGame(ORIGIN, 'arma-reforger'))?.title).toBe('Arma Reforger: Deluxe Edition');
    expect(await fetchGame(ORIGIN, 'missing')).toBeNull();
  });
});

describe('fetchPopular', () => {
  const card = (slug: string, title: string, img: string, host = 'https://games.example') =>
    `<div class="widget-grid-view-image"><a href="${host}/${slug}/" title="${title}" class="bump-view" data-bump-view="tp"><img decoding="async" loading="lazy" width="150" height="200" src="${img}" alt="${title}"/></a></div>`;
  const widget = (h2: string, cards: string[]) =>
    `<div class="jetpack_top_posts_widget"><h2 class="widgettitle">${h2}</h2><div class='widgets-grid-layout no-grav'>${cards.join('\n')}</div></div>`;

  const HTML = `<html><body>
${widget('Most Popular Repacks of the Month', [
  card('some-game-slug', 'Some Game - v13.1.29 (Campaign Only)', 'https://i0.wp.com/img.example/out/2026/10/19/55c8.jpg?resize=150%2C200&#038;ssl=1'),
  card('some-game-slug', 'Some Game - v13.1.29 (Campaign Only)', 'https://i0.wp.com/img.example/out/2026/10/19/55c8.jpg?resize=150%2C200&#038;ssl=1'),
  card('elsewhere', 'Elsewhere - v1', 'https://img.example/e.jpg', 'https://other.example'),
  card('second-game', 'Second Game &#8211; Deluxe', 'https://img.example/s.jpg'),
])}
${widget('Most Popular Repacks of the Year', [card('third-game', 'Third Game', 'https://i2.wp.com/img.example/t.jpg?ssl=1')])}
</body></html>`;

  it('parses each widget into a deduped, same-origin row', async () => {
    route({ '/popular-repacks/': ok(HTML) });
    const rows = await fetchPopular(ORIGIN);
    expect(rows.map((r) => r.title)).toEqual(['Popular this month', 'Popular this year']);
    expect(rows[0].games).toEqual([
      {
        slug: 'some-game-slug',
        title: 'Some Game',
        subtitle: 'v13.1.29 (Campaign Only)',
        cover: 'https://img.example/out/2026/10/19/55c8.jpg',
        postId: null,
        date: null,
      },
      { slug: 'second-game', title: 'Second Game', subtitle: 'Deluxe', cover: 'https://img.example/s.jpg', postId: null, date: null },
    ]);
    expect(rows[1].games).toEqual([
      { slug: 'third-game', title: 'Third Game', subtitle: '', cover: 'https://img.example/t.jpg', postId: null, date: null },
    ]);
  });
});

describe('errors', () => {
  it('reports a bot check as blocked', async () => {
    mockInvoke.mockResolvedValue({ status: 403, body: '<title>DDoS protection</title> Checking your browser…', totalPages: null });
    const err = await fetchPopular(ORIGIN).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.kind).toBe('blocked');
    expect(err.message).toBe('The game source is asking for a browser check. Try again in a minute.');
  });

  it('reports other statuses as http errors', async () => {
    mockInvoke.mockResolvedValue({ status: 500, body: 'oops', totalPages: null });
    const err = await mainCategory(ORIGIN).catch((e) => e);
    expect(err).toMatchObject({ kind: 'http', message: 'The game source answered HTTP 500.' });
  });

  it('reports unreadable JSON as a parse error', async () => {
    mockInvoke.mockResolvedValue(ok('<html>not json</html>'));
    await expect(mainCategory(ORIGIN)).rejects.toMatchObject({ kind: 'parse' });
  });
});
