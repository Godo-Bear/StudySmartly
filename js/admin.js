// StudySmartly — admin panel
// Talks to the Cloudflare Worker at /api/*. The Worker checks the admin code
// (ADMIN_CODE secret) and saves data/games.json to the main branch on GitHub.

const $ = (id) => document.getElementById(id);
const STORE_KEY = "ss-admin-code";

let adminCode = "";
let games = [];
let editingId = null;
const recentImages = {}; // id -> dataURL, so new pictures show before the site redeploys
let pendingImage = null; // { dataURL, base64, type } of a newly picked thumbnail

/* ---------- Remembering the code ---------- */
function loadCode() {
  for (const store of [sessionStorage, localStorage]) {
    try {
      const v = store.getItem(STORE_KEY);
      if (v) return v;
    } catch {}
  }
  return "";
}
function saveCode(code, remember) {
  try { (remember ? localStorage : sessionStorage).setItem(STORE_KEY, code); } catch {}
}
function clearCode() {
  try { localStorage.removeItem(STORE_KEY); sessionStorage.removeItem(STORE_KEY); } catch {}
}

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      "X-Admin-Code": adminCode,
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

/* ---------- UI ---------- */
function setStatus(text, kind = "") {
  $("status").className = `status ${kind}`;
  $("statusText").textContent = text;
}
function setBusy(busy) {
  ["saveBtn", "refreshBtn"].forEach((id) => ($(id).disabled = busy));
  document.querySelectorAll("#gameRows button").forEach((b) => (b.disabled = busy));
}

function renderTable() {
  const sorted = [...games].sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  $("gameCount").textContent = `(${games.length})`;
  $("gameRows").innerHTML = sorted.length
    ? sorted.map((g) => `
      <tr>
        <td><div class="mini-thumb">${thumbHTML({ ...g, thumbnail: recentImages[g.id] || g.thumbnail })}</div></td>
        <td><div class="name">${escapeHTML(g.name)}</div><div class="url"><a href="${escapeHTML(safeURL(g.url))}" target="_blank" rel="noopener">${escapeHTML(g.url)}</a></div></td>
        <td>${escapeHTML(g.creator)}</td>
        <td>${escapeHTML(g.category || "—")}</td>
        <td><div class="row-actions">
          <button class="btn btn-ghost btn-small" data-edit="${escapeHTML(g.id)}">Edit</button>
          <button class="btn btn-danger" data-del="${escapeHTML(g.id)}">Delete</button>
        </div></td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:30px">No games yet — add the first one!</td></tr>`;

  const uniq = (key) => [...new Set(games.map((g) => g[key]).filter(Boolean))];
  $("creatorList").innerHTML = uniq("creator").map((c) => `<option value="${escapeHTML(c)}">`).join("");
  $("categoryList").innerHTML = [...new Set([...uniq("category"), "Action", "Puzzle", "Racing", "Platformer", "Shooting", "Multiplayer", "Skill", "Strategy"])]
    .map((c) => `<option value="${escapeHTML(c)}">`).join("");
}

function formData() {
  return {
    name: $("fName").value.trim(),
    creator: $("fCreator").value.trim(),
    url: $("fUrl").value.trim(),
    category: $("fCategory").value.trim(),
    description: $("fDesc").value.trim(),
  };
}

function currentThumb() {
  if (pendingImage) return pendingImage.dataURL;
  const g = editingId && games.find((x) => x.id === editingId);
  return g ? recentImages[g.id] || g.thumbnail || "" : "";
}

function renderPreview() {
  const g = formData();
  g.name = g.name || "Game name";
  g.thumbnail = currentThumb();
  $("preview").innerHTML = `
    <div class="thumb">${thumbHTML(g)}${g.category ? `<span class="badge">${escapeHTML(g.category)}</span>` : ""}</div>
    <div class="card-body">
      <div class="card-title">${escapeHTML(g.name)}</div>
      <div class="card-creator">by ${escapeHTML(g.creator || "Creator")}</div>
    </div>`;
}

function resetForm() {
  editingId = null;
  $("gameForm").reset();
  setImage(null);
  $("formTitle").textContent = "Add a game";
  $("saveBtn").textContent = "Add game";
  $("cancelEdit").classList.add("hidden");
  renderPreview();
}

function startEdit(id) {
  const g = games.find((x) => String(x.id) === id);
  if (!g) return;
  editingId = g.id;
  $("fName").value = g.name || "";
  $("fCreator").value = g.creator || "";
  $("fUrl").value = g.url || "";
  $("fCategory").value = g.category || "";
  setImage(null);
  $("fDesc").value = g.description || "";
  $("formTitle").textContent = `Edit “${g.name}”`;
  $("saveBtn").textContent = "Save changes";
  $("cancelEdit").classList.remove("hidden");
  renderPreview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function handleAuthError(err) {
  if (err.status === 401) {
    clearCode();
    toast("Admin code changed. Please unlock again.", true);
    setTimeout(() => location.reload(), 1200);
    return true;
  }
  return false;
}

async function refresh() {
  setBusy(true);
  setStatus("Loading games…");
  try {
    games = (await api("/games")).games;
    renderTable();
    setStatus("Unlocked · saving to the main branch", "ok");
  } catch (err) {
    if (!handleAuthError(err)) setStatus(`Couldn't load games: ${err.message}`, "warn");
  } finally {
    setBusy(false);
  }
}

/* ---------- Thumbnail upload ---------- */
const MAX_SIDE = 512;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function setImage(img) {
  pendingImage = img;
  const editing = editingId && games.find((x) => x.id === editingId);
  const shown = img ? img.dataURL : editing && (recentImages[editing.id] || editing.thumbnail);
  $("uploadThumb").innerHTML = shown ? `<img src="${escapeHTML(shown)}" alt="">` : "🖼️";
  $("uploadLabel").textContent = img ? "Picture ready ✓" : editing ? "Change picture" : "Upload a picture";
  $("uploadHint").textContent = img
    ? "Click to pick a different one"
    : editing ? "Optional · leave it to keep the current picture" : "PNG, JPG, WebP or GIF · click or drag it here";
  $("thumbReq").classList.toggle("hidden", !!editing);
  $("fThumbFile").value = "";
  renderPreview();
}

// Shrink the picture to a square-ish thumbnail so the repo stays small.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't a picture we can read.")); };
    img.src = url;
  });
}
async function processImage(file) {
  if (!ACCEPTED.includes(file.type)) throw new Error("Please pick a PNG, JPG, WebP or GIF picture.");
  if (file.size > 15 * 1024 * 1024) throw new Error("That picture is too big (max 15 MB).");
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  let dataURL = canvas.toDataURL("image/webp", 0.85);
  if (!dataURL.startsWith("data:image/webp")) dataURL = canvas.toDataURL("image/png");
  const [head, base64] = dataURL.split(",");
  return { dataURL, base64, type: head.slice(5, head.indexOf(";")) };
}
async function pickFile(file) {
  if (!file) return;
  try {
    setImage(await processImage(file));
  } catch (err) {
    toast(err.message, true);
  }
}

