// Shared helpers for StudySmartly (used by index.html and admin.html)

const ICONS = {
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4M8 10v4"/><circle cx="15.5" cy="11" r="1" fill="#fff"/><circle cx="17.5" cy="13" r="1" fill="#fff"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><path d="M12 4v16M4 12h16"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
};

function escapeHTML(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// Only allow http(s) links so a bad entry can't run javascript: URLs.
function safeURL(url) {
  try {
    const u = new URL(url, location.href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

// Deterministic colourful gradient for games without a thumbnail.
const GRADIENTS = [
  ["#6c5ce7", "#00c2ff"], ["#ff4d8d", "#ffb347"], ["#22c55e", "#0ea5e9"],
  ["#f97316", "#ef4444"], ["#8b5cf6", "#ec4899"], ["#14b8a6", "#6366f1"],
  ["#eab308", "#f43f5e"], ["#0ea5e9", "#22d3ee"],
];
function gradientFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [a, b] = GRADIENTS[h % GRADIENTS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}
function initials(name) {
  const words = String(name || "?").trim().split(/\s+/);
  return ((words[0]?.[0] || "") + (words[1]?.[0] || "")).toUpperCase() || "?";
}

function thumbHTML(game) {
  const t = String(game.thumbnail || "");
  // allow http(s) links, site paths, and freshly uploaded data:image pictures
  const img = /^data:image\/(png|jpeg|webp|gif);base64,/.test(t) ? t : safeURL(t);
  const fallback = `<div class="thumb-fallback" style="background:${gradientFor(game.name)}">${escapeHTML(initials(game.name))}</div>`;
  if (!img) return fallback;
  // If the image fails to load, swap to the gradient fallback.
  return `<img src="${escapeHTML(img)}" alt="" loading="lazy"
    onerror="this.outerHTML=this.dataset.fb" data-fb="${escapeHTML(fallback)}">`;
}

function isNew(game) {
  if (!game.addedAt) return false;
  return Date.now() - new Date(game.addedAt).getTime() < 1000 * 60 * 60 * 24 * 14;
}

/* ---------- Theme ---------- */
function getTheme() {
  try {
    const saved = localStorage.getItem("ss-theme");
    if (saved) return saved;
  } catch {}
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
    b.innerHTML = theme === "dark" ? ICONS.sun : ICONS.moon;
    b.title = theme === "dark" ? "Light mode" : "Dark mode";
  });
}
function initTheme() {
  applyTheme(getTheme());
  document.querySelectorAll("[data-theme-toggle]").forEach((b) =>
    b.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem("ss-theme", next); } catch {}
      applyTheme(next);
    })
  );
}

function fillIcons() {
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = ICONS[el.dataset.icon] || "";
  });
}

let toastTimer;
function toast(msg, isError = false) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 6000 : 3200);
}

// Apply theme ASAP to avoid a flash.
applyTheme(getTheme());

/* ---------- Games data + cards (shared by home and play pages) ---------- */
async function fetchGames() {
  try {
    const res = await fetch(`data/games.json?t=${Date.now()}`); // cache-bust for fresh adds
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    return (Array.isArray(data) ? data : data.games || [])
      .filter((g) => g && g.name && (g.url || g.paid))
      .sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  } catch (err) {
    console.error("Could not load games.json", err);
    return [];
  }
}

function playURL(game) {
  return `play.html?id=${encodeURIComponent(game.id)}`;
}

function isOwner(g, user) {
  return !!(g.owner && user && g.owner.toLowerCase() === user.username.toLowerCase());
}

function cardHTML(g, user) {
  const owned = g.paid && user && (user.admin || user.unlocked.includes(g.id) || isOwner(g, user));
  return `
    <a class="card" href="${playURL(g)}" aria-label="Play ${escapeHTML(g.name)}">
      <div class="thumb">
        ${thumbHTML(g)}
        ${g.category ? `<span class="badge">${escapeHTML(g.category)}</span>` : ""}
        ${isNew(g) ? `<span class="badge new">NEW</span>` : ""}
        ${g.paid ? `<span class="badge lock ${owned ? "owned" : ""}">${owned ? "✓ Owned" : `🔒 Paid${g.price ? ` · ${escapeHTML(g.price)}` : ""}`}</span>` : ""}
        <div class="play-overlay"><span>${ICONS.play}</span></div>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHTML(g.name)}</div>
        <div class="card-creator">by ${escapeHTML(g.creator || "Unknown")}</div>
      </div>
    </a>`;
}

/* ---------- Player accounts ---------- */
const TOKEN_KEY = "ss-token";
function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
function setToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch {}
}
async function userApi(path, opts = {}) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
// Returns the logged-in user, or null.
async function loadMe() {
  if (!getToken()) return null;
  try {
    return (await userApi("/me")).user;
  } catch (err) {
    if (err.status === 401) setToken("");
    return null;
  }
}

