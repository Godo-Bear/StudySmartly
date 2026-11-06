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
  loadLogins();
  loadReports();
  loadChatReports();
  loadCommentReports();
  try {
    users = (await api("/users")).users;
    renderUsers();
  } catch (err) {
    if (!handleAuthError(err)) $("userRows").innerHTML = `<p class="muted-note">Couldn't load accounts: ${escapeHTML(err.message)}</p>`;
  }
}

/* ---------- Approving accounts + login log ---------- */
const STATUS_LABEL = { approved: "✅ Allowed", pending: "⏳ Not allowed yet", blocked: "⛔ Blocked" };
function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function flag(cc) {
  return /^[A-Z]{2}$/.test(cc || "") ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) + " " + cc : "";
}

// Creator access: Not a creator / forever / for a set time
function creatorCell(u) {
  if (u.admin) return `<span class="creator-pill on">🎨 Always (admin)</span>`;
  const left = u.creatorUntil > 0 ? u.creatorUntil - Date.now() : 0;
  const now = u.creatorUntil === -1 ? "Forever" : left > 0 ? `Until ${new Date(u.creatorUntil).toLocaleDateString()}` : "No";
  return `<select class="creator-select ${u.creator ? "on" : ""}" data-creator="${escapeHTML(u.username)}" aria-label="Creator access for ${escapeHTML(u.username)}">
      <option value="" selected disabled>${u.creator ? "🎨 " : ""}${now}</option>
      <option value="-1">🎨 Creator forever</option>
      <option value="1">🎨 For 1 day</option>
      <option value="7">🎨 For 7 days</option>
      <option value="30">🎨 For 30 days</option>
      <option value="90">🎨 For 90 days</option>
      <option value="0">✖ Not a creator</option>
    </select>`;
}
async function setCreator(username, days) {
  try {
    const { user } = await api(`/users/${encodeURIComponent(username)}/creator`, { method: "POST", body: JSON.stringify({ days: Number(days) }) });
    users = users.map((u) => (u.username === user.username ? { ...u, creator: user.creator, creatorUntil: user.creatorUntil } : u));
    renderUsers();
    toast(Number(days) === 0 ? `${username} can't add games anymore` : Number(days) === -1 ? `${username} is a creator 🎨` : `${username} is a creator for ${days} day${days === "1" ? "" : "s"} 🎨`);
  } catch (err) {
    if (!handleAuthError(err)) toast(err.message, true);
    renderUsers();
  }
}
$("pendingRows").addEventListener("change", (e) => {
  const sel = e.target.closest("[data-creator]");
  if (sel && sel.value !== "") setCreator(sel.dataset.creator, sel.value);
});

// Reset a password: show the temporary one to pass on.
async function resetPassword(username) {
  if (!(await askConfirm(`Make a new temporary password for ${username}? Their old password stops working and they're logged out everywhere.`, { yes: "Reset password" }))) return;
  try {
    const { temp } = await api(`/users/${encodeURIComponent(username)}/password`, { method: "POST" });
    const wrap = document.createElement("div");
    wrap.className = "ask-backdrop";
    wrap.innerHTML = `
      <div class="ask-box">
        <p>New temporary password for <b>${escapeHTML(username)}</b>:</p>
        <div class="temp-pw" id="tempPw">${escapeHTML(temp)}</div>
        <p class="sub">Give it to them. When they log in, they'll be asked to choose their own password.</p>
        <div class="ask-buttons">
          <button class="btn btn-ghost" id="copyPw">Copy</button>
          <button class="btn btn-primary" id="donePw">Done</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector("#copyPw").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(temp); toast("Copied"); } catch { toast("Select it and copy it by hand", true); }
    });
    wrap.querySelector("#donePw").addEventListener("click", () => wrap.remove());
  } catch (err) {
    if (!handleAuthError(err)) toast(err.message, true);
  }
}

/* ---------- 🗨️ Reported comments ---------- */
async function loadCommentReports() {
  try {
    const { reports } = await api("/comments/reports");
    const open = reports.filter((r) => !r.resolvedBy);
    $("commentReportCount").textContent = open.length;
    $("commentReportCount").classList.toggle("zero", !open.length);
    $("commentReportsPanel").classList.toggle("has-waiting", open.length > 0);
    $("commentReportRows").innerHTML = reports.length
      ? reports.slice(0, 50).map((r) => `
        <div class="report-row ${r.resolvedBy ? "done" : ""}">
          <div class="report-info">
            <div><b>${escapeHTML(r.author)}</b> on <a href="play.html?id=${encodeURIComponent(r.game)}" target="_blank" rel="noopener">${escapeHTML(r.gameName)}</a></div>
            <div class="report-note">${r.deleted ? "<i>(deleted)</i> " : ""}“${escapeHTML(r.text)}”</div>
            <div class="udate">reported by ${escapeHTML(r.reporter)} · ${ago(new Date(r.at).toISOString())}${r.resolvedBy ? ` · ✅ handled by ${escapeHTML(r.resolvedBy)}` : ""}</div>
          </div>
          ${r.resolvedBy ? "" : `
            <button class="btn btn-danger" data-comment-delete="${r.commentId}">Delete comment</button>
            <button class="btn btn-ghost btn-small" data-comment-resolve="${r.id}">It's fine</button>`}
        </div>`).join("")
      : `<p class="muted-note">No reported comments. 🎉</p>`;
  } catch (err) {
    if (!handleAuthError(err)) $("commentReportRows").innerHTML = `<p class="muted-note">Couldn't load: ${escapeHTML(err.message)}</p>`;
  }
}
$("refreshCommentReportsBtn").addEventListener("click", loadCommentReports);
$("commentReportRows").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-comment-delete]"), ok = e.target.closest("[data-comment-resolve]");
  if (!del && !ok) return;
  if (del && !(await askConfirm("Delete this comment for everyone?", { yes: "Delete", danger: true }))) return;
  try {
    await api(del ? `/comments/${del.dataset.commentDelete}/delete` : `/comments/${ok.dataset.commentResolve}/resolve`, { method: "POST" });
    toast(del ? "Comment deleted" : "Marked as fine");
    loadCommentReports();
  } catch (err) { if (!handleAuthError(err)) toast(err.message, true); }
});

