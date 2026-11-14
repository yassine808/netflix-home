/**
 * Torrentio (Stremio addon) client — keyless.
 *
 * Torrentio answers with the releases a set of indexers know for one IMDb id.
 * Every stream carries a magnet info hash, a file index inside the torrent and
 * a human-readable `title` blob. This module parses that blob into a flat
 * release object, ranks the releases for this app's constraints (Brave must be
 * able to play the file without a re-encode) and hands back a magnet link.
 *
 * API:
 *   series  /stream/series/<imdbId>:<season>:<episode>.json
 *   movie   /stream/movie/<imdbId>.json
 *   body    { streams: [...] }
 *
 * A stream looks like:
 *   {
 *     name: 'Torrentio\n1080p',
 *     title: '[Group] Show [BD][4k][HEVC 10bit x265][Dual Audio]\n' +
 *            'Season 1/Show - S01E01 - Title.mkv\n' +
 *            '👤 13 💾 1.7 GB ⚙️ 1337x\n' +
 *            'Dubbed / Dual Audio / 🇬🇧',
 *     infoHash: 'a759f18cc838b14683703afe8abbda08cb82728a',
 *     fileIdx: 0,
 *     behaviorHints: { filename: 'Show - S01E01 - Title.mkv' }
 *   }
 *
 * Line counts vary between indexers, so every field is located by its marker
 * (👤 / 💾 / ⚙️) rather than by a fixed line number.
 */

export const TORRENTIO_BASE = 'https://torrentio.strem.fun';

const UA = 'Mozilla/5.0';
const TIMEOUT_MS = 20000;

const HASH_RE = /^[0-9a-f]{40}$/i;
const MB = 1024 * 1024;

/* Region flags -> the language a viewer would expect behind them. Best effort:
 * a flag names a country, not a language, so ambiguous countries are left out. */
const COUNTRY_LANG = {
  GB: 'en', UK: 'en', US: 'en', AU: 'en', NZ: 'en', IE: 'en', CA: 'en',
  JP: 'ja', FR: 'fr', DE: 'de', AT: 'de', CH: 'de', ES: 'es', MX: 'es',
  AR: 'es', CO: 'es', CL: 'es', PE: 'es', IT: 'it', KR: 'ko', CN: 'zh',
  TW: 'zh', HK: 'zh', SG: 'zh', PT: 'pt', BR: 'pt', RU: 'ru', IN: 'hi',
  AE: 'ar', SA: 'ar', EG: 'ar', NL: 'nl', BE: 'nl', SE: 'sv', DK: 'da',
  NO: 'no', FI: 'fi', PL: 'pl', TR: 'tr', TH: 'th', VN: 'vi', ID: 'id',
  IL: 'he', CZ: 'cs', HU: 'hu', GR: 'el', UA: 'uk', RO: 'ro',
};

/* Full language names and 3-letter codes accepted by rankReleases for
 * `originalLanguage`, mapped to the 2-letter form the flags produce. */
const LANG_ALIASES = {
  english: 'en', eng: 'en',
  japanese: 'ja', jpn: 'ja', jp: 'ja',
  french: 'fr', fre: 'fr', fra: 'fr',
  german: 'de', ger: 'de', deu: 'de',
  spanish: 'es', spa: 'es',
  italian: 'it', ita: 'it',
  korean: 'ko', kor: 'ko',
  chinese: 'zh', chi: 'zh', zho: 'zh', mandarin: 'zh', cantonese: 'zh',
  portuguese: 'pt', por: 'pt', russian: 'ru', rus: 'ru',
  hindi: 'hi', hin: 'hi', arabic: 'ar', ara: 'ar',
  dutch: 'nl', nld: 'nl', swedish: 'sv', swe: 'sv',
  danish: 'da', dan: 'da', norwegian: 'no', nor: 'no',
  finnish: 'fi', fin: 'fi', polish: 'pl', pol: 'pl',
  turkish: 'tr', tur: 'tr', thai: 'th', tha: 'th',
  vietnamese: 'vi', vie: 'vi', indonesian: 'id', ind: 'id',
  hebrew: 'he', heb: 'he', czech: 'cs', ces: 'cs',
  hungarian: 'hu', hun: 'hu', greek: 'el', ell: 'el',
  ukrainian: 'uk', ukr: 'uk', romanian: 'ro', ron: 'ro',
};