// Link to the login page that comes back here afterwards.
function loginURL(mode = "login") {
  const next = location.pathname.replace(/^\//, "") + location.search;
  return `login.html?mode=${mode}&next=${encodeURIComponent(next || "./")}`;
}

// Header account button. Call once per page.
function initAccount(user) {
  const slot = document.getElementById("accountSlot");
  if (!slot) return;
  if (!user) {
    slot.innerHTML = `<a class="btn btn-primary login-btn" href="${loginURL()}">Log in</a>`;
    return;
  }
  slot.innerHTML = `
    <div class="account-menu">
      <button class="account-btn" id="accountBtn" aria-haspopup="true">
        <span class="avatar" style="background:${gradientFor(user.username)}">${escapeHTML(user.username[0].toUpperCase())}</span>
        <span class="account-name">${escapeHTML(user.username)}</span>
      </button>
      <div class="account-dropdown hidden" id="accountDropdown">
        <div class="dd-head">Signed in as<br><b>${escapeHTML(user.username)}</b>
          ${user.admin ? `<span class="admin-tag">ADMIN</span>` : ""}</div>
        <div class="dd-sub">${user.admin ? "You can play every paid game" : `${user.unlocked.length} paid game${user.unlocked.length === 1 ? "" : "s"} unlocked`}</div>
        ${user.admin ? `<a class="btn btn-primary btn-small" href="admin.html" style="width:100%;margin-bottom:8px">🛡️ Admin panel</a>` : ""}
        <button class="btn btn-ghost btn-small" id="logoutUserBtn" style="width:100%">Log out</button>
      </div>
    </div>`;
  const dd = document.getElementById("accountDropdown");
  document.getElementById("accountBtn").addEventListener("click", (e) => { e.stopPropagation(); dd.classList.toggle("hidden"); });
  document.addEventListener("click", (e) => { if (!dd.contains(e.target)) dd.classList.add("hidden"); });
  document.getElementById("logoutUserBtn").addEventListener("click", logOut);
}

// Round "+" button in the bottom-right corner that opens the Create page.
function addCreateButton() {
  if (document.querySelector(".fab")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <a class="fab" href="create.html" aria-label="Add your game">
      <span class="fab-plus">${ICONS.plus}</span><span class="fab-label">Add your game</span>
    </a>`);
}

async function logOut() {
  try { await userApi("/auth/logout", { method: "POST" }); } catch {}
  setToken("");
  location.reload();
}

/* ---------- Sidebar: Home, game types, Creators, Add your game ---------- */
const CATEGORY_ICONS = {
  action: "⚡", shooting: "🎯", shooter: "🎯", racing: "🏎️", car: "🚗", puzzle: "🧩", platformer: "🍄",
  multiplayer: "👥", "2 player": "👥", skill: "🎳", strategy: "♟️", sports: "⚽", adventure: "🗺️",
  horror: "👻", arcade: "🕹️", io: "🌐", girls: "💖", clicker: "👆", idle: "⏳", music: "🎵",
  educational: "📚", math: "➗", fighting: "🥊", simulation: "🛠️", other: "🎮",
};
function categoryIcon(name) {
  return CATEGORY_ICONS[String(name || "").trim().toLowerCase()] || "🎮";
}
function gameCategory(g) {
  return (g.category || "Other").trim() || "Other";
}
function categoryCounts(games) {
  const counts = {};
  for (const g of games) counts[gameCategory(g)] = (counts[gameCategory(g)] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
function categoryURL(name) {
  return `index.html?category=${encodeURIComponent(name)}`;
}
function creatorURL(name) {
  return `index.html?creator=${encodeURIComponent(name)}`;
}

// active: "home" | "category:<name>" | "creators" | "create"
function initSidebar(games, active = "") {
  if (document.getElementById("sidebar")) return;
  const link = (href, icon, label, key, count) => `
    <a class="side-link ${active.toLowerCase() === key.toLowerCase() ? "active" : ""}" href="${href}">
      <span class="side-icon">${icon}</span><span class="side-label">${escapeHTML(label)}</span>
      ${count != null ? `<span class="side-count">${count}</span>` : ""}
    </a>`;
  const cats = categoryCounts(games);
  document.body.insertAdjacentHTML("beforeend", `
    <div class="sidebar-backdrop" id="sidebarBackdrop"></div>
    <aside class="sidebar" id="sidebar" aria-label="Site menu">
      <nav>
        ${link("./", "🏠", "Home", "home", games.length)}
        <div class="side-heading">Game types</div>
        ${cats.length
          ? cats.map(([name, n]) => link(categoryURL(name), categoryIcon(name), name, `category:${name}`, n)).join("")
          : `<p class="side-empty">No games yet</p>`}
        <div class="side-heading">Community</div>
        ${link("creators.html", "👥", "Creators", "creators")}
        ${link("create.html", "＋", "Add your game", "create")}
      </nav>
    </aside>`);
  document.body.classList.add("has-sidebar");

  // ☰ button for small screens
  const headerInner = document.querySelector(".header-inner");
  if (headerInner && !document.getElementById("menuBtn")) {
    headerInner.insertAdjacentHTML("afterbegin",
      `<button class="menu-btn" id="menuBtn" aria-label="Open menu" aria-controls="sidebar" aria-expanded="false"><span></span><span></span><span></span></button>`);
  }
  const setOpen = (open) => {
    document.body.classList.toggle("sidebar-open", open);
    document.getElementById("menuBtn")?.setAttribute("aria-expanded", open);
  };
  document.getElementById("menuBtn")?.addEventListener("click", () => setOpen(!document.body.classList.contains("sidebar-open")));
  document.getElementById("sidebarBackdrop").addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
}