/* ---------- 💬 Reported chat messages ---------- */
async function loadChatReports() {
  try {
    const { reports } = await api("/chat/reports");
    const open = reports.filter((r) => !r.resolvedBy);
    $("chatReportCount").textContent = open.length;
    $("chatReportCount").classList.toggle("zero", !open.length);
    $("chatReportsPanel").classList.toggle("has-waiting", open.length > 0);
    $("chatReportRows").innerHTML = reports.length
      ? reports.slice(0, 50).map((r) => `
        <div class="report-row ${r.resolvedBy ? "done" : ""}">
          <div class="report-info">
            <div><b>${escapeHTML(r.from)}</b> in ${escapeHTML(r.where)}</div>
            <div class="report-note">${r.deleted ? "<i>(deleted)</i> " : ""}“${escapeHTML(r.text)}”</div>
            <div class="udate">reported by ${escapeHTML(r.reporter)} · ${ago(new Date(r.at).toISOString())}${r.resolvedBy ? ` · ✅ handled by ${escapeHTML(r.resolvedBy)}` : ""}</div>
          </div>
          ${r.resolvedBy ? "" : `
            <button class="btn btn-danger" data-chat-delete="${r.messageId}">Delete message</button>
            <button class="btn btn-ghost btn-small" data-chat-resolve="${r.id}">It's fine</button>`}
        </div>`).join("")
      : `<p class="muted-note">No reported messages. 🎉</p>`;
  } catch (err) {
    if (!handleAuthError(err)) $("chatReportRows").innerHTML = `<p class="muted-note">Couldn't load: ${escapeHTML(err.message)}</p>`;
  }
}
$("refreshChatReportsBtn").addEventListener("click", loadChatReports);
$("chatReportRows").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-chat-delete]"), ok = e.target.closest("[data-chat-resolve]");
  if (!del && !ok) return;
  if (del && !(await askConfirm("Delete this message for everyone?", { yes: "Delete", danger: true }))) return;
  try {
    await api(del ? `/chat/messages/${del.dataset.chatDelete}/delete` : `/chat/reports/${ok.dataset.chatResolve}/resolve`, { method: "POST" });
    toast(del ? "Message deleted" : "Marked as fine");
    loadChatReports();
  } catch (err) { if (!handleAuthError(err)) toast(err.message, true); }
});

