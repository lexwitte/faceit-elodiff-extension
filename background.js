const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EMPTY_STATS = { lastSeasonElo: null, highestElo: null };
const cacheKey = (userId) => `stats:${userId}:cs2`;

const MIN_REQUEST_GAP_MS = 300;
const FALLBACK_COOLDOWN_MS = 5 * 1000;
const MAX_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([429, 503]);
// `Date` has one-second resolution, so younger cache hits can't be told apart.
const CACHE_HIT_MIN_AGE_MS = 2000;
// `cf-cache-status` values for responses Cloudflare served without asking the
// origin. REVALIDATED is left out: it sent a conditional request upstream.
const CF_CACHE_HITS = new Set(["HIT", "STALE", "UPDATING"]);

function validElo(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function sanitizeStats(entry) {
  return {
    lastSeasonElo: validElo(entry?.lastSeasonElo) ? entry.lastSeasonElo : null,
    highestElo: validElo(entry?.highestElo) ? entry.highestElo : null
  };
}

async function readCache(userId) {
  const key = cacheKey(userId);
  const data = await chrome.storage.local.get(key);
  const entry = data[key];
  // A missing or malformed timestamp must expire the entry: comparing against
  // undefined yields NaN, which would keep it cached forever.
  if (!entry || !Number.isFinite(entry.ts)) return null;
  const stats = sanitizeStats(entry);
  const ttl = stats.lastSeasonElo == null && stats.highestElo == null ? NEG_CACHE_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - entry.ts > ttl) return null;
  return { ...stats, ts: entry.ts };
}

async function writeCache(userId, stats) {
  await chrome.storage.local.set({
    [cacheKey(userId)]: { ...sanitizeStats(stats), ts: Date.now() }
  });
}

