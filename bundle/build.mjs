/**
 * Builds dist\netflix-home.exe: one file containing the server, the UI, ffmpeg
 * and ffprobe.
 *
 *   1. esbuild turns server\index.js into a single CommonJS script
 *   2. Node's single-executable support packs that script plus the UI files and
 *      the two media binaries into a blob
 *   3. the blob is injected into a copy of node.exe
 *   4. the PE subsystem is switched to GUI so no console window opens
 *
 * On launch the exe unpacks its UI + media tools once into
 * <library>\.cache\app and starts the server from memory.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.build');
const outDir = path.join(root, 'dist');
const outFile = path.join(outDir, 'netflix-home.exe');
const bundleScript = path.join(buildDir, 'app.cjs');
const blobFile = path.join(buildDir, 'app.blob');
const seaConfigFile = path.join(buildDir, 'sea-config.json');
const manifestFile = path.join(root, 'bundle', 'manifest.json');
const nodeExe = process.execPath;

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function assetFingerprint(files) {
  const hash = crypto.createHash('sha256');
  for (const { key, source } of files) {
    const stat = fs.statSync(source);
    hash.update(`${key}:${stat.size}:${stat.mtimeMs}\n`);
  }
  const sources = ['server', 'public', 'bundle/entry.js', 'package.json'];
  for (const rel of sources) {
    const full = path.join(root, rel);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const file of walk(full)) {
        const sub = fs.statSync(path.join(full, file));
        hash.update(`${rel}/${file}:${sub.size}:${sub.mtimeMs}\n`);
      }
    } else {
      hash.update(`${rel}:${stat.size}:${stat.mtimeMs}\n`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

const ffmpeg = path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const ffprobe = path.join(root, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe');
for (const file of [ffmpeg, ffprobe]) {
  if (!fs.existsSync(file)) throw new Error(`missing ${file} — run npm install first`);
}

const publicFiles = walk(path.join(root, 'public')).map((rel) => ({
  key: `public/${rel}`,
  source: path.join(root, 'public', rel),
}));
const assets = [
  ...publicFiles,
  { key: 'bin/ffmpeg.exe', source: ffmpeg },
  { key: 'bin/ffprobe.exe', source: ffprobe },
];

fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const buildId = assetFingerprint(assets);
fs.writeFileSync(manifestFile, JSON.stringify({
  build: buildId,
  files: assets.map((entry) => entry.key),
}, null, 2));

console.log(`bundling ${assets.length} asset(s) into one exe ...`);

await esbuild.build({
  entryPoints: [path.join(root, 'bundle', 'entry.js')],
  outfile: bundleScript,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  legalComments: 'none',
  logLevel: 'warning',
  alias: {
    'ffmpeg-static': path.join(root, 'bundle', 'shims', 'ffmpeg-static.js'),
    'ffprobe-static': path.join(root, 'bundle', 'shims', 'ffprobe-static.js'),
  },
});

fs.writeFileSync(seaConfigFile, JSON.stringify({
  main: bundleScript,
  output: blobFile,
  disableExperimentalSEAWarning: true,
  assets: Object.fromEntries(assets.map((entry) => [entry.key, entry.source])),
}, null, 2));

execFileSync(nodeExe, ['--experimental-sea-config', seaConfigFile], { stdio: 'inherit', cwd: root });

fs.copyFileSync(nodeExe, outFile);
execFileSync(nodeExe, [
  path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
  outFile,
  'NODE_SEA_BLOB',
  blobFile,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit', cwd: root });

/* Console exe -> GUI exe: double-clicking must not open a black window. */
function setWindowedSubsystem(file) {
  const buf = fs.readFileSync(file);
  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOffset) !== 0x00004550) throw new Error('not a PE executable');
  buf.writeUInt16LE(2, peOffset + 24 + 68); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  fs.writeFileSync(file, buf);
}
setWindowedSubsystem(outFile);

const sizeMb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(1);
console.log(`built ${outFile} (${sizeMb} MB, build ${buildId})`);