// StudySmartly — Create page: anyone with an account can publish their own
// game (a link, or uploaded game files) and edit or delete their games.

const $ = (id) => document.getElementById(id);
const JSZIP = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
const MAX_FILES = 200;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;
const SAFE_PATH = /^[\w\-. /@()+,'&!~[\]]+$/;

let me = null;
let source = "link";        // "link" | "upload"
let gameFiles = null;       // [{ path, data: Blob }] picked for upload
let pendingImage = null;    // processed thumbnail { dataURL, base64, type }
let myGames = [];
let editing = null;         // game being edited

/* ---------- Small helpers ---------- */
function showError(msg) {
  $("formError").textContent = msg;
  $("formError").classList.toggle("hidden", !msg);
  if (msg) $("formError").scrollIntoView({ behavior: "smooth", block: "center" });
}
function fmtSize(b) {
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}
function setProgress(done, total, text) {
  $("progress").classList.toggle("hidden", total === 0);
  $("progressBar").style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
  $("progressText").textContent = text || "";
}

/* ---------- Link / upload tabs ---------- */
function setSource(s) {
  source = s;
  document.querySelectorAll("[data-source]").forEach((b) => {
    b.classList.toggle("active", b.dataset.source === s);
    b.setAttribute("aria-selected", b.dataset.source === s);
  });
  $("linkSource").classList.toggle("hidden", s !== "link");
  $("uploadSource").classList.toggle("hidden", s !== "upload");
  showError("");
}
$("sourceTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-source]");
  if (b) setSource(b.dataset.source);
});

/* ---------- Game files: .html, .zip or a folder ---------- */
let zipReady;
function loadJSZip() {
  zipReady ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = JSZIP;
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => { zipReady = null; reject(new Error("Couldn't load the zip reader. Check your internet and try again.")); };
    document.head.appendChild(s);
  });
  return zipReady;
}

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\.git)(\/|$)/i;

// If every file sits inside one top folder (e.g. "my-game/index.html"), drop it.
function stripTopFolder(files) {
  const tops = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  if (tops.size === 1 && !tops.has("")) {
    const top = [...tops][0] + "/";
    files.forEach((f) => (f.path = f.path.slice(top.length)));
  }
  return files;
}

async function readZip(file) {
  const JSZip = await loadJSZip();
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error("That .zip couldn't be opened. Try zipping your game folder again.");
  }
  const entries = Object.values(zip.files).filter((e) => !e.dir && !JUNK.test(e.name));
  if (entries.length > MAX_FILES) throw new Error(`That zip has ${entries.length} files. Games can have up to ${MAX_FILES}.`);
  const files = [];
  for (const e of entries) files.push({ path: e.name, data: await e.async("blob") });
  return files;
}

async function useFiles(list) {
  showError("");
  $("filesLabel").textContent = "Reading files…";
  try {
    let files;
    if (list.length === 1 && /\.zip$/i.test(list[0].name)) {
      files = await readZip(list[0]);
    } else {
      files = list
        .map((f) => ({ path: f.webkitRelativePath || f.name, data: f }))
        .filter((f) => !JUNK.test(f.path));
    }
    files = stripTopFolder(files);
    if (!files.length) throw new Error("No files found.");
    if (files.length > MAX_FILES) throw new Error(`Games can have up to ${MAX_FILES} files.`);
    const bad = files.filter((f) => !SAFE_PATH.test(f.path) || f.path.split("/").some((p) => !p || p === "." || p === ".."));
    if (bad.length) throw new Error(`Rename these files (letters, numbers, - and _ work best): ${bad.slice(0, 3).map((f) => f.path).join(", ")}`);
    const big = files.find((f) => f.data.size > MAX_FILE);
    if (big) throw new Error(`${big.path} is too big (max 20 MB per file).`);
    const total = files.reduce((n, f) => n + f.data.size, 0);
    if (total > MAX_TOTAL) throw new Error(`Your game is ${fmtSize(total)}. The limit is 40 MB.`);
    const pages = files.filter((f) => /\.html?$/i.test(f.path)).map((f) => f.path);
    if (!pages.length) throw new Error("Your game needs an .html file (usually index.html).");

    gameFiles = files;
    pages.sort((a, b) => (a.split("/").length - b.split("/").length) || (/index\.html?$/i.test(b) - /index\.html?$/i.test(a)));
    $("fEntry").innerHTML = pages.map((p) => `<option>${escapeHTML(p)}</option>`).join("");
    $("entryField").classList.toggle("hidden", pages.length < 2);
    $("filesLabel").textContent = `✓ ${files.length} file${files.length === 1 ? "" : "s"} ready (${fmtSize(total)})`;
    $("filesHint").textContent = "Click to pick different files";
    if (!$("fName").value.trim()) {
      const guess = (list.length === 1 ? list[0].name : (list[0].webkitRelativePath || "").split("/")[0]).replace(/\.(zip|html?)$/i, "");
      if (guess && !/^index$/i.test(guess)) $("fName").value = guess.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);
      renderPreview();
    }
  } catch (err) {
    gameFiles = null;
    $("entryField").classList.add("hidden");
    $("filesLabel").textContent = "Upload a .zip or .html file";
    showError(err.message);
  }
  $("fFiles").value = "";
  $("fFolder").value = "";
}

