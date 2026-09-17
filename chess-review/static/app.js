/* PGN Game Review – front-end */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const CLASS_META = {
    brilliant: { sym: "!!", label: "Brilliant", color: "#1baca6" },
    great: { sym: "!", label: "Great move", color: "#5b8baf" },
    best: { sym: "★", label: "Best", color: "#96bc4b" },
    excellent: { sym: "✓", label: "Excellent", color: "#96bc4b" },
    good: { sym: "✓", label: "Good", color: "#96af8b" },
    book: { sym: "📖", label: "Book", color: "#a88865" },
    forced: { sym: "→", label: "Forced", color: "#8f8f8f" },
    inaccuracy: { sym: "?!", label: "Inaccuracy", color: "#f7c631" },
    mistake: { sym: "?", label: "Mistake", color: "#ffa459" },
    miss: { sym: "✗", label: "Missed win", color: "#ff7769" },
    blunder: { sym: "??", label: "Blunder", color: "#fa412d" },
  };
  const CLASS_ORDER = ["brilliant", "great", "best", "excellent", "good", "book", "forced", "inaccuracy", "mistake", "miss", "blunder"];

  const state = {
    config: null,
    collectionId: null,
    depth: 16,
    games: [],
    job: null,
    pollTimer: null,
    listTimer: null,
    detail: null,
    ply: 0,
    flipped: false,
  };

  // ------------------------------------------------------------------ utils
  const api = async (url, opts = {}) => {
    const r = await fetch(url, opts);
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch (_) { }
      throw new Error(msg);
    }
    return r.json();
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shortName = (s) => (s || "?").split(",")[0].trim();
  const fmtTime = (sec) => {
    if (sec == null) return "–";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
  };
  const scoreClass = (label) => (label || "routine").toLowerCase().replace(/\s+/g, "-");

  // ------------------------------------------------------------------ views
  function showView(name) {
    $$(".view").forEach((v) => v.classList.add("hidden"));
    $(`#view-${name}`).classList.remove("hidden");
    $$(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    if (name !== "game") {
      window.removeEventListener("keydown", onKey);
    } else {
      window.addEventListener("keydown", onKey);
    }
  }
  $$(".navbtn").forEach((b) => b.addEventListener("click", () => {
    if (b.disabled) return;
    showView(b.dataset.view);
    if (b.dataset.view === "home") loadCollections();
  }));

  // ------------------------------------------------------------------ config
  async function loadConfig() {
    try {
      state.config = await api("/api/config");
    } catch (e) {
      state.config = { engine_path: null, cpu_count: 4, defaults: { depth: 16, workers: 4, threads: 1, hash_mb: 128 } };
    }
    const c = state.config;
    const pill = $("#engine-pill");
    if (c.engine_path) {
      pill.textContent = `${c.engine_name || "engine"} · ${c.engine_path}`;
      pill.title = c.engine_path;
    } else {
      pill.textContent = "⚠ no engine found – set path in Settings";
      pill.style.color = "#ffa459";
    }
    $("#depth").value = c.defaults.depth;
    $("#workers").value = c.defaults.workers;
    $("#threads").value = c.defaults.threads;
    $("#hash").value = c.defaults.hash_mb;
    $("#cpu-hint").textContent = `${c.cpu_count} CPU cores detected. Parallel engines × threads should not exceed the core count. ` +
      `Depth 16 ≈ 0.2–0.4 s per position on Apple Silicon; a 40-move game has ~80 positions.`;
    $("#engine-path").value = c.engine_path || "";
    $("#engine-status").textContent = c.engine_path ? `Detected: ${c.engine_name}` : "No engine detected.";
  }

  $("#btn-save-engine").addEventListener("click", async () => {
    try {
      await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ engine_path: $("#engine-path").value.trim() }) });
      await loadConfig();
      $("#engine-status").textContent += " · saved";
    } catch (e) {
      $("#engine-status").textContent = "Error: " + e.message;
    }
  });

  // ------------------------------------------------------------------ upload
  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) uploadFile(f); });
  $("#file").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) uploadFile(f); e.target.value = ""; });

  function readSettings() {
    return {
      depth: +$("#depth").value || 16,
      workers: +$("#workers").value || 4,
      threads: +$("#threads").value || 1,
      hash_mb: +$("#hash").value || 128,
    };
  }

  async function uploadFile(file) {
    const s = readSettings();
    state.depth = s.depth;
    dz.querySelector(".dz-inner").innerHTML = `<div class="dz-icon">⏳</div><div>Parsing ${esc(file.name)}…</div>`;
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api(`/api/upload?depth=${s.depth}`, { method: "POST", body: fd });
      dz.querySelector(".dz-inner").innerHTML = `<div class="dz-icon">📂</div><div><strong>Drop a .pgn file here</strong> or click to choose</div>`;
      await openCollection(res.collection_id, s.depth);
      if (res.cached < res.n_games) startAnalysis(s);
    } catch (e) {
      dz.querySelector(".dz-inner").innerHTML = `<div class="dz-icon">⚠️</div><div>${esc(e.message)}</div>`;
    }
  }

  async function loadCollections() {
    const rows = await api("/api/collections").catch(() => []);
    const tb = $("#collections-table tbody");
    tb.innerHTML = rows.length ? "" : `<tr><td colspan="4" class="muted">Nothing uploaded yet.</td></tr>`;
    for (const c of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${esc(c.name)}</td><td>${c.n_games}</td><td class="muted">${new Date(c.uploaded_at * 1000).toLocaleString()}</td>
        <td style="text-align:right"><button class="btn small" data-open="${c.id}">Open</button> <button class="btn ghost small" data-del="${c.id}">Delete</button></td>`;
      tb.appendChild(tr);
    }
    tb.onclick = async (e) => {
      const open = e.target.dataset.open, del = e.target.dataset.del;
      if (open) { openCollection(+open, readSettings().depth); }
      if (del && confirm("Delete this upload? (Analysis cache is kept.)")) { await api(`/api/collections/${del}`, { method: "DELETE" }); loadCollections(); }
    };
  }

  // ------------------------------------------------------------------ collection / games list
  async function openCollection(cid, depth) {
    state.collectionId = cid;
    state.depth = depth;
    $("#nav-games").disabled = false;
    $("#export-csv").href = `/api/collections/${cid}/export.csv?depth=${depth}`;
    $("#export-json").href = `/api/collections/${cid}/export.json?depth=${depth}`;
    showView("games");
    await refreshGames();
    // is a job already running for this collection?
    const jobs = await api("/api/jobs").catch(() => []);
    const running = jobs.find((j) => j.collection_id === cid && (j.status === "running" || j.status === "queued"));
    if (running) trackJob(running.id);
    else renderProgress(null);
    location.hash = `c=${cid}&d=${depth}`;
  }

  async function refreshGames() {
    const data = await api(`/api/collections/${state.collectionId}/games?depth=${state.depth}`);
    state.games = data.games;
    state.collection = data.collection;
    renderGames();
    if (!state.job || !["running", "queued"].includes(state.job.status)) renderProgress(null);
  }

  function renderProgress(job) {
    const analyzed = state.games.filter((g) => g.analyzed).length;
    const total = state.games.length;
    const running = job && ["running", "queued"].includes(job.status);
    $("#progress-title").textContent = state.collection ? state.collection.name : "Analysis";
    $("#btn-analyze").classList.toggle("hidden", running);
    $("#btn-cancel").classList.toggle("hidden", !running);
    $("#btn-analyze").textContent = analyzed >= total ? "Re-check (all analysed)" : analyzed ? `Analyse remaining ${total - analyzed} games` : "Analyse all games";
    if (running) {
      const done = job.done_games, tot = job.total_games;
      const pct = job.total_positions ? Math.min(100, 100 * job.done_positions / job.total_positions) : (tot ? 100 * done / tot : 0);
      $("#bar-fill").style.width = pct.toFixed(1) + "%";
      $("#progress-sub").textContent = ` · depth ${job.depth} · ${job.workers} engine${job.workers > 1 ? "s" : ""} × ${job.threads} thread${job.threads > 1 ? "s" : ""}`;
      $("#progress-meta").textContent = `${done} / ${tot} games (${job.cached_games} from cache${job.failed_games ? `, ${job.failed_games} failed` : ""}) · ` +
        `${job.done_positions.toLocaleString()} / ${job.total_positions.toLocaleString()} positions · ${job.positions_per_sec} pos/s · ` +
        `elapsed ${fmtTime(job.elapsed)} · ETA ${fmtTime(job.eta)}`;
      const cur = Object.values(job.current || {});
      $("#progress-current").textContent = cur.length ? "Analysing: " + cur.join("  |  ") : "";
    } else {
      $("#bar-fill").style.width = total ? (100 * analyzed / total).toFixed(1) + "%" : "0%";
      $("#progress-sub").textContent = ` · depth ${state.depth}`;
      $("#progress-meta").textContent = `${analyzed} / ${total} games analysed` + (job && job.status === "cancelled" ? " · cancelled" : job && job.status === "error" ? ` · error: ${job.error}` : "");
      $("#progress-current").textContent = "";
    }
  }

  async function startAnalysis(settings) {
    const s = settings || readSettings();
    try {
      const job = await api(`/api/collections/${state.collectionId}/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depth: state.depth, workers: s.workers, threads: s.threads, hash_mb: s.hash_mb }),
      });
      trackJob(job.id);
    } catch (e) {
      alert(e.message);
    }
  }
  $("#btn-analyze").addEventListener("click", () => startAnalysis());
  $("#btn-cancel").addEventListener("click", async () => { if (state.job) await api(`/api/jobs/${state.job.id}/cancel`, { method: "POST" }); });

  function trackJob(jid) {
    clearInterval(state.pollTimer); clearInterval(state.listTimer);
    const poll = async () => {
      try {
        state.job = await api(`/api/jobs/${jid}`);
        renderProgress(state.job);
        if (!["running", "queued"].includes(state.job.status)) {
          clearInterval(state.pollTimer); clearInterval(state.listTimer);
          await refreshGames();
          renderProgress(state.job);
        }
      } catch (_) { }
    };
    poll();
    state.pollTimer = setInterval(poll, 1500);
    state.listTimer = setInterval(refreshGames, 6000);
  }

  // ------------------------------------------------------------------ games list rendering
  ["#search", "#filter-tag", "#sort"].forEach((s) => $(s).addEventListener("input", renderGames));

  function upsetMargin(g) {
    const w = +g.white_elo || 0, b = +g.black_elo || 0;
    if (!w || !b) return -1;
    if (g.result === "1-0") return b - w;
    if (g.result === "0-1") return w - b;
    return -1;
  }

  function renderGames() {
    const q = $("#search").value.trim().toLowerCase();
    const tag = $("#filter-tag").value;
    const sort = $("#sort").value;
    let list = state.games.slice();
    if (q) list = list.filter((g) => [g.white, g.black, g.white_team, g.black_team, g.opening?.name, g.round, g.board].join(" ").toLowerCase().includes(q));
    if (tag === "__analyzed") list = list.filter((g) => g.analyzed);
    else if (tag === "decisive") list = list.filter((g) => g.result === "1-0" || g.result === "0-1");
    else if (tag) list = list.filter((g) => g.interest && g.interest.tags.includes(tag));
    const iscore = (g) => (g.interest ? g.interest.score : -1);
    if (sort === "interest") list.sort((a, b) => iscore(b) - iscore(a) || a.idx - b.idx);
    else if (sort === "idx") list.sort((a, b) => a.idx - b.idx);
    else if (sort === "accuracy") list.sort((a, b) => (Math.max(b.white_accuracy || 0, b.black_accuracy || 0)) - (Math.max(a.white_accuracy || 0, a.black_accuracy || 0)));
    else if (sort === "upset") list.sort((a, b) => upsetMargin(b) - upsetMargin(a));
    else if (sort === "rating") list.sort((a, b) => ((+b.white_elo || 0) + (+b.black_elo || 0)) - ((+a.white_elo || 0) + (+a.black_elo || 0)));

    const analyzed = state.games.filter((g) => g.analyzed);
    const brilliant = analyzed.reduce((n, g) => n + (g.white_counts?.brilliant || 0) + (g.black_counts?.brilliant || 0), 0);
    const upsets = analyzed.filter((g) => g.interest?.tags.includes("upset")).length;
    const avgAcc = analyzed.length ? (analyzed.reduce((s, g) => s + g.white_accuracy + g.black_accuracy, 0) / (2 * analyzed.length)).toFixed(1) : "–";
    $("#stats").textContent = `${list.length} of ${state.games.length} games shown · ${analyzed.length} analysed · avg accuracy ${avgAcc}% · ${brilliant} brilliant moves · ${upsets} upsets`;

    const el = $("#games-list");
    el.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const g of list.slice(0, 400)) frag.appendChild(gameRow(g));
    el.appendChild(frag);
    if (list.length > 400) {
      const more = document.createElement("div"); more.className = "muted"; more.style.padding = "8px";
      more.textContent = `Showing first 400 of ${list.length}. Use search/filters to narrow down.`; el.appendChild(more);
    }
  }

  function playerLine(name, title, elo, team) {
    return `<div class="line">${title ? `<span class="title">${esc(title)}</span>` : ""}<span class="name">${esc(name)}</span><span class="elo">${esc(elo || "")}</span>${team ? `<span class="team">${esc(team)}</span>` : ""}</div>`;
  }

  function gameRow(g) {
    const row = document.createElement("div");
    row.className = "game-row" + (g.analyzed ? "" : " pending");
    const it = g.interest;
    const scoreHtml = g.analyzed
      ? `<div class="score ${scoreClass(it.label)}">${it.score}<small>${esc(it.label.toUpperCase())}</small></div>`
      : `<div class="score">…<small>PENDING</small></div>`;
    const meta = [g.round ? `Round ${esc(g.round)}` : "", g.board ? `Board ${esc(g.board)}` : "", g.opening ? esc(g.opening.name) : "", g.n_moves ? `${Math.ceil(g.n_moves / 2)} moves` : ""].filter(Boolean).join(" · ");
    const acc = g.analyzed ? `<div class="acc">
        <div class="accrow"><span>${esc(shortName(g.white))}</span><b>${g.white_accuracy}%</b></div>
        <div class="accrow"><span>${esc(shortName(g.black))}</span><b>${g.black_accuracy}%</b></div>
        <div class="accrow muted">${badgeCounts(g.white_counts)} / ${badgeCounts(g.black_counts)}</div></div>` : `<div class="acc muted">not analysed</div>`;
    const tags = g.analyzed ? `<div class="tags">${it.tags.map((t) => `<span class="tag ${esc(t)}">${esc(t.replace(/-/g, " "))}</span>`).join("")}</div>` : "";
    row.innerHTML = `${scoreHtml}
      <div class="players">
        ${playerLine(g.white, g.white_title, g.white_elo, g.white_team)}
        ${playerLine(g.black, g.black_title, g.black_elo, g.black_team)}
        <div class="meta">${meta}</div>
      </div>
      <div><span class="result-chip">${esc(g.result)}</span>${tags}</div>
      ${acc}
      ${g.analyzed && it.reasons.length ? `<div class="summary">${it.reasons.map(esc).join(" · ")}</div>` : ""}`;
    if (g.analyzed) row.addEventListener("click", () => openGame(g.id));
    return row;
  }

  function badgeCounts(c) {
    if (!c) return "";
    const parts = [];
    if (c.brilliant) parts.push(`<span style="color:${CLASS_META.brilliant.color}">${c.brilliant}!!</span>`);
    if (c.great) parts.push(`<span style="color:${CLASS_META.great.color}">${c.great}!</span>`);
    if (c.blunder) parts.push(`<span style="color:${CLASS_META.blunder.color}">${c.blunder}??</span>`);
    if (c.miss) parts.push(`<span style="color:${CLASS_META.miss.color}">${c.miss}✗</span>`);
    if (c.mistake) parts.push(`<span style="color:${CLASS_META.mistake.color}">${c.mistake}?</span>`);
    return parts.join(" ") || "clean";
  }

  // ------------------------------------------------------------------ game view
  async function openGame(gid) {
    const d = await api(`/api/games/${gid}?depth=${state.depth}`);
    if (!d.analysis) { alert("This game is not analysed yet."); return; }
    state.detail = d;
    state.ply = 0;
    state.flipped = false;
    renderGameHeader();
    renderMoveList();
    renderAccuracy();
    goto(d.analysis.moves.length); // show final position first? no – start at beginning
    goto(0);
    showView("game");
    location.hash = `c=${state.collectionId}&d=${state.depth}&g=${gid}`;
    window.scrollTo(0, 0);
  }
  $("#btn-back").addEventListener("click", () => { showView("games"); location.hash = `c=${state.collectionId}&d=${state.depth}`; });

  function renderGameHeader() {
    const g = state.detail.game, it = g.interest;
    const site = g.site && g.site.startsWith("http") ? `<a href="${esc(g.site)}" target="_blank" rel="noopener">source ↗</a>` : "";
    $("#game-header").innerHTML = `
      <div class="game-header">
        <div class="title">${esc(g.white)} ${esc(g.white_elo ? `(${g.white_elo})` : "")} vs ${esc(g.black)} ${esc(g.black_elo ? `(${g.black_elo})` : "")} <span class="result-chip">${esc(g.result)}</span></div>
        <div class="muted" style="margin:4px 0 8px">${[g.event, g.round ? `Round ${g.round}` : "", g.board ? `Board ${g.board}` : "", g.date, g.opening ? `${g.opening.eco} ${g.opening.name}` : ""].filter(Boolean).map(esc).join(" · ")} ${site}</div>
        <div style="display:flex;gap:12px;align-items:flex-start">
          <div class="score ${scoreClass(it.label)}" style="flex:none">${it.score}<small>${esc(it.label.toUpperCase())}</small></div>
          <div>
            <div class="summary-text">${esc(g.summary)}</div>
            ${it.reasons.length ? `<ul class="reasons muted">${it.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
          </div>
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">Engine: ${esc(state.detail.engine || "Stockfish")} · depth ${state.depth}</div>
      </div>`;
  }

  function renderAccuracy() {
    const P = state.detail.analysis.players, g = state.detail.game;
    let rows = `<div class="acc-grid">
      <div class="acc-big">${P.white.accuracy}%</div><div class="cls-label">Accuracy</div><div class="acc-big">${P.black.accuracy}%</div>
      <div class="cnt muted">${shortName(g.white)}</div><div></div><div class="cnt muted">${shortName(g.black)}</div>`;
    for (const c of CLASS_ORDER) {
      const w = P.white.counts[c] || 0, b = P.black.counts[c] || 0;
      rows += `<div class="cnt ${w ? "" : "zero"}">${w}</div><div class="cls-label"><span class="badge ${c}">${CLASS_META[c].sym}</span>${CLASS_META[c].label}</div><div class="cnt ${b ? "" : "zero"}">${b}</div>`;
    }
    rows += `<div class="cnt muted" style="font-size:12px">ACPL ${P.white.acpl}</div><div></div><div class="cnt muted" style="font-size:12px">ACPL ${P.black.acpl}</div></div>`;
    $("#accuracy-card").innerHTML = rows;
  }

  function renderMoveList() {
    const moves = state.detail.analysis.moves;
    const el = $("#movelist");
    el.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (let i = 0; i < moves.length; i += 2) {
      const no = document.createElement("div"); no.className = "no"; no.textContent = `${i / 2 + 1}.`; frag.appendChild(no);
      frag.appendChild(moveCell(moves[i]));
      if (moves[i + 1]) frag.appendChild(moveCell(moves[i + 1]));
      else { const e = document.createElement("div"); e.className = "mv empty"; frag.appendChild(e); }
    }
    el.appendChild(frag);
  }
  function moveCell(m) {
    const d = document.createElement("div");
    d.className = "mv"; d.dataset.ply = m.ply;
    const meta = CLASS_META[m.classification];
    d.innerHTML = `<span class="dot" style="background:${meta.color}"></span>${esc(m.san)}<span class="muted" style="font-size:11px">${["best", "excellent", "good", "book", "forced"].includes(m.classification) ? "" : meta.sym}</span>`;
    d.addEventListener("click", () => goto(m.ply));
    return d;
  }

  function onKey(e) {
    if (e.key === "ArrowLeft") { goto(state.ply - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { goto(state.ply + 1); e.preventDefault(); }
    else if (e.key === "Home") goto(0);
    else if (e.key === "End") goto(state.detail.analysis.moves.length);
    else if (e.key === "f") flip();
  }
  $("#btn-first").onclick = () => goto(0);
  $("#btn-prev").onclick = () => goto(state.ply - 1);
  $("#btn-next").onclick = () => goto(state.ply + 1);
  $("#btn-last").onclick = () => goto(state.detail.analysis.moves.length);
  $("#btn-flip").onclick = () => flip();
  function flip() { state.flipped = !state.flipped; goto(state.ply); }

  function goto(ply) {
    const moves = state.detail.analysis.moves;
    ply = Math.max(0, Math.min(moves.length, ply));
    state.ply = ply;
    const m = ply > 0 ? moves[ply - 1] : null;
    const fen = m ? m.fen_after : moves[0].fen_before;
    const next = ply < moves.length ? moves[ply] : null;
    renderBoard(fen, m, next);
    renderEvalBar(m);
    renderMoveInfo(m, next);
    renderLabels(ply);
    $$("#movelist .mv").forEach((el) => el.classList.toggle("active", +el.dataset.ply === ply));
    const act = $("#movelist .mv.active");
    if (act && act.scrollIntoView) act.scrollIntoView({ block: "nearest" });
    drawGraph();
  }

  function renderLabels(ply) {
    const g = state.detail.game, moves = state.detail.analysis.moves;
    const clockFor = (color) => {
      for (let i = ply - 1; i >= 0; i--) if (moves[i].color === color && moves[i].clock) return moves[i].clock;
      return "";
    };
    const white = `<span>${esc(g.white)}<span class="elo">${esc(g.white_elo || "")}</span></span><span class="clock">${clockFor("white")}</span>`;
    const black = `<span>${esc(g.black)}<span class="elo">${esc(g.black_elo || "")}</span></span><span class="clock">${clockFor("black")}</span>`;
    $("#label-top").innerHTML = state.flipped ? white : black;
    $("#label-bottom").innerHTML = state.flipped ? black : white;
  }

  // ------------------------------------------------------------------ board
  const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  function parseFen(fen) {
    const rows = fen.split(" ")[0].split("/");
    const board = [];
    for (const r of rows) {
      const row = [];
      for (const ch of r) {
        if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) row.push(null);
        else row.push(ch);
      }
      board.push(row);
    }
    return board; // board[0] = rank 8
  }
  const sqXY = (sq) => { // "e4" -> [file 0-7, rank 0-7 from top]
    let f = sq.charCodeAt(0) - 97, r = 8 - +sq[1];
    if (state.flipped) { f = 7 - f; r = 7 - r; }
    return [f, r];
  };

  function renderBoard(fen, lastMove, nextMove) {
    const board = parseFen(fen);
    const el = $("#board");
    let html = "";
    const from = lastMove ? lastMove.uci.slice(0, 2) : null, to = lastMove ? lastMove.uci.slice(2, 4) : null;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const rr = state.flipped ? 7 - r : r, ff = state.flipped ? 7 - f : f;
        const sqName = String.fromCharCode(97 + ff) + (8 - rr);
        const piece = board[rr][ff];
        const light = (rr + ff) % 2 === 0;
        const cls = ["sq", light ? "light" : "dark", sqName === from ? "from" : "", sqName === to ? "to" : ""].join(" ");
        let inner = "";
        if (piece) {
          const white = piece === piece.toUpperCase();
          inner += `<svg class="piece" viewBox="0 0 100 100"><text x="50" y="82" text-anchor="middle" font-size="86" font-family="Apple Symbols, Segoe UI Symbol, DejaVu Sans, Noto Sans Symbols2, sans-serif" fill="${white ? "#fff" : "#1a1a1a"}" stroke="${white ? "#1a1a1a" : "#000"}" stroke-width="${white ? 3 : 1.5}" paint-order="stroke">${GLYPH[piece.toLowerCase()]}</text></svg>`;
        }
        if (lastMove && sqName === to) {
          const meta = CLASS_META[lastMove.classification];
          inner += `<span class="mark" style="background:${meta.color}">${meta.sym}</span>`;
        }
        if (f === 7) inner += `<span class="coord rank">${8 - rr}</span>`;
        if (r === 7) inner += `<span class="coord file">${String.fromCharCode(97 + ff)}</span>`;
        html += `<div class="${cls}">${inner}</div>`;
      }
    }
    // arrows: best move in the position that was on the board before `lastMove` (shown when the move was not best)
    let arrows = "";
    if (lastMove && lastMove.best_uci && lastMove.best_uci !== lastMove.uci && !["book", "forced", "best"].includes(lastMove.classification)) {
      // draw on the *previous* position would be ideal; we show it on the current board as a hint of what was best
      arrows += arrow(lastMove.best_uci, "rgba(150,188,75,.85)");
    }
    html += `<svg class="arrows" viewBox="0 0 8 8">${arrows}</svg>`;
    el.innerHTML = html;
  }
  function arrow(uci, color) {
    const [fx, fy] = sqXY(uci.slice(0, 2)), [tx, ty] = sqXY(uci.slice(2, 4));
    const x1 = fx + .5, y1 = fy + .5, x2 = tx + .5, y2 = ty + .5;
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (!len) return "";
    const ux = dx / len, uy = dy / len;
    const hx = x2 - ux * .28, hy = y2 - uy * .28;
    return `<line x1="${x1}" y1="${y1}" x2="${hx}" y2="${hy}" stroke="${color}" stroke-width=".16" stroke-linecap="round"/>
      <polygon points="${x2},${y2} ${hx - uy * .18},${hy + ux * .18} ${hx + uy * .18},${hy - ux * .18}" fill="${color}"/>`;
  }

  function renderEvalBar(m) {
    let evalWhite = 0, mate = null;
    if (m) { evalWhite = m.eval_white; mate = m.mate_after; }
    const win = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-2000, Math.min(2000, evalWhite)))) - 1);
    const pct = state.flipped ? 100 - win : win;
    const bar = $("#evalbar-white");
    bar.style.height = pct + "%";
    bar.style.order = state.flipped ? -1 : 1;
    $("#evalbar").style.flexDirection = state.flipped ? "column" : "column";
    // when flipped white is at top
    $("#evalbar").style.justifyContent = state.flipped ? "flex-start" : "flex-end";
    let txt;
    if (mate !== null && mate !== undefined) txt = mate === 0 ? "#" : `M${Math.abs(mate)}`;
    else txt = (Math.abs(evalWhite) >= 1900 ? (evalWhite > 0 ? "+M" : "-M") : ((evalWhite >= 0 ? "+" : "") + (evalWhite / 100).toFixed(1)));
    const t = $("#evalbar-text");
    t.textContent = txt;
    const whiteAhead = evalWhite >= 0;
    t.style.color = whiteAhead ? "#222" : "#eee";
    t.style.top = (whiteAhead === !state.flipped) ? "auto" : "4px";
    t.style.bottom = (whiteAhead === !state.flipped) ? "4px" : "auto";
  }

  function renderMoveInfo(m, next) {
    const el = $("#move-info");
    if (!m) {
      el.innerHTML = `<div class="explain">Start of the game. Use ← → to step through the moves.</div>`;
      return;
    }
    const meta = CLASS_META[m.classification];
    const no = Math.ceil(m.ply / 2) + (m.color === "white" ? "." : "...");
    let explain = "";
    const pct = (x) => `${(x * 100).toFixed(0)}%`;
    switch (m.classification) {
      case "brilliant": explain = `A sacrifice (≈${m.sacrifice} pawns of material offered) that keeps the position sound. Winning chances ${pct(m.ep_before)} → ${pct(m.ep_after)}.`; break;
      case "great": explain = `A critical move – the alternatives would have given up much more. Winning chances ${pct(m.ep_before)} → ${pct(m.ep_after)}.`; break;
      case "best": explain = `The engine's top choice.`; break;
      case "excellent": explain = `Almost as good as ${m.best_san}. Lost ${(m.ep_loss * 100).toFixed(1)}% winning chances.`; break;
      case "good": explain = `A reasonable move; ${m.best_san} was more precise. Lost ${(m.ep_loss * 100).toFixed(1)}% winning chances.`; break;
      case "book": explain = `A known opening move.`; break;
      case "forced": explain = `The only legal move.`; break;
      case "inaccuracy": explain = `${m.best_san} was better. Winning chances ${pct(m.ep_before)} → ${pct(m.ep_after)}.`; break;
      case "mistake": explain = `${m.best_san} was much better. Winning chances ${pct(m.ep_before)} → ${pct(m.ep_after)}.`; break;
      case "miss": explain = `A winning position slipped away – ${m.best_san} would have kept it. Winning chances ${pct(m.ep_before)} → ${pct(m.ep_after)}.`; break;
      case "blunder": explain = `${m.best_san} was necessary. Winning chances ${pct(m.ep_before)} → ${pct(m.ep_after)}.`; break;
    }
    const pv = m.pv && m.pv.length && m.best_uci !== m.uci ? `<div class="pv muted">Best line: <b>${esc(m.pv.join(" "))}</b></div>` : "";
    el.innerHTML = `<div class="big"><span class="badge ${m.classification}" style="width:34px;height:34px;font-size:16px">${meta.sym}</span> ${esc(no)} ${esc(m.san)} <span class="muted" style="font-size:14px;font-weight:500">${meta.label}</span></div>
      <div><div class="explain">${esc(explain)} <span class="muted">Move accuracy ${m.accuracy}%.</span></div>${pv}</div>`;
  }

  // ------------------------------------------------------------------ graph
  function drawGraph() {
    const cv = $("#graph");
    const graph = state.detail.analysis.graph;
    const moves = state.detail.analysis.moves;
    const W = cv.clientWidth || 600, H = 90;
    if (cv.width !== W * devicePixelRatio) { cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio; }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const n = graph.length;
    const x = (i) => (n > 1 ? (i / (n - 1)) * W : 0);
    const y = (w) => H - (w / 100) * H;
    // background halves
    ctx.fillStyle = "#3a3734"; ctx.fillRect(0, 0, W, H);
    // white area
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let i = 0; i < n; i++) ctx.lineTo(x(i), y(graph[i]));
    ctx.lineTo(W, H); ctx.closePath();
    ctx.fillStyle = "#e8e6e3"; ctx.fill();
    // midline
    ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke(); ctx.setLineDash([]);
    // markers
    for (const m of moves) {
      if (["brilliant", "great", "blunder", "miss", "mistake"].includes(m.classification)) {
        ctx.fillStyle = CLASS_META[m.classification].color;
        ctx.beginPath(); ctx.arc(x(m.ply), y(graph[m.ply]), m.classification === "mistake" ? 2.5 : 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    // current
    ctx.strokeStyle = "#81b64c"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x(state.ply), 0); ctx.lineTo(x(state.ply), H); ctx.stroke();
    cv.onclick = (e) => {
      const rect = cv.getBoundingClientRect();
      const i = Math.round(((e.clientX - rect.left) / rect.width) * (n - 1));
      goto(i);
    };
  }
  window.addEventListener("resize", () => { if (state.detail && !$("#view-game").classList.contains("hidden")) drawGraph(); });

  // ------------------------------------------------------------------ boot
  async function boot() {
    await loadConfig();
    await loadCollections();
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("c")) {
      await openCollection(+h.get("c"), +h.get("d") || state.depth);
      if (h.get("g")) openGame(+h.get("g"));
    }
  }
  boot();
})();
