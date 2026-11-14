/**
 * Boot the server on a throwaway library and measure the things this project
 * keeps optimising: time to listen, first library response, scan work, gzip
 * ratio, cache headers, and process cost.
 *
 *   node scripts/bench.mjs
 *
 * Exits non-zero when a result regresses past the limits recorded in plan.md.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BENCH_PORT) || 3099;
const LIMITS = {
  firstLibraryMs: 1500,
  unchangedScanMs: 60,
  gzipRatio: 0.75,
  htmlBytes: 40000,
  assetBytes: 200000,
};

function rawRequest(port, urlPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`${label} timed out`);
    await sleep(100);
  }
}

function makeClip(library) {
  const dir = path.join(library, 'Movies', 'Bench Movie');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Bench Movie 2020 1080p.mp4');
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', file,
    ], { windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(file) : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

async function main() {
  const library = path.join(os.tmpdir(), `nh-bench-${process.pid}`);
  await fsp.mkdir(library, { recursive: true });
  await makeClip(library);

  const portFile = path.join(library, '.cache', 'port');
  const started = Date.now();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, LIBRARY_ROOT: library, PORT: String(PORT) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });

  const failures = [];
  let scan = null;
  try {
    const port = await waitFor(() => {
      const value = Number(fs.readFileSync(portFile, 'utf8').trim());
      return Number.isInteger(value) && value > 0 ? value : null;
    }, 30000, 'listen');
    const listenMs = Date.now() - started;

    const first = await waitFor(async () => {
      const res = await rawRequest(port, '/api/library');
      return res.status === 200 ? res : null;
    }, 30000, 'first library');
    const firstLibraryMs = Date.now() - started;
    const firstJson = JSON.parse(first.body.toString('utf8'));

    // Let the startup refresh finish, then measure a truly unchanged rescan.
    await waitFor(async () => {
      const res = await rawRequest(port, '/api/library');
      const json = JSON.parse(res.body.toString('utf8'));
      scan = json.scan;
      return json.scan ? json : null;
    }, 30000, 'startup scan');

    const firstRescan = JSON.parse((await rawRequest(port, '/api/rescan', {}, 'POST')).body.toString('utf8'));
    const secondRescan = JSON.parse((await rawRequest(port, '/api/rescan', {}, 'POST')).body.toString('utf8'));
    scan = secondRescan.scan || firstRescan.scan;

    const plain = await rawRequest(port, '/api/library', { 'Accept-Encoding': 'identity' });
    const gzip = await rawRequest(port, '/api/library', { 'Accept-Encoding': 'gzip' });
    const etag = plain.headers.etag;
    const cached = await rawRequest(port, '/api/library', { 'If-None-Match': etag });

    const home = await rawRequest(port, '/');
    const asset = await rawRequest(port, '/app.js');
    const stats = JSON.parse((await rawRequest(port, '/api/db/stats')).body.toString('utf8'));

    const gzipRatio = gzip.body.length / plain.body.length;
    const rows = [
      ['listen', `${listenMs} ms`],
      ['first /api/library', `${firstLibraryMs} ms (${firstJson.items.length} item)`],
      ['startup scan', `${scan?.ms} ms, ${scan?.probed} probed, changed=${scan?.changed}`],
      ['library plain', `${plain.body.length} B`],
      ['library gzip', `${gzip.body.length} B (${Math.round(gzipRatio * 100)}%)`],
      ['library 304', cached.status === 304 ? '304, 0 B' : `HTTP ${cached.status}`],
      ['home HTML', `${home.body.length} B`],
      ['app.js', `${asset.body.length} B, ${asset.headers['cache-control']}`],
      ['rss', `${Math.round((stats.process?.rssBytes || 0) / 1048576)} MB`],
      ['cpu', `${stats.process?.cpuUserMs || 0} ms user + ${stats.process?.cpuSystemMs || 0} ms system`],
      ['wal', `${stats.walBytes || 0} B`],
    ];
    const width = Math.max(...rows.map(([name]) => name.length));
    for (const [name, value] of rows) console.log(`${name.padEnd(width)}  ${value}`);

    if (firstLibraryMs > LIMITS.firstLibraryMs) failures.push(`first library ${firstLibraryMs} ms > ${LIMITS.firstLibraryMs}`);
    if ((scan?.ms || 0) > LIMITS.unchangedScanMs) failures.push(`unchanged scan ${scan?.ms} ms > ${LIMITS.unchangedScanMs}`);
    if (scan?.probed) failures.push(`unchanged scan probed ${scan.probed} file(s)`);
    if (gzipRatio > LIMITS.gzipRatio) failures.push(`gzip ratio ${gzipRatio.toFixed(2)} > ${LIMITS.gzipRatio}`);
    if (cached.status !== 304) failures.push(`ETag revalidation returned ${cached.status}`);
    if (!/immutable/.test(String(asset.headers['cache-control']))) failures.push('app.js is not immutable');
    if (!/gzip/.test(String(gzip.headers['content-encoding']))) failures.push('library is not gzipped');
    if (home.body.length > LIMITS.htmlBytes) failures.push(`home HTML ${home.body.length} B > ${LIMITS.htmlBytes}`);
  } catch (err) {
    failures.push(err.message);
    console.error(log.trim());
  } finally {
    child.kill();
    await sleep(300);
    await fsp.rm(library, { recursive: true, force: true }).catch(() => {});
  }

  if (failures.length) {
    console.error(`\nFAIL\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('\nOK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
