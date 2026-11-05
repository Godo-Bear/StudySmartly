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
  // Some sites refuse to be shown inside another page; offer to open them instead.
  if (/^https?:\/\//i.test(url) && game.paid) {
    const check = await userApi(`/embed/${encodeURIComponent(game.id)}`).catch(() => ({}));
    if (check.embeddable === false) return showOpenInstead(url);
  }
  url = await withSaveTicket(url);
  $("frame").src = url;
  // Count the play for "Most played" (fire and forget).
  fetch(`/api/plays/${encodeURIComponent(game.id)}`, {
    method: "POST", keepalive: true, headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
  }).catch(() => {}); // also adds it to your Recently Played
  $("frame").classList.remove("hidden");
  $("cover").classList.add("hidden");
  $("frame").focus();
}

// The game's website doesn't allow being framed: show "Open game" on the cover.
let openInsteadUrl = "";
function showOpenInstead(url) {
  openInsteadUrl = url;
  const btn = $("cover").querySelector(".cover-play, .open-game");
  if (btn) btn.outerHTML = `
    <div class="open-instead">
      <a class="btn btn-play open-game" href="${escapeHTML(url)}" target="_blank" rel="noopener" id="openGameBtn">▶ Open game</a>
      <p>This game's website doesn't let it play inside StudySmartly, so it opens in a new tab.</p>
    </div>`;
  $("cover").classList.add("locked"); // the cover itself isn't a Play button anymore
  $("cover").removeAttribute("role");
  $("fsBtn").disabled = true;
  $("openGameBtn").addEventListener("click", () => {
    fetch(`/api/plays/${encodeURIComponent(game.id)}`, {
      method: "POST", keepalive: true, headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
    }).catch(() => {});
  });
}
async function checkFraming() {
  if (!game || game.paid || !/^https?:\/\//i.test(game.url || "")) return;
  const r = await userApi(`/embed/${encodeURIComponent(game.id)}`).catch(() => ({}));
  if (r.embeddable === false && $("frame").classList.contains("hidden")) showOpenInstead(safeURL(game.url));
}

/* ---------- Saved progress ----------
   Games hosted on StudySmartly run walled off, so they can't keep their own
   saves. When you're logged in, the game's progress is sent here and saved
   to your account, then loaded back in next time. */
const save = { folder: "", pending: null, timer: null, last: "", savedAt: null, failed: false };
const SAVE_EVERY = 15000; // ms between saves while playing

function hostedFolder(url) {
  const m = new URL(url, location.href).pathname.match(/^\/games\/([\w-]+)\//);
  return m && new URL(url, location.href).origin === location.origin ? m[1] : "";
}

async function withSaveTicket(url) {
  save.folder = hostedFolder(url);
  if (!save.folder) return url;
  renderSaveBar();
  if (!user) return url;
  try {
    const { ticket } = await userApi(`/saves/${encodeURIComponent(game.id)}/ticket`, { method: "POST", body: JSON.stringify({ folder: save.folder }) });
    const u = new URL(url, location.href);
    u.searchParams.set("ss_save", ticket);
    return u.pathname + u.search + u.hash;
  } catch {
    save.failed = true;
    renderSaveBar();
    return url;
  }
}

function renderSaveBar() {
  const bar = $("saveBar");
  if (!save.folder) return bar.classList.add("hidden");
  bar.classList.remove("hidden");
  if (!user) return bar.classList.add("hidden"); // no "log in to save" nag
  bar.className = `save-bar ${save.failed ? "warn" : "ok"}`;
  const when = save.savedAt ? `Saved ${timeAgo(save.savedAt)}` : "Progress saves automatically";
  bar.innerHTML = `
    <span class="save-icon">${save.failed ? "⚠️" : "✅"}</span>
    <div class="save-text"><b>${save.failed ? "Couldn't save just now. We'll keep trying." : `Saving to ${escapeHTML(user.username)}'s account`}</b>
      <span>${when}</span></div>
    <div class="save-actions"><button class="btn btn-ghost btn-small" id="resetSave">Reset progress</button></div>`;
  $("resetSave").addEventListener("click", resetProgress);
}

function timeAgo(d) {
  const s = Math.round((Date.now() - d) / 1000);
  return s < 10 ? "just now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

async function flushSave(useBeacon = false) {
  clearTimeout(save.timer);
  save.timer = null;
  if (!save.pending || !user) return;
  const body = JSON.stringify({ data: save.pending });
  if (body === save.last) { save.pending = null; return; }
  const data = save.pending;
  save.pending = null;
  try {
    const res = await fetch(`/api/saves/${encodeURIComponent(game.id)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json" },
      body,
      keepalive: useBeacon && body.length < 60000, // lets the save finish while leaving the page
    });
    if (!res.ok) throw new Error(res.status);
    save.last = body;
    save.savedAt = Date.now();
    save.failed = false;
  } catch {
    save.pending = save.pending || data; // try again next time
    save.failed = true;
    if (!useBeacon) save.timer = setTimeout(flushSave, SAVE_EVERY);
  }
  renderSaveBar();
}

