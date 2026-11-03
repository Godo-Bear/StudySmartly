// Shared helpers for StudySmartly (used by index.html and admin.html)

const ICONS = {
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4M8 10v4"/><circle cx="15.5" cy="11" r="1" fill="#fff"/><circle cx="17.5" cy="13" r="1" fill="#fff"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><path d="M12 4v16M4 12h16"/></svg>',
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
  const img = safeURL(game.thumbnail || "");
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
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

// Apply theme ASAP to avoid a flash.
applyTheme(getTheme());
