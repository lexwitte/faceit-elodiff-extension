const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cacheKey = (nickname) => `elo:${nickname.toLowerCase()}`;

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

function parseHighestElo(html) {
  const viewStart = html.indexOf('id="view1_stats"');
  const section = viewStart >= 0 ? html.slice(viewStart, viewStart + 200000) : html;
  const match = section.match(/Highest\s*ELO<\/span>\s*<span[^>]*class="value"[^>]*>\s*(\d+)\s*</i);
  if (match) return parseInt(match[1], 10);
  const fallback = html.match(/Highest\s*ELO[^<]*<[^>]*>\s*(\d+)/i);
  return fallback ? parseInt(fallback[1], 10) : null;
}

async function fetchHighestElo(nickname) {
  const url = `https://faceitanalyser.com/stats/${encodeURIComponent(nickname)}/cs2`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "omit",
    headers: { "Accept": "text/html,application/xhtml+xml" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return parseHighestElo(html);
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
