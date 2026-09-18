// Runs in the page's own JS world at document_start, before FACEIT's bundle (and
// Sentry's fetch instrumentation) grab references to the natives patched below.
(() => {
  const PING_HOST_SUFFIX = ".ping.faceit.com";
  const PAGE_SOURCE = "fme-ping-page";
  const BRIDGE_SOURCE = "fme-ping-bridge";
  const MAX_PENALTY_MS = 1000;
  const INFLATED_FIELDS = new Set(["responseStart", "responseEnd", "duration"]);

  let penalties = {};
  const reportedHosts = new Set();

  function pingHost(resource) {
    try {
      const raw =
        typeof resource === "string" ? resource : resource instanceof URL ? resource.href : resource?.url;
      if (typeof raw !== "string" || !raw.includes(PING_HOST_SUFFIX)) return null;
      const { hostname } = new URL(raw, location.href);
      return hostname.endsWith(PING_HOST_SUFFIX) ? hostname : null;
    } catch {
      return null;
    }
  }

  function sanitizePenalties(raw) {
    const clean = {};
    if (!raw || typeof raw !== "object") return clean;
    for (const [host, ms] of Object.entries(raw)) {
      if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
        clean[host] = Math.min(Math.round(ms), MAX_PENALTY_MS);
      }
    }
    return clean;
  }

  // Lets the popup list servers without hardcoding FACEIT's location list.
  function reportHost(host) {
    if (reportedHosts.has(host)) return;
    reportedHosts.add(host);
    window.postMessage({ source: PAGE_SOURCE, host }, location.origin);
  }

  // Real (never inflated) round trips, shown next to the server names by the bridge.
  // "timing" samples come from resource timing, "wall" ones from the clock around fetch().
  function reportSample(host, ms, kind) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    window.postMessage({ source: PAGE_SOURCE, host, sample: { ms, kind } }, location.origin);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== BRIDGE_SOURCE) return;
    penalties = sanitizePenalties(event.data.penalties);
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // FACEIT falls back to wall-clock time around fetch() when no resource timing
  // entry shows up within 5ms of the response. Holding the response keeps that
  // fallback consistent, and gives the (inflated) timing entry time to win.
  const nativeFetch = window.fetch;
  window.fetch = function (resource) {
    const host = pingHost(resource);
    if (!host) return nativeFetch.apply(this, arguments);
    reportHost(host);
    const startedAt = performance.now();
    const result = nativeFetch.apply(this, arguments);
    result.then(() => reportSample(host, performance.now() - startedAt, "wall")).catch(() => {});
    const penalty = penalties[host];
    if (!penalty) return result;
    return result.then((response) => {
      // Chrome only emits the timing entry once the body is read, which FACEIT never
      // does. Draining a clone makes the entry arrive right away, so a sample takes
      // one round trip instead of the whole penalty.
      response.clone().arrayBuffer().catch(() => {});
      return sleep(penalty).then(() => response);
    });
  };

  function inflateEntry(entry, penalty) {
    return new Proxy(entry, {
      get(target, prop) {
        // Timing fields are native getters: they need the real entry as `this`.
        const value = Reflect.get(target, prop, target);
        if (typeof value === "function") return value.bind(target);
        // A zero means the field is hidden (no Timing-Allow-Origin); keep it so.
        if (INFLATED_FIELDS.has(prop) && typeof value === "number" && value > 0) return value + penalty;
        return value;
      }
    });
  }

  function patchEntries(entries) {
    return entries.map((entry) => {
      const host = entry.entryType === "resource" ? pingHost(entry.name) : null;
      const penalty = host ? penalties[host] : 0;
      return penalty ? inflateEntry(entry, penalty) : entry;
    });
  }

  function wrapEntryList(list) {
    return {
      getEntries: () => patchEntries(list.getEntries()),
      getEntriesByType: (type) => patchEntries(list.getEntriesByType(type)),
      getEntriesByName: (name, type) => patchEntries(list.getEntriesByName(name, type))
    };
  }

  // FACEIT's primary ping reading is responseStart - requestStart of the resource
  // timing entry, which no fetch() wrapper can touch, so the entries are patched.
  const NativePerformanceObserver = window.PerformanceObserver;
  if (NativePerformanceObserver) {
    new NativePerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const host = pingHost(entry.name);
        // Zeroes mean the fields are hidden (no Timing-Allow-Origin).
        if (host && entry.requestStart > 0 && entry.responseStart > 0) {
          reportSample(host, entry.responseStart - entry.requestStart, "timing");
        }
      }
    }).observe({ type: "resource" });

    class PerformanceObserver extends NativePerformanceObserver {
      constructor(callback) {
        super((list, observer) => {
          const hasPenalties = Object.keys(penalties).length > 0;
          callback.call(observer, hasPenalties ? wrapEntryList(list) : list, observer);
        });
      }
    }
    window.PerformanceObserver = PerformanceObserver;
  }
})();