$("fThumbFile").addEventListener("change", (e) => pickFile(e.target.files[0]));
["dragenter", "dragover"].forEach((ev) =>
  $("uploadBox").addEventListener(ev, (e) => { e.preventDefault(); $("uploadBox").classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) =>
  $("uploadBox").addEventListener(ev, (e) => { e.preventDefault(); $("uploadBox").classList.remove("drag"); }));
$("uploadBox").addEventListener("drop", (e) => pickFile(e.dataTransfer.files[0]));

/* ---------- Events ---------- */
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  adminCode = $("adminCode").value;
  $("loginBtn").disabled = true;
  $("loginBtn").textContent = "Checking…";
  try {
    await api("/login", { method: "POST" });
    saveCode(adminCode, $("remember").checked);
    showDashboard();
  } catch (err) {
    adminCode = "";
    $("adminCode").select();
    toast(err.status === 404 ? "Admin API not found. Is the site running on Cloudflare?" : err.message, true);
  } finally {
    $("loginBtn").disabled = false;
    $("loginBtn").textContent = "Unlock";
  }
});

$("logoutBtn").addEventListener("click", () => {
  clearCode();
  location.reload();
});

$("gameForm").addEventListener("input", renderPreview);
$("cancelEdit").addEventListener("click", resetForm);
$("refreshBtn").addEventListener("click", refresh);

$("gameForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = formData();
  if (!safeURL(data.url)) return toast("The game link must start with http:// or https://", true);
  if (!editingId && !pendingImage) return toast("Please upload a thumbnail picture", true);
  if (pendingImage) data.image = { data: pendingImage.base64, type: pendingImage.type };

  setBusy(true);
  setStatus("Saving…");
  try {
    if (editingId) {
      if (pendingImage) recentImages[editingId] = pendingImage.dataURL;
      games = (await api(`/games/${encodeURIComponent(editingId)}`, { method: "PUT", body: JSON.stringify(data) })).games;
      toast(`Saved “${data.name}”`);
    } else {
      const res = await api("/games", { method: "POST", body: JSON.stringify(data) });
      if (pendingImage) recentImages[res.game.id] = pendingImage.dataURL;
      games = res.games;
      toast(`Added “${data.name}” 🎉`);
    }
    resetForm();
    renderTable();
    setStatus("Saved to main. Live on the site in about a minute.", "ok");
  } catch (err) {
    if (!handleAuthError(err)) {
      toast(`Save failed: ${err.message}`, true);
      setStatus(`Save failed: ${err.message}`, "warn");
    }
  } finally {
    setBusy(false);
  }
});

$("gameRows").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit]");
  if (editBtn) return startEdit(editBtn.dataset.edit);

  const delBtn = e.target.closest("[data-del]");
  if (!delBtn) return;
  const id = delBtn.dataset.del;
  const g = games.find((x) => String(x.id) === id);
  if (!g || !confirm(`Delete “${g.name}” by ${g.creator}?`)) return;

  setBusy(true);
  setStatus("Deleting…");
  try {
    games = (await api(`/games/${encodeURIComponent(id)}`, { method: "DELETE" })).games;
    if (String(editingId) === id) resetForm();
    renderTable();
    toast(`Deleted “${g.name}”`);
    setStatus("Saved to main. Live on the site in about a minute.", "ok");
  } catch (err) {
    if (!handleAuthError(err)) {
      toast(`Delete failed: ${err.message}`, true);
      setStatus(`Delete failed: ${err.message}`, "warn");
    }
  } finally {
    setBusy(false);
  }
});

function showDashboard() {
  $("loginView").classList.add("hidden");
  $("dashView").classList.remove("hidden");
  $("logoutBtn").classList.remove("hidden");
  resetForm();
  refresh();
}

/* ---------- Boot ---------- */
fillIcons();
initTheme();
adminCode = loadCode();
if (adminCode) showDashboard();
