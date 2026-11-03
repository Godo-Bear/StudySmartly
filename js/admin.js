// StudySmartly — admin panel
// Talks to the Cloudflare Worker at /api/*. The Worker checks the admin code
// (ADMIN_CODE secret) and saves data/games.json to the main branch on GitHub.

const $ = (id) => document.getElementById(id);
const STORE_KEY = "ss-admin-code";

let adminCode = "";
let me = null; // the logged-in admin account, when signed in that way
let games = [];
let editingId = null;
let users = null; // null until loaded
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
  const res = await fetch(`/api/admin${path}`, {
    ...opts,
    headers: {
      ...(adminCode ? { "X-Admin-Code": adminCode } : {}),
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
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
// Errors go in the status bar too, so they don't vanish with the toast.
function showError(msg) {
  toast(msg, true);
  if (!$("dashView").classList.contains("hidden")) setStatus(msg, "warn");
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
        <td><div class="name">${escapeHTML(g.name)}${g.paid ? ` <span class="price-tag" style="font-size:11px">🔒 Paid${g.price ? ` · ${escapeHTML(g.price)}` : ""}</span>` : ""}</div><div class="url"><a href="${escapeHTML(safeURL(g.url))}" target="_blank" rel="noopener">${escapeHTML(g.url)}</a></div></td>
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
  if (users) renderUsers();
}

function formData() {
  return {
    name: $("fName").value.trim(),
    creator: $("fCreator").value.trim(),
    url: $("fUrl").value.trim(),
    category: $("fCategory").value.trim(),
    description: $("fDesc").value.trim(),
    paid: $("fPaid").checked,
    price: $("fPaid").checked ? $("fPrice").value.trim() : "",
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
  $("priceField").classList.add("hidden");
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
  $("fPaid").checked = !!g.paid;
  $("fPrice").value = g.price || "";
  $("priceField").classList.toggle("hidden", !g.paid);
  $("formTitle").textContent = `Edit “${g.name}”`;
  $("saveBtn").textContent = "Save changes";
  $("cancelEdit").classList.remove("hidden");
  renderPreview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function handleAuthError(err) {
  if (err.status === 401) {
    clearCode();
    toast(adminCode ? "Admin code changed. Please unlock again." : "You're no longer signed in as an admin.", true);
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
    setStatus(me ? `Signed in as ${me.username} (admin) · saving to the main branch` : "Unlocked with the admin code · saving to the main branch", "ok");
  } catch (err) {
    if (!handleAuthError(err)) setStatus(`Couldn't load games: ${err.message}`, "warn");
  } finally {
    setBusy(false);
  }
  loadUsers();
}

/* ---------- Thumbnail upload ---------- */
// Any picture the browser can open, or a PDF (its first page is used),
// is redrawn as a small WebP so it's quick to save and load.
const MAX_SIDE = 512;
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";

function setImage(img) {
  pendingImage = img;
  const editing = editingId && games.find((x) => x.id === editingId);
  const shown = img ? img.dataURL : editing && (recentImages[editing.id] || editing.thumbnail);
  $("uploadThumb").innerHTML = shown ? `<img src="${escapeHTML(shown)}" alt="">` : "🖼️";
  $("uploadLabel").textContent = img ? "Picture ready ✓" : editing ? "Change picture" : "Upload a picture";
  $("uploadHint").textContent = img
    ? "Click to pick a different one"
    : editing ? "Optional · leave it to keep the current picture" : "Any picture or a PDF · click or drag it here";
  $("thumbReq").classList.toggle("hidden", !!editing);
  $("fThumbFile").value = "";
  renderPreview();
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(/hei[cf]/i.test(file.type + file.name)
        ? "iPhone HEIC photos don't work in this browser. Take a screenshot of it, or save it as JPG, and upload that."
        : "That file isn't a picture this browser can open. Try a PNG, JPG or PDF."));
    };
    img.src = url;
  });
}

let pdfjsReady;
function loadPdfJs() {
  pdfjsReady ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `${PDFJS}/pdf.min.js`;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => { pdfjsReady = null; reject(new Error("Couldn't load the PDF reader. Check your internet and try again.")); };
    document.head.appendChild(s);
  });
  return pdfjsReady;
}
async function renderPdf(file) {
  const pdfjs = await loadPdfJs();
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch {
    throw new Error("That PDF couldn't be opened. It may be damaged or password-protected.");
  }
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: (MAX_SIDE * 2) / Math.max(base.width, base.height) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // PDFs are see-through by default
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  pdf.destroy();
  return canvas;
}

