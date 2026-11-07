/** Dev-only demo data for the Windows Games section (browser preview). Never in production builds. */

const TITLES = [
  ['Starfall Odyssey', 'v2.1.4 + 3 DLCs'], ['Iron Harbor', 'Deluxe Edition – v1.08'], ['Lumen Drift', 'v0.9.7 (Early Access)'],
  ['Hollow Crown', 'Complete Edition'], ['Neon Courier', 'v3.0.2 + Soundtrack'], ['Frostbound Tactics', 'v1.4.0'],
  ['A Game About Chopping Trees', 'v1.0.3'], ['Sunken Archive', 'v1.12 + Bonus Content'], ['Velocity Rift', 'v5.2'],
  ['Mosswood Tales', 'v1.1.0'], ['Ashen Protocol', 'v2.0 + 2 DLCs'], ['Paper Lanterns', 'v1.0.6'],
] as const;

const slugOf = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function gameArt(title: string, i: number, w: number, h: number) {
  const hue = (i * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="hsl(${hue},65%,42%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,14%)"/></linearGradient></defs>`
    + `<rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="${h > w ? '82%' : '55%'}" text-anchor="middle" font-family="Segoe UI,Arial" font-weight="700" font-size="${Math.round(w / 11)}" fill="white">${title}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function postHtml(title: string, version: string, i: number) {
  const hash = (i + 1).toString(16).padStart(40, 'f');
  const shots = [0, 1, 2, 3].map((n) => `<a href="#"><img src="https://shots.example/${i}-${n}.jpg.240p.jpg"></a>`).join('');
  return `<h3><strong>${title} <span style="color:#808080">${version}</span></strong></h3>
<p><a href="#"><img src="https://img.example/cover-${i}.jpg" /></a><br />
Genres/Tags: <a href="#">Action</a>, <a href="#">Adventure</a>, <a href="#">3D</a><br />
Company: <strong>Example Studio</strong><br />Languages: <strong>ENG/MULTI8</strong><br />
Original Size: <strong>${(i % 5) + 4}.2 GB</strong><br />Repack Size: <strong>from ${(i % 4) + 1}.8 GB</strong> [Selective Download]
<p></p><h3>Download Mirrors (Torrent)</h3><ul><li>[<a href="magnet:?xt=urn:btih:${hash}&#038;dn=${encodeURIComponent(title)}+%5BRepack%5D">magnet</a>]</li></ul>
<h3>Screenshots (Click to enlarge)</h3><p>${shots}</p>
<h3>Repack Features</h3><ul><li>Based on the official release<li>100% Lossless &#038; MD5 Perfect<li>Selective Download: skip bonus content<li>Installation takes 2-6 minutes<li>After-install integrity check</ul>
<div class="su-spoiler"><div class="su-spoiler-title">Game Description</div><div class="su-spoiler-content"><p>${title} is a demo game used to preview the Games section. Explore, fight and build across a hand-crafted world.</p></div></div>`;
}

export const gamePosts = TITLES.map(([title, version], i) => ({
  id: 1000 + i, slug: slugOf(title), link: `https://games.example/${slugOf(title)}/`, date: '2026-11-0' + ((i % 7) + 1),
  title: { rendered: `${title} – ${version}` }, content: { rendered: postHtml(title, version, i) },
}));

export const popularPage = `<div class="jetpack_top_posts_widget"><h2 class="widgettitle">Most Popular Repacks of the Month</h2><div>${gamePosts.slice(0, 8)
  .map((p, i) => `<div class="widget-grid-view-image"><a href="${p.link}" title="${TITLES[i][0]} - ${TITLES[i][1]}"><img src="https://img.example/cover-${i}.jpg"/></a></div>`).join('')}</div></div>
<div class="jetpack_top_posts_widget"><h2 class="widgettitle">Most Popular Repacks of the Year</h2><div>${gamePosts.slice(4)
  .map((p, j) => `<div class="widget-grid-view-image"><a href="${p.link}" title="${TITLES[j + 4][0]} - ${TITLES[j + 4][1]}"><img src="https://img.example/cover-${j + 4}.jpg"/></a></div>`).join('')}</div></div>`;

// ---------------------------------------------------------------------------
// games_library table and games_* settings
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const library: Row[] = [];
const gameSettings: Record<string, string> = {
  games_source_url: 'https://games.example',
  games_download_dir: 'D:\\Downloads\\Game Installers',
  games_install_dir: 'D:\\Games',
};
let nextId = 1;

const LIBRARY_COLUMNS = ['slug', 'title', 'subtitle', 'cover', 'detail', 'status', 'info_hash', 'installer_dir', 'auto_install', 'delete_installer', 'choices'];

export function handleGamesSql(q: string, values: unknown[]): unknown | undefined {
  if (q.includes("key LIKE 'games_%'")) return Object.entries(gameSettings).map(([key, value]) => ({ key, value }));
  if (q.startsWith('INSERT INTO settings') && String(values[0]).startsWith('games_')) {
    gameSettings[String(values[0])] = String(values[1]);
    return [1, 0];
  }
  if (!q.includes('games_library')) return undefined;
  if (q.startsWith('CREATE')) return [0, 0];
  if (q.startsWith('SELECT * FROM games_library WHERE slug')) return library.filter((r) => r.slug === values[0]);
  if (q.startsWith('SELECT * FROM games_library')) return [...library].reverse();
  if (q.startsWith('INSERT INTO games_library')) {
    const data = Object.fromEntries(LIBRARY_COLUMNS.map((c, i) => [c, values[i] ?? null]));
    const existing = library.find((r) => r.slug === data.slug);
    if (existing) Object.assign(existing, data, { error: null });
    else library.push({ id: nextId++, install_dir: null, exe_path: null, error: null, size_bytes: null, play_seconds: 0, last_played: null, installed_at: null, created_at: new Date().toISOString(), ...data });
    return [1, 0];
  }
  const row = library.find((r) => r.id === values[0]);
  if (q.startsWith('UPDATE games_library SET play_seconds')) {
    if (row) Object.assign(row, { play_seconds: Number(row.play_seconds) + Number(values[1]), last_played: values[2] });
  } else if (q.startsWith('UPDATE games_library SET')) {
    const sets = q.slice('UPDATE games_library SET '.length, q.indexOf(' WHERE')).split(', ');
    for (const set of sets) {
      const [column, param] = set.split(' = $');
      if (row) row[column] = values[Number(param) - 1];
    }
  } else if (q.startsWith('DELETE FROM games_library')) {
    const index = library.findIndex((r) => r.id === values[0]);
    if (index >= 0) library.splice(index, 1);
  }
  return [1, 0];
}
