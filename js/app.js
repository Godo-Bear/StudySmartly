// StudySmartly — home page. The same page also shows one game type
// (index.html?category=Shooting) or one creator's games (?creator=Name).

const params = new URLSearchParams(location.search);
const state = {
  games: [],
  user: null,
  category: params.get("category") || "",
  creator: params.get("creator") || "",
  query: (params.get("q") || "").trim(),
  top: [], // [{ id, count }] most played
};
const $ = (id) => document.getElementById(id);

function pageGames() {
  return state.games.filter((g) =>
    (!state.category || gameCategory(g).toLowerCase() === state.category.toLowerCase()) &&
    (!state.creator || (g.creator || "").trim().toLowerCase() === state.creator.toLowerCase()));
}

function renderChips() {
  const all = state.creator ? pageGames() : state.games; // on a creator page, chips show their types
  const chips = categoryCounts(all);
  const base = state.creator ? `&creator=${encodeURIComponent(state.creator)}` : "";
  const allHref = state.creator ? creatorURL(state.creator) : "./";
  $("chips").innerHTML = `
    <a class="chip ${!state.category ? "active" : ""}" href="${allHref}">All <span class="count">${all.length}</span></a>
    ${chips.map(([name, n]) => `
      <a class="chip ${state.category.toLowerCase() === name.toLowerCase() ? "active" : ""}" href="${categoryURL(name)}${base}">
        ${categoryIcon(name)} ${escapeHTML(name)} <span class="count">${n}</span>
      </a>`).join("")}`;
  $("chips").querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "center" });
}

function renderHero() {
  const list = pageGames();
  const creators = new Set(list.map((g) => (g.creator || "").trim().toLowerCase()).filter(Boolean));
  $("statGames").textContent = list.length;
  $("statCreators").textContent = creators.size;
  if (!state.category && !state.creator) return;

  // Proper casing from the data, e.g. ?category=shooting -> "Shooting"
  const cat = state.category && (state.games.map(gameCategory).find((c) => c.toLowerCase() === state.category.toLowerCase()) || state.category);
  const who = state.creator && (state.games.map((g) => (g.creator || "").trim()).find((c) => c.toLowerCase() === state.creator.toLowerCase()) || state.creator);
  $("crumbs").classList.remove("hidden");
  $("crumbs").innerHTML = `<a href="./">Home</a> › ${who ? `<a href="creators.html">Creators</a> › ` : ""}${escapeHTML(who && cat ? `${who} · ${cat}` : who || cat)}`;
  if (who) {
    $("heroIcon").classList.add("hidden");
    $("heroTitle").textContent = cat ? `${who}'s ${cat} games` : `Games by ${who}`;
    $("heroText").textContent = `Every game ${who} has shared on StudySmartly.`;
    document.title = `Games by ${who} · StudySmartly`;
  } else {
    $("heroIcon").textContent = categoryIcon(cat);
    $("heroIcon").classList.remove("hidden");
    $("heroTitle").textContent = `${cat} Games`;
    $("heroText").textContent = `Every ${cat.toLowerCase()} game on StudySmartly. Pick one and hit play.`;
    document.title = `${cat} Games · StudySmartly`;
  }
}

function filtered() {
  const q = state.query.toLowerCase();
  return pageGames().filter((g) => {
    const hay = `${g.name} ${g.creator} ${g.category} ${g.description}`.toLowerCase();
    return !q || hay.includes(q);
  });
}

const isHome = () => !state.category && !state.creator && !state.query;

// Home page: a section for each game type, newest games first.
const PER_SECTION = 6;
function renderHomeSections() {
  // 🔥 Most played first (only games that still exist and have been played)
  const byId = new Map(state.games.map((g) => [g.id, g]));
  const top = state.top.filter((t) => t.count > 0 && byId.has(t.id)).slice(0, PER_SECTION);
  const mostPlayed = top.length ? `
    <section class="home-section most-played">
      <div class="section-head">
        <span class="section-icon">🔥</span>
        <h2>Most Played</h2>
        <span class="result-count">Top ${top.length}</span>
      </div>
      <div class="grid">${top.map((t, i) => cardHTML(byId.get(t.id), state.user, { plays: t.count, rank: i + 1 })).join("")}</div>
    </section>` : "";
  // Every game under one "Different Subjects" heading, newest first.
  $("homeSections").innerHTML = mostPlayed + (state.games.length
    ? `
      <section class="home-section">
        <div class="section-head">
          <span class="section-icon">📚</span>
          <h2>Different Subjects</h2>
          <span class="result-count">${state.games.length} game${state.games.length === 1 ? "" : "s"}</span>
        </div>
        <div class="grid">${state.games.map((g) => cardHTML(g, state.user)).join("")}</div>
      </section>`
    : `<div class="empty" style="margin-top:30px"><div class="big">📚</div><h3>Nothing here yet</h3><p>Be the first: <a href="create.html" style="color:var(--accent);font-weight:700">add yours</a>.</p></div>`);
}

async function loadTop() {
  try {
    const res = await fetch("/api/plays/top");
    if (res.ok) state.top = (await res.json()).top || [];
  } catch {}
}

function render() {
  const home = isHome();
  $("homeSections").classList.toggle("hidden", !home);
  $("listView").classList.toggle("hidden", home);
  if (home) renderHomeSections();
  else renderGrid();
}

function renderGrid() {
  const list = filtered();
  $("sectionTitle").textContent = state.query
    ? `Results for “${state.query}”`
    : "All games";
  $("resultCount").textContent = `${list.length} game${list.length === 1 ? "" : "s"}`;

  if (!list.length) {
    $("grid").innerHTML = state.query
      ? `<div class="empty"><div class="big">🔍</div><h3>No games found</h3><p>Try a different search.</p></div>`
      : state.category || state.creator
        ? `<div class="empty"><div class="big">${state.category ? categoryIcon(state.category) : "🎮"}</div><h3>Nothing here yet</h3><p>Made one? <a href="create.html" style="color:var(--accent);font-weight:700">Add your game</a>.</p></div>`
        : `<div class="empty"><div class="big">🎮</div><h3>No games yet</h3><p>Be the first: <a href="create.html" style="color:var(--accent);font-weight:700">add your game</a>.</p></div>`;
    return;
  }
  $("grid").innerHTML = list.map((g) => cardHTML(g, state.user)).join("");
}

$("searchInput").addEventListener("input", (e) => {
  state.query = e.target.value.trim();
  render();
});
$("searchForm").addEventListener("submit", (e) => e.preventDefault());

(async function init() {
  fillIcons();
  initTheme();
  $("year").textContent = new Date().getFullYear();
  if (state.query) $("searchInput").value = state.query;
  state.user = await loadMe();
  if (!siteGate(state.user)) return; // not approved yet: show the lock screen
  [state.games] = await Promise.all([fetchGames(), isHome() ? loadTop() : null]);
  initAccount(state.user);
  initSidebar(state.games, state.category ? `category:${state.category}` : state.creator ? "creators" : "home");
  addCreateButton();
  renderHero();
  renderChips();
  render();
})();