async function processImage(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error("That file is too big (max 25 MB).");
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const src = isPdf ? await renderPdf(file) : await loadImage(file);
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  if (!w || !h) throw new Error("That picture looks empty.");
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext("2d").drawImage(src, 0, 0, canvas.width, canvas.height);
  let dataURL = canvas.toDataURL("image/webp", 0.85);
  if (!dataURL.startsWith("data:image/webp")) dataURL = canvas.toDataURL("image/jpeg", 0.88);
  const [head, base64] = dataURL.split(",");
  return { dataURL, base64, type: head.slice(5, head.indexOf(";")) };
}
async function pickFile(file) {
  if (!file) return;
  $("uploadLabel").textContent = "Reading picture…";
  try {
    setImage(await processImage(file));
    if ($("status").classList.contains("warn")) setStatus("Picture ready ✓", "ok");
  } catch (err) {
    setImage(pendingImage); // put the box back how it was
    showError(err.message);
  }
}

$("fThumbFile").addEventListener("change", (e) => pickFile(e.target.files[0]));
["dragenter", "dragover"].forEach((ev) =>
  $("uploadBox").addEventListener(ev, (e) => { e.preventDefault(); $("uploadBox").classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) =>
  $("uploadBox").addEventListener(ev, (e) => { e.preventDefault(); $("uploadBox").classList.remove("drag"); }));
$("uploadBox").addEventListener("drop", (e) => pickFile(e.dataTransfer.files[0]));

/* ---------- Player accounts ---------- */
async function loadUsers() {
  $("userRows").innerHTML = `<p class="muted-note">Loading accounts…</p>`;
  try {
    users = (await api("/users")).users;
    renderUsers();
  } catch (err) {
    if (!handleAuthError(err)) $("userRows").innerHTML = `<p class="muted-note">Couldn't load accounts: ${escapeHTML(err.message)}</p>`;
  }
}

function renderUsers() {
  if (!users) return;
  const paidGames = games.filter((g) => g.paid);
  renderUnlockBox(paidGames);
  const q = $("userSearch").value.trim().toLowerCase();
  const list = users.filter((u) => !q || u.username.toLowerCase().includes(q));
  $("userCount").textContent = `(${users.length})`;
  if (!users.length) {
    $("userRows").innerHTML = `<p class="muted-note">No one has signed up yet. Players make an account with the <b>Log in</b> button on the site.</p>`;
    return;
  }
  if (!list.length) {
    $("userRows").innerHTML = `<p class="muted-note">No usernames match.</p>`;
    return;
  }
  $("userRows").innerHTML = list.map((u) => {
    const owned = u.unlocked.map((id) => games.find((g) => g.id === id)).filter((g) => g && g.paid);
    const options = paidGames.filter((g) => !u.unlocked.includes(g.id));
    return `
      <div class="user-row">
        <div class="user-top">
          <span class="avatar" style="background:${gradientFor(u.username)}">${escapeHTML(u.username[0].toUpperCase())}</span>
          <div><div class="uname">${escapeHTML(u.username)}${u.admin ? `<span class="admin-tag">ADMIN</span>` : ""}</div>
            <div class="udate">Joined ${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"}</div></div>
          <button class="btn btn-ghost btn-small" style="margin-left:auto" data-admin="${escapeHTML(u.username)}" data-make="${u.admin ? "0" : "1"}">${u.admin ? "Remove admin" : "Make admin"}</button>
          <button class="btn btn-danger" style="margin-left:0" data-del-user="${escapeHTML(u.username)}">Delete</button>
        </div>
        <div class="owned-list">
          ${owned.length
            ? owned.map((g) => { const info = (u.unlockInfo || {})[g.id]; return `<span class="owned-chip" title="${info ? escapeHTML(`Unlocked by ${info.by} on ${new Date(info.at).toLocaleDateString()}${info.note ? ` · ${info.note}` : ""}`) : ""}">✓ ${escapeHTML(g.name)}${info ? ` <span class="via">· ${escapeHTML(info.paidWith)}</span>` : ""}
                <button title="Lock again" aria-label="Lock ${escapeHTML(g.name)} again" data-lock="${escapeHTML(u.username)}" data-game="${escapeHTML(g.id)}">×</button></span>`; }).join("")
            : `<span class="muted-note">No paid games unlocked</span>`}
        </div>
        ${u.admin
          ? `<span class="muted-note">🛡️ Admin, so they can play every paid game</span>`
          : paidGames.length
          ? options.length
            ? `<div class="unlock-row">
                <select aria-label="Paid game to unlock for ${escapeHTML(u.username)}">
                  ${options.map((g) => `<option value="${escapeHTML(g.id)}">${escapeHTML(g.name)} · by ${escapeHTML(g.creator)}</option>`).join("")}
                </select>
                <button class="btn btn-primary btn-small" data-unlock="${escapeHTML(u.username)}">🔓 Unlock</button>
              </div>`
            : `<span class="muted-note">Owns every paid game 🎉</span>`
          : `<span class="muted-note">Tick “Needs to pay owner to own” on a game to make it unlockable.</span>`}
      </div>`;
  }).join("");
}

async function setUnlock(username, gameId, unlock, payment = {}) {
  const g = games.find((x) => x.id === gameId);
  try {
    const { user } = await api(`/users/${encodeURIComponent(username)}/${unlock ? "unlock" : "lock"}`, {
      method: "POST", body: JSON.stringify({ gameId, ...payment }),
    });
    users = users.map((u) => (u.username === user.username ? user : u));
    renderUsers();
    toast(unlock ? `Unlocked “${g ? g.name : "game"}” for ${username} 🔓` : `Locked “${g ? g.name : "game"}” for ${username}`);
    return true;
  } catch (err) {
    if (!handleAuthError(err)) toast(err.message, true);
    renderUsers();
    return false;
  }
}

// The "Unlock a paid game" box: pick an account + a paid game.
function renderUnlockBox(paidGames) {
  $("userList").innerHTML = users.map((u) => `<option value="${escapeHTML(u.username)}">`).join("");
  const picked = $("uGame").value;
  $("uGame").innerHTML = paidGames.length
    ? paidGames.map((g) => `<option value="${escapeHTML(g.id)}">${escapeHTML(g.name)}${g.price ? ` (${escapeHTML(g.price)})` : ""} · by ${escapeHTML(g.creator)}</option>`).join("")
    : `<option value="">No paid games yet</option>`;
  if (paidGames.some((g) => g.id === picked)) $("uGame").value = picked;
  $("uSubmit").disabled = !paidGames.length || !users.length;
}
function unlockResult(msg, ok) {
  $("uResult").textContent = msg;
  $("uResult").className = `unlock-result ${ok ? "ok" : "err"}`;
}

$("unlockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const typed = $("uUser").value.trim().toLowerCase();
  const user = users.find((u) => u.username.toLowerCase() === typed);
  const game = games.find((g) => g.id === $("uGame").value);
  if (!user) return unlockResult(typed ? `There's no account called “${$("uUser").value.trim()}”. Ask them to sign up first.` : "Pick their account.", false);
  if (!game) return unlockResult("Pick the game they paid for.", false);
  if (user.unlocked.includes(game.id)) return unlockResult(`${user.username} already owns ${game.name}.`, false);
  $("uSubmit").disabled = true;
  const ok = await setUnlock(user.username, game.id, true, { paidWith: $("uPaid").value, note: $("uNote").value.trim() });
  $("uSubmit").disabled = false;
  if (ok) {
    unlockResult(`✓ Unlocked ${game.name} for ${user.username} (${$("uPaid").value}).`, true);
    $("uUser").value = "";
    $("uNote").value = "";
  }
});

