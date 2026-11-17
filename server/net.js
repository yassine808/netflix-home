/**
 * The offline switch, enforced at the socket.
 *
 * Offline mode already answers 503 on the routes that need the internet and
 * pauses running downloads, but a route is only one way out of the process. A
 * background timer, a keep-alive connection inside undici, a resolver call or a
 * child process could still reach the network after the switch is flipped. This
 * module closes those doors at the lowest point the process owns:
 *
 *   1. `fetch` refuses any URL that is not loopback.
 *   2. `net.Socket.prototype.connect` refuses the connection itself, which is
 *      where every TCP client ends up: http, https, tls and undici included.
 *   3. `dns.lookup` and the `resolve*` family answer with an error instead of
 *      sending a query.
 *
 * Loopback stays open on purpose: the browser talks to this server, and an
 * aria2c RPC call goes to 127.0.0.1. Neither leaves the machine, so neither is
 * an internet request.
 *
 * `installNetworkGuard()` runs once from index.js. Every block is counted and
 * logged, and `/api/offline/stats` reports the count, so "no internet while
 * offline" can be checked instead of assumed.
 */

import dns from 'node:dns';
import net from 'node:net';
import { isOffline } from './settings.js';

/* Loopback names and addresses. 0.0.0.0 and :: mean "this machine" when they
 * appear as a connect target, so they pass too. */
const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', '127.0.0.1', '0.0.0.0', '::1', '::', '[::1]']);

export function isLoopbackHost(host) {
  const raw = String(host ?? '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  /* No host means Node connects to localhost. */
  if (!raw) return true;
  if (LOOPBACK_NAMES.has(raw)) return true;
  return net.isIP(raw) !== 0 && (raw.startsWith('127.') || raw === '::1' || raw === '0.0.0.0' || raw === '::');
}

/* Schemes that carry a packet somewhere. Anything else (`file:`, `data:`,
 * `blob:`) never leaves the machine and is not this module's business. */
const REMOTE_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'ftps:', 'magnet:']);

let blockCount = 0;
const recentBlocks = [];

function note(kind, target) {
  blockCount += 1;
  const line = `${new Date().toISOString()} ${kind} ${target}`;
  recentBlocks.push(line);
  if (recentBlocks.length > 20) recentBlocks.shift();
  /* The deployed app's console is G:\NETFLIX\launcher.log; a blocked request is
   * a bug we want to see there rather than a silent gap. */
  console.warn(`[offline] blocked ${kind} ${target}`);
}

function gateError(target) {
  const err = new Error(`offline mode is on — internet access is disabled (${target})`);
  err.code = 'EOFFLINE';
  err.offline = true;
  err.status = 503;
  return err;
}

export { gateError };

/** Snapshot for diagnostics: how often the gate fired and against what. */
export function offlineGateStats() {
  return {
    offline: isOffline(),
    installed: installed,
    blocked: blockCount,
    recent: [...recentBlocks],
  };
}

let installed = false;

/* ---- fetch ---- */

function fetchTarget(input) {
  const raw = typeof input === 'string'
    ? input
    : input && typeof input === 'object' && typeof input.url === 'string' ? input.url : '';
  if (!raw) return { remote: false, label: '' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    /* A relative URL is a same-process fetch the browser would never send. */
    return { remote: false, label: raw };
  }
  const remote = REMOTE_SCHEMES.has(url.protocol) && !isLoopbackHost(url.hostname);
  return { remote, label: `${url.protocol}//${url.host}` };
}

function patchFetch() {
  if (typeof globalThis.fetch !== 'function') return;
  const original = globalThis.fetch;
  if (original.__offlineGuard) return;
  const guarded = function fetch(input, init) {
    if (isOffline()) {
      const target = fetchTarget(input);
      if (target.remote) {
        note('fetch', target.label);
        return Promise.reject(gateError(target.label));
      }
    }
    return original.call(this, input, init);
  };
  guarded.__offlineGuard = true;
  globalThis.fetch = guarded;
}

/* ---- sockets ---- */

/* `connect` accepts several shapes:
 *   connect(options[, callback])      - options.host/hostname/port/path
 *   connect(port[, host][, callback])
 *   connect(path[, callback])         - named pipe or unix socket
 * Only the first two can leave the machine, and only when the host is not
 * loopback. */
function connectTarget(args) {
  const first = args[0];
  /* net.connect() and tls.connect() hand the normalised arguments to the socket
   * as a single array: [{ host, port }, callback]. */
  if (Array.isArray(first)) return connectTarget(first);
  if (first && typeof first === 'object') {
    if (first.path) return { local: true, label: String(first.path) };
    const host = first.host || first.hostname || '';
    return { local: isLoopbackHost(host), label: `${host || 'localhost'}:${first.port ?? ''}` };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) {
    return { local: true, label: first };
  }
  const second = args[1];
  const host = typeof second === 'string'
    ? second
    : second && typeof second === 'object' ? second.host || second.hostname || '' : '';
  return { local: isLoopbackHost(host), label: `${host || 'localhost'}:${first ?? ''}` };
}

function patchSockets() {
  const original = net.Socket.prototype.connect;
  if (original.__offlineGuard) return;
  const guarded = function connect(...args) {
    if (isOffline()) {
      const target = connectTarget(args);
      if (!target.local) {
        note('socket', target.label);
        const err = gateError(target.label);
        /* Fail the way a refused connection does: asynchronously, after the
         * caller has attached its listeners. A socket nobody listens on is
         * destroyed quietly instead of raising an unhandled 'error' and taking
         * the whole server down with it. */
        process.nextTick(() => {
          if (this.listenerCount('error') > 0) this.destroy(err);
          else this.destroy();
        });
        return this;
      }
    }
    return original.apply(this, args);
  };
  guarded.__offlineGuard = true;
  net.Socket.prototype.connect = guarded;
}

/* ---- dns ---- */

/* The callback API answers with the error through the callback; the promises
 * API answers with a rejected promise. Neither touches the resolver while
 * offline, so no query is sent. */
function patchDnsPair(target, name, promiseApi) {
  const original = target && target[name];
  if (typeof original !== 'function' || original.__offlineGuard) return;
  const guarded = function guardedDns(host, ...rest) {
    const blocked = isOffline() && !isLoopbackHost(host);
    if (!blocked) return original.call(this, host, ...rest);
    note('dns', String(host));
    const err = gateError(String(host));
    if (promiseApi) return Promise.reject(err);
    const callback = rest[rest.length - 1];
    if (typeof callback === 'function') {
      process.nextTick(() => callback(err));
      return {};
    }
    throw err;
  };
  guarded.__offlineGuard = true;
  target[name] = guarded;
}

function patchDns() {
  for (const name of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
    'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr',
    'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
    patchDnsPair(dns, name, false);
    patchDnsPair(dns.promises, name, true);
  }
}

/** Install every gate. Safe to call twice; the second call is a no-op. */
export function installNetworkGuard() {
  if (installed) return offlineGateStats();
  installed = true;
  patchFetch();
  patchSockets();
  patchDns();
  return offlineGateStats();
}
