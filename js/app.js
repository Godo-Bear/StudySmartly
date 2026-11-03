// StudySmartly — home page game library

const state = { games: [], category: "All", query: "", user: null };
const $ = (id) => document.getElementById(id);

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
  $("grid").innerHTML = list.map((g) => cardHTML(g, state.user)).join("");
}

function renderStats() {
  $("statGames").textContent = state.games.length;
  const creators = new Set(state.games.map((g) => (g.creator || "").trim().toLowerCase()).filter(Boolean));
  $("statCreators").textContent = creators.size;
}

$("chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.category = chip.dataset.cat;
  renderChips();
  renderGrid();
});

$("searchInput").addEventListener("input", (e) => {
  state.query = e.target.value.trim();
  renderGrid();
});
$("searchForm").addEventListener("submit", (e) => e.preventDefault());

(async function init() {
  fillIcons();
  initTheme();
  $("year").textContent = new Date().getFullYear();
  // Searches submitted from the play page arrive as ?q=
  const q = new URLSearchParams(location.search).get("q");
  if (q) { state.query = q.trim(); $("searchInput").value = state.query; }
  [state.games, state.user] = await Promise.all([fetchGames(), loadMe()]);
  initAccount(state.user);
  renderStats();
  renderChips();
  renderGrid();
})();