function summarizeSeasons(seasons) {
  // seasonId is a uuid, so recency comes from the response order: oldest to newest.
  const newestFirst = seasons.filter((s) => s && typeof s === "object").reverse();
  const highest = newestFirst.map((s) => s.elo_highest).filter(validElo);

  return {
    lastSeasonElo: newestFirst.slice(1).map((s) => s.elo_end).find(validElo) ?? null,
    highestElo: highest.length ? Math.max(...highest) : null
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One request in flight per route, so a full match room never bursts ten of them
// and a match lookup never waits behind a room's worth of stats. Waits belong to
// FACEIT's rate limits, which `x-faceit-ratelimit-name` names on every response;
// routes that turn out to share a limit share its wait. Until a route's limit is
// known, it is tracked under the route's own name.
const queueTails = new Map(); // route -> tail of its request queue
const limitOfRoute = new Map(); // route -> rate limit name
const nextRequestAt = new Map(); // rate limit name -> earliest next request

// Chrome may stop the worker mid-cooldown; a fresh one must not send early.
const THROTTLE_KEY = "throttle";
const restoredThrottle = chrome.storage.session
  .get(THROTTLE_KEY)
  .then((data) => {
    const saved = data[THROTTLE_KEY];
    for (const [route, limit] of Object.entries(saved?.routes ?? {})) {
      if (!limitOfRoute.has(route) && typeof limit === "string") limitOfRoute.set(route, limit);
    }
    for (const [limit, at] of Object.entries(saved?.schedules ?? {})) {
      if (Number.isFinite(at)) nextRequestAt.set(limit, Math.max(nextRequestAt.get(limit) ?? 0, at));
    }
  })
  .catch((err) => console.error(err));

function persistThrottle() {
  chrome.storage.session
    .set({
      [THROTTLE_KEY]: {
        routes: Object.fromEntries(limitOfRoute),
        schedules: Object.fromEntries(nextRequestAt)
      }
    })
    .catch((err) => console.error(err));
}

const limitFor = (route) => limitOfRoute.get(route) ?? route;
const scheduleFor = (route) => nextRequestAt.get(limitFor(route)) ?? 0;

// Returns whether the route's limit changed. The wait tracked under the old name
// carries over, so learning the name never shortens it.
function learnLimit(route, res) {
  const name = res.headers.get("x-faceit-ratelimit-name")?.trim();
  if (!name || limitOfRoute.get(route) === name) return false;
  nextRequestAt.set(name, Math.max(nextRequestAt.get(name) ?? 0, scheduleFor(route)));
  limitOfRoute.set(route, name);
  return true;
}

// Never moves a limit's next slot earlier: another route sharing it may have just
// been told to back off.
function scheduleNextRequest(route, delay, learned) {
  const limit = limitFor(route);
  nextRequestAt.set(limit, Math.max(nextRequestAt.get(limit) ?? 0, Date.now() + delay));
  // Only waits longer than the normal gap are worth outliving the worker.
  if (learned || delay > MIN_REQUEST_GAP_MS) persistThrottle();
}

function enqueue(route, task) {
  const run = (queueTails.get(route) ?? Promise.resolve()).then(task, task);
  queueTails.set(
    route,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}

function headerNumber(res, name) {
  const raw = res.headers.get(name);
  const value = raw == null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

// `Retry-After` is either delay-seconds or an HTTP date.
function retryAfterMs(res) {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const until = Date.parse(raw);
  if (!Number.isFinite(until)) return null;
  // Measured against the response's own `Date`, so local clock skew cancels out.
  const sent = Date.parse(res.headers.get("date") ?? "");
  return Math.max(until - (Number.isFinite(sent) ? sent : Date.now()), 0);
}

// `ratelimit-reset` is the seconds left in the current window. An explicit
// `Retry-After` on a 429/503 wins and is never shortened by the cap.
function cooldownMs(res, retryable) {
  const retryAfter = retryable ? retryAfterMs(res) : null;
  if (retryAfter != null) return retryAfter;
  const reset = headerNumber(res, "ratelimit-reset");
  if (reset == null) return FALLBACK_COOLDOWN_MS;
  return Math.min(Math.max(reset, 0) * 1000, MAX_COOLDOWN_MS);
}

// The smallest gap seen between the local clock and a response's `Date` header.
// Responses fresh off the network sit at this baseline (clock skew plus latency);
// ones replayed from the HTTP cache keep their original `Date`, so their age adds
// on top of it.
let minDateLagMs = Infinity;

function servedFromBrowserCache(res) {
  const date = Date.parse(res.headers.get("date") ?? "");
  if (!Number.isFinite(date)) return false;
  const lag = Date.now() - date;
  minDateLagMs = Math.min(minDateLagMs, lag);
  return lag - minDateLagMs > CACHE_HIT_MIN_AGE_MS;
}

function servedFromCloudflareCache(res) {
  const status = res.headers.get("cf-cache-status");
  return status != null && CF_CACHE_HITS.has(status.trim().toUpperCase());
}

async function throttledFetch(route, url, init) {
  return enqueue(route, async () => {
    await restoredThrottle;
    for (let attempt = 1; ; attempt++) {
      // A route sharing this limit can push the slot back while we sleep.
      for (let wait; (wait = scheduleFor(route) - Date.now()) > 0; ) await sleep(wait);

      const res = await fetch(url, init);
      // A cache hit never reached the rate-limited API: it spent no budget, and its
      // rate-limit headers are as stale as the entry, so it must not move the schedule.
      if (servedFromBrowserCache(res) || servedFromCloudflareCache(res)) return res;
      const learned = learnLimit(route, res);
      const retryable = RETRY_STATUSES.has(res.status);
      // `ratelimit-remaining` is the request budget left in the window; once it is
      // gone, hold every queued request until the window resets.
      const remaining = headerNumber(res, "ratelimit-remaining") ?? Infinity;
      const outOfBudget = retryable || remaining <= 0;
      const delay = outOfBudget ? cooldownMs(res, retryable) : MIN_REQUEST_GAP_MS;
      scheduleNextRequest(route, delay, learned);

      // A wait beyond the cap still holds the queue, but this caller gets the error
      // now instead of hanging on it.
      if (!retryable || attempt >= MAX_ATTEMPTS || delay > MAX_COOLDOWN_MS) return res;
    }
  });
}

// A rate-limited error carries when the route's queue opens again, so the content
// script can ask then.
function httpError(res, route) {
  const err = new Error(`HTTP ${res.status}`);
  if (RETRY_STATUSES.has(res.status)) err.retryAt = scheduleFor(route);
  return err;
}

async function fetchPlayerStats(userId) {
  const url = `https://www.faceit.com/api/statistics/v1/cs2/players/${encodeURIComponent(userId)}/seasons`;
  const res = await throttledFetch("stats", url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" }
  });
  if (!res.ok) throw httpError(res, "stats");
  const data = await res.json();
  const seasons = data?.payload?.cs2?.seasons;
  if (!Array.isArray(seasons)) throw new Error("Seasons API returned invalid data");
  return summarizeSeasons(seasons);
}

async function getPlayerStats(userId, { force } = {}) {
  if (!userId) return { ...EMPTY_STATS, cached: false, ts: Date.now() };
  if (!force) {
    const cached = await readCache(userId);
    if (cached) return { ...cached, cached: true };
  }
  try {
    const stats = await fetchPlayerStats(userId);
    await writeCache(userId, stats);
    return { ...stats, cached: false, ts: Date.now() };
  } catch (err) {
    console.error(err);
    return { ...EMPTY_STATS, cached: false, ts: Date.now(), error: String(err), retryAt: err?.retryAt ?? null };
  }
}

// Cache entries written by the pre-seasons-API versions are never read again.
async function pruneLegacyCache() {
  const all = await chrome.storage.local.get(null);
  const legacy = Object.keys(all).filter((k) => k.startsWith("elo:") || k.startsWith("season:"));
  if (legacy.length) await chrome.storage.local.remove(legacy);
}

async function fetchMatch(matchId) {
  const url = `https://www.faceit.com/api/match/v2/match/${encodeURIComponent(matchId)}`;
  const res = await throttledFetch("match", url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" }
  });
  if (!res.ok) throw httpError(res, "match");
  return res.json();
}

chrome.runtime.onInstalled.addListener(() => {
  pruneLegacyCache().catch((err) => console.error(err));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "getMatch") {
        const data = await fetchMatch(msg.matchId);
        sendResponse({ ok: true, data });
      } else if (msg?.type === "getPlayerStats") {
        const result = await getPlayerStats(msg.userId, { force: !!msg.force });
        sendResponse({ ok: true, ...result });
      } else if (msg?.type === "clearCache") {
        await chrome.storage.local.clear();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "unknown message type" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err), retryAt: err?.retryAt ?? null });
    }
  })();
  return true;
});