/* ---------- 🚩 Reports ---------- */
const REASON = { broken: "💥 Broken / won't load", inappropriate: "⚠️ Inappropriate", other: "💬 Something else" };
let reports = [];
async function loadReports() {
  try {
    reports = (await api("/reports")).reports;
    renderReports();
  } catch (err) {
    if (!handleAuthError(err)) $("reportRows").innerHTML = `<p class="muted-note">Couldn't load reports: ${escapeHTML(err.message)}</p>`;
  }
}
function renderReports() {
  const open = reports.filter((r) => !r.resolvedAt);
  $("reportCount").textContent = open.length;
  $("reportCount").classList.toggle("zero", !open.length);
  $("reportsPanel").classList.toggle("has-waiting", open.length > 0);
  const nameOf = (id) => (games.find((g) => g.id === id) || {}).name || "(deleted game)";
  $("reportRows").innerHTML = reports.length
    ? reports.slice(0, 50).map((r) => `
      <div class="report-row ${r.resolvedAt ? "done" : ""}">
        <div class="report-info">
          <div><b>${escapeHTML(nameOf(r.game))}</b> · ${REASON[r.reason] || escapeHTML(r.reason)}</div>
          ${r.note ? `<div class="report-note">“${escapeHTML(r.note)}”</div>` : ""}
          <div class="udate">by ${escapeHTML(r.user)} · ${ago(r.at)}${r.resolvedAt ? ` · ✅ done by ${escapeHTML(r.resolvedBy)}` : ""}</div>
        </div>
        <a class="btn btn-ghost btn-small" href="play.html?id=${encodeURIComponent(r.game)}" target="_blank" rel="noopener">▶ Check it</a>
        ${r.resolvedAt ? "" : `<button class="btn btn-primary btn-small" data-resolve="${r.id}">✅ Done</button>`}
      </div>`).join("")
    : `<p class="muted-note">No reports. 🎉</p>`;
}
$("refreshReportsBtn").addEventListener("click", loadReports);
$("reportRows").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-resolve]");
  if (!b) return;
  b.disabled = true;
  try {
    await api(`/reports/${b.dataset.resolve}/resolve`, { method: "POST" });
    loadReports();
    toast("Report marked done ✅");
  } catch (err) {
    if (!handleAuthError(err)) toast(err.message, true);
    b.disabled = false;
  }
});

