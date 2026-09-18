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
  // Chess piece artwork: the "cburnett" vector set (by Colin M. L. Burnett, CC-BY-SA/GPL),
  // the same widely-used, professionally drawn set that powers Lichess and Wikipedia's
  // chess diagrams — a clean, modern look in place of the old unicode-glyph pieces.
  const PIECE_SVG = {
    'P': '<g id="white-pawn" class="white pawn"><path d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47 1.47-1.19 2.41-3 2.41-5.03 0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linecap="round"/></g>',
    'N': '<g id="white-knight" class="white knight" fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18" style="fill:#ffffff; stroke:#000000;"/><path d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10" style="fill:#ffffff; stroke:#000000;"/><path d="M 9.5 25.5 A 0.5 0.5 0 1 1 8.5,25.5 A 0.5 0.5 0 1 1 9.5 25.5 z" style="fill:#000000; stroke:#000000;"/><path d="M 15 15.5 A 0.5 1.5 0 1 1 14,15.5 A 0.5 1.5 0 1 1 15 15.5 z" transform="matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)" style="fill:#000000; stroke:#000000;"/></g>',
    'B': '<g id="white-bishop" class="white bishop" fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><g fill="#fff" stroke-linecap="butt"><path d="M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.354.49-2.323.47-3-.5 1.354-1.94 3-2 3-2zM15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2zM25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z"/></g><path d="M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5" stroke-linejoin="miter"/></g>',
    'R': '<g id="white-rook" class="white rook" fill="#fff" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 39h27v-3H9v3zM12 36v-4h21v4H12zM11 14V9h4v2h5V9h5v2h5V9h4v5" stroke-linecap="butt"/><path d="M34 14l-3 3H14l-3-3"/><path d="M31 17v12.5H14V17" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M31 29.5l1.5 2.5h-20l1.5-2.5"/><path d="M11 14h23" fill="none" stroke-linejoin="miter"/></g>',
    'Q': '<g id="white-queen" class="white queen" fill="#fff" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM24.5 7.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM41 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM16 8.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0zM33 9a2 2 0 1 1-4 0 2 2 0 1 1 4 0z"/><path d="M9 26c8.5-1.5 21-1.5 27 0l2-12-7 11V11l-5.5 13.5-3-15-3 15-5.5-14V25L7 14l2 12zM9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z" stroke-linecap="butt"/><path d="M11.5 30c3.5-1 18.5-1 22 0M12 33.5c6-1 15-1 21 0" fill="none"/></g>',
    'K': '<g id="white-king" class="white king" fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22.5 11.63V6M20 8h5" stroke-linejoin="miter"/><path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5" fill="#fff" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M11.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10V37z" fill="#fff"/><path d="M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0"/></g>',
    'p': '<g id="black-pawn" class="black pawn"><path d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47 1.47-1.19 2.41-3 2.41-5.03 0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z" fill="#000" stroke="#000" stroke-width="1.5" stroke-linecap="round"/></g>',
    'n': '<g id="black-knight" class="black knight" fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18" style="fill:#000000; stroke:#000000;"/><path d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10" style="fill:#000000; stroke:#000000;"/><path d="M 9.5 25.5 A 0.5 0.5 0 1 1 8.5,25.5 A 0.5 0.5 0 1 1 9.5 25.5 z" style="fill:#ececec; stroke:#ececec;"/><path d="M 15 15.5 A 0.5 1.5 0 1 1 14,15.5 A 0.5 1.5 0 1 1 15 15.5 z" transform="matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)" style="fill:#ececec; stroke:#ececec;"/><path d="M 24.55,10.4 L 24.1,11.85 L 24.6,12 C 27.75,13 30.25,14.49 32.5,18.75 C 34.75,23.01 35.75,29.06 35.25,39 L 35.2,39.5 L 37.45,39.5 L 37.5,39 C 38,28.94 36.62,22.15 34.25,17.66 C 31.88,13.17 28.46,11.02 25.06,10.5 L 24.55,10.4 z " style="fill:#ececec; stroke:none;"/></g>',
    'b': '<g id="black-bishop" class="black bishop" fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.354.49-2.323.47-3-.5 1.354-1.94 3-2 3-2zm6-4c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2zM25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z" fill="#000" stroke-linecap="butt"/><path d="M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5" stroke="#fff" stroke-linejoin="miter"/></g>',
    'r': '<g id="black-rook" class="black rook" fill="#000" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 39h27v-3H9v3zM12.5 32l1.5-2.5h17l1.5 2.5h-20zM12 36v-4h21v4H12z" stroke-linecap="butt"/><path d="M14 29.5v-13h17v13H14z" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M14 16.5L11 14h23l-3 2.5H14zM11 14V9h4v2h5V9h5v2h5V9h4v5H11z" stroke-linecap="butt"/><path d="M12 35.5h21M13 31.5h19M14 29.5h17M14 16.5h17M11 14h23" fill="none" stroke="#fff" stroke-width="1" stroke-linejoin="miter"/></g>',
    'q': '<g id="black-queen" class="black queen" fill="#000" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><g fill="#000" stroke="none"><circle cx="6" cy="12" r="2.75"/><circle cx="14" cy="9" r="2.75"/><circle cx="22.5" cy="8" r="2.75"/><circle cx="31" cy="9" r="2.75"/><circle cx="39" cy="12" r="2.75"/></g><path d="M9 26c8.5-1.5 21-1.5 27 0l2.5-12.5L31 25l-.3-14.1-5.2 13.6-3-14.5-3 14.5-5.2-13.6L14 25 6.5 13.5 9 26zM9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z" stroke-linecap="butt"/><path d="M11 38.5a35 35 1 0 0 23 0" fill="none" stroke-linecap="butt"/><path d="M11 29a35 35 1 0 1 23 0M12.5 31.5h20M11.5 34.5a35 35 1 0 0 22 0M10.5 37.5a35 35 1 0 0 24 0" fill="none" stroke="#fff"/></g>',
    'k': '<g id="black-king" class="black king" fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22.5 11.63V6" stroke-linejoin="miter"/><path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5" fill="#000" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M11.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10V37z" fill="#000"/><path d="M20 8h5" stroke-linejoin="miter"/><path d="M32 29.5s8.5-4 6.03-9.65C34.15 14 25 18 22.5 24.5l.01 2.1-.01-2.1C20 18 9.906 14 6.997 19.85c-2.497 5.65 4.853 9 4.853 9M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0" stroke="#fff"/></g>',
  };
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
          inner += `<svg class="piece" viewBox="0 0 45 45">${PIECE_SVG[piece]}</svg>`;
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