const SIZE_UNITS = {
  B: 1,
  KB: 1024, KIB: 1024,
  MB: MB, MIB: MB,
  GB: 1024 * MB, GIB: 1024 * MB,
  TB: 1024 * 1024 * MB, TIB: 1024 * 1024 * MB,
};

const QUALITY_POINTS = { '1080p': 300, '2160p': 150, '720p': 120, '480p': 40, sd: 0 };
const CODEC_POINTS = { h264: 400, hevc: -160, av1: -200 };
const CODEC_LABEL = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', other: 'video' };

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSize(text) {
  const match = /💾\s*([\d.,]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)\b/i.exec(text);
  if (!match) return 0;
  const value = Number(match[1].replace(/,/g, ''));
  const unit = SIZE_UNITS[match[2].toUpperCase()];
  if (!Number.isFinite(value) || !unit) return 0;
  return Math.round(value * unit);
}

function parseSeeders(text) {
  const match = /👤\s*([\d.,]+)/.exec(text);
  return match ? num(match[1].replace(/,/g, '')) : 0;
}

function parseProvider(text) {
  const match = /⚙\uFE0F?\s*([^\n]+)/.exec(text);
  return match ? match[1].trim() : '';
}

function basename(value) {
  const parts = String(value || '').split(/[\\/]/);
  return parts[parts.length - 1].trim();
}

/* Flag emojis are pairs of regional indicators; a tag list such as
 * "🇬🇧 🇯🇵" is the only reliable language hint Torrentio gives us. */
function flagLanguages(text) {
  const codes = new Set();
  const points = Array.from(String(text || ''), (ch) => ch.codePointAt(0));
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i] - 0x1f1e6;
    const b = points[i + 1] - 0x1f1e6;
    if (a >= 0 && a < 26 && b >= 0 && b < 26) {
      const country = String.fromCharCode(65 + a) + String.fromCharCode(65 + b);
      const lang = COUNTRY_LANG[country];
      if (lang) codes.add(lang);
      i += 1;
    }
  }
  return [...codes];
}

function flagCount(text) {
  let count = 0;
  const points = Array.from(String(text || ''), (ch) => ch.codePointAt(0));
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i] - 0x1f1e6;
    const b = points[i + 1] - 0x1f1e6;
    if (a >= 0 && a < 26 && b >= 0 && b < 26) {
      count += 1;
      i += 1;
    }
  }
  return count;
}

/* Indexer tags: "Dubbed / Dual Audio / 🇬🇧". Flags become `languages`, not
 * tags, so the tag list stays text-only. */