window.addEventListener("message", (e) => {
  // Only listen to the game we're showing.
  if (e.source !== $("frame").contentWindow || !save.folder || !e.data) return;
  if (e.data.type === "ss-save" && user && e.data.data && typeof e.data.data === "object") {
    save.pending = e.data.data;
    if (!save.timer) save.timer = setTimeout(flushSave, save.savedAt ? SAVE_EVERY : 2000);
  }
});
// Save right away when leaving or switching tabs.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave(true); });
window.addEventListener("pagehide", () => flushSave(true));
setInterval(() => { if (save.savedAt && user) renderSaveBar(); }, 30000);

async function resetProgress() {
  if (!(await askConfirm("Reset your progress in this game? This can't be undone.", { yes: "Reset", danger: true }))) return;
  try {
    clearTimeout(save.timer);
    save.timer = null;
    save.pending = null;
    await userApi(`/saves/${encodeURIComponent(game.id)}`, { method: "DELETE" });
    save.last = "";
    save.savedAt = null;
    toast("Progress reset. Restarting the game…");
    const frame = $("frame");
    const u = new URL(frame.getAttribute("src"), location.href);
    u.searchParams.delete("ss_save");
    frame.src = await withSaveTicket(u.pathname + u.search + u.hash);
  } catch (err) {
    toast(err.message, true);
  }
}

// Show the save message before the game starts, for games hosted here.
function previewSaveBar() {
  if (game && !game.paid && hostedFolder(safeURL(game.url) || location.href)) {
    save.folder = hostedFolder(game.url);
    renderSaveBar();
  }
}

/* ---------- 👍 / 👎, ⭐ favourite, 🚩 report ---------- */
let myVote = 0;
function renderVotes(v) {
  myVote = v.mine;
  $("likeBtn").classList.toggle("on", v.mine === 1);
  $("dislikeBtn").classList.toggle("on", v.mine === -1);
  $("likeCount").textContent = formatPlays(v.up);
  $("dislikeCount").textContent = formatPlays(v.down);
}
async function castVote(v) {
  try {
    renderVotes(await userApi(`/votes/${encodeURIComponent(game.id)}`, { method: "POST", body: JSON.stringify({ v: myVote === v ? 0 : v }) }));
  } catch (err) { toast(err.message, true); }
}
$("likeBtn").addEventListener("click", () => castVote(1));
$("dislikeBtn").addEventListener("click", () => castVote(-1));

let isFav = false;
function renderFav() {
  $("favBtn").classList.toggle("on", isFav);
  $("favBtn").innerHTML = isFav ? "⭐ Favourite" : "☆ Favourite";
  $("favBtn").title = isFav ? "Remove from your favourites" : "Add to your favourites";
}
$("favBtn").addEventListener("click", async () => {
  try {
    isFav = (await userApi(`/favs/${encodeURIComponent(game.id)}`, { method: "POST", body: JSON.stringify({ on: !isFav }) })).on;
    renderFav();
    toast(isFav ? "Added to your favourites ⭐" : "Removed from favourites");
  } catch (err) { toast(err.message, true); }
});

