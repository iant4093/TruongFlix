import { invoke } from '@tauri-apps/api/core';
import type { GameCard, GameDetail, GameRow } from './types';

export interface SourcePost {
  id: number;
  slug: string;
  link: string;
  date?: string;
  title: { rendered: string };
  content: { rendered: string };
}

interface SourceResponse {
  status: number;
  body: string;
  totalPages: number | null;
}

export class SourceError extends Error {
  constructor(public kind: 'blocked' | 'http' | 'parse', message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

const POST_FIELDS = '_fields=id,slug,link,title,date,content';
const BOT_CHECK = /ddos|challenge|captcha|checking your browser/i;

const categoryCache = new Map<string, number | null>();

export function resetSourceCache() {
  categoryCache.clear();
}

const trimOrigin = (origin: string) => origin.trim().replace(/\/+$/, '');

async function get(origin: string, path: string): Promise<SourceResponse> {
  const res = await invoke<SourceResponse>('games_source_get', { origin: trimOrigin(origin), path });
  if (res.status >= 200 && res.status < 300) return res;
  if ((res.status === 403 || res.status === 503) && BOT_CHECK.test(res.body)) {
    throw new SourceError('blocked', 'The game source is asking for a browser check. Try again in a minute.');
  }
  throw new SourceError('http', `The game source answered HTTP ${res.status}.`);
}

function json<T>(res: SourceResponse): T {
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new SourceError('parse', 'The game source sent an unreadable answer.');
  }
}

export async function mainCategory(origin: string): Promise<number | null> {
  const key = trimOrigin(origin);
  if (categoryCache.has(key)) return categoryCache.get(key)!;
  const cats = json<{ id: number; count: number }[]>(
    await get(key, '/wp-json/wp/v2/categories?per_page=100&_fields=id,count'),
  );
  let best: { id: number; count: number } | null = null;
  for (const c of Array.isArray(cats) ? cats : []) if (!best || c.count > best.count) best = c;
  const id = best?.id ?? null;
  categoryCache.set(key, id);
  return id;
}

async function listPosts(origin: string, page: number, perPage: number, extra = '') {
  const cat = await mainCategory(origin);
  const path =
    `/wp-json/wp/v2/posts?${cat != null ? `categories=${cat}&` : ''}per_page=${perPage}&page=${page}` +
    `${extra}&${POST_FIELDS}`;
  const res = await get(origin, path);
  const posts = json<SourcePost[]>(res);
  const games = (Array.isArray(posts) ? posts : []).map(parsePost).filter((g) => g.magnet || g.repackSize);
  return { games, totalPages: res.totalPages ?? 1 };
}

export const fetchNewest = (origin: string, page = 1, perPage = 24) => listPosts(origin, page, perPage);

export const searchGames = (origin: string, query: string, page = 1, perPage = 24) =>
  listPosts(origin, page, perPage, `&search=${encodeURIComponent(query)}`);

export async function fetchGame(origin: string, slug: string): Promise<GameDetail | null> {
  const posts = json<SourcePost[]>(
    await get(origin, `/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&${POST_FIELDS}`),
  );
  return Array.isArray(posts) && posts.length ? parsePost(posts[0]) : null;
}

const parseHtml = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const decode = (html: string) => clean(parseHtml(html).body.textContent);

function splitTitle(text: string): [string, string] {
  const m = /\s+[-–]\s+/.exec(text);
  return m ? [text.slice(0, m.index).trim(), text.slice(m.index + m[0].length).trim()] : [text.trim(), ''];
}

export function unwrapImage(url: string): string {
  const m = /^https?:\/\/i\d\.wp\.com\/([^?#]+)/i.exec(url);
  return m ? `https://${m[1]}` : url;
}

const imgSrc = (img: Element) => img.getAttribute('src') || img.getAttribute('data-src') || '';
const isAfter = (node: Node, ref: Node) => !!(ref.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
const headingIndex = (heads: Element[], text: string) =>
  heads.findIndex((h) => clean(h.textContent).toLowerCase().includes(text));

/** Splits an element's content into lines at <br>, keeping the element nodes of each line. */
function lineNodes(root: Element): Node[][] {
  const lines: Node[][] = [[]];
  const walk = (parent: Node) => {
    for (const n of Array.from(parent.childNodes)) {
      if (n.nodeName === 'BR') lines.push([]);
      else if (n.nodeType === Node.ELEMENT_NODE && !['A', 'STRONG', 'B', 'EM', 'I'].includes(n.nodeName)) walk(n);
      else lines[lines.length - 1].push(n);
    }
  };
  walk(root);
  return lines;
}

function metadata(doc: Document) {
  const out = { genres: [] as string[], companies: [] as string[], languages: '', originalSize: '', repackSize: '' };
  const para =
    Array.from(doc.querySelectorAll('p')).find((p) => /Repack Size:|Genres\/Tags:/.test(p.textContent ?? '')) ??
    doc.body;
  for (const nodes of lineNodes(para)) {
    const text = clean(nodes.map((n) => n.textContent).join(''));
    const m = /^([A-Za-z/ ]+):\s*(.*)$/.exec(text);
    if (!m) continue;
    const label = m[1].trim().toLowerCase();
    const strong = nodes.find((n) => n.nodeName === 'STRONG' || n.nodeName === 'B');
    const value = strong ? clean(strong.textContent) : clean(m[2]);
    if (label === 'genres/tags') {
      const links = nodes.filter((n) => n.nodeName === 'A').map((n) => clean(n.textContent));
      out.genres = (links.length ? links : m[2].split(',').map(clean)).filter(Boolean);
    } else if (label === 'company' || label === 'companies') {
      out.companies = value.split(',').map(clean).filter(Boolean);
    } else if (label === 'languages') out.languages = value;
    else if (label === 'original size') out.originalSize = value;
    else if (label === 'repack size') out.repackSize = value;
  }
  return { ...out, selective: /Selective Download/i.test(para.textContent ?? '') };
}

function description(doc: Document): string {
  const spoiler = Array.from(doc.querySelectorAll('.su-spoiler')).find((s) =>
    /game description/i.test(s.querySelector('.su-spoiler-title')?.textContent ?? ''),
  );
  const content = spoiler?.querySelector('.su-spoiler-content');
  if (!content) return '';
  const paras: string[] = [];
  let cur = '';
  const flush = () => {
    if (clean(cur)) paras.push(clean(cur));
    cur = '';
  };
  for (const n of Array.from(content.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE || ['A', 'STRONG', 'B', 'EM', 'I', 'SPAN'].includes(n.nodeName)) {
      cur += n.textContent ?? '';
    } else if (n.nodeName === 'BR') {
      cur += ' ';
    } else {
      flush();
      cur = n.textContent ?? '';
      flush();
    }
  }
  flush();
  return paras.join('\n\n');
}

export function parsePost(post: SourcePost): GameDetail {
  const doc = parseHtml(post.content?.rendered ?? '');
  const [fallbackTitle, fallbackSub] = splitTitle(decode(post.title?.rendered ?? ''));

  const strong = doc.querySelector('h3 strong');
  let title = fallbackTitle;
  let subtitle = fallbackSub;
  if (strong) {
    const copy = strong.cloneNode(true) as Element;
    const span = copy.querySelector('span');
    span?.remove();
    title = clean(copy.textContent) || fallbackTitle;
    if (span) subtitle = clean(span.textContent);
  }

  const heads = Array.from(doc.querySelectorAll('h3'));
  const imgs = Array.from(doc.querySelectorAll('img'));
  const mirrors = heads[headingIndex(heads, 'download mirrors')];
  const coverImg = imgs.find((img) => !mirrors || !isAfter(img, mirrors));
  const cover = coverImg && imgSrc(coverImg) ? unwrapImage(imgSrc(coverImg)) : null;

  const shotsAt = headingIndex(heads, 'screenshots');
  const screenshots: GameDetail['screenshots'] = [];
  if (shotsAt >= 0) {
    const next = heads[shotsAt + 1];
    for (const img of imgs) {
      if (!isAfter(img, heads[shotsAt]) || (next && isAfter(img, next))) continue;
      const thumb = imgSrc(img);
      if (thumb) screenshots.push({ thumb, full: thumb.replace(/\.240p\.(jpe?g|png)$/i, '') });
      if (screenshots.length >= 8) break;
    }
  }

  const featAt = headingIndex(heads, 'repack features');
  const featList =
    featAt >= 0 ? Array.from(doc.querySelectorAll('ul')).find((ul) => isAfter(ul, heads[featAt])) : undefined;
  const features = featList
    ? Array.from(featList.querySelectorAll('li'))
        .map((li) => clean(li.textContent))
        .filter(Boolean)
    : [];

  return {
    slug: post.slug ?? '',
    title,
    subtitle,
    cover,
    postId: post.id ?? null,
    date: post.date ?? null,
    link: post.link ?? '',
    ...metadata(doc),
    magnet: doc.querySelector('a[href^="magnet:"]')?.getAttribute('href') ?? null,
    screenshots,
    features,
    description: description(doc),
  };
}

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '');

function rowTitle(text: string): string {
  if (/of the month$/i.test(text)) return 'Popular this month';
  if (/of the year$/i.test(text)) return 'Popular this year';
  if (/of the week$/i.test(text)) return 'Popular this week';
  return text.replace(/^most\s+/i, '');
}

export function parsePopular(origin: string, html: string): GameRow[] {
  const doc = parseHtml(html);
  const host = bareHost(new URL(trimOrigin(origin)).hostname);
  const rows: GameRow[] = [];
  for (const widget of Array.from(doc.querySelectorAll('.jetpack_top_posts_widget'))) {
    const seen = new Set<string>();
    const games: GameCard[] = [];
    for (const a of Array.from(widget.querySelectorAll('.widget-grid-view-image > a'))) {
      let url: URL;
      try {
        url = new URL(a.getAttribute('href') ?? '', trimOrigin(origin));
      } catch {
        continue;
      }
      const slug = url.pathname.split('/').filter(Boolean)[0];
      if (bareHost(url.hostname) !== host || !slug || seen.has(slug)) continue;
      seen.add(slug);
      const img = a.querySelector('img');
      const [title, subtitle] = splitTitle(clean(a.getAttribute('title') || img?.getAttribute('alt') || slug));
      const src = img ? imgSrc(img) : '';
      games.push({ slug, title, subtitle, cover: src ? unwrapImage(src) : null, postId: null, date: null });
    }
    if (games.length) rows.push({ title: rowTitle(clean(widget.querySelector('h2')?.textContent)), games });
  }
  return rows;
}

export async function fetchPopular(origin: string): Promise<GameRow[]> {
  const res = await get(origin, '/popular-repacks/');
  return parsePopular(origin, res.body);
}