function parseTags(line) {
  return String(line || '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && !/^[\p{Regional_Indicator}\s]+$/u.test(part));
}

const CAM_RE = /\b(?:hq[- ]?cam|cam|hdts|ts)\b/i;
const RES_RE = /(2160p|1080p|720p|480p|4k)/i;

function qualityFor(name, fileName, bucket) {
  const haystacks = [name, fileName, bucket].filter(Boolean);
  if (haystacks.some((text) => CAM_RE.test(text))) return 'cam';
  // The release title is the most trustworthy place for a resolution token.
  const inName = RES_RE.exec(name || '');
  if (inName) return /^4k$/i.test(inName[1]) ? '2160p' : inName[1].toLowerCase();
  for (const text of haystacks) {
    const match = RES_RE.exec(text);
    if (match) return /^4k$/i.test(match[1]) ? '2160p' : match[1].toLowerCase();
  }
  return 'sd';
}

/* Codec comes from the earliest match in the title + file name, so a title such
 * as "x265 10bit H.264 fallback" keeps the HEVC reading instead of the trailing
 * H.264 mention. Ties break hevc -> av1 -> h264. */
const CODEC_RES = [
  ['hevc', /hevc|x[. ]?265|h[. ]?265/i],
  ['av1', /\bav1\b/i],
  ['h264', /h[. ]?264|x264|avc\b/i],
];

function codecFor(text) {
  let best = null;
  let bestIndex = Infinity;
  for (const [codec, re] of CODEC_RES) {
    const match = re.exec(text);
    if (match && match.index < bestIndex) {
      best = codec;
      bestIndex = match.index;
    }
  }
  return best || 'other';
}

/**
 * Turn one Torrentio stream into a release, or null when it has no usable hash.
 */
export function parseStream(stream) {
  if (!stream || typeof stream !== 'object') return null;
  const infoHash = String(stream.infoHash || '').trim().toLowerCase();
  if (!HASH_RE.test(infoHash)) return null;

  const nameLines = String(stream.name || '').split('\n');
  const titleLines = String(stream.title || '').split('\n');
  const bucket = (nameLines[1] || '').trim();
  // The tag line sits after the stats line and carries no 👤/💾/⚙ marker; a
  // three-line title has no tag line at all.
  const tail = titleLines[titleLines.length - 1] || '';
  const flagsLine = titleLines.length > 3 && !/[👤💾⚙]/.test(tail) ? tail : '';

  const name = (titleLines[0] || nameLines[0] || '').trim();
  const fileHint = stream?.behaviorHints?.filename;
  const fileName = (fileHint ? String(fileHint).trim() : '') || basename(titleLines[1]);
  const searchText = `${name}\n${fileName}`;

  const languages = flagLanguages(titleLines.join('\n'));
  const dualAudio = /dual[- ]?audio|multi[- ]?audio|\bdual\b/i.test(searchText)
    || flagCount(titleLines.join('\n')) >= 2;

  const isPack = (/s\d{1,2}\b|season\s*\d+|complete/i.test(name))
    && !/s\d{1,2}\s*e\d{1,3}/i.test(fileName);

  return {
    infoHash,
    fileIdx: Number.isInteger(stream.fileIdx) ? stream.fileIdx : num(stream.fileIdx),
    name,
    fileName,
    provider: parseProvider(stream.title || ''),
    sizeBytes: parseSize(stream.title || ''),
    seeders: parseSeeders(stream.title || ''),
    quality: qualityFor(name, fileName, bucket),
    codec: codecFor(`${searchText}\n${bucket}`),
    dualAudio,
    languages,
    tags: parseTags(flagsLine),
    isPack,
    score: 0,
    reasons: [],
  };
}

/**
 * Raw, unranked releases for one movie or one episode, deduped by
 * infoHash + fileIdx. Throws when Torrentio itself fails.
 */
export async function findReleases({ imdbId, isSeries = true, season = 0, episode = 0 } = {}) {
  const id = String(imdbId || '').trim();
  if (!id) return [];
  const path = isSeries
    ? `series/${id}:${num(season)}:${num(episode)}`
    : `movie/${id}`;
  const url = `${TORRENTIO_BASE}/stream/${path}.json`;

  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`torrentio HTTP ${res.status}`);
  const data = await res.json();
  const streams = Array.isArray(data?.streams) ? data.streams : [];

  const seen = new Set();
  const releases = [];
  for (const stream of streams) {
    const release = parseStream(stream);
    if (!release) continue;
    // A movie inside a multi-file torrent is a collection pack, not a release.
    if (!isSeries && release.fileIdx > 0) release.moviePack = true;
    const key = `${release.infoHash}:${release.fileIdx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    releases.push(release);
  }
  return releases;
}

/* Size: a 300 MB - 2.5 GB episode downloads quickly and streams comfortably.
 * Penalties grow linearly outside that band (2.5-4 GB) and are capped at
 * -80 above 4 GB and -40 below 250 MB. */
function sizePenalty(bytes) {
  if (!bytes) return 0;
  const sizeMb = bytes / MB;
  if (sizeMb > 4096) return -80;
  if (sizeMb >= 2500) return -80 * ((sizeMb - 2500) / (4096 - 2500));
  if (sizeMb >= 300) return 0;
  if (sizeMb >= 250) return -40 * ((300 - sizeMb) / 50);
  return -40;
}

function languageCode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (/^[a-z]{2}$/.test(raw)) return raw;
  return LANG_ALIASES[raw] || '';
}

/**
 * Rank releases for playback in this app. Deterministic: the same list always
 * produces the same order.
 *
 *   1. Drop anything under 3 seeders (a dead torrent never finishes).
 *   2. Drop CAM/TS rips.
 *   3. Quality: 1080p +300, 2160p +150 (big files, slow), 720p +120,
 *      480p +40, sd 0.
 *   4. Codec: h264 +400 (plays in Brave without work), hevc -160 (needs a full
 *      re-encode), av1 -200.
 *   5. Audio: dual audio +250; +120 more when English plus another language is
 *      offered, +60 when English is the only one.
 *   6. Seeders: min(400, seeders) / 2 points. Health dominates: a 462-seeder
 *      release downloads in ~90 s, a 26-seeder one can stall for minutes.
 *   7. Size: see sizePenalty().
 *   8. Packs cost -10: the same download for one episode, less predictable.
 *   9. originalLanguage +80 when its 2-letter form is advertised.
 */
export function rankReleases(releases, { originalLanguage = '' } = {}) {
  if (!Array.isArray(releases)) return [];
  const wanted = languageCode(originalLanguage);
  const ranked = [];

  for (const release of releases) {
    if (!release) continue;
    if (num(release.seeders) < 3) continue;
    if (release.quality === 'cam') continue;

    let score = 0;
    const reasons = [];

    if (release.codec === 'h264' || release.codec === 'hevc' || release.codec === 'av1') {
      score += CODEC_POINTS[release.codec];
      reasons.push(release.codec);
    }

    if (release.quality !== 'sd') {
      score += QUALITY_POINTS[release.quality] ?? 0;
      reasons.push(release.quality);
    }

    const languages = Array.isArray(release.languages) ? release.languages : [];
    if (release.dualAudio) {
      score += 250;
      reasons.push('dual audio');
    }
    if (languages.includes('en') && languages.length > 1) {
      score += 120;
      reasons.push('en + other');
    } else if (languages.length === 1 && languages[0] === 'en') {
      score += 60;
      reasons.push('english');
    }

    score += Math.min(400, num(release.seeders)) / 2;
    reasons.push(`${num(release.seeders)} seeders`);

    const penalty = sizePenalty(num(release.sizeBytes));
    if (penalty !== 0) {
      score += penalty;
      reasons.push(penalty < -50 ? 'very large' : penalty < 0 ? 'size' : 'small');
    }

    if (release.isPack) {
      score -= 10;
      reasons.push('pack');
    }

    /* A movie that sits inside a multi-film torrent is a bad fit: the picker
     * would still select one file, but the swarm is shaped for a collection. */
    if (release.moviePack) {
      score -= 250;
      reasons.push('movie pack');
    }

    if (wanted && languages.includes(wanted)) {
      score += 80;
      reasons.push(`original ${wanted}`);
    }

    release.score = Math.round(score * 10) / 10;
    release.reasons = reasons;
    ranked.push(release);
  }

  return ranked.sort((a, b) => b.score - a.score || b.seeders - a.seeders);
}

/** Magnet link for a parsed release. */
export function magnetFor(release) {
  const name = String(release?.name || '');
  return `magnet:?xt=urn:btih:${release.infoHash}&dn=${encodeURIComponent(name)}`;
}

/** Short human label for a release row: "1080p H.264 · 462 seeders". */
export function releaseLabel(release) {
  if (!release) return '';
  const quality = release.quality === 'sd' ? 'SD' : String(release.quality || '');
  const codec = CODEC_LABEL[release.codec] || CODEC_LABEL.other;
  const seeders = num(release.seeders);
  return `${quality} ${codec} · ${seeders} seeders`;
}

/** Brave plays H.264 natively; this is the flag callers branch on. */
export function isH264(release) {
  return release?.codec === 'h264';
}