$("reportBtn").addEventListener("click", () => {
  const wrap = document.createElement("div");
  wrap.className = "ask-backdrop";
  wrap.innerHTML = `
    <form class="ask-box report-box">
      <h3>🚩 Report “${escapeHTML(game.name)}”</h3>
      <p class="sub">An admin will look at it.</p>
      <label class="radio"><input type="radio" name="reason" value="broken" checked> It's broken / won't load</label>
      <label class="radio"><input type="radio" name="reason" value="inappropriate"> It's inappropriate</label>
      <label class="radio"><input type="radio" name="reason" value="other"> Something else</label>
      <textarea name="note" maxlength="300" placeholder="Tell us more (optional)"></textarea>
      <div class="ask-buttons">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-danger-solid">Send report</button>
      </div>
    </form>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-close]")) close(); });
  wrap.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    f.querySelector("[type=submit]").disabled = true;
    try {
      await userApi(`/reports/${encodeURIComponent(game.id)}`, { method: "POST", body: JSON.stringify({ reason: f.reason.value, note: f.note.value }) });
      close();
      toast("Thanks! An admin will look at it. 🚩");
    } catch (err) {
      toast(err.message, true);
      f.querySelector("[type=submit]").disabled = false;
    }
  });
});

/* ---------- ✨ AI overview ---------- */
let aiTries = 0;
function renderOverview(o) {
  const li = (arr) => arr.map((x) => `<li>${escapeHTML(x)}</li>`).join("");
  $("aiBody").innerHTML = `
    ${o.summary ? `<p class="ai-summary">${escapeHTML(o.summary)}</p>` : ""}
    ${o.goal ? `<div class="ai-block"><h3>🎯 Goal</h3><p>${escapeHTML(o.goal)}</p></div>` : ""}
    ${o.howToPlay && o.howToPlay.length ? `<div class="ai-block"><h3>🕹️ How to play</h3><ol>${li(o.howToPlay)}</ol></div>` : ""}
    ${o.controls && o.controls.length ? `<div class="ai-block"><h3>⌨️ Controls</h3>
      <div class="ai-controls">${o.controls.map((c) => `<div><kbd>${escapeHTML(c.input)}</kbd><span>${escapeHTML(c.action)}</span></div>`).join("")}</div></div>` : ""}
    ${o.tips && o.tips.length ? `<div class="ai-block"><h3>💡 Tips</h3><ul>${li(o.tips)}</ul></div>` : ""}
    ${o.goodFor ? `<div class="ai-block"><h3>🧠 Good for</h3><p>${escapeHTML(o.goodFor)}</p></div>` : ""}`;
}
async function loadOverview(refresh = false) {
  $("aiBody").innerHTML = `<div class="ai-writing"><span class="ai-spinner"></span> ${refresh ? "Rewriting" : "Loading"} the overview…</div>`;
  try {
    const r = await userApi(`/overview/${encodeURIComponent(game.id)}${refresh ? "/refresh" : ""}`, refresh ? { method: "POST" } : {});
    if (r.status === "ready") { aiTries = 0; return renderOverview(r.overview); }
    if (r.status === "writing" && aiTries++ < 20) {
      $("aiBody").innerHTML = `<div class="ai-writing"><span class="ai-spinner"></span> The AI is reading through the game… this takes a few seconds the first time.</div>`;
      return setTimeout(() => loadOverview(), 6000);
    }
    $("aiBody").innerHTML = `<p class="muted-note">${escapeHTML(r.message || "No overview yet.")}</p>
      <button class="btn btn-ghost btn-small" id="aiRetry">Try again</button>`;
    $("aiRetry").addEventListener("click", () => loadOverview());
  } catch (err) {
    $("aiBody").innerHTML = `<p class="muted-note">${escapeHTML(err.message)}</p>`;
  }
}
$("aiRefresh").addEventListener("click", () => loadOverview(true));

/* ---------- 💬 Comments ---------- */
let comments = { comments: [], owner: "", canModerate: false };
function ago(at) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} days ago`;
  return new Date(at).toLocaleDateString();
}
function renderComments() {
  const list = comments.comments;
  $("commentCount").textContent = list.length ? `(${list.length})` : "";
  const me = user ? user.username.toLowerCase() : "";
  $("commentList").innerHTML = list.length
    ? list.map((c) => {
        const mine = c.user === me;
        const isCreator = comments.owner && c.user === comments.owner.toLowerCase();
        return `
          <div class="comment" data-id="${c.id}">
            <span class="avatar sm" style="background:${gradientFor(c.name)}">${escapeHTML(initials(c.name))}</span>
            <div class="comment-body">
              <div class="comment-top"><b>${escapeHTML(c.name)}</b>${isCreator ? `<span class="creator-tag">Creator</span>` : ""}<time>${escapeHTML(ago(c.at))}</time></div>
              <p>${escapeHTML(c.text)}</p>
              <div class="comment-actions">
                ${mine || comments.canModerate ? `<button data-del-comment="${c.id}">Delete</button>` : ""}
                ${!mine ? `<button data-report-comment="${c.id}">Report</button>` : ""}
              </div>
            </div>
          </div>`;
      }).join("")
    : `<p class="muted-note">No comments yet. Be the first!</p>`;
}
async function loadComments() {
  try {
    comments = await userApi(`/comments/${encodeURIComponent(game.id)}`);
    renderComments();
  } catch (err) {
    $("commentList").innerHTML = `<p class="muted-note">${escapeHTML(err.message)}</p>`;
  }
}
$("commentText").addEventListener("input", () => { $("commentChars").textContent = `${$("commentText").value.length} / 500`; });
$("commentText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("commentForm").requestSubmit();
});
$("commentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("commentText").value.trim();
  if (!text) return;
  $("commentPost").disabled = true;
  try {
    const { comment } = await userApi(`/comments/${encodeURIComponent(game.id)}`, { method: "POST", body: JSON.stringify({ text }) });
    comments.comments.unshift(comment);
    renderComments();
    $("commentText").value = "";
    $("commentChars").textContent = "0 / 500";
  } catch (err) { toast(err.message, true); }
  $("commentPost").disabled = false;
});
$("commentList").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del-comment]"), rep = e.target.closest("[data-report-comment]");
  if (!del && !rep) return;
  const id = Number((del || rep).dataset[del ? "delComment" : "reportComment"]);
  if (!(await askConfirm(del ? "Delete this comment?" : "Report this comment to the admins?", { yes: del ? "Delete" : "Report", danger: true }))) return;
  try {
    await userApi(`/comments/c/${id}/${del ? "delete" : "report"}`, { method: "POST" });
    if (del) { comments.comments = comments.comments.filter((c) => c.id !== id); renderComments(); toast("Comment deleted"); }
    else toast("Thanks. An admin will look at it 🛡️");
  } catch (err) { toast(err.message, true); }
});

async function loadSocial() {
  try {
    const [votes, lib] = await Promise.all([userApi(`/votes/${encodeURIComponent(game.id)}`), userApi("/library")]);
    renderVotes(votes);
    isFav = lib.favs.includes(game.id);
    renderFav();
  } catch {}
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
  if (!e.target.closest("a") && !openInsteadUrl) startGame();
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
  user = await loadMe();
  if (!siteGate(user)) return; // not approved yet: show the lock screen
  const games = await fetchGames();
  initAccount(user);
  setTimeout(previewSaveBar, 0);
  const current = games.find((g) => String(g.id) === new URLSearchParams(location.search).get("id"));
  initSidebar(games, current ? `category:${gameCategory(current)}` : "");
  addCreateButton();
  render(games);
  if (game) {
    checkFraming();
    loadSocial();
    loadComments();
    loadOverview();
    // The game's creator or an admin can ask for a fresh overview
    if (user && (user.admin || isOwner(game, user))) $("aiRefresh").classList.remove("hidden");
  }
})();
