// StudySmartly — public game library

const state = { games: [], category: "All", query: "" };

const $ = (id) => document.getElementById(id);

async function loadGames() {
  try {
    // cache-bust so newly added games show up right away
    const res = await fetch(`data/games.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    state.games = (Array.isArray(data) ? data : data.games || [])
      .filter((g) => g && g.name && g.url)
      .sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  } catch (err) {
    console.error("Could not load games.json", err);
    state.games = [];
  }
}

function categories() {
  const counts = {};
  for (const g of state.games) {
    const c = (g.category || "Other").trim();
    counts[c] = (counts[c] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderChips() {
  const chips = [["All", state.games.length], ...categories()];
  $("chips").innerHTML = chips
    .map(([name, count]) => `
      <button class="chip ${name === state.category ? "active" : ""}" data-cat="${escapeHTML(name)}">
        ${escapeHTML(name)} <span class="count">${count}</span>
      </button>`)
    .join("");
}

function filtered() {
  const q = state.query.toLowerCase();
  return state.games.filter((g) => {
    const inCat = state.category === "All" || (g.category || "Other").trim() === state.category;
    const hay = `${g.name} ${g.creator} ${g.category} ${g.description}`.toLowerCase();
    return inCat && (!q || hay.includes(q));
  });
}

function renderGrid() {
  const list = filtered();
  $("sectionTitle").textContent = state.query
    ? `Results for “${state.query}”`
    : state.category === "All" ? "New Games" : `${state.category} Games`;
  $("resultCount").textContent = `${list.length} game${list.length === 1 ? "" : "s"}`;

  if (!list.length) {
    $("grid").innerHTML = state.games.length
      ? `<div class="empty"><div class="big">🔍</div><h3>No games found</h3><p>Try a different search or category.</p></div>`
      : `<div class="empty"><div class="big">🎮</div><h3>No games yet</h3><p>Admins can add the first game from the <a href="admin.html" style="color:var(--accent);font-weight:700">admin panel</a>.</p></div>`;
    return;
  }

  $("grid").innerHTML = list
    .map((g) => `
      <button class="card" data-id="${escapeHTML(g.id)}" aria-label="Open ${escapeHTML(g.name)}">
        <div class="thumb">
          ${thumbHTML(g)}
          ${g.category ? `<span class="badge">${escapeHTML(g.category)}</span>` : ""}
          ${isNew(g) ? `<span class="badge new">NEW</span>` : ""}
          <div class="play-overlay"><span>${ICONS.play}</span></div>
        </div>
        <div class="card-body">
          <div class="card-title">${escapeHTML(g.name)}</div>
          <div class="card-creator">by ${escapeHTML(g.creator || "Unknown")}</div>
        </div>
      </button>`)
    .join("");
}

function renderStats() {
  $("statGames").textContent = state.games.length;
  const creators = new Set(state.games.map((g) => (g.creator || "").trim().toLowerCase()).filter(Boolean));
  $("statCreators").textContent = creators.size;
}

/* ---------- Modal ---------- */
function openModal(game) {
  $("modalThumb").innerHTML = thumbHTML(game);
  $("modalTitle").textContent = game.name;
  $("modalMeta").innerHTML = `
    <span class="pill">by <b>${escapeHTML(game.creator || "Unknown")}</b></span>
    ${game.category ? `<span class="pill">${escapeHTML(game.category)}</span>` : ""}
    ${game.addedAt ? `<span class="pill">Added ${new Date(game.addedAt).toLocaleDateString()}</span>` : ""}`;
  $("modalDesc").textContent = game.description || "No description yet — just hit play and find out!";
  const url = safeURL(game.url);
  $("modalPlay").href = url || "#";
  $("modal").classList.add("open");
  $("modal").setAttribute("aria-hidden", "false");
  $("modalPlay").focus();
}
function closeModal() {
  $("modal").classList.remove("open");
  $("modal").setAttribute("aria-hidden", "true");
}

/* ---------- Events ---------- */
$("chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.category = chip.dataset.cat;
  renderChips();
  renderGrid();
});

$("grid").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const game = state.games.find((g) => String(g.id) === card.dataset.id);
  if (game) openModal(game);
});

$("searchInput").addEventListener("input", (e) => {
  state.query = e.target.value.trim();
  renderGrid();
});
$("searchForm").addEventListener("submit", (e) => e.preventDefault());

$("modalClose").addEventListener("click", closeModal);
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

/* ---------- Boot ---------- */
(async function init() {
  fillIcons();
  initTheme();
  $("year").textContent = new Date().getFullYear();
  await loadGames();
  renderStats();
  renderChips();
  renderGrid();
})();
