// StudySmartly — play page: shows a game embedded in the site with fullscreen.

const $ = (id) => document.getElementById(id);
let game = null;

function render(games) {
  const id = new URLSearchParams(location.search).get("id");
  game = games.find((g) => String(g.id) === id);
  if (!game || !safeURL(game.url)) {
    $("notFound").classList.remove("hidden");
    document.title = "Game not found · StudySmartly";
    return;
  }

  document.title = `${game.name} · StudySmartly`;
  $("playView").classList.remove("hidden");

  // Cover
  $("coverThumb").innerHTML = thumbHTML(game);
  $("coverTitle").textContent = game.name;
  const img = safeURL(game.thumbnail || "");
  $("coverBg").style.background = img ? `center / cover no-repeat url("${img.replace(/"/g, "%22")}")` : gradientFor(game.name);

  // Info bar
  $("gameTitle").textContent = game.name;
  $("gameSub").innerHTML = `by ${escapeHTML(game.creator || "Unknown")}
    ${game.category ? `<span class="pill">${escapeHTML(game.category)}</span>` : ""}`;
  if (game.description) $("gameDesc").textContent = game.description;
  else $("aboutPanel").classList.add("hidden");

  // More games: same category first, then the rest
  const others = games.filter((g) => g !== game);
  others.sort((a, b) => (b.category === game.category) - (a.category === game.category));
  const more = others.slice(0, 12);
  $("moreGrid").innerHTML = more.length
    ? more.map(cardHTML).join("")
    : `<div class="empty"><div class="big">🎮</div><h3>More games coming soon</h3></div>`;
}

function startGame() {
  if (!game || !$("frame").classList.contains("hidden")) return;
  $("frame").src = safeURL(game.url);
  $("frame").classList.remove("hidden");
  $("cover").classList.add("hidden");
  $("frame").focus();
}

/* ---------- Fullscreen ---------- */
function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement) || $("player").classList.contains("fake-fs");
}
function enterFullscreen() {
  startGame();
  const el = $("player");
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req) {
    Promise.resolve(req.call(el)).catch(() => el.classList.add("fake-fs"));
  } else {
    // iPhone Safari has no element fullscreen: fill the window instead.
    el.classList.add("fake-fs");
  }
  setTimeout(() => $("frame").focus(), 100);
}
function exitFullscreen() {
  $("player").classList.remove("fake-fs");
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
}

$("cover").addEventListener("click", startGame);
$("fsBtn").addEventListener("click", () => (isFullscreen() ? exitFullscreen() : enterFullscreen()));
$("exitFs").addEventListener("click", exitFullscreen);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("player").classList.contains("fake-fs")) exitFullscreen();
});

/* ---------- Share ---------- */
$("shareBtn").addEventListener("click", async () => {
  const data = { title: `${game.name} on StudySmartly`, text: `Play ${game.name} by ${game.creator}!`, url: location.href };
  if (navigator.share) {
    try { await navigator.share(data); return; } catch (err) { if (err.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Link copied! 🔗");
  } catch {
    prompt("Copy this link:", location.href);
  }
});

(async function init() {
  fillIcons();
  initTheme();
  $("year").textContent = new Date().getFullYear();
  render(await fetchGames());
})();
