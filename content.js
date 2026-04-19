(() => {
  const MATCH_ID_RE = /\/cs2\/room\/(1-[0-9a-f-]+)/i;
  const ROOT_ID = "fme-root";
  const PANEL_ID = "fme-panel";
  const LAUNCHER_ID = "fme-launcher";
  const STORAGE_POS = "fme:position";

  const LOGO_URL = chrome.runtime.getURL("logo.png");

  const STATE = {
    matchId: null,
    loading: false,
    data: null,
    position: null,
    minimizedForMatch: null
  };

  function isMinimized() {
    return STATE.minimizedForMatch != null && STATE.minimizedForMatch === currentMatchId();
  }

  function currentMatchId() {
    const m = location.pathname.match(MATCH_ID_RE);
    return m ? m[1] : null;
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: "empty response" });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  function avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function winChance(eloA, eloB) {
    return 1 / (1 + Math.pow(10, (eloB - eloA) / 1e3));
  }

  function normalizeRoster(faction) {
    if (!faction?.roster) return { name: faction?.name || "", players: [] };
    const players = faction.roster.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      steamId64: p.gameId,
      elo: typeof p.elo === "number" ? p.elo : null,
      avatar: p.avatar || ""
    }));
    return { name: faction.name || "", players };
  }

  async function loadTeams(matchId) {
    const res = await sendMessage({ type: "getMatch", matchId });
    if (!res.ok) throw new Error(res.error || "match fetch failed");
    const teams = res.data?.payload?.teams || {};
    return {
      faction1: normalizeRoster(teams.faction1),
      faction2: normalizeRoster(teams.faction2)
    };
  }

  async function loadHighestElos(teams) {
    const all = [...teams.faction1.players, ...teams.faction2.players];
    const unique = [...new Map(all.map((p) => [p.nickname, p])).values()];
    const results = await Promise.all(
      unique.map(async (p) => {
        const r = await sendMessage({ type: "getHighestElo", nickname: p.nickname });
        return [p.nickname, r];
      })
    );
    const byNickname = new Map(results);
    const annotate = (team) =>
      team.players.map((p) => {
        const r = byNickname.get(p.nickname) || {};
        return { ...p, highestElo: r.highestElo ?? null, cached: !!r.cached, eloError: r.error || null };
      });
    return {
      faction1: { ...teams.faction1, players: annotate(teams.faction1) },
      faction2: { ...teams.faction2, players: annotate(teams.faction2) }
    };
  }

  function teamSummary(team) {
    const elos = team.players.map((p) => p.elo).filter((v) => typeof v === "number");
    const highs = team.players.map((p) => p.highestElo).filter((v) => typeof v === "number");
    return {
      avgElo: avg(elos),
      avgHighest: avg(highs),
      nCurrent: elos.length,
      nHighest: highs.length
    };
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "className") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v != null) node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.appendChild(c);
    return node;
  }

  function formatElo(v) {
    return v == null ? "—" : Math.round(v).toString();
  }

  function renderTeamBlock(label, team, colorClass, opponentAvgHighest = null) {
    const summary = teamSummary(team);
    const isHigher = opponentAvgHighest != null && summary.nHighest
      ? summary.avgHighest > opponentAvgHighest
      : null;
    const maxArrow = isHigher === true ? "↑" : isHigher === false ? "↓" : "·";
    const maxClass = "fme-team-stat" + (isHigher === true ? " fme-team-stat-max" : " fme-team-stat-min");
    const rows = team.players.map((p) => {
      const diff = p.highestElo != null && p.elo != null ? p.highestElo - p.elo : null;
      const avatar = p.avatar
        ? el("div", { className: "fme-avatar", style: `background-image:url(${p.avatar})` })
        : el("div", { className: "fme-avatar fme-avatar-empty" });
      return el("div", { className: "fme-row" }, [
        avatar,
        el("span", { className: "fme-nick", text: p.nickname, title: p.nickname }),
        el("span", { className: "fme-elo", text: formatElo(p.elo) }),
        el("span", { className: "fme-arrow", html: "&rsaquo;" }),
        el("span", {
          className: "fme-highest" + (p.highestElo == null ? " fme-missing" : ""),
          text: formatElo(p.highestElo),
          title: p.eloError ? `Error: ${p.eloError}` : (p.cached ? "from cache" : "fresh")
        }),
        el("span", {
          className: "fme-diff" + (diff != null && diff > 0 ? " fme-diff-pos" : " fme-diff-zero"),
          text: diff != null ? (diff > 0 ? `+${diff}` : `${diff}`) : ""
        })
      ]);
    });
    return el("div", { className: `fme-team ${colorClass}` }, [
      el("div", { className: "fme-team-head" }, [
        el("span", { className: "fme-team-pip" }),
        el("span", { className: "fme-team-label", text: label.toUpperCase() }),
        el("span", { className: "fme-team-stat", text: `Ø ${formatElo(summary.avgElo)}` }),
        el("span", { className: "fme-team-sep", text: "·" }),
        el("span", { className: maxClass, text: `${maxArrow} ${formatElo(summary.avgHighest)}` })
      ]),
      ...rows
    ]);
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = el("div", { id: ROOT_ID });
      document.documentElement.appendChild(root);
    }
    return root;
  }

  function ensurePanel() {
    const root = ensureRoot();
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = el("div", { id: PANEL_ID, className: "fme-panel" });
      root.appendChild(panel);
      applyPosition(panel);
      makeDraggable(panel);
    }
    return panel;
  }

  function ensureLauncher() {
    const root = ensureRoot();
    let btn = document.getElementById(LAUNCHER_ID);
    if (!btn) {
      btn = el("button", {
        id: LAUNCHER_ID,
        className: "fme-launcher",
        title: "Open Faceit MaxElo",
        html: `<img src="${LOGO_URL}" alt="MaxElo">`,
        onclick: () => setMinimized(false)
      });
      root.appendChild(btn);
    }
    return btn;
  }

  function applyPosition(panel) {
    const pos = STATE.position;
    if (pos && pos.left != null && pos.top != null) {
      panel.style.left = pos.left + "px";
      panel.style.top = pos.top + "px";
      panel.style.right = "auto";
    } else {
      panel.style.right = "16px";
      panel.style.top = "88px";
      panel.style.left = "auto";
    }
  }

  function clampToViewport(panel) {
    const rect = panel.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    left = Math.max(0, Math.min(left, maxLeft));
    top = Math.max(0, Math.min(top, maxTop));
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.style.right = "auto";
  }

  function makeDraggable(panel) {
    let dragging = false;
    let startX = 0, startY = 0, originLeft = 0, originTop = 0;

    panel.addEventListener("mousedown", (e) => {
      const handle = e.target.closest(".fme-drag-handle");
      if (!handle) return;
      if (e.target.closest(".fme-btn")) return;
      if (e.button !== 0) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      panel.classList.add("fme-dragging");
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let left = originLeft + dx;
      let top = originTop + dy;
      const rect = panel.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      left = Math.max(0, Math.min(left, maxLeft));
      top = Math.max(0, Math.min(top, maxTop));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove("fme-dragging");
      document.body.style.userSelect = "";
      const rect = panel.getBoundingClientRect();
      STATE.position = { left: Math.round(rect.left), top: Math.round(rect.top) };
      try { chrome.storage.local.set({ [STORAGE_POS]: STATE.position }); } catch {}
    });

    window.addEventListener("resize", () => clampToViewport(panel));
  }

  function renderHeader(panel) {
    return el("div", { className: "fme-header fme-drag-handle" }, [
      el("span", { className: "fme-logo", html: `<img src="${LOGO_URL}" alt="">` }),
      el("span", { className: "fme-title", text: "MaxElo" }),
      el("span", { className: "fme-spacer" }),
      el("button", {
        className: "fme-btn",
        title: "Refresh",
        html: "&#x21bb;",
        onclick: (e) => { e.stopPropagation(); refresh(true); }
      }),
      el("button", {
        className: "fme-btn",
        title: "Minimize",
        text: "–",
        onclick: (e) => { e.stopPropagation(); setMinimized(true); }
      })
    ]);
  }

  function renderPanel(teams) {
    const panel = ensurePanel();
    panel.innerHTML = "";

    const s1 = teamSummary(teams.faction1);
    const s2 = teamSummary(teams.faction2);
    const chance1 = s1.nHighest && s2.nHighest ? winChance(s1.avgHighest, s2.avgHighest) : null;
    const diff = s1.nHighest && s2.nHighest ? s1.avgHighest - s2.avgHighest : null;

    const summary = el("div", { className: "fme-summary" }, [
      el("div", { className: "fme-winline" }, [
        el("span", {
          className: "fme-win1",
          text: chance1 != null ? `${(chance1 * 100).toFixed(0)}%` : "—"
        }),
        el("span", {
          className: "fme-winmid",
          text: diff != null ? `Δ ${diff >= 0 ? "+" : ""}${Math.round(diff)}` : "win chance"
        }),
        el("span", {
          className: "fme-win2",
          text: chance1 != null ? `${((1 - chance1) * 100).toFixed(0)}%` : "—"
        })
      ]),
      el("div", { className: "fme-winbar" }, [
        el("div", {
          className: "fme-winbar-fill",
          style: `width:${chance1 != null ? (chance1 * 100).toFixed(1) : 50}%`
        })
      ])
    ]);

    panel.append(
      renderHeader(panel),
      summary,
      renderTeamBlock("Team 1", teams.faction1, "fme-team1", s2.nHighest ? s2.avgHighest : null),
      renderTeamBlock("Team 2", teams.faction2, "fme-team2", s1.nHighest ? s1.avgHighest : null)
    );

    clampToViewport(panel);
  }

  function renderStatus(message, kind = "loading") {
    const panel = ensurePanel();
    panel.innerHTML = "";
    panel.append(
      renderHeader(panel),
      el("div", { className: `fme-${kind}`, text: message })
    );
  }

  function setMinimized(minimized) {
    STATE.minimizedForMatch = minimized ? currentMatchId() : null;
    applyVisibility();
  }

  function applyVisibility() {
    const root = ensureRoot();
    const panel = ensurePanel();
    const launcher = ensureLauncher();
    const onMatchPage = !!currentMatchId();
    if (!onMatchPage) {
      root.classList.add("fme-hidden");
      return;
    }
    root.classList.remove("fme-hidden");
    const min = isMinimized();
    panel.style.display = min ? "none" : "";
    launcher.style.display = min ? "" : "none";
  }

  async function refresh(force = false) {
    const matchId = currentMatchId();
    if (!matchId) {
      STATE.matchId = null;
      STATE.data = null;
      applyVisibility();
      return;
    }
    applyVisibility();
    if (STATE.loading) return;
    STATE.loading = true;
    STATE.matchId = matchId;
    try {
      renderStatus("Fetching match…", "loading");
      const teams = await loadTeams(matchId);
      renderStatus("Fetching highest ELOs…", "loading");
      const annotated = await loadHighestElos(teams);
      if (force) {
        const all = [...annotated.faction1.players, ...annotated.faction2.players];
        const unique = [...new Map(all.map((p) => [p.nickname, p])).values()];
        await Promise.all(unique.map((p) =>
          sendMessage({ type: "getHighestElo", nickname: p.nickname, force: true })
        ));
        const refreshed = await loadHighestElos(teams);
        STATE.data = refreshed;
        renderPanel(refreshed);
      } else {
        STATE.data = annotated;
        renderPanel(annotated);
      }
    } catch (err) {
      renderStatus(`Error: ${err?.message || err}`, "error");
    } finally {
      STATE.loading = false;
    }
  }

  async function loadPrefs() {
    try {
      const data = await chrome.storage.local.get([STORAGE_POS]);
      STATE.position = data[STORAGE_POS] || null;
    } catch {}
  }

  async function bootstrap() {
    await loadPrefs();
    ensureRoot();
    ensurePanel();
    ensureLauncher();
    applyVisibility();
    watchUrlChanges();
  }

  function watchUrlChanges() {
    let lastMatchId = currentMatchId();
    if (lastMatchId) refresh();

    const tick = () => {
      const now = currentMatchId();
      if (now !== lastMatchId) {
        lastMatchId = now;
        refresh();
      } else {
        applyVisibility();
      }
    };

    const wrap = (name) => {
      const original = history[name];
      history[name] = function () {
        const result = original.apply(this, arguments);
        setTimeout(tick, 50);
        return result;
      };
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", () => setTimeout(tick, 50));
    setInterval(tick, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