$("fFiles").addEventListener("change", (e) => e.target.files.length && useFiles([...e.target.files]));
$("pickFolder").addEventListener("click", () => $("fFolder").click());
$("fFolder").addEventListener("change", (e) => e.target.files.length && useFiles([...e.target.files]));
dropZone($("filesBox"), (files) => useFiles(files));

/* ---------- Thumbnail ---------- */
function setImage(img) {
  pendingImage = img;
  const shown = img ? img.dataURL : editing && editing.thumbnail;
  $("uploadThumb").innerHTML = shown ? `<img src="${escapeHTML(shown)}" alt="">` : "🖼️";
  $("uploadLabel").textContent = img ? "Picture ready ✓" : editing ? "Change picture" : "Upload a picture";
  $("uploadHint").textContent = img ? "Click to pick a different one"
    : editing ? "Optional · leave it to keep the current picture" : "Any picture or a PDF · click or drag it here";
  $("thumbReq").classList.toggle("hidden", !!editing);
  $("fThumbFile").value = "";
  renderPreview();
}
async function pickImage(file) {
  if (!file) return;
  $("uploadLabel").textContent = "Reading picture…";
  try {
    setImage(await processImage(file));
    showError("");
  } catch (err) {
    setImage(pendingImage);
    showError(err.message);
  }
}
$("fThumbFile").addEventListener("change", (e) => pickImage(e.target.files[0]));
dropZone($("uploadBox"), (files) => pickImage(files[0]));

function dropZone(el, onFiles) {
  ["dragenter", "dragover"].forEach((ev) => el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.remove("drag"); }));
  el.addEventListener("drop", (e) => e.dataTransfer.files.length && onFiles([...e.dataTransfer.files]));
}

/* ---------- Form ---------- */
function formData() {
  return {
    name: $("fName").value.trim(),
    creator: $("fCreator").value.trim() || (me && me.username) || "",
    category: $("fCategory").value.trim(),
    description: $("fDesc").value.trim(),
    paid: $("fPaid").checked,
    price: $("fPaid").checked ? $("fPrice").value.trim() : "",
  };
}

function renderPreview() {
  const g = formData();
  g.name = g.name || "Your game";
  g.thumbnail = pendingImage ? pendingImage.dataURL : editing ? editing.thumbnail : "";
  $("preview").innerHTML = `
    <div class="thumb">${thumbHTML(g)}
      ${g.category ? `<span class="badge">${escapeHTML(g.category)}</span>` : ""}
      ${g.paid ? `<span class="badge lock">🔒 Paid${g.price ? ` · ${escapeHTML(g.price)}` : ""}</span>` : ""}
    </div>
    <div class="card-body">
      <div class="card-title">${escapeHTML(g.name)}</div>
      <div class="card-creator">by ${escapeHTML(g.creator || "you")}</div>
    </div>`;
}
$("gameForm").addEventListener("input", renderPreview);
$("fPaid").addEventListener("change", () => {
  $("priceField").classList.toggle("hidden", !$("fPaid").checked);
  if ($("fPaid").checked) $("fPrice").focus();
  renderPreview();
});