$("userSearch").addEventListener("input", renderUsers);
$("refreshUsersBtn").addEventListener("click", loadUsers);
$("userRows").addEventListener("click", async (e) => {
  const unlockBtn = e.target.closest("[data-unlock]");
  if (unlockBtn) {
    unlockBtn.disabled = true;
    const gameId = unlockBtn.parentElement.querySelector("select").value;
    return setUnlock(unlockBtn.dataset.unlock, gameId, true, { paidWith: "Cash" });
  }
  const lockBtn = e.target.closest("[data-lock]");
  if (lockBtn) {
    const g = games.find((x) => x.id === lockBtn.dataset.game);
    if (!confirm(`Lock “${g ? g.name : "this game"}” for ${lockBtn.dataset.lock} again?`)) return;
    return setUnlock(lockBtn.dataset.lock, lockBtn.dataset.game, false);
  }
  const adminBtn = e.target.closest("[data-admin]");
  if (adminBtn) {
    const name = adminBtn.dataset.admin, make = adminBtn.dataset.make === "1";
    if (!confirm(make
      ? `Make ${name} an admin? They'll be able to add/delete games, unlock paid games and manage accounts.`
      : `Remove admin from ${name}?`)) return;
    try {
      const { user } = await api(`/users/${encodeURIComponent(name)}/admin`, { method: "POST", body: JSON.stringify({ admin: make }) });
      users = users.map((u) => (u.username === user.username ? user : u));
      renderUsers();
      toast(make ? `${name} is now an admin 🛡️` : `${name} is no longer an admin`);
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, true);
    }
    return;
  }
  const delBtn = e.target.closest("[data-del-user]");
  if (delBtn) {
    const name = delBtn.dataset.delUser;
    if (!confirm(`Delete the account “${name}”? They will lose every game unlocked for them.`)) return;
    try {
      await api(`/users/${encodeURIComponent(name)}`, { method: "DELETE" });
      users = users.filter((u) => u.username !== name);
      renderUsers();
      toast(`Deleted ${name}`);
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, true);
    }
  }
});

