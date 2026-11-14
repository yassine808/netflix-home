/**
 * One SQLite database for everything the app knows about the library.
 *
 * Before this, metadata lived in meta.json, pictures in pictures.db, hero
 * clips in library.db and trailers in trailers.db, while artwork, subtitles
 * and audio tracks were only files on disk. Every screen then had to stat,
 * readdir or ffprobe before it could answer. Now a single connection owns one
 * WAL database (`<library>\.cache\catalog.db`) and the small things - posters,
 * backdrops, logos, subtitle text, audio-track info, intro windows - live in
 * it. Large media (thumbnails, hero previews, trailers, dubbed audio) stay in
 * their cache folders but are indexed here, so a lookup is one indexed SELECT
 * instead of a directory scan.
 *
 * Optimisations that matter here:
 *   - WAL + synchronous=NORMAL: readers never block the scanner writer.
 *   - One connection, prepared statements reused by each module.
 *   - mmap + a 32 MB page cache keeps the hot index in memory.
 *   - Every scan writes inside one transaction.
 *   - Legacy pictures.db / library.db / trailers.db rows are copied once on
 *     first start, so upgrading does not regenerate any thumbnails or clips.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = createRequire(process.execPath)('node:sqlite'));
} catch {
  console.warn('node:sqlite is unavailable; the catalog database will not persist');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL UNIQUE,
  series_key TEXT,
  collection TEXT,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_series ON items(series_key);
CREATE INDEX IF NOT EXISTS items_collection ON items(collection);
CREATE INDEX IF NOT EXISTS items_mtime ON items(mtime DESC);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  path TEXT,
  blob BLOB,
  etag TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id, kind)
);
CREATE INDEX IF NOT EXISTS assets_kind ON assets(kind);

CREATE TABLE IF NOT EXISTS subtitles (
  item_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  label TEXT,
  body TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, lang)
);
CREATE INDEX IF NOT EXISTS subtitles_item ON subtitles(item_id);

CREATE TABLE IF NOT EXISTS subtitle_scans (
  item_id TEXT PRIMARY KEY,
  dir_mtime INTEGER NOT NULL,
  scanned_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audio_probe (
  item_id TEXT PRIMARY KEY,
  source_size INTEGER NOT NULL,
  source_mtime INTEGER NOT NULL,
  probed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audio_tracks (
  item_id TEXT NOT NULL,
  stream_index INTEGER NOT NULL,
  position INTEGER NOT NULL,
  lang TEXT,
  title TEXT,
  codec TEXT,
  channels INTEGER,
  bit_rate INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  variant_path TEXT,
  PRIMARY KEY (item_id, stream_index)
);

CREATE TABLE IF NOT EXISTS picture (
  key TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  width INTEGER NOT NULL,
  source_size INTEGER NOT NULL,
  source_mtime INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  seek_sec REAL NOT NULL,
  score REAL NOT NULL,
  built_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS picture_id ON picture(id);

CREATE TABLE IF NOT EXISTS hero (
  id TEXT PRIMARY KEY,
  source_size INTEGER NOT NULL,
  source_mtime INTEGER NOT NULL,
  start_sec REAL NOT NULL,
  image_path TEXT NOT NULL,
  video_path TEXT NOT NULL,
  built_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trailers (
  id TEXT PRIMARY KEY,
  imdb_id TEXT,
  youtube_id TEXT,
  title TEXT,
  path TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS intro (
  key TEXT PRIMARY KEY,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  source TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);

/* Directory index: the scanner trusts a directory whose mtime is unchanged
 * instead of stat-ing every file inside it again on each launch. */
CREATE TABLE IF NOT EXISTS dirs (
  rel_path TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  entries TEXT NOT NULL,
  scanned_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_state (
  root TEXT PRIMARY KEY,
  root_mtime INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  last_scan INTEGER NOT NULL,
  last_ms INTEGER NOT NULL
);
`;

let db = null;
let dbFile = null;

export function initDb(cacheDir) {
  if (db) return db;
  dbFile = path.join(cacheDir, 'catalog.db');
  if (!DatabaseSync) return null;
  try {
    // A first run on a fresh drive has no .cache folder yet.
    fs.mkdirSync(cacheDir, { recursive: true });
    db = new DatabaseSync(dbFile);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA cache_size = -32000;
      PRAGMA mmap_size = 268435456;
      /* Keep the WAL small: checkpoint often, cap it at 8 MB. */
      PRAGMA wal_autocheckpoint = 512;
      PRAGMA journal_size_limit = 8388608;
    `);
    db.exec(SCHEMA);
    migrateLegacy(cacheDir);
    try {
      db.exec('PRAGMA optimize');
    } catch {
      /* older SQLite builds may not support it */
    }
    return db;
  } catch (err) {
    db = null;
    console.warn('catalog database disabled:', err?.message || String(err));
    return null;
  }
}

/* Copy rows from the old per-feature databases exactly once. The old files
 * stay on disk (destroying them buys nothing); the copy only happens when the
 * matching catalog table is still empty. */