function validate() {
  const d = formData();
  if (!editing && source === "link" && !/^https?:\/\/\S+\.\S+/i.test($("fUrl").value.trim())) return "Paste your game's link (it starts with https://).";
  if (editing && !isUploaded(editing) && !/^https?:\/\/\S+\.\S+/i.test($("fUrl").value.trim())) return "Paste your game's link (it starts with https://).";
  if (!editing && source === "upload" && !gameFiles) return "Upload your game's files first.";
  if (!d.name) return "Give your game a name.";
  if (!editing && !pendingImage) return "Add a thumbnail picture so people can spot your game.";
  return "";
}

// Upload each file (4 at a time) to the upload we reserved.
async function uploadFiles() {
  const { id } = await userApi("/uploads", {
    method: "POST",
    body: JSON.stringify({ files: gameFiles.map((f) => ({ path: f.path, size: f.data.size })) }),
  });
  let done = 0;
  const queue = [...gameFiles];
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(`/api/uploads/${id}?path=${encodeURIComponent(f.path)}`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${getToken()}` },
            body: f.data,
          });
          if (!res.ok) {
            let msg = `Upload failed (${res.status})`;
            try { msg = (await res.json()).error || msg; } catch {}
            throw Object.assign(new Error(msg), { status: res.status });
          }
          break;
        } catch (err) {
          if (attempt >= 3 || (err.status && err.status < 500)) throw err;
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
      done++;
      setProgress(done, gameFiles.length, `Uploading files… ${done}/${gameFiles.length}`);
    }
  };
  setProgress(0, gameFiles.length, `Uploading files… 0/${gameFiles.length}`);
  await Promise.all(Array.from({ length: Math.min(4, gameFiles.length) }, worker));
  return id;
}

$("gameForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const problem = validate();
  if (problem) return showError(problem);
  showError("");
  const btn = $("saveBtn");
  btn.disabled = true;
  const label = btn.textContent;
  try {
    const body = formData();
    if (pendingImage) body.image = { data: pendingImage.base64, type: pendingImage.type };

    if (editing) {
      btn.textContent = "Saving…";
      if (!isUploaded(editing)) body.url = $("fUrl").value.trim();
      await userApi(`/my/games/${encodeURIComponent(editing.id)}`, { method: "PUT", body: JSON.stringify(body) });
      toast(`Saved “${body.name}”`);
      resetForm();
      loadMyGames();
      return;
    }

    if (source === "upload") {
      btn.textContent = "Uploading…";
      body.uploadId = await uploadFiles();
      body.entry = $("fEntry").value;
    } else {
      body.url = $("fUrl").value.trim();
    }
    btn.textContent = "Publishing…";
    setProgress(1, 1, "Publishing…");
    const { game } = await userApi("/my/games", { method: "POST", body: JSON.stringify(body) });
    showDone(game);
  } catch (err) {
    if (err.status === 401) {
      toast("Please log in again.", true);
      setTimeout(() => (location.href = loginURL()), 1200);
    }
    showError(err.status === 404 && !err.message.includes("expired") ? "This only works on the live site." : err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    setProgress(0, 0);
  }
});

function showDone(game) {
  $("createView").classList.add("hidden");
  $("doneView").classList.remove("hidden");
  $("doneTitle").textContent = `“${game.name}” is live! 🎉`;
  $("doneView-play").href = playURL(game);
  window.scrollTo({ top: 0 });
}
$("addAnother").addEventListener("click", () => {
  $("doneView").classList.add("hidden");
  $("createView").classList.remove("hidden");
  resetForm();
  loadMyGames();
});

/* ---------- Edit my games ---------- */
function isUploaded(g) {
  return /^\/games\//.test(g.url || "");
}

function resetForm() {
  editing = null;
  gameFiles = null;
  $("gameForm").reset();
  $("fCreator").value = me ? me.username : "";
  $("priceField").classList.add("hidden");
  $("entryField").classList.add("hidden");
  $("filesLabel").textContent = "Upload a .zip or .html file";
  $("filesHint").textContent = "A .zip of your game folder, or a single .html file · drag it here";
  $("sourceTabs").classList.remove("hidden");
  $("filesLocked").classList.add("hidden");
  setSource("link");
  $("formTitle").textContent = "Add your game";
  $("formSub").textContent = "It goes live for everyone about a minute after you publish.";
  $("saveBtn").textContent = "🚀 Publish game";
  $("cancelEdit").classList.add("hidden");
  showError("");
  setImage(null);
}

function startEdit(id) {
  const g = myGames.find((x) => x.id === id);
  if (!g) return;
  resetForm();
  editing = g;
  $("sourceTabs").classList.add("hidden");
  if (isUploaded(g)) {
    $("linkSource").classList.add("hidden");
    $("uploadSource").classList.add("hidden");
    $("filesLocked").classList.remove("hidden");
  } else {
    setSource("link");
    $("fUrl").value = g.url || "";
  }
  $("fName").value = g.name || "";
  $("fCreator").value = g.creator || "";
  $("fCategory").value = g.category || "";
  $("fDesc").value = g.description || "";
  $("fPaid").checked = !!g.paid;
  $("fPrice").value = g.price || "";
  $("priceField").classList.toggle("hidden", !g.paid);
  $("formTitle").textContent = `Edit “${g.name}”`;
  $("formSub").textContent = "Changes show on the site about a minute after you save.";
  $("saveBtn").textContent = "Save changes";
  $("cancelEdit").classList.remove("hidden");
  setImage(null);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
$("cancelEdit").addEventListener("click", resetForm);

async function loadMyGames() {
  try {
    myGames = (await userApi("/my/games")).games
      .sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  } catch (err) {
    $("myGames").innerHTML = `<p class="muted-note">Couldn't load your games: ${escapeHTML(err.message)}</p>`;
    return;
  }
  $("myCount").textContent = myGames.length ? `(${myGames.length})` : "";
  $("myGames").innerHTML = myGames.length
    ? myGames.map((g) => `
      <div class="my-game">
        <div class="mini-thumb">${thumbHTML(g)}</div>
        <div class="my-game-info">
          <div class="name">${escapeHTML(g.name)}</div>
          <div class="my-game-meta">${isUploaded(g) ? "📦 Hosted here" : "🔗 Link"}${g.paid ? ` · 🔒 Paid${g.price ? ` ${escapeHTML(g.price)}` : ""}` : ""}</div>
        </div>
        <div class="row-actions">
          <a class="btn btn-ghost btn-small" href="${playURL(g)}" title="Play">▶</a>
          <button class="btn btn-ghost btn-small" data-edit="${escapeHTML(g.id)}">Edit</button>
          <button class="btn btn-danger" data-del="${escapeHTML(g.id)}">Delete</button>
        </div>
      </div>`).join("")
    : `<p class="muted-note">You haven't added any games yet. Your first one is on the left 👈</p>`;
}

