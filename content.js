(() => {
  const MATCH_ID_RE = /\/cs2\/room\/(1-[0-9a-f-]+)/i;
  const ROOT_ID = "fme-root";
  const PANEL_ID = "fme-panel";
  const OUTLIER_LOW_MULTIPLIER = 0.8;
  const OUTLIER_HIGH_MULTIPLIER = 1.2;
  const MAX_STATS_ATTEMPTS = 3;

  const LOGO_URL = chrome.runtime.getURL("logo.png");

  const STATE = {
    matchId: null,
    loading: false,
    statsLoading: false,
    data: null,
    collapsed: false,
    loadId: 0
  };

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

  function validElo(v) {
    return typeof v === "number" && Number.isFinite(v) && v > 0;
  }

  function sanitizeElo(v) {
    return validElo(v) ? v : null;
  }

  function winChance(eloA, eloB) {
    return 1 / (1 + Math.pow(10, (eloB - eloA) / 1000));
  }

  function normalizeRoster(faction) {
    if (!faction?.roster) return { name: faction?.name || "", players: [] };
    const players = faction.roster.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      steamId64: p.gameId,
      elo: sanitizeElo(p.elo),
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

  function allPlayers(teams) {
    return [...teams.faction1.players, ...teams.faction2.players];
  }

  // A player is done once the worker answered, even if the API had no seasons for
  // them. Only an unanswered message (dead service worker, torn-down channel) is
  // worth another attempt.
  function playersAwaitingStats(teams) {
    return allPlayers(teams).filter(
      (p) => !p.statsLoaded && (p.statsAttempts || 0) < MAX_STATS_ATTEMPTS
    );
  }

  async function loadPlayerStats(teams, { force = false, onUpdate, players } = {}) {
    const byUserId = new Map();
    for (const player of allPlayers(teams)) {
      const group = byUserId.get(player.id) || [];
      group.push(player);
      byUserId.set(player.id, group);
    }

    const assign = (userId, fields) => {
      for (const player of byUserId.get(userId) || []) Object.assign(player, fields);
    };

    const targets = players || allPlayers(teams);
    const unique = [...new Map(targets.map((p) => [p.id, p])).values()];

    await Promise.all(
      unique.map((player) => {
        assign(player.id, { statsAttempts: (player.statsAttempts || 0) + 1 });
        return sendMessage({ type: "getPlayerStats", userId: player.id, force }).then((stats) => {
          if (!stats.ok || stats.error) {
            console.warn("[fme] season stats failed for", player.nickname, stats.error || stats);
          }
          if (stats.ok) {
            assign(player.id, {
              statsLoaded: true,
              lastSeasonElo: sanitizeElo(stats.lastSeasonElo),
              highestElo: sanitizeElo(stats.highestElo)
            });
          }
          onUpdate?.();
        });
      })
    );
    return teams;
  }

  // Repaints the widget as each player's seasons land, so rows fill in one by one
  // instead of waiting for the whole (rate-limited) batch.
  function loadStats(teams, { force = false, players } = {}) {
    const matchId = STATE.matchId;
    const loadId = STATE.loadId;
    STATE.statsLoading = true;
    return loadPlayerStats(teams, {
      force,
      players,
      onUpdate: () => {
        if (currentMatchId() === matchId && STATE.loadId === loadId) renderPanel(teams);
      }
    }).finally(() => {
      if (STATE.loadId === loadId) STATE.statsLoading = false;
    });
  }

  function teamSummary(team) {
    const elos = team.players.map((p) => p.elo).filter(validElo);
    const lastSeasonElos = team.players.map((p) => p.lastSeasonElo).filter(validElo);
    const highs = team.players.map((p) => p.highestElo).filter(validElo);
    return {
      avgElo: avg(elos),
      avgLastSeason: avg(lastSeasonElos),
      avgHighest: avg(highs),
      nCurrent: elos.length,
      nLastSeason: lastSeasonElos.length,
      nHighest: highs.length
    };
  }

  function teamRatingDifference(a, b) {
    let difference = 0;
    let comparableRatings = 0;
    if (a.nCurrent && b.nCurrent) {
      difference += a.avgElo - b.avgElo;
      comparableRatings += 1;
    }
    if (a.nLastSeason && b.nLastSeason) {
      difference += a.avgLastSeason - b.avgLastSeason;
      comparableRatings += 1;
    }
    if (a.nHighest && b.nHighest) {
      difference += a.avgHighest - b.avgHighest;
      comparableRatings += 1;
    }
    return comparableRatings ? difference : null;
  }

  function roomOutlierMetrics(teams) {
    const players = [...teams.faction1.players, ...teams.faction2.players];
    const currentElos = players.map((p) => p.elo).filter(validElo);
    const lastSeasonElos = players.map((p) => p.lastSeasonElo).filter(validElo);
    const highestElos = players.map((p) => p.highestElo).filter(validElo);
    return {
      avgCurrent: currentElos.length ? avg(currentElos) : null,
      avgLastSeason: lastSeasonElos.length ? avg(lastSeasonElos) : null,
      avgHighest: highestElos.length ? avg(highestElos) : null
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
    return v == null ? "-" : Math.round(v).toString();
  }

  function outlierMeta(metricValue, averageMetric, averageText) {
    if (!validElo(metricValue) || !validElo(averageMetric)) {
      return { className: "", title: null };
    }
    if (metricValue <= averageMetric * OUTLIER_LOW_MULTIPLIER) {
      return {
        className: " fme-outlier-low",
        title: `At or below ${OUTLIER_LOW_MULTIPLIER}x ${averageText}`
      };
    }
    if (metricValue >= averageMetric * OUTLIER_HIGH_MULTIPLIER) {
      return {
        className: " fme-outlier-high",
        title: `At or above ${OUTLIER_HIGH_MULTIPLIER}x ${averageText}`
      };
    }
    return { className: "", title: averageText };
  }

  function columnCompareMeta(hasValue, value, opponentHasValue, opponentValue) {
    if (!hasValue || !opponentHasValue || value === opponentValue) {
      return { arrow: "·", className: "fme-team-stat fme-team-stat-min" };
    }
    if (value > opponentValue) {
      return { arrow: "↑", className: "fme-team-stat fme-team-stat-max" };
    }
    return { arrow: "↓", className: "fme-team-stat fme-team-stat-min" };
  }

  function renderTeamBlock(label, team, colorClass, opponentSummary = null, roomMetrics = {}) {
    const summary = teamSummary(team);
    const currentHeader = columnCompareMeta(summary.nCurrent, summary.avgElo, opponentSummary?.nCurrent, opponentSummary?.avgElo);
    const lastSeasonHeader = columnCompareMeta(summary.nLastSeason, summary.avgLastSeason, opponentSummary?.nLastSeason, opponentSummary?.avgLastSeason);
    const highestHeader = columnCompareMeta(summary.nHighest, summary.avgHighest, opponentSummary?.nHighest, opponentSummary?.avgHighest);
    const rows = team.players.map((p) => {
      const currentOutlier = outlierMeta(
        p.elo,
        roomMetrics.avgCurrent,
        `lobby avg ${formatElo(roomMetrics.avgCurrent)}`
      );
      const seasonOutlier = outlierMeta(
        p.lastSeasonElo,
        roomMetrics.avgLastSeason,
        `lobby avg ${formatElo(roomMetrics.avgLastSeason)}`
      );
      const highestOutlier = outlierMeta(
        p.highestElo,
        roomMetrics.avgHighest,
        `lobby avg ${formatElo(roomMetrics.avgHighest)}`
      );
      const avatar = p.avatar
        ? el("div", { className: "fme-avatar", style: `background-image:url(${p.avatar})` })
        : el("div", { className: "fme-avatar fme-avatar-empty" });
      return el("div", { className: "fme-row" }, [
        el("div", { className: "fme-player-name" }, [
          avatar,
          el("span", { className: "fme-player-text" }, [
            p.id
              ? el("a", {
                  className: "fme-nick",
                  href: `https://www.faceit.com/users/${p.id}`,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  text: p.nickname,
                  title: p.nickname,
                  onclick: (e) => e.stopPropagation()
                })
              : el("span", { className: "fme-nick", text: p.nickname, title: p.nickname })
          ])
        ]),
        el("span", {
          className: "fme-stat fme-elo" + (validElo(p.elo) ? currentOutlier.className : ""),
          text: formatElo(validElo(p.elo) ? p.elo : null),
          title: currentOutlier.title
        }),
        el("span", {
          className: "fme-stat fme-season" + (validElo(p.lastSeasonElo) ? seasonOutlier.className : " fme-missing"),
          text: formatElo(validElo(p.lastSeasonElo) ? p.lastSeasonElo : null),
          title: seasonOutlier.title
        }),
        el("span", {
          className: "fme-stat fme-highest" + (validElo(p.highestElo) ? highestOutlier.className : " fme-missing"),
          text: formatElo(validElo(p.highestElo) ? p.highestElo : null),
          title: highestOutlier.title
        })
      ]);
    });
    return el("div", { className: `fme-team ${colorClass}` }, [
      el("div", { className: "fme-team-head" }, [
        el("span", { className: "fme-team-title" }, [
          el("span", { className: "fme-team-pip" }),
          el("span", { className: "fme-team-label", text: label.toUpperCase() })
        ]),
        el("span", {
          className: currentHeader.className,
          text: `CUR ${currentHeader.arrow} ${formatElo(summary.nCurrent ? summary.avgElo : null)}`,
          title: "Current ELO team average"
        }),
        el("span", {
          className: lastSeasonHeader.className,
          text: `LK ${lastSeasonHeader.arrow} ${formatElo(summary.nLastSeason ? summary.avgLastSeason : null)}`,
          title: "Last season ELO team average"
        }),
        el("span", {
          className: highestHeader.className,
          text: `HI ${highestHeader.arrow} ${formatElo(summary.nHighest ? summary.avgHighest : null)}`,
          title: "Highest ELO team average"
        })
      ]),
      ...rows
    ]);
  }

  function ensureRoot() {
    const mountTarget = document.querySelector('div[name="info"]');
    if (!mountTarget) return null;

    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = el("div", { id: ROOT_ID });
    }
    if (root.parentElement !== mountTarget) mountTarget.appendChild(root);
    return root;
  }

  function ensurePanel() {
    const root = ensureRoot();
    if (!root) return null;
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = el("div", { id: PANEL_ID, className: "fme-panel" });
      root.appendChild(panel);
    }
    panel.classList.toggle("fme-collapsed", STATE.collapsed);
    return panel;
  }

  function renderHeader() {
    return el("div", { className: "fme-header" }, [
      el("span", { className: "fme-logo", html: `<img src="${LOGO_URL}" alt="">` }),
      el("span", { className: "fme-title", text: "Room ELO Diff" }),
      el("span", { className: "fme-spacer" }),
      el("button", {
        className: "fme-btn fme-refresh-btn",
        type: "button",
        title: "Refresh (ignores cache)",
        html: '<svg class="fme-btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 4v7h-7"></path></svg>',
        onclick: (e) => {
          e.stopPropagation();
          refresh(true);
        }
      }),
      el("button", {
        className: "fme-btn fme-collapse-btn",
        type: "button",
        title: STATE.collapsed ? "Expand" : "Collapse",
        "aria-expanded": String(!STATE.collapsed),
        html: '<svg class="fme-collapse-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"></path></svg>',
        onclick: (e) => {
          e.stopPropagation();
          STATE.collapsed = !STATE.collapsed;
          const panel = e.currentTarget.closest(`#${PANEL_ID}`);
          panel?.classList.toggle("fme-collapsed", STATE.collapsed);
          e.currentTarget.title = STATE.collapsed ? "Expand" : "Collapse";
          e.currentTarget.setAttribute("aria-expanded", String(!STATE.collapsed));
        }
      })
    ]);
  }

  function renderFooter() {
    return el("div", { className: "fme-footer" }, [
      el("span", { text: "Brought by " }),
      el("a", {
        href: "https://mooncase.one/",
        target: "_blank",
        rel: "noopener",
        text: "mooncase.one"
      })
    ]);
  }

  function renderPanel(teams) {
    const panel = ensurePanel();
    if (!panel) return;
    panel.innerHTML = "";

    const s1 = teamSummary(teams.faction1);
    const s2 = teamSummary(teams.faction2);
    const roomMetrics = roomOutlierMetrics(teams);
    const ratingDifference = teamRatingDifference(s1, s2);
    const chance1 = ratingDifference != null ? winChance(ratingDifference, 0) : null;

    const summary = el("div", { className: "fme-summary" }, [
      el("div", { className: "fme-winline" }, [
        el("span", {
          className: "fme-win1",
          text: chance1 != null ? `${(chance1 * 100).toFixed(0)}%` : "-"
        }),
        el("span", {
          className: "fme-winmid",
          text: "win chance",
          title: "Win chance uses comparable CUR, LK, and HI team averages with a 1000 Elo scale"
        }),
        el("span", {
          className: "fme-win2",
          text: chance1 != null ? `${((1 - chance1) * 100).toFixed(0)}%` : "-"
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
      renderHeader(),
      summary,
      renderTeamBlock("Team 1", teams.faction1, "fme-team1", s2, roomMetrics),
      renderTeamBlock("Team 2", teams.faction2, "fme-team2", s1, roomMetrics),
      renderFooter()
    );
  }

  function renderStatus(message, kind = "loading") {
    const panel = ensurePanel();
    if (!panel) return;
    panel.innerHTML = "";
    panel.append(
      renderHeader(),
      el("div", { className: `fme-${kind}`, text: message }),
      renderFooter()
    );
  }

  function applyVisibility() {
    const root = ensureRoot();
    if (!root) return false;
    ensurePanel();
    const onMatchPage = !!currentMatchId();
    if (!onMatchPage) {
      root.classList.add("fme-hidden");
      return true;
    }
    root.classList.remove("fme-hidden");
    return true;
  }

  async function refresh(force = false) {
    const matchId = currentMatchId();
    if (!matchId) {
      STATE.matchId = null;
      STATE.data = null;
      applyVisibility();
      return;
    }
    if (!applyVisibility()) return;
    if (STATE.loading && STATE.matchId === matchId) return;
    const loadId = ++STATE.loadId;
    STATE.loading = true;
    STATE.matchId = matchId;
    STATE.data = null;
    try {
      renderStatus("Fetching match…", "loading");
      const teams = await loadTeams(matchId);
      if (currentMatchId() !== matchId || STATE.loadId !== loadId) return;
      STATE.data = teams;
      STATE.loading = false;
      renderPanel(teams);
      await loadStats(teams, { force });
    } catch (err) {
      if (currentMatchId() === matchId && STATE.loadId === loadId) {
        renderStatus(`Error: ${err?.message || err}`, "error");
      }
    } finally {
      if (STATE.loadId === loadId) STATE.loading = false;
    }
  }

  function bootstrap() {
    watchUrlChanges();
  }

  function watchUrlChanges() {
    let lastMatchId = null;

    const tick = () => {
      const now = currentMatchId();
      const mounted = applyVisibility();
      if (now !== lastMatchId) {
        lastMatchId = now;
        if (now && mounted) refresh();
        return;
      }

      if (!now || !mounted || STATE.loading) return;
      const panel = document.getElementById(PANEL_ID);
      if (STATE.matchId !== now || !STATE.data) return refresh();
      if (panel && !panel.childElementCount) renderPanel(STATE.data);
      if (STATE.statsLoading) return;
      // The service worker can be torn down while the throttled queue waits out a
      // rate limit, leaving those replies unanswered. Pick the stragglers back up.
      const pending = playersAwaitingStats(STATE.data);
      if (pending.length) loadStats(STATE.data, { players: pending });
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
    tick();
    setInterval(tick, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