function migrateLegacy(cacheDir) {
  const copies = [
    ['pictures.db', 'picture'],
    ['library.db', 'hero'],
    ['trailers.db', 'trailers'],
  ];
  for (const [file, table] of copies) {
    const full = path.join(cacheDir, file);
    if (!fs.existsSync(full)) continue;
    try {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n || 0;
      if (count > 0) continue;
      const alias = `legacy_${table}`;
      db.exec(`ATTACH DATABASE '${full.replace(/'/g, "''")}' AS ${alias}`);
      try {
        const columnCount = db.prepare(`PRAGMA ${alias}.table_info(${table})`).all().length;
        if (!columnCount) continue;
        db.exec(`INSERT OR IGNORE INTO ${table} SELECT * FROM ${alias}.${table}`);
      } finally {
        db.exec(`DETACH DATABASE ${alias}`);
      }
    } catch (err) {
      console.warn(`legacy ${file} import skipped:`, err?.message || String(err));
    }
  }
}

export function getDb() {
  return db;
}

export function isDbReady() {
  return Boolean(db);
}

/* Run a batch of writes atomically. Falls back to a plain call when SQLite is
 * unavailable, so every caller keeps working without a database. */
export function transaction(fn) {
  if (!db) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export function hash32(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 32);
}

export function getAsset(id, kind) {
  if (!db) return null;
  try {
    return db.prepare('SELECT id, kind, mime, bytes, path, blob, etag FROM assets WHERE id = ? AND kind = ?')
      .get(String(id), String(kind)) || null;
  } catch {
    return null;
  }
}

/* Small pictures and wordmarks are stored as BLOBs: no path lookup, no file
 * handle, one row read. The etag lets the browser skip the body entirely. */
export function putAsset({ id, kind, mime, buffer, path: filePath = null }) {
  if (!db) return null;
  const bytes = buffer ? buffer.length : 0;
  const etag = buffer ? `"${hash32(buffer)}"` : null;
  try {
    db.prepare(`INSERT INTO assets (id, kind, mime, bytes, path, blob, etag, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, kind) DO UPDATE SET
        mime = excluded.mime,
        bytes = excluded.bytes,
        path = excluded.path,
        blob = excluded.blob,
        etag = excluded.etag,
        updated_at = excluded.updated_at`)
      .run(String(id), String(kind), mime || null, bytes, filePath, buffer || null, etag, Date.now());
    return { mime, buffer, path: filePath, etag };
  } catch {
    return null;
  }
}

export function getKv(key) {
  if (!db) return null;
  try {
    return db.prepare('SELECT value FROM kv WHERE key = ?').get(String(key))?.value ?? null;
  } catch {
    return null;
  }
}

export function setKv(key, value) {
  if (!db) return;
  try {
    db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(String(key), String(value), Date.now());
  } catch {
    /* metadata is best effort */
  }
}

/* Index statistics after a scan that moved a lot of rows. Cheap, and without
 * it a large library keeps whatever plan SQLite guessed on an empty table. */
export function analyzeDb() {
  if (!db) return false;
  try {
    db.exec('ANALYZE');
    return true;
  } catch {
    return false;
  }
}

let lastPurge = 0;
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
const ORPHAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/* Rows whose title is gone. Artwork is keyed by series as well as by item, so
 * both columns count as owners; anything unreferenced for 30 days is stale. */
export function purgeOrphans({ force = false } = {}) {
  if (!db) return 0;
  if (!force && Date.now() - lastPurge < PURGE_EVERY_MS) return 0;
  lastPurge = Date.now();
  const cutoff = Date.now() - ORPHAN_MAX_AGE_MS;
  const owned = 'SELECT id FROM items UNION SELECT series_key FROM items WHERE series_key IS NOT NULL';
  let removed = 0;
  try {
    removed += Number(db.prepare(`DELETE FROM assets WHERE updated_at < ?
      AND id NOT IN (${owned})`).run(cutoff).changes) || 0;
    removed += Number(db.prepare(`DELETE FROM subtitles WHERE updated_at < ?
      AND item_id NOT IN (SELECT id FROM items)`).run(cutoff).changes) || 0;
    removed += Number(db.prepare(`DELETE FROM audio_tracks WHERE item_id NOT IN (SELECT id FROM items)`).run().changes) || 0;
    removed += Number(db.prepare(`DELETE FROM audio_probe WHERE item_id NOT IN (SELECT id FROM items)`).run().changes) || 0;
  } catch {
    /* best effort */
  }
  return removed;
}

let lastVacuum = 0;
const VACUUM_EVERY_MS = 24 * 60 * 60 * 1000;

/* VACUUM only pays off when a quarter of the file is free pages. Returns true
 * when the file was rewritten. */
export function maybeVacuum({ force = false } = {}) {
  if (!db) return false;
  if (!force && Date.now() - lastVacuum < VACUUM_EVERY_MS) return false;
  try {
    const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count) || 0;
    const free = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count) || 0;
    if (!pages || free / pages < 0.25) return false;
    lastVacuum = Date.now();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.exec('PRAGMA optimize');
    return true;
  } catch {
    return false;
  }
}

/* Counts + file size, for verifying what is actually stored. */
export function dbStats() {
  if (!db || !dbFile) return { ready: false };
  const tables = ['items', 'assets', 'subtitles', 'audio_tracks', 'picture', 'hero', 'trailers', 'intro', 'dirs'];
  const counts = {};
  for (const table of tables) {
    try {
      counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    } catch {
      counts[table] = 0;
    }
  }
  const sizeOf = (file) => {
    try { return fs.statSync(file).size; } catch { return 0; }
  };
  return {
    ready: true,
    file: dbFile,
    bytes: sizeOf(dbFile) + sizeOf(`${dbFile}-wal`) + sizeOf(`${dbFile}-shm`),
    mainBytes: sizeOf(dbFile),
    walBytes: sizeOf(`${dbFile}-wal`),
    tables: counts,
  };
}