$("fPaid").addEventListener("change", () => {
  $("priceField").classList.toggle("hidden", !$("fPaid").checked);
  if ($("fPaid").checked) $("fPrice").focus();
});

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
    $("loginBtn").textContent = "Unlock with code";
  }
});

$("logoutBtn").addEventListener("click", () => {
  clearCode();
  if (me) logOut(); // also ends the account session
  else location.reload();
});

$("gameForm").addEventListener("input", renderPreview);
$("cancelEdit").addEventListener("click", resetForm);
$("refreshBtn").addEventListener("click", refresh);

$("gameForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = formData();
  if (!safeURL(data.url)) return toast("The game link must start with http:// or https://", true);
  if (!editingId && !pendingImage) return showError("Please upload a thumbnail picture first.");
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
      showError(`Save failed: ${err.message}`);
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
(async function boot() {
  fillIcons();
  initTheme();
  adminCode = loadCode();
  if (adminCode) return showDashboard();

  // Signed in with an admin account? Go straight in.
  const user = await loadMe();
  if (user && user.admin) {
    me = user;
    return showDashboard();
  }
  if (user) {
    $("accountNote").innerHTML = `You're logged in as <b>${escapeHTML(user.username)}</b>, but that account isn't an admin yet. An admin can make it one, or use the admin code.`;
    $("accountLoginBtn").classList.add("hidden");
  }
  $("loginView").classList.remove("hidden");
})();
