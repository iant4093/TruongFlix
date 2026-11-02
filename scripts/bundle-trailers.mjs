// Pinned, checksum-verified helpers for HD trailer resolution. Tauri signs/bundles these
// sidecars; users do not need Python, yt-dlp, Deno, or FFmpeg installed on their computer.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
const target = process.env.TAURI_ENV_TARGET_TRIPLE || host;
if (!target || !['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc'].includes(target)) {
  throw new Error(`Trailer helpers are not configured for ${target}`);
}
const windows = target.includes('windows');
const out = join(root, 'src-tauri', 'bin');
const downloads = join(out, 'downloads');
mkdirSync(downloads, { recursive: true });
const ytVersion = '2026.10.26';
const denoVersion = 'v2.9.8';
const ytAsset = windows ? 'yt-dlp.exe' : 'yt-dlp_macos';
const ytHash = windows
  ? 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d'
  : '0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa';
const denoAsset = `deno-${target}.zip`;
const denoHashes = {
  'aarch64-apple-darwin': '9f0bf660393da2eaff044cdc7444cb08c73f235849b61d224d825a194ce7c98e',
  'x86_64-apple-darwin': '4b2f5edd2639b7470f034238b321d7002d8dfb4726d8558f52c17afac370eb2c',
  'x86_64-pc-windows-msvc': 'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function download(url, path, expected) {
  if (existsSync(path) && (!expected || hash(readFileSync(path)) === expected)) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Trailer helper download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (expected && hash(bytes) !== expected) throw new Error(`Checksum mismatch: ${path}`);
  writeFileSync(path, bytes);
}
const yt = join(downloads, `${ytVersion}-${ytAsset}`);
const deno = join(downloads, `${denoVersion}-${denoAsset}`);
await Promise.all([
  download(`https://github.com/yt-dlp/yt-dlp/releases/download/${ytVersion}/${ytAsset}`, yt, ytHash),
  download(`https://github.com/denoland/deno/releases/download/${denoVersion}/${denoAsset}`, deno, denoHashes[target]),
]);
const executable = windows ? 'deno.exe' : 'deno';
if (windows) {
  const sevenZip = 'C:\\Program Files\\7-Zip\\7z.exe';
  execFileSync(existsSync(sevenZip) ? sevenZip : '7z', ['e', deno, `-o${downloads}`, executable, '-y'], { stdio: 'ignore' });
} else {
  execFileSync('unzip', ['-j', '-o', deno, executable, '-d', downloads], { stdio: 'ignore' });
}
for (const [name, source] of [['yt-dlp', yt], ['deno', join(downloads, executable)]]) {
  const dest = join(out, `${name}-${target}${windows ? '.exe' : ''}`);
  copyFileSync(source, dest);
  chmodSync(dest, 0o755);
  if (target === host) {
    const version = execFileSync(dest, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
    if (!version.includes(name === 'yt-dlp' ? ytVersion : denoVersion.slice(1))) throw new Error(`Unexpected ${name} version: ${version}`);
    console.log(`[trailers] Verified executable: ${name} ${version}`);
  }
}
const licenses = join(out, 'licenses');
mkdirSync(licenses, { recursive: true });
await Promise.all([
  download(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${ytVersion}/LICENSE`, join(licenses, 'yt-dlp-LICENSE.txt')),
  download(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${ytVersion}/THIRD_PARTY_LICENSES.txt`, join(licenses, 'yt-dlp-THIRD_PARTY_LICENSES.txt')),
  download(`https://raw.githubusercontent.com/denoland/deno/${denoVersion}/LICENSE.md`, join(licenses, 'deno-LICENSE.md')),
]);
console.log(`[trailers] Bundled yt-dlp ${ytVersion} and Deno ${denoVersion} for ${target}`);
