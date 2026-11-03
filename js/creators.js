// StudySmartly — Creators page: everyone who has shared games.

const $ = (id) => document.getElementById(id);

function groupByCreator(games) {
  const map = new Map();
  for (const g of games) {
    const name = (g.creator || "Unknown").trim();
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, { name, games: [] });
    map.get(key).games.push(g);
  }
  // most games first, then newest
  return [...map.values()].sort((a, b) => b.games.length - a.games.length || a.name.localeCompare(b.name));
}

function render(games) {
  const creators = groupByCreator(games);
  $("statCreators").textContent = creators.length;
  $("statGames").textContent = games.length;
  $("resultCount").textContent = `${creators.length} creator${creators.length === 1 ? "" : "s"}`;
  if (!creators.length) {
    $("creatorGrid").innerHTML = `<div class="empty"><div class="big">👥</div><h3>No creators yet</h3><p>Be the first: <a href="create.html" style="color:var(--accent);font-weight:700">add your game</a>.</p></div>`;
    return;
  }
  $("creatorGrid").innerHTML = creators.map((c) => {
    const cats = categoryCounts(c.games).map(([n]) => n);
    const latest = c.games.slice(0, 3);
    return `
      <a class="creator-card" href="${creatorURL(c.name)}">
        <div class="creator-top">
          <span class="avatar" style="background:${gradientFor(c.name)}">${escapeHTML(initials(c.name))}</span>
          <div>
            <div class="creator-name">${escapeHTML(c.name)}</div>
            <div class="creator-meta">${c.games.length} game${c.games.length === 1 ? "" : "s"}</div>
          </div>
        </div>
        <div class="creator-thumbs">
          ${latest.map((g) => `<div class="t" title="${escapeHTML(g.name)}">${thumbHTML(g)}</div>`).join("")}
        </div>
        <div class="creator-tags">${cats.map((n) => `<span class="pill">${categoryIcon(n)} ${escapeHTML(n)}</span>`).join("")}</div>
      </a>`;
  }).join("");
}

$("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("searchInput").value.trim();
  location.href = q ? `./?q=${encodeURIComponent(q)}` : "./";
});

(async function init() {
  fillIcons();
  initTheme();
  $("year").textContent = new Date().getFullYear();
  const [games, user] = await Promise.all([fetchGames(), loadMe()]);
  initAccount(user);
  initSidebar(games, "creators");
  addCreateButton();
  render(games);
})();
