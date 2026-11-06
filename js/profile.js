// StudySmartly — a player's profile: badges, stats, games they made,
// favourites, and a friend / message button.

const $ = (id) => document.getElementById(id);
const name = new URLSearchParams(location.search).get("u") || "";
let me = null, profile = null, relation = "none";

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" }) : "";
}
function lastOn(iso) {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 600) return "On now";
  if (s < 3600) return `On ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `On ${Math.round(s / 3600)} h ago`;
  return `Last on ${Math.round(s / 86400)} day${s < 172800 ? "" : "s"} ago`;
}

function renderActions() {
  const n = escapeHTML(profile.username);
  const btn = {
    self: `<span class="muted-note">This is you 👋</span>`,
    none: `<button class="btn btn-primary" data-act="add">➕ Add friend</button>`,
    outgoing: `<button class="btn btn-ghost" disabled>Request sent ✓</button>`,
    incoming: `<button class="btn btn-primary" data-act="accept">✅ Accept friend request</button>`,
    friends: `<button class="btn btn-primary" data-act="dm">💬 Message</button><span class="friends-pill">✓ Friends</span>`,
    blocked: `<span class="muted-note">You blocked ${n}.</span><button class="btn btn-ghost btn-small" data-act="unblock">Unblock</button>`,
  }[relation] || "";
  $("pActions").innerHTML = btn;
}

$("pActions").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const n = encodeURIComponent(profile.username);
  b.disabled = true;
  try {
    if (b.dataset.act === "add") {
      const r = await userApi("/chat/friends", { method: "POST", body: JSON.stringify({ username: profile.username }) });
      relation = r.accepted ? "friends" : "outgoing";
      toast(r.accepted ? `You and ${profile.username} are friends now 🎉` : `Friend request sent to ${profile.username}`);
    } else if (b.dataset.act === "accept") {
      await userApi(`/chat/friends/${n}/accept`, { method: "POST" });
      relation = "friends";
      toast(`You and ${profile.username} are friends now 🎉`);
    } else if (b.dataset.act === "unblock") {
      await userApi(`/chat/friends/${n}/unblock`, { method: "POST" });
      relation = "none";
    } else if (b.dataset.act === "dm") {
      const r = await userApi(`/chat/friends/${n}/dm`, { method: "POST" });
      location.href = `chat.html#${encodeURIComponent(r.room)}`;
      return;
    }
    renderActions();
  } catch (err) {
    toast(err.message, true);
    b.disabled = false;
  }
});

function render(games) {
  const p = profile;
  const byId = new Map(games.map((g) => [g.id, g]));
  document.title = `${p.username} · StudySmartly`;
  $("pAvatar").textContent = initials(p.username);
  $("pAvatar").style.background = gradientFor(p.username);
  $("pName").textContent = p.username;
  $("pBadges").innerHTML = [
    p.admin ? `<span class="pbadge admin">🛡️ Admin</span>` : "",
    p.creator ? `<span class="pbadge creator">🎨 Creator</span>` : "",
    p.made.length >= 3 ? `<span class="pbadge">🏗️ ${p.made.length} games made</span>` : "",
  ].join("");
  $("pMeta").textContent = [p.joined ? `Joined ${fmtDate(p.joined)}` : "", lastOn(p.lastSeen)].filter(Boolean).join(" · ");
  const made = p.made.map((id) => byId.get(id)).filter(Boolean);
  const favs = p.favourites.map((id) => byId.get(id)).filter(Boolean);
  $("sMade").textContent = made.length;
  $("sRevised").textContent = p.stats.gamesRevised >= 20 ? "20+" : p.stats.gamesRevised;
  $("sLikes").textContent = p.stats.likesGiven;
  $("sComments").textContent = p.stats.comments;
  $("madeTitle").textContent = `Games by ${p.username}`;
  $("madeSection").classList.toggle("hidden", !made.length);
  $("madeGrid").innerHTML = made.map((g) => cardHTML(g, me)).join("");
  $("favGrid").innerHTML = favs.length
    ? favs.map((g) => cardHTML(g, me)).join("")
    : `<p class="muted-note">${relation === "self" ? "Tap ☆ Favourite on a game to add it here." : "No favourites yet."}</p>`;
  renderActions();
  $("profileView").classList.remove("hidden");
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
  me = await loadMe();
  if (!siteGate(me)) return;
  const games = await fetchGames();
  initAccount(me);
  initSidebar(games, "");
  addCreateButton();
  try {
    const r = await userApi(`/profile/${encodeURIComponent(name || me.username)}`);
    profile = r.profile;
    relation = r.relation;
    render(games);
  } catch {
    $("profileMissing").classList.remove("hidden");
  }
})();
