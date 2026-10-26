#!/usr/bin/env node
// Copies libmpv and every non-system dependency into src-tauri/libmpv/, rewrites their install
// names to @loader_path so they resolve inside TruongFlix.app/Contents/Frameworks, re-signs them,
// and writes src-tauri/tauri.macos.conf.json so `tauri build` bundles them.
//
// Windows: downloads shinchiro's libmpv-2.dll into src-tauri/libmpv/ instead (see bundleWindows).
//
// Usage: node scripts/bundle-libmpv.mjs [path/to/libmpv.2.dylib] [--force]

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src-tauri', 'libmpv');
const confPath = join(root, 'src-tauri', 'tauri.macos.conf.json');

if (process.platform === 'win32') {
  await bundleWindows();
  process.exit(0);
}
if (process.platform !== 'darwin') {
  console.log('[bundle-libmpv] only macOS and Windows bundle libmpv — skipping');
  process.exit(0);
}

/**
 * Windows: download shinchiro's self-contained libmpv build (one DLL with FFmpeg statically
 * linked) and extract libmpv-2.dll. tauri.windows.conf.json ships it next to the executable.
 */
async function bundleWindows() {
  const dll = join(outDir, 'libmpv-2.dll');
  if (existsSync(dll) && !process.argv.includes('--force')) {
    console.log('[bundle-libmpv] libmpv-2.dll already present (use --force to refresh)');
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const headers = { 'User-Agent': 'TruongFlix-build', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch('https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest', { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const release = await res.json();
  // Baseline x86-64 build (not the AVX2-only "v3" variant) for compatibility with older CPUs.
  const asset = release.assets.find((a) => /^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$/.test(a.name));
  if (!asset) throw new Error('No mpv-dev-x86_64 asset in the latest mpv-winbuild release');
  console.log(`[bundle-libmpv] downloading ${asset.name} (${(asset.size / 1e6).toFixed(0)} MB)`);
  const archive = join(outDir, asset.name);
  const download = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'TruongFlix-build' } });
  if (!download.ok) throw new Error(`Download failed: ${download.status}`);
  writeFileSync(archive, Buffer.from(await download.arrayBuffer()));
  const sevenZip = ['C:\\Program Files\\7-Zip\\7z.exe', '7z'].find((p) => p === '7z' || existsSync(p));
  execFileSync(sevenZip, ['e', archive, `-o${outDir}`, 'libmpv-2.dll', '-y'], { stdio: 'ignore' });
  rmSync(archive, { force: true });
  if (!existsSync(dll)) throw new Error('libmpv-2.dll not found in the archive');
  console.log(`[bundle-libmpv] libmpv-2.dll (${(statSync(dll).size / 1e6).toFixed(1)} MB) → src-tauri/libmpv/`);
}

const source =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
  ['/opt/homebrew/lib/libmpv.2.dylib', '/usr/local/lib/libmpv.2.dylib'].find((p) => existsSync(p));
if (!source || !existsSync(source)) {
  console.error('[bundle-libmpv] libmpv not found. Install it with `brew install mpv` or pass a path.');
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const isSystem = (p) => p.startsWith('/usr/lib/') || p.startsWith('/System/');

/** Install name ("id") of a dylib, e.g. /opt/homebrew/opt/ffmpeg/lib/libavcodec.63.dylib */
const installId = (file) => run('otool', ['-D', file]).split('\n')[1]?.trim() || file;

/** Load commands of a dylib (excluding its own id line). */
function references(file) {
  const id = installId(file);
  return run('otool', ['-L', file])
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(' (')[0])
    .filter((p) => p && p !== id && !isSystem(p));
}

function resolveRef(ref, from) {
  if (ref.startsWith('@rpath/') || ref.startsWith('@loader_path/') || ref.startsWith('@executable_path/')) {
    const name = ref.split('/').slice(1).join('/');
    const rpaths = run('otool', ['-l', from])
      .split('Load command')
      .filter((c) => c.includes('LC_RPATH'))
      .map((c) => c.match(/path (.+?) \(offset/)?.[1])
      .filter(Boolean)
      .map((p) => p.replace('@loader_path', dirname(from)));
    for (const dir of [dirname(from), ...rpaths, '/opt/homebrew/lib', '/usr/local/lib']) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return realpathSync(candidate);
    }
    throw new Error(`Cannot resolve ${ref} referenced by ${from}`);
  }
  return realpathSync(ref);
}

// 1. Walk the dependency graph from libmpv. Key = real file, value = bundled file name.
const libs = new Map();
const pending = [realpathSync(source)];
while (pending.length) {
  const file = pending.pop();
  if (libs.has(file)) continue;
  libs.set(file, basename(installId(file)));
  for (const ref of references(file)) pending.push(resolveRef(ref, file));
}
// libmpv itself is loaded by name from Contents/Frameworks.
libs.set(realpathSync(source), 'libmpv.2.dylib');

const names = new Set(libs.values());
if (names.size !== libs.size) throw new Error('Two dependencies would share a file name');

// 2. Copy into a clean output dir.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const [file, name] of libs) {
  copyFileSync(file, join(outDir, name));
  chmodSync(join(outDir, name), 0o644);
}

// 3. Rewrite ids and references to @loader_path (all libs sit side by side in Frameworks).
const nameForRef = (ref, from) => libs.get(resolveRef(ref, from));
for (const [file, name] of libs) {
  const target = join(outDir, name);
  const args = ['-id', `@loader_path/${name}`];
  for (const ref of references(file)) {
    const dep = nameForRef(ref, file);
    if (dep) args.push('-change', ref, `@loader_path/${dep}`);
  }
  // Drop Homebrew rpaths so nothing can resolve outside the bundle.
  const rpaths = run('otool', ['-l', target])
    .split('Load command')
    .filter((c) => c.includes('LC_RPATH'))
    .map((c) => c.match(/path (.+?) \(offset/)?.[1])
    .filter(Boolean);
  for (const rp of rpaths) args.push('-delete_rpath', rp);
  execFileSync('install_name_tool', [...args, target], { stdio: ['ignore', 'ignore', 'pipe'] });
}

// 4. Verify no reference escapes the bundle, then ad-hoc sign (required on Apple Silicon after
//    editing; `tauri build` re-signs with your Developer ID when one is configured).
const bundled = readdirSync(outDir).filter((f) => f.endsWith('.dylib'));
for (const f of bundled) {
  const bad = references(join(outDir, f)).filter((r) => !r.startsWith('@loader_path/'));
  if (bad.length) throw new Error(`${f} still references: ${bad.join(', ')}`);
  execFileSync('codesign', ['--force', '--sign', '-', join(outDir, f)], { stdio: 'ignore' });
}

// 5. Platform config consumed by `tauri build` (merged over tauri.conf.json on macOS).
const frameworks = bundled.sort().map((f) => `./libmpv/${f}`);
writeFileSync(confPath, JSON.stringify({ bundle: { macOS: { frameworks } } }, null, 2) + '\n');

const total = bundled.reduce((n, f) => n + statSync(join(outDir, f)).size, 0);
console.log(`[bundle-libmpv] ${bundled.length} libraries (${(total / 1e6).toFixed(1)} MB) → src-tauri/libmpv/`);
console.log(`[bundle-libmpv] wrote ${basename(confPath)}`);