$("myGames").addEventListener("click", async (e) => {
  const ed = e.target.closest("[data-edit]");
  if (ed) return startEdit(ed.dataset.edit);
  const del = e.target.closest("[data-del]");
  if (!del) return;
  const g = myGames.find((x) => x.id === del.dataset.del);
  if (!g || !confirm(`Delete “${g.name}”? This removes it from StudySmartly${isUploaded(g) ? " along with its files" : ""}.`)) return;
  del.disabled = true;
  try {
    await userApi(`/my/games/${encodeURIComponent(g.id)}`, { method: "DELETE" });
    if (editing && editing.id === g.id) resetForm();
    toast(`Deleted “${g.name}”`);
    loadMyGames();
  } catch (err) {
    toast(err.message, true);
    del.disabled = false;
  }
});

/* ---------- Boot ---------- */
(async function init() {
  fillIcons();
  initTheme();
  const [user, games] = await Promise.all([loadMe(), fetchGames()]);
  me = user;
  initAccount(me);
  if (!me) {
    $("gate").classList.remove("hidden");
    $("gateSignup").href = loginURL("signup");
    $("gateLogin").href = loginURL("login");
    return;
  }
  const cats = [...new Set([...games.map((g) => g.category).filter(Boolean), "Action", "Puzzle", "Racing", "Platformer", "Shooting", "Multiplayer", "Skill", "Strategy"])];
  $("categoryList").innerHTML = cats.map((c) => `<option value="${escapeHTML(c)}">`).join("");
  $("createView").classList.remove("hidden");
  resetForm();
  loadMyGames();
})();
