// StudySmartly — admin panel
// Reads and writes data/games.json in the GitHub repo via the GitHub REST API.
// Every add/edit/delete becomes a commit on the configured branch (main).

const $ = (id) => document.getElementById(id);
const FILE_PATH = "data/games.json";
const STORE_KEY = "ss-admin";

let cfg = null;        // { owner, repo, branch, token }
let games = [];
let fileSha = null;    // needed by GitHub to update an existing file
let editingId = null;

/* ---------- Config / login ---------- */
function guessRepo() {
  // On GitHub Pages the URL is https://<owner>.github.io/<repo>/
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (m) return { owner: m[1], repo: location.pathname.split("/").filter(Boolean)[0] || `${m[1]}.github.io` };
  return { owner: "Godo-Bear", repo: "StudySmartly" };
}
function loadCfg() {
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
  }
  return null;
}
function saveCfg(c, remember) {
  try {
    (remember ? localStorage : sessionStorage).setItem(STORE_KEY, JSON.stringify(c));
  } catch {}
}
function clearCfg() {
  try { localStorage.removeItem(STORE_KEY); sessionStorage.removeItem(STORE_KEY); } catch {}
}

/* ---------- GitHub API ---------- */
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).message || msg; } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function checkAccess() {
  const repo = await gh("");
  if (!repo.permissions || !(repo.permissions.push || repo.permissions.admin)) {
    throw new Error("This token can't write to the repo. Give it Contents: Read and write.");
  }
}

async function fetchGames() {
  try {
    const file = await gh(`/contents/${FILE_PATH}?ref=${encodeURIComponent(cfg.branch)}`);
    fileSha = file.sha;
    const data = JSON.parse(b64decode(file.content));
    games = Array.isArray(data) ? data : data.games || [];
  } catch (err) {
    if (err.status === 404) { games = []; fileSha = null; } else throw err;
  }
}

async function commitGames(message) {
  const body = {
    message,
    content: b64encode(JSON.stringify(games, null, 2) + "\n"),
    branch: cfg.branch,
    ...(fileSha ? { sha: fileSha } : {}),
  };
  const res = await gh(`/contents/${FILE_PATH}`, { method: "PUT", body: JSON.stringify(body) });
  fileSha = res.content.sha;
}

// Re-read the latest file, apply a change, commit. Retries once if someone
// else saved at the same moment (409 conflict).
async function mutate(change, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await fetchGames();
    const backup = JSON.parse(JSON.stringify(games));
    change();
    try {
      await commitGames(message);
      return;
    } catch (err) {
      games = backup;
      if (err.status !== 409 || attempt === 1) throw err;
    }
  }
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
        <td><div class="mini-thumb">${thumbHTML(g)}</div></td>
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
    thumbnail: $("fThumb").value.trim(),
    description: $("fDesc").value.trim(),
  };
}

function renderPreview() {
  const g = formData();
  g.name = g.name || "Game name";
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
  $("fThumb").value = g.thumbnail || "";
  $("fDesc").value = g.description || "";
  $("formTitle").textContent = `Edit “${g.name}”`;
  $("saveBtn").textContent = "Save changes";
  $("cancelEdit").classList.remove("hidden");
  renderPreview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function refresh() {
  setBusy(true);
  setStatus("Loading games…");
  try {
    await fetchGames();
    renderTable();
    setStatus(`Connected to ${cfg.owner}/${cfg.repo} · branch ${cfg.branch}`, "ok");
  } catch (err) {
    setStatus(`Couldn't load games: ${err.message}`, "warn");
  } finally {
    setBusy(false);
  }
}

/* ---------- Events ---------- */
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  cfg = {
    owner: $("ghOwner").value.trim(),
    repo: $("ghRepo").value.trim(),
    branch: $("ghBranch").value.trim() || "main",
    token: $("ghToken").value.trim(),
  };
  $("loginBtn").disabled = true;
  $("loginBtn").textContent = "Checking…";
  try {
    await checkAccess();
    saveCfg(cfg, $("remember").checked);
    showDashboard();
  } catch (err) {
    toast(err.status === 401 ? "That token isn't valid." : err.status === 404 ? "Repo not found (or token can't see it)." : err.message, true);
    cfg = null;
  } finally {
    $("loginBtn").disabled = false;
    $("loginBtn").textContent = "Sign in";
  }
});

$("logoutBtn").addEventListener("click", () => {
  clearCfg();
  location.reload();
});

$("gameForm").addEventListener("input", renderPreview);
$("cancelEdit").addEventListener("click", resetForm);
$("refreshBtn").addEventListener("click", refresh);

$("gameForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = formData();
  if (!safeURL(data.url)) return toast("The game link must start with http:// or https://", true);
  if (data.thumbnail && !safeURL(data.thumbnail)) return toast("The thumbnail must be an http(s) link", true);

  setBusy(true);
  setStatus("Saving to GitHub…");
  const id = editingId;
  try {
    if (id) {
      await mutate(() => {
        const g = games.find((x) => x.id === id);
        if (!g) throw new Error("That game was deleted by someone else.");
        Object.assign(g, data, { updatedAt: new Date().toISOString() });
      }, `Update game: ${data.name}`);
      toast(`Saved “${data.name}”`);
    } else {
      await mutate(() => {
        games.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), ...data, addedAt: new Date().toISOString() });
      }, `Add game: ${data.name} by ${data.creator}`);
      toast(`Added “${data.name}” 🎉`);
    }
    resetForm();
    renderTable();
    setStatus(`Saved to ${cfg.branch}. Live on the site in about a minute.`, "ok");
  } catch (err) {
    toast(`Save failed: ${err.message}`, true);
    setStatus(`Save failed: ${err.message}`, "warn");
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
    await mutate(() => { games = games.filter((x) => String(x.id) !== id); }, `Remove game: ${g.name}`);
    if (String(editingId) === id) resetForm();
    renderTable();
    toast(`Deleted “${g.name}”`);
    setStatus(`Saved to ${cfg.branch}.`, "ok");
  } catch (err) {
    toast(`Delete failed: ${err.message}`, true);
    setStatus(`Delete failed: ${err.message}`, "warn");
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
const guess = guessRepo();
$("ghOwner").value = guess.owner;
$("ghRepo").value = guess.repo;
cfg = loadCfg();
if (cfg) showDashboard();
