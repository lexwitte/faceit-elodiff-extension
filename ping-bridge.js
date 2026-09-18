// Isolated-world half of the ping penalty feature: ping-main.js lives in the page
// world and has no chrome.* APIs, so settings and discovered servers cross here.
// Also owns the "Less preferred" checkboxes on the matchmaking server tiles.
(() => {
  const PENALTIES_KEY = "pingPenalties";
  const HOSTS_KEY = "pingHosts";
  const PAGE_SOURCE = "fme-ping-page";
  const BRIDGE_SOURCE = "fme-ping-bridge";
  const PING_HOST_RE = /^[a-z0-9.-]+\.ping\.faceit\.com$/;
  // The locale segment differs between users: /en/matchmaking, /de/matchmaking, ...
  const MATCHMAKING_RE = /^\/[^/]+\/matchmaking(\/|$)/;
  const TILE_SELECTOR = '[class*="styles__ServerList"] [role="button"][aria-label]';
  const TOGGLE_CLASS = "fme-less-preferred";
  const PING_CLASS = "fme-ping";
  const DEFAULT_PENALTY_MS = 250;
  const MAX_PENALTY_MS = 1000;
  const SAMPLE_WINDOW = 5;

  let penalties = {};
  let hosts = [];
  // host -> { kind, values }: the last few real round trips reported by ping-main.js.
  const samples = new Map();

  function pushPenalties() {
    window.postMessage({ source: BRIDGE_SOURCE, penalties }, location.origin);
  }

  // All servers are pinged at once; serialize the read-modify-write so no host is lost.
  let saveTail = Promise.resolve();

  function rememberHost(host) {
    if (hosts.includes(host)) return;
    hosts = [...hosts, host].sort();
    scheduleRender();
    saveTail = saveTail
      .then(async () => {
        const data = await chrome.storage.local.get(HOSTS_KEY);
        const saved = Array.isArray(data[HOSTS_KEY]) ? data[HOSTS_KEY] : [];
        if (saved.includes(host)) return;
        await chrome.storage.local.set({ [HOSTS_KEY]: [...saved, host].sort() });
      })
      .catch((err) => console.warn("[fme] could not save ping host", err));
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== PAGE_SOURCE) return;
    const host = event.data.host;
    if (typeof host !== "string" || !PING_HOST_RE.test(host)) return;
    rememberHost(host);
    if (event.data.sample) addSample(host, event.data.sample);
  });

  function addSample(host, { ms, kind }) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return;
    let entry = samples.get(host);
    // Wall-clock samples include connection setup; drop them once real timing shows up.
    if (entry?.kind === "timing" && kind !== "timing") return;
    if (!entry || entry.kind !== kind) {
      entry = { kind, values: [] };
      samples.set(host, entry);
    }
    entry.values = [...entry.values, ms].slice(-SAMPLE_WINDOW);
    scheduleRender();
  }

  // The fastest recent sample is the closest to the true round trip.
  function measuredPing(host) {
    const entry = samples.get(host);
    return entry ? Math.round(Math.min(...entry.values)) : null;
  }

  const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

  // Tiles carry nothing but their name, and ping hosts look like "germany.eu.ping.faceit.com".
  // Matching against hosts FACEIT actually pinged avoids hardcoding the region part.
  function hostForTile(tile) {
    const name = slug(tile.getAttribute("aria-label") || "");
    if (!name) return null;
    return hosts.find((host) => slug(host.split(".")[0]) === name) || null;
  }

  // Returns 0 when the user cancels or enters nothing usable.
  function askPenalty() {
    const raw = window.prompt(
      `Extra latency to add to this server, in ms (1-${MAX_PENALTY_MS}):`,
      String(DEFAULT_PENALTY_MS)
    );
    const value = Math.round(Number(raw));
    if (raw === null || !Number.isFinite(value) || value <= 0) return 0;
    return Math.min(value, MAX_PENALTY_MS);
  }

  function setPenalty(host, ms) {
    if (ms) penalties[host] = ms;
    else delete penalties[host];
    pushPenalties();
    chrome.storage.sync
      .set({ [PENALTIES_KEY]: penalties })
      .catch((err) => console.warn("[fme] could not save ping penalties", err));
  }

  function buildToggle(host) {
    const label = document.createElement("label");
    label.className = TOGGLE_CLASS;
    label.dataset.host = host;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => {
      setPenalty(host, input.checked ? askPenalty() : 0);
      scheduleRender();
    });

    // The tile itself is a button: keep our events from toggling the server selection.
    for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "keydown", "keyup"]) {
      label.addEventListener(type, (event) => event.stopPropagation());
    }

    const icon = document.createElement("span");
    icon.className = "fme-less-preferred-icon";
    icon.textContent = "\u2193";

    label.append(input, icon);
    return label;
  }

  // Overlaid on the flag instead of squeezed next to the name, which has no room to spare.
  function renderPing(tile, host) {
    const ping = host ? measuredPing(host) : null;
    let node = tile.querySelector(`:scope > .${PING_CLASS}`);
    if (ping === null) {
      node?.remove();
      return;
    }
    if (!node) {
      node = document.createElement("span");
      node.className = PING_CLASS;
      tile.append(node);
    }
    // Less preferred servers show the total FACEIT sees; the toggle's tooltip has the split.
    const penalty = penalties[host] || 0;
    const text = `${ping + penalty}ms`;
    if (node.textContent !== text) node.textContent = text;
    node.classList.toggle("fme-active", penalty > 0);
  }

  function render() {
    if (!MATCHMAKING_RE.test(location.pathname)) return;
    for (const tile of document.querySelectorAll(TILE_SELECTOR)) {
      const host = hostForTile(tile);
      let toggle = tile.querySelector(`:scope > .${TOGGLE_CLASS}`);
      if (toggle && toggle.dataset.host !== host) {
        toggle.remove();
        toggle = null;
      }
      renderPing(tile, host);
      if (!host) continue;
      if (!toggle) {
        toggle = buildToggle(host);
        tile.append(toggle);
      }
      const penalty = penalties[host] || 0;
      const checked = penalty > 0;
      const title = checked ? `Less preferred (+${penalty}ms)` : "Mark as less preferred";
      if (toggle.title !== title) toggle.title = title;
      const input = toggle.querySelector("input");
      if (input.checked !== checked) input.checked = checked;
      toggle.classList.toggle("fme-active", checked);
    }
  }

  let renderQueued = false;

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes[PENALTIES_KEY]) return;
    penalties = { ...(changes[PENALTIES_KEY].newValue || {}) };
    pushPenalties();
    scheduleRender();
  });

  Promise.all([chrome.storage.sync.get(PENALTIES_KEY), chrome.storage.local.get(HOSTS_KEY)])
    .then(([sync, local]) => {
      penalties = { ...(sync[PENALTIES_KEY] || {}) };
      const saved = Array.isArray(local[HOSTS_KEY]) ? local[HOSTS_KEY] : [];
      // Keep penalised servers matchable even if the seen-hosts cache was cleared.
      hosts = [...new Set([...hosts, ...saved, ...Object.keys(penalties)])].sort();
      pushPenalties();
      scheduleRender();
    })
    .catch((err) => console.warn("[fme] ping penalties unavailable", err));

  // The server tab is rendered (and re-rendered) by React long after document_start.
  new MutationObserver(scheduleRender).observe(document.documentElement, { childList: true, subtree: true });
})();
