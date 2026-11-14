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

/* Castle rating / watch-count snapshots. Persisted so a restart or a Castle
 * outage still shows the last known score. */
CREATE TABLE IF NOT EXISTS castle_stats (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

/* Complete Castle title snapshots: description, tags, seasons, episodes,
 * resolutions and the original artwork URLs. The sheet reads this row first,
 * so a title opens instantly and keeps working offline; Sync refreshes it. */
CREATE TABLE IF NOT EXISTS castle_titles (
  id TEXT PRIMARY KEY,
  series_key TEXT,
  search_key TEXT,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS castle_titles_series ON castle_titles(series_key);
CREATE INDEX IF NOT EXISTS castle_titles_search ON castle_titles(search_key);

/* Castle artwork downloaded through the server. The address is the upstream
 * CDN location; the blob is the saved copy. Rows exist as soon as a title is
 * saved, even before the bytes arrive, so the art route knows where to fetch
 * from. */
CREATE TABLE IF NOT EXISTS castle_media (
  key TEXT PRIMARY KEY,
  castle_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  blob BLOB,
  etag TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS castle_media_title ON castle_media(castle_id);

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
    // Older databases grew the title table before the series key column.
    try {
      db.exec('ALTER TABLE castle_titles ADD COLUMN series_key TEXT');
    } catch {
      /* column already exists */
    }
    try {
      db.exec('ALTER TABLE castle_titles ADD COLUMN search_key TEXT');
    } catch {
      /* column already exists */
    }
    try {
      db.exec('CREATE INDEX IF NOT EXISTS castle_titles_series ON castle_titles(series_key)');
      db.exec('CREATE INDEX IF NOT EXISTS castle_titles_search ON castle_titles(search_key)');
    } catch {
      /* best effort */
    }
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

/* Last saved Castle rating for one id. The row never expires; callers decide
 * when to refresh and fall back to it when the network fails. */
export function getCastleStat(id) {
  if (!db) return null;
  try {
    const row = db.prepare('SELECT payload, fetched_at FROM castle_stats WHERE id = ?')
      .get(String(id));
    if (!row) return null;
    return { ...JSON.parse(row.payload), fetchedAt: Number(row.fetched_at) || 0 };
  } catch {
    return null;
  }
}

export function putCastleStat(stats) {
  if (!db || !stats || !stats.id) return null;
  try {
    db.prepare(`INSERT INTO castle_stats (id, payload, fetched_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        fetched_at = excluded.fetched_at`)
      .run(String(stats.id), JSON.stringify(stats), Date.now());
    return stats;
  } catch {
    return null;
  }
}

/* Saved Castle title, or null. `fetchedAt` is kept out of the payload so the
 * stored JSON is exactly what Castle returned, normalized. */
export function getCastleTitleSaved(id) {
  if (!db) return null;
  try {
    const row = db.prepare('SELECT payload, fetched_at FROM castle_titles WHERE id = ?')
      .get(String(id));
    if (!row) return null;
    return { ...JSON.parse(row.payload), fetchedAt: Number(row.fetched_at) || 0 };
  } catch {
    return null;
  }
}

export function getCastleTitleBySeriesKey(seriesKey) {
  if (!db || !seriesKey) return null;
  try {
    const row = db.prepare(`SELECT payload, fetched_at FROM castle_titles
      WHERE series_key = ? OR search_key = ?
      ORDER BY fetched_at DESC LIMIT 1`)
      .get(String(seriesKey), String(seriesKey));
    if (!row) return null;
    return { ...JSON.parse(row.payload), fetchedAt: Number(row.fetched_at) || 0 };
  } catch {
    return null;
  }
}

export function putCastleTitleSaved(title) {
  if (!db || !title || !title.id) return null;
  try {
    const { fetchedAt, seriesKey, searchKey, ...payload } = title;
    db.prepare(`INSERT INTO castle_titles (id, series_key, search_key, payload, fetched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        series_key = excluded.series_key,
        search_key = excluded.search_key,
        payload = excluded.payload,
        fetched_at = excluded.fetched_at`)
      .run(String(title.id), seriesKey || null, searchKey || null, JSON.stringify(payload), Number(fetchedAt) || Date.now());
    return title;
  } catch {
    return null;
  }
}

export function listCastleTitleIds() {
  if (!db) return [];
  try {
    return db.prepare('SELECT id FROM castle_titles ORDER BY id')
      .all()
      .map((row) => String(row.id));
  } catch {
    return [];
  }
}

export function castleTitleCount() {
  if (!db) return 0;
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM castle_titles').get()?.n || 0;
  } catch {
    return 0;
  }
}

/* Castle rotates the CDN host while keeping the image path. Two URLs with the
 * same path are the same picture, so a host change updates the address but
 * keeps the saved bytes instead of downloading them again. */
function mediaPath(url) {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url || '');
  }
}

/* Artwork index row. The URL is recorded before the bytes exist so the art
 * route can download on first request; a changed image path drops the blob. */
export function indexCastleMedia({ key, castleId, kind, url }) {
  if (!db || !key || !url) return null;
  try {
    const old = db.prepare('SELECT url FROM castle_media WHERE key = ?').get(String(key));
    if (!old) {
      db.prepare(`INSERT INTO castle_media (key, castle_id, kind, url, mime, bytes, blob, etag, updated_at)
        VALUES (?, ?, ?, ?, NULL, 0, NULL, NULL, ?)`)
        .run(String(key), String(castleId), String(kind), String(url), Date.now());
    } else if (String(old.url) !== String(url)) {
      if (mediaPath(old.url) === mediaPath(url)) {
        db.prepare(`UPDATE castle_media
          SET castle_id = ?, kind = ?, url = ?, updated_at = ?
          WHERE key = ?`)
          .run(String(castleId), String(kind), String(url), Date.now(), String(key));
      } else {
        db.prepare(`UPDATE castle_media
          SET castle_id = ?, kind = ?, url = ?, mime = NULL, bytes = 0, blob = NULL, etag = NULL, updated_at = ?
          WHERE key = ?`)
          .run(String(castleId), String(kind), String(url), Date.now(), String(key));
      }
    }
    return true;
  } catch {
    return null;
  }
}

export function getCastleMedia(key) {
  if (!db) return null;
  try {
    return db.prepare('SELECT key, castle_id, kind, url, mime, bytes, blob, etag FROM castle_media WHERE key = ?')
      .get(String(key)) || null;
  } catch {
    return null;
  }
}

/* Cheap existence check for the warm pass: reads the byte count without
 * pulling the image BLOB into memory. */
export function castleMediaReady(key) {
  if (!db) return false;
  try {
    return (db.prepare('SELECT bytes FROM castle_media WHERE key = ?').get(String(key))?.bytes || 0) > 1024;
  } catch {
    return false;
  }
}

export function putCastleMediaBlob({ key, mime, buffer }) {
  if (!db || !key || !buffer?.length) return null;
  const etag = `"${hash32(buffer)}"`;
  try {
    db.prepare(`UPDATE castle_media
      SET mime = ?, bytes = ?, blob = ?, etag = ?, updated_at = ?
      WHERE key = ?`)
      .run(mime || 'image/jpeg', buffer.length, buffer, etag, Date.now(), String(key));
    return { key, mime: mime || 'image/jpeg', bytes: buffer.length, etag };
  } catch {
    return null;
  }
}

export function castleMediaCount() {
  if (!db) return 0;
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM castle_media WHERE bytes > 1024').get()?.n || 0;
  } catch {
    return 0;
  }
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
