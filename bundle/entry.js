/**
 * Entry point for the single-file build (`npm run bundle`).
 *
 * The whole app — server code, UI files, ffmpeg and ffprobe — is packed inside
 * netflix-home.exe by Node's single-executable support. On launch this file:
 *
 *   1. works out the library folder (next to the exe, else G:\NETFLIX, ...)
 *   2. extracts the packed UI + media tools once into <library>\.cache\app
 *   3. hands control to the normal server with PUBLIC_DIR / FFMPEG_PATH set
 *   4. opens the browser, or just opens it if the app is already running
 *
 * Log lines go to launcher.log beside the exe, because the exe has no console.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import manifest from './manifest.json';

const BUILD_ID = manifest.build;
const ASSETS = manifest.files;

const exeDir = path.dirname(process.execPath);
const logPath = path.join(exeDir, 'launcher.log');
const nodeRequire = createRequire(process.execPath);

let sea = null;
try {
  sea = nodeRequire('node:sea');
} catch {
  /* running the source, not the packed exe */
}

function log(line) {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    fs.appendFileSync(logPath, `[${stamp}] ${line}\n`);
  } catch { /* logging is best effort */ }
}

for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    log(args.map((value) => (typeof value === 'string' ? value : String(value))).join(' '));
    try { original(...args); } catch { /* no console in a windowed exe */ }
  };
}

function hasExactDir(dir, name) {
  try {
    return fs.readdirSync(dir).includes(name);
  } catch {
    return false;
  }
}

/* Same order as the server: env, a Movies folder beside the exe, then the old
 * fixed locations. The exe folder is the last resort so a fresh folder works. */
function libraryRoot() {
  if (process.env.LIBRARY_ROOT) return path.resolve(process.env.LIBRARY_ROOT);
  if (hasExactDir(exeDir, 'Movies')) return exeDir;
  for (const candidate of ['G:\\NETFLIX', 'G:\\Movies', 'G:\\']) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* drive not ready */
    }
  }
  return exeDir;
}

/* One-time unpack of the UI files and the two ffmpeg binaries. The build id in
 * .cache\app\build-id makes a new exe replace old files and nothing else. */
function extractAssets(root) {
  const appDir = path.join(root, '.cache', 'app');
  const stamp = path.join(appDir, 'build-id');
  let current = '';
  try {
    current = fs.readFileSync(stamp, 'utf8').trim();
  } catch { /* first run */ }
  if (current === BUILD_ID) return appDir;

  fs.rmSync(appDir, { recursive: true, force: true });
  for (const rel of ASSETS) {
    const dest = path.join(appDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = sea && sea.isSea() ? Buffer.from(sea.getAsset(rel)) : null;
    if (!data) throw new Error(`missing packed asset: ${rel}`);
    fs.writeFileSync(dest, data);
  }
  fs.writeFileSync(stamp, BUILD_ID, 'utf8');
  return appDir;
}

function openBrowser(url) {
  spawn('cmd.exe', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/library`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function runningPort(portFile) {
  try {
    const port = Number(fs.readFileSync(portFile, 'utf8').trim());
    if (port && await probe(port)) return port;
  } catch { /* no port file yet */ }
  return 0;
}

async function waitForServer(portFile, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const port = await runningPort(portFile);
    if (port) return port;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return 0;
}

async function main() {
  const root = libraryRoot();
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  process.env.LIBRARY_ROOT = root;
  process.env.APP_ROOT = exeDir;
  const portFile = path.join(root, '.cache', 'port');

  const already = await runningPort(portFile);
  if (already) {
    log(`app already running on port ${already}; opening browser`);
    openBrowser(`http://localhost:${already}`);
    return;
  }

  const appDir = extractAssets(root);
  process.env.PUBLIC_DIR = path.join(appDir, 'public');
  process.env.FFMPEG_PATH = path.join(appDir, 'bin', 'ffmpeg.exe');
  process.env.FFPROBE_PATH = path.join(appDir, 'bin', 'ffprobe.exe');
  log(`unpacked app files into ${appDir}`);

  await import('../server/index.js');

  const port = await waitForServer(portFile);
  if (port) {
    log(`browser opened at http://localhost:${port}`);
    openBrowser(`http://localhost:${port}`);
  } else {
    log('server did not become ready in 20 s');
  }
}

main().catch((err) => {
  log(`fatal: ${err?.stack || err}`);
  process.exit(1);
});