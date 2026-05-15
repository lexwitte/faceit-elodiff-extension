const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const HIGHEST_ELO_PRIMARY_TIMEOUT_MS = 2000;
const HIGHEST_ELO_BASE_URLS = ["https://faceitanalyser.com", "https://ru.faceitanalyser.com"];
const HIGHEST_ELO_LAST_BASE_URL_KEY = "highestElo:lastBaseUrl";
const cacheKey = (nickname) => `elo:${nickname.toLowerCase()}`;
const seasonCacheKey = (userId) => `season:${userId}:cs2`;

async function readCache(nickname) {
  const key = cacheKey(nickname);
  const data = await chrome.storage.local.get(key);
  const entry = data[key];
  if (!entry) return null;
  const ttl = entry.highestElo == null ? NEG_CACHE_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - entry.ts > ttl) return null;
  return entry;
}

async function writeCache(nickname, highestElo) {
  await chrome.storage.local.set({
    [cacheKey(nickname)]: { highestElo, ts: Date.now() }
  });
}

async function readSeasonCache(userId) {
  const key = seasonCacheKey(userId);
  const data = await chrome.storage.local.get(key);
  const entry = data[key];
  if (!entry) return null;
  const ttl = entry.lastSeasonElo == null && entry.winStreak == null ? NEG_CACHE_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - entry.ts > ttl) return null;
  return entry;
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

function parseHighestElo(html) {
  const viewStart = html.indexOf('id="view1_stats"');
  const section = viewStart >= 0 ? html.slice(viewStart, viewStart + 200000) : html;
  const match = section.match(/Highest\s*ELO<\/span>\s*<span[^>]*class="value"[^>]*>\s*(\d+)\s*</i);
  if (match) return parseInt(match[1], 10);
  const fallback = html.match(/Highest\s*ELO[^<]*<[^>]*>\s*(\d+)/i);
  return fallback ? parseInt(fallback[1], 10) : null;
}

async function fetchHighestElo(nickname) {
  const encodedNickname = encodeURIComponent(nickname);
  const baseUrls = await orderedHighestEloBaseUrls();
  let lastErr = null;
  for (const [index, baseUrl] of baseUrls.entries()) {
    const url = `${baseUrl}/stats/${encodedNickname}/cs2`;
    try {
      const highestElo = await fetchHighestEloFromUrl(url, index === 0 ? HIGHEST_ELO_PRIMARY_TIMEOUT_MS : null);
      await writeHighestEloBaseUrl(baseUrl);
      return highestElo;
    } catch (err) {
      lastErr = err;
      if (!isHighestEloFallbackError(err) || index === baseUrls.length - 1) throw err;
    }
  }
  throw lastErr || new Error("highest ELO fetch failed");
}

async function orderedHighestEloBaseUrls() {
  const data = await chrome.storage.local.get(HIGHEST_ELO_LAST_BASE_URL_KEY);
  const lastBaseUrl = data[HIGHEST_ELO_LAST_BASE_URL_KEY];
  if (!HIGHEST_ELO_BASE_URLS.includes(lastBaseUrl)) return HIGHEST_ELO_BASE_URLS;
  return [
    lastBaseUrl,
    ...HIGHEST_ELO_BASE_URLS.filter((baseUrl) => baseUrl !== lastBaseUrl)
  ];
}

async function writeHighestEloBaseUrl(baseUrl) {
  await chrome.storage.local.set({ [HIGHEST_ELO_LAST_BASE_URL_KEY]: baseUrl });
}

function isHighestEloFallbackError(err) {
  return err?.name === "AbortError" || err?.networkError === true;
}

async function fetchHighestEloFromUrl(url, timeoutMs) {
  const res = await fetchWithOptionalTimeout(url, {
    method: "GET",
    credentials: "omit",
    headers: { "Accept": "text/html,application/xhtml+xml" }
  }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return parseHighestElo(html);
}

async function fetchWithOptionalTimeout(url, options, timeoutMs) {
  if (!timeoutMs) {
    try {
      return await fetch(url, options);
    } catch (err) {
      throwNetworkError(err);
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throwNetworkError(err);
  } finally {
    clearTimeout(timeoutId);
  }
}

function throwNetworkError(err) {
  const wrapped = new Error(String(err?.message || err));
  wrapped.networkError = true;
  throw wrapped;
}

async function getHighestElo(nickname, { force } = {}) {
  if (!force) {
    const cached = await readCache(nickname);
    if (cached) return { highestElo: cached.highestElo, cached: true, ts: cached.ts };
  }
  try {
    const highestElo = await fetchHighestElo(nickname);
    await writeCache(nickname, highestElo);
    return { highestElo, cached: false, ts: Date.now() };
  } catch (err) {
    await writeCache(nickname, null);
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
    lastSeasonElo: typeof lastSeasonValue === "number" ? lastSeasonValue : null,
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
        const result = await getHighestElo(msg.nickname, { force: !!msg.force });
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
