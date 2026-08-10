const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EMPTY_STATS = { lastSeasonElo: null, highestElo: null };
const cacheKey = (userId) => `stats:${userId}:cs2`;

const MIN_REQUEST_GAP_MS = 300;
const FALLBACK_COOLDOWN_MS = 5 * 1000;
const MAX_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([429, 503]);

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
    lastSeasonElo: newestFirst.map((s) => s.elo_end).find(validElo) ?? null,
    highestElo: highest.length ? Math.max(...highest) : null
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One request in flight at a time, so a full match room never bursts ten of them.
let queueTail = Promise.resolve();
let nextRequestAt = 0;

function enqueue(task) {
  const run = queueTail.then(task, task);
  queueTail = run.then(
    () => {},
    () => {}
  );
  return run;
}

function headerNumber(res, name) {
  const raw = res.headers.get(name);
  const value = raw == null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

// `ratelimit-reset` is the seconds left in the current window.
function cooldownMs(res) {
  const reset = headerNumber(res, "ratelimit-reset");
  if (reset == null) return FALLBACK_COOLDOWN_MS;
  return Math.min(Math.max(reset, 0) * 1000, MAX_COOLDOWN_MS);
}

async function throttledFetch(url, init) {
  return enqueue(async () => {
    for (let attempt = 1; ; attempt++) {
      const wait = nextRequestAt - Date.now();
      if (wait > 0) await sleep(wait);

      const res = await fetch(url, init);
      const retryable = RETRY_STATUSES.has(res.status);
      // `ratelimit-remaining` is the request budget left in the window; once it is
      // gone, hold every queued request until the window resets.
      const remaining = headerNumber(res, "ratelimit-remaining") ?? Infinity;
      const outOfBudget = retryable || remaining <= 0;
      nextRequestAt = Date.now() + (outOfBudget ? cooldownMs(res) : MIN_REQUEST_GAP_MS);

      if (!retryable || attempt >= MAX_ATTEMPTS) return res;
    }
  });
}

async function fetchPlayerStats(userId) {
  const url = `https://www.faceit.com/api/statistics/v1/cs2/players/${encodeURIComponent(userId)}/seasons`;
  const res = await throttledFetch(url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    return { ...EMPTY_STATS, cached: false, ts: Date.now(), error: String(err) };
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
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true;
});
