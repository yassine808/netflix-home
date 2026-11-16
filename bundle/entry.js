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
import { initConfig, getLibraryRootSetting } from '../server/config.js';

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

/* The exe has no console, so a quit from the tray, a stray signal or an
 * exception would make the process vanish without a trace. Each of those paths
 * leaves a line now; "the app closed by itself" then has an answer in
 * launcher.log instead of a gap between two timestamps. */
process.on('exit', (code) => log(`process exiting with code ${code}`));
process.on('SIGINT', () => log('signal SIGINT received'));
process.on('SIGTERM', () => log('signal SIGTERM received'));
process.on('SIGBREAK', () => {
  log('signal SIGBREAK received');
  process.exit(0);
});
/* A single failed request must not take the whole server with it: log the
 * error and keep serving, the queue and playback are still fine. */
process.on('uncaughtException', (err) => log(`uncaught exception: ${err?.stack || err}`));
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack || err}`));

function hasExactDir(dir, name) {
  try {
    return fs.readdirSync(dir).includes(name);
  } catch {
    return false;
  }
}

/* Same order as the server: env, the folder chosen in Settings (config.json
 * beside the exe), a Movies folder next to the exe, then the old fixed
 * locations. The exe folder is the last resort so a fresh folder works. */
function libraryRoot() {
  if (process.env.LIBRARY_ROOT) return path.resolve(process.env.LIBRARY_ROOT);
  const chosen = getLibraryRootSetting();
  if (chosen) {
    try {
      if (fs.statSync(chosen).isDirectory()) return chosen;
      log(`library folder from Settings is not a folder: ${chosen}`);
    } catch {
      log(`library folder from Settings is missing: ${chosen}`);
    }
  }
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
  /* Starting the server in the background must not pull focus away from
   * whatever is on screen, so a caller can opt out of the tab. */
  if (process.env.NETFLIX_NO_BROWSER === '1') {
    log(`browser suppressed by NETFLIX_NO_BROWSER: ${url}`);
    return;
  }
  spawn('cmd.exe', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  log(`browser opened at ${url}`);
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

/* A restart from Settings spawns this exe while the old server is still
 * shutting down. Waiting for that pid keeps the new instance from finding the
 * old server alive, opening a tab and exiting again. */
async function waitForProcessExit(pid, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log(`pid ${pid} was still alive after ${ms} ms; starting anyway`);
  return false;
}

/* The exe has no window, so the notification-area icon is the only handle on a
 * server that is already running. It is a Windows PowerShell WinForms process
 * (bundle/tray.ps1, packed as an asset) that owns the icon and talks to the
 * server over loopback; the script removes its own icon when the server stops
 * answering, so a quit or a crash never leaves a ghost in the tray. */
function startTray(port, appDir) {
  if (process.env.NETFLIX_NO_TRAY === '1') {
    log('tray suppressed by NETFLIX_NO_TRAY');
    return;
  }
  const script = path.join(appDir, 'tray.ps1');
  if (!fs.existsSync(script)) {
    log(`tray script missing: ${script}`);
    return;
  }
  const icon = path.join(appDir, 'public', 'favicon.ico');
  try {
    /* Not detached: on Windows a detached PowerShell exits its WinForms loop
     * straight away (exit code 0, no icon). The child still outlives the
     * server because Windows does not kill children with their parent. */
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', script,
      '-Port', String(port),
      '-ServerPid', String(process.pid),
      '-Icon', icon,
    ], { stdio: 'ignore', windowsHide: true });
    child.once('error', (err) => log(`tray failed to start: ${err?.message || err}`));
    child.unref();
    log(`tray icon started for http://localhost:${port}`);
  } catch (err) {
    log(`tray failed to start: ${err?.message || err}`);
  }
}

async function main() {
  /* config.json carries the library folder picked in Settings. It has to be
   * read before the root is resolved. */
  initConfig(exeDir);
  const waitPid = Number(process.env.NETFLIX_WAIT_PID) || 0;
  if (waitPid) await waitForProcessExit(waitPid);

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
  process.env.YTDLP_PATH = path.join(appDir, 'bin', 'yt-dlp.exe');
  process.env.ARIA2C_PATH = path.join(appDir, 'bin', 'aria2c.exe');
  log(`unpacked app files into ${appDir}`);

  await import('../server/index.js');

  const port = await waitForServer(portFile);
  if (port) {
    openBrowser(`http://localhost:${port}`);
    startTray(port, appDir);
  } else {
    log('server did not become ready in 20 s');
  }
}

main().catch((err) => {
  log(`fatal: ${err?.stack || err}`);
  process.exit(1);
});