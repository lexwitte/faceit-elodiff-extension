const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const HIGHEST_ELO_API_BASE_URL = "https://api.mooncase.one/faceit/stats";
const cacheKey = (userId) => `elo:${userId}`;
const seasonCacheKey = (userId) => `season:${userId}:cs2`;

function validElo(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

async function readCache(userId) {
  const key = cacheKey(userId);
  const data = await chrome.storage.local.get(key);
  const entry = data[key];
  if (!entry) return null;
  if (!validElo(entry.highestElo) || Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return entry;
}

async function writeCache(userId, highestElo) {
  if (!validElo(highestElo)) return;
  await chrome.storage.local.set({
    [cacheKey(userId)]: { highestElo, ts: Date.now() }
  });
}

async function readSeasonCache(userId) {
  const key = seasonCacheKey(userId);
  const data = await chrome.storage.local.get(key);
  const entry = data[key];
  if (!entry) return null;
  const lastSeasonElo = validElo(entry.lastSeasonElo) ? entry.lastSeasonElo : null;
  const ttl = lastSeasonElo == null && entry.winStreak == null ? NEG_CACHE_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - entry.ts > ttl) return null;
  return { ...entry, lastSeasonElo };
}

async function writeSeasonCache(userId, summary) {
  await chrome.storage.local.set({
    [seasonCacheKey(userId)]: {
      lastSeasonElo: summary?.lastSeasonElo ?? null,
      winStreak: summary?.winStreak ?? null,
      ts: Date.now()
    }
  });
}

async function fetchHighestElo(userId) {
  const url = `${HIGHEST_ELO_API_BASE_URL}/${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "omit",
    headers: { "Accept": "application/json" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload?.success !== true) throw new Error("Highest ELO API request failed");
  const highestElo = payload?.data?.highestElo;
  if (!validElo(highestElo)) {
    throw new Error("Highest ELO API returned invalid data");
  }
  return highestElo;
}

async function getHighestElo(userId, { force } = {}) {
  if (!userId) return { highestElo: null, cached: false, ts: Date.now() };
  if (!force) {
    const cached = await readCache(userId);
    if (cached) return { highestElo: cached.highestElo, cached: true, ts: cached.ts };
  }
  try {
    const highestElo = await fetchHighestElo(userId);
    await writeCache(userId, highestElo);
    return { highestElo, cached: false, ts: Date.now() };
  } catch (err) {
    return { highestElo: null, cached: false, ts: Date.now(), error: String(err) };
  }
}

async function fetchSeasonSummary(userId) {
  const url = `https://www.faceit.com/api/skills/v4/user/${encodeURIComponent(userId)}/game/cs2/summary`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const lastSeasonValue = data?.last_season?.value;
  const currentWinStreak = data?.current_season?.win_streak;
  return {
    lastSeasonElo: validElo(lastSeasonValue) ? lastSeasonValue : null,
    winStreak: typeof currentWinStreak === "number" ? currentWinStreak : null
  };
}

async function getSeasonSummary(userId, { force } = {}) {
  if (!userId) return { lastSeasonElo: null, winStreak: null, cached: false, ts: Date.now() };
  if (!force) {
    const cached = await readSeasonCache(userId);
    if (cached) {
      return {
        lastSeasonElo: cached.lastSeasonElo,
        winStreak: cached.winStreak,
        seasonCached: true,
        ts: cached.ts
      };
    }
  }
  try {
    const summary = await fetchSeasonSummary(userId);
    await writeSeasonCache(userId, summary);
    return { ...summary, seasonCached: false, ts: Date.now() };
  } catch (err) {
    console.error(err);
    return {
      lastSeasonElo: null,
      winStreak: null,
      seasonCached: false,
      ts: Date.now(),
      seasonError: String(err)
    };
  }
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "getMatch") {
        const data = await fetchMatch(msg.matchId);
        sendResponse({ ok: true, data });
      } else if (msg?.type === "getHighestElo") {
        const result = await getHighestElo(msg.userId, { force: !!msg.force });
        sendResponse({ ok: true, ...result });
      } else if (msg?.type === "getSeasonSummary") {
        const result = await getSeasonSummary(msg.userId, { force: !!msg.force });
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
