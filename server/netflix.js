/**
 * Netflix trailer scraper.
 *
 * Netflix's public title pages carry the billboard clip as an `og:video`
 * meta tag; it is a direct MP4 on the Netflix CDN and needs no account.
 * Finding the title id is the hard part because the public search page
 * redirects to the login form, so JustWatch (keyless, region-aware) is used
 * only to map a title to its Netflix URL. Everything after that is scraped
 * from netflix.com itself.
 *
 * The result is cached in memory for a short time; the trailer file itself is
 * downloaded and indexed by server/trailers.js.
 */

import { isOffline } from './settings.js';
import { normalizeTitle } from './imdb.js';

const JUSTWATCH = 'https://apis.justwatch.com/graphql';
const NETFLIX_LOCALE = process.env.NETFLIX_LOCALE || 'ma-en';
const NETFLIX_COUNTRY = process.env.NETFLIX_COUNTRY || 'MA';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SUCCESS_TTL = 30 * 60 * 1000;
const MISS_TTL = 30 * 60 * 1000;

const SEARCH_QUERY = `query GetSearchResults($country: Country!, $language: Language!, $first: Int!, $searchQuery: String!) {
  popularTitles(country: $country, first: $first, filter: {searchQuery: $searchQuery}) {
    edges {
      node {
        __typename
        ... on Movie {
          content(country: $country, language: $language) { title originalReleaseYear }
          offers(country: $country, platform: WEB) { standardWebURL package { clearName } }
        }
        ... on Show {
          content(country: $country, language: $language) { title originalReleaseYear }
          offers(country: $country, platform: WEB) { standardWebURL package { clearName } }
        }
      }
    }
  }
}`;

const cache = new Map();
const inflight = new Map();

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#x2f;|&#0*47;/gi, '/')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/* Attribute order varies between pages, so read the tag first and then pick
 * the two attributes instead of matching one fixed string. */
function metaContent(html, property) {
  for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
    const name = tag.match(/\bproperty\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!name || (name[1] ?? name[2]) !== property) continue;
    const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    return decodeEntities(content?.[1] ?? content?.[2] ?? '');
  }
  return '';
}

/* The billboard player is the video element Yassine pointed at; og:video is
 * the same file with the signed CDN URL. Either one is enough. */
function videoFromPage(html) {
  for (const property of ['og:video:secure_url', 'og:video']) {
    const value = metaContent(html, property);
    if (value) return value;
  }
  const tag = String(html || '').match(/<video\b[^>]*data-uia="hero-billboard-video"[^>]*>/i)?.[0] || '';
  const src = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return src ? decodeEntities(src[1] ?? src[2] ?? '') : '';
}

function isNetflixCdn(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.endsWith('.nflxso.net') || host.endsWith('.nflxvideo.net');
  } catch {
    return false;
  }
}

async function searchJustWatch(item) {
  const title = String(item.seriesTitle || item.title || '').trim();
  if (!title) return [];
  const res = await fetch(JUSTWATCH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      operationName: 'GetSearchResults',
      variables: {
        country: NETFLIX_COUNTRY,
        language: 'en',
        first: 8,
        searchQuery: title,
      },
      query: SEARCH_QUERY,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const edges = data?.data?.popularTitles?.edges;
  return Array.isArray(edges) ? edges.map((edge) => edge?.node).filter(Boolean) : [];
}

function netflixOffers(node) {
  const offers = Array.isArray(node?.offers) ? node.offers : [];
  return offers
    .filter((offer) => /^netflix$/i.test(String(offer?.package?.clearName || '').trim()))
    .map((offer) => String(offer?.standardWebURL || ''))
    .map((url) => {
      const id = url.match(/netflix\.com\/(?:[a-z-]+\/)?title\/(\d{5,12})/i)?.[1];
      return id ? { id, url: `https://www.netflix.com/title/${id}` } : null;
    })
    .filter(Boolean);
}

/* The exact title wins, then the right type, then the closest year. A title
 * that only shares a prefix ("Peaky Blinders: The Immortal Man") is not used. */
function pickCandidate(nodes, item) {
  const wanted = normalizeTitle(item.seriesTitle || item.title);
  const type = item.isSeries ? 'Show' : 'Movie';
  const year = Number(item.year) || 0;
  const ranked = [];
  for (const node of nodes) {
    const title = String(node?.content?.title || '');
    const normalized = normalizeTitle(title);
    if (!normalized || normalized !== wanted) continue;
    const offers = netflixOffers(node);
    if (!offers.length) continue;
    ranked.push({
      node,
      offer: offers[0],
      typeMatch: node.__typename === type,
      yearMatch: year > 1900 && Number(node.content?.originalReleaseYear) === year,
    });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => Number(b.typeMatch) - Number(a.typeMatch)
    || Number(b.yearMatch) - Number(a.yearMatch));
  return ranked[0].offer;
}

async function scrapePage(netflixId) {
  const url = `https://www.netflix.com/${NETFLIX_LOCALE}/title/${netflixId}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const videoUrl = videoFromPage(html);
  if (!isNetflixCdn(videoUrl)) return null;
  return { videoUrl, netflixId, pageUrl: url };
}

/**
 * Resolve the Netflix billboard clip for a library item.
 * Returns { videoUrl, netflixId, pageUrl } or null. Never throws.
 */
export async function netflixTrailer(item) {
  if (!item || isOffline()) return null;
  const title = String(item.seriesTitle || item.title || '').trim();
  if (!title) return null;

  const key = `${item.isSeries ? 'series' : 'movie'}:${normalizeTitle(title)}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.until) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    try {
      const nodes = await searchJustWatch(item);
      const offer = pickCandidate(nodes, item);
      if (!offer) return null;
      return await scrapePage(offer.id);
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  const value = await task;
  cache.set(key, { value, until: Date.now() + (value ? SUCCESS_TTL : MISS_TTL) });
  return value;
}
