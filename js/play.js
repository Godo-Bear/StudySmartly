// StudySmartly — play page: shows a game embedded in the site with fullscreen.

const $ = (id) => document.getElementById(id);
let game = null;
let user = null;
let playable = true; // false while a paid game is locked for this visitor

function render(games) {
  const id = new URLSearchParams(location.search).get("id");
  game = games.find((g) => String(g.id) === id);
  if (!game || (!game.paid && !safeURL(game.url))) {
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
    ${game.category ? `<span class="pill">${escapeHTML(game.category)}</span>` : ""}
    ${game.paid ? `<span class="price-tag">${user && (user.admin || user.unlocked.includes(game.id) || isOwner(game, user)) ? "✓ Owned" : `🔒 Paid${game.price ? ` · ${escapeHTML(game.price)}` : ""}`}</span>` : ""}`;
  if (game.paid) renderLock();
  if (game.description) $("gameDesc").textContent = game.description;
  else $("aboutPanel").classList.add("hidden");

  // More games: same category first, then the rest
  const others = games.filter((g) => g !== game);
  others.sort((a, b) => (b.category === game.category) - (a.category === game.category));
  const more = others.slice(0, 12);
  $("moreGrid").innerHTML = more.length
    ? more.map((g) => cardHTML(g, user)).join("")
    : `<div class="empty"><div class="big">🎮</div><h3>More games coming soon</h3></div>`;
}

// Paid games: show who to pay and what to do instead of the Play button.
function renderLock() {
  if (user && (user.admin || user.unlocked.includes(game.id) || isOwner(game, user))) return; // owned: normal Play button
  playable = false;
  const owner = escapeHTML(game.creator || "the owner");
  const price = game.price ? ` <b>${escapeHTML(game.price)}</b>` : "";
  $("cover").classList.add("locked");
  $("player").classList.add("is-locked");
  $("cover").removeAttribute("role");
  $("cover").removeAttribute("tabindex");
  $("cover").querySelector(".cover-play").outerHTML = `
    <div class="lock-box">
      <div class="lock-title">🔒 Needs to pay owner to own</div>
      <div class="lock-text">
        Pay <b>${owner}</b>${price} to own this game. Once you've paid, an admin unlocks it for your account.
        ${user
          ? `<br>Your username is <code>${escapeHTML(user.username)}</code>. Send it to ${owner} when you pay.`
          : `<br>You need an account first.`}
      </div>
      ${user ? "" : `<a class="btn btn-primary" href="${loginURL("signup")}">Sign up / Log in</a>`}
    </div>`;
  $("fsBtn").disabled = true;
}

async function startGame() {
  if (!game || !playable || !$("frame").classList.contains("hidden")) return;
  let url = safeURL(game.url);
  if (game.paid) {
    try {
      url = safeURL((await userApi(`/play/${encodeURIComponent(game.id)}`)).url);
    } catch (err) {
      toast(err.message, true);
      return;
    }
  }
  if (!url) return toast("This game's link is broken.", true);
  $("frame").src = url;
  $("frame").classList.remove("hidden");
  $("cover").classList.add("hidden");
  $("frame").focus();
}

/* ---------- Fullscreen ---------- */
function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement) || $("player").classList.contains("fake-fs");
}
function enterFullscreen() {
  if (!playable) return;
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

$("cover").addEventListener("click", (e) => {
  if (!e.target.closest("a")) startGame();
});
$("cover").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target === $("cover")) { e.preventDefault(); startGame(); }
});
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
  const [games, me] = await Promise.all([fetchGames(), loadMe()]);
  user = me;
  initAccount(user);
  const current = games.find((g) => String(g.id) === new URLSearchParams(location.search).get("id"));
  initSidebar(games, current ? `category:${gameCategory(current)}` : "");
  addCreateButton();
  render(games);
})();