// "Who can get on" table: Username | Allowed TRUE/FALSE. Waiting accounts first.
function renderPending() {
  const order = { pending: 0, blocked: 1, approved: 2 };
  const list = [...users].sort((a, b) => (a.admin - b.admin) || (order[a.status] - order[b.status]) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const waiting = users.filter((u) => !u.admin && u.status !== "approved").length;
  $("pendingCount").textContent = waiting;
  $("pendingCount").classList.toggle("zero", !waiting);
  $("approvePanel").classList.toggle("has-waiting", waiting > 0);
  $("pendingRows").innerHTML = list.length
    ? list.map((u) => {
        const allowed = u.admin || u.status === "approved";
        return `<tr>
          <td class="name">${escapeHTML(u.username)}${u.admin ? ` <span class="admin-tag">ADMIN</span>` : ""}</td>
          <td>${u.admin
            ? `<button class="bool true locked" data-admin-note="${escapeHTML(u.username)}" title="Admins are always allowed">TRUE</button>`
            : `<button class="bool ${allowed ? "true" : "false"}" data-set-status="${allowed ? "pending" : "approved"}" data-user="${escapeHTML(u.username)}"
                 title="${allowed ? "Click to take access away" : "Click to let them on"}">${allowed ? "TRUE" : "FALSE"}</button>`}</td>
          <td>${ago(u.createdAt)}${u.country ? ` · ${flag(u.country)}` : ""}</td>
          <td>${creatorCell(u)}</td>
          <td>${ago(u.lastSeen)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5" class="muted-note">No accounts yet.</td></tr>`;
}

async function setStatus(username, status) {
  document.querySelectorAll(`[data-set-status][data-user="${CSS.escape(username)}"]`).forEach((b) => { b.disabled = true; b.textContent = "…"; });
  try {
    const { user } = await api(`/users/${encodeURIComponent(username)}/status`, { method: "POST", body: JSON.stringify({ status }) });
    users = users.map((u) => (u.username === user.username ? user : u));
    renderUsers();
    toast(status === "approved" ? `${username}: TRUE. They can get on now ✅` : `${username}: FALSE. Access taken away`);
  } catch (err) {
    if (!handleAuthError(err)) toast(err.message, true);
    renderUsers();
  }
}

const RESULT_LABEL = {
  ok: ["✅", "Logged in", "ok"], signup: ["🆕", "Signed up (waiting)", "info"], pending: ["⏳", "Logged in, still waiting", "warn"],
  blocked: ["⛔", "Blocked account tried", "bad"], "wrong-password": ["❌", "Wrong password", "bad"], "no-account": ["❓", "No such account", "bad"],
  locked: ["🔒", "Locked (too many wrong passwords)", "bad"],
};
let logins = [];
async function loadLogins() {
  try {
    logins = (await api("/logins")).logins;
    renderLogins();
  } catch (err) {
    if (!handleAuthError(err)) $("loginRows").innerHTML = `<tr><td colspan="5" class="muted-note">Couldn't load: ${escapeHTML(err.message)}</td></tr>`;
  }
}
function renderLogins() {
  const onlyProblems = $("loginFilter").value === "problems";
  const list = logins.filter((l) => !onlyProblems || l.result !== "ok");
  $("loginRows").innerHTML = list.length
    ? list.map((l) => {
        const [icon, label, kind] = RESULT_LABEL[l.result] || ["•", l.result, "info"];
        return `<tr>
          <td title="${escapeHTML(new Date(l.at).toLocaleString())}">${ago(l.at)}</td>
          <td class="name">${escapeHTML(l.username || "—")}</td>
          <td><span class="log-pill ${kind}">${icon} ${escapeHTML(label)}</span></td>
          <td>${escapeHTML([l.city, flag(l.country)].filter(Boolean).join(", ") || "—")}</td>
          <td>${escapeHTML(l.device || "—")}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5" class="muted-note">No login attempts yet.</td></tr>`;
}
$("loginFilter").addEventListener("change", renderLogins);
$("refreshLoginsBtn").addEventListener("click", loadLogins);
$("pendingRows").addEventListener("click", (e) => {
  const note = e.target.closest("[data-admin-note]");
  if (note) return toast(`${note.dataset.adminNote} is an admin, so they're always TRUE. Click "Remove admin" on their account first.`, true);
  const b = e.target.closest("[data-set-status]");
  if (b) setStatus(b.dataset.user, b.dataset.setStatus);
});

function renderUsers() {
  if (!users) return;
  renderPending();
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
            <div class="udate">Joined ${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"} · last on ${ago(u.lastSeen)}${u.country ? ` · ${flag(u.country)}` : ""}</div>
            <span class="status-pill ${u.status}">${STATUS_LABEL[u.status] || u.status}</span></div>
          ${u.admin ? "" : `<button class="bool ${u.status === "approved" ? "true" : "false"}" style="margin-left:auto" data-set-status="${u.status === "approved" ? "pending" : "approved"}" data-user="${escapeHTML(u.username)}" title="Allowed to get on?">${u.status === "approved" ? "TRUE" : "FALSE"}</button>`}
          <button class="btn btn-ghost btn-small" style="${u.admin ? "margin-left:auto" : ""}" data-admin="${escapeHTML(u.username)}" data-make="${u.admin ? "0" : "1"}">${u.admin ? "Remove admin" : "Make admin"}</button>
          <button class="btn btn-ghost btn-small" data-reset-pw="${escapeHTML(u.username)}" title="Make a temporary password for them">🔑 Reset password</button>
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
    if (!(await askConfirm(`Lock “${g ? g.name : "this game"}” for ${lockBtn.dataset.lock} again?`, { yes: "Lock it" }))) return;
    return setUnlock(lockBtn.dataset.lock, lockBtn.dataset.game, false);
  }
  const adminBtn = e.target.closest("[data-admin]");
  if (adminBtn) {
    const name = adminBtn.dataset.admin, make = adminBtn.dataset.make === "1";
    if (!(await askConfirm(make
      ? `Make ${name} an admin? They'll be able to add/delete games, unlock paid games and manage accounts.`
      : `Remove admin from ${name}?`, { yes: make ? "Make admin" : "Remove admin" }))) return;
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
  const statusBtn = e.target.closest("[data-set-status]");
  if (statusBtn) return setStatus(statusBtn.dataset.user, statusBtn.dataset.setStatus);
  const resetBtn = e.target.closest("[data-reset-pw]");
  if (resetBtn) return resetPassword(resetBtn.dataset.resetPw);
  const delBtn = e.target.closest("[data-del-user]");
  if (delBtn) {
    const name = delBtn.dataset.delUser;
    if (!(await askConfirm(`Delete the account “${name}”? They'll be logged out and lose every game unlocked for them.`, { yes: "Delete account", danger: true }))) return;
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
    setStatus("Saved. It’s live on the site now.", "ok");
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
  if (!g || !(await askConfirm(`Delete “${g.name}” by ${g.creator}?`, { yes: "Delete game", danger: true }))) return;

  setBusy(true);
  setStatus("Deleting…");
  try {
    games = (await api(`/games/${encodeURIComponent(id)}`, { method: "DELETE" })).games;
    if (String(editingId) === id) resetForm();
    renderTable();
    toast(`Deleted “${g.name}”`);
    setStatus("Saved. It’s live on the site now.", "ok");
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
