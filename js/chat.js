// StudySmartly — Friends & Chat page.

const $ = (id) => document.getElementById(id);
let me = null;
let state = { friends: [], incoming: [], outgoing: [], rooms: [], blocked: [] };
let current = null;      // the open room { id, type, name, code, members }
let shown = new Map();   // message id -> true, for the open room
let ws = null, wsTries = 0, pingTimer = null;

const api = (path, opts = {}) => userApi(`/chat${path}`, opts);
const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
const roomPath = (id) => `/rooms/${encodeURIComponent(id)}`;

function timeLabel(at) {
  const d = new Date(at), now = new Date();
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? t : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${t}`;
}
function avatar(name, small) {
  return `<span class="avatar ${small ? "sm" : ""}" style="background:${gradientFor(name)}">${escapeHTML(initials(name))}</span>`;
}

/* ---------- Tabs ---------- */
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== b.dataset.tab));
}));

/* ---------- Lists ---------- */
async function loadState() {
  try {
    state = await api("/state");
  } catch (err) {
    $("roomList").innerHTML = `<p class="muted-note">${escapeHTML(err.message)}</p>`;
    return;
  }
  renderRooms();
  renderFriends();
  refreshSidebarBadge();
}

function renderRooms() {
  const unread = state.rooms.reduce((n, r) => n + (current && r.id === current.id ? 0 : r.unread), 0);
  $("chatsBadge").textContent = unread;
  $("chatsBadge").classList.toggle("hidden", !unread);
  $("roomList").innerHTML = state.rooms.length
    ? state.rooms.map((r) => `
      <button class="room-item ${current && current.id === r.id ? "active" : ""}" data-room="${escapeHTML(r.id)}">
        ${r.type === "group" ? `<span class="avatar group">👥</span>` : avatar(r.name)}
        <span class="room-info">
          <span class="room-top"><b>${escapeHTML(r.name)}</b>${r.last ? `<time>${escapeHTML(timeLabel(r.last.at))}</time>` : ""}</span>
          <span class="room-last">${r.last ? escapeHTML((r.last.name && r.type === "group" ? `${r.last.name}: ` : "") + r.last.text) : r.type === "group" ? `Code ${escapeHTML(r.code)}` : "Say hi! 👋"}</span>
        </span>
        ${r.unread && !(current && current.id === r.id) ? `<span class="unread-dot">${r.unread}</span>` : ""}
      </button>`).join("")
    : `<div class="muted-note empty-list">No chats yet. Add a friend in the <b>Friends</b> tab, make a group, or join one with a room code.</div>`;
}

function renderFriends() {
  $("friendsBadge").textContent = state.incoming.length;
  $("friendsBadge").classList.toggle("hidden", !state.incoming.length);
  $("requestList").innerHTML =
    (state.incoming.length ? `<div class="list-head">Friend requests</div>` + state.incoming.map((n) => `
      <div class="friend-row request">${avatar(n)}<a class="profile-link" href="${profileURL(n)}"><b>${escapeHTML(n)}</b></a>
        <button class="btn btn-primary btn-small" data-accept="${escapeHTML(n)}">Accept</button>
        <button class="btn btn-ghost btn-small" data-decline="${escapeHTML(n)}">Decline</button>
      </div>`).join("") : "") +
    (state.outgoing.length ? `<div class="list-head">Sent</div>` + state.outgoing.map((n) => `
      <div class="friend-row">${avatar(n)}<span>${escapeHTML(n)}</span><span class="muted-note">Waiting…</span>
        <button class="btn btn-ghost btn-small" data-remove="${escapeHTML(n)}">Cancel</button>
      </div>`).join("") : "");
  $("friendList").innerHTML = `<div class="list-head">Friends (${state.friends.length})</div>` + (state.friends.length
    ? state.friends.map((n) => `
      <div class="friend-row">${avatar(n)}<a class="profile-link" href="${profileURL(n)}"><b>${escapeHTML(n)}</b></a>
        <button class="btn btn-primary btn-small" data-dm="${escapeHTML(n)}">💬 Message</button>
      </div>`).join("")
    : `<p class="muted-note">No friends yet. Add someone by their username above.</p>`);
  $("blockedBox").classList.toggle("hidden", !state.blocked.length);
  $("blockedList").innerHTML = state.blocked.map((n) => `
    <div class="friend-row">${avatar(n)}<span>${escapeHTML(n)}</span>
      <button class="btn btn-ghost btn-small" data-unblock="${escapeHTML(n)}">Unblock</button></div>`).join("");
}

$("roomList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-room]");
  if (b) openRoom(b.dataset.room);
});
document.querySelector('[data-pane="friends"]').addEventListener("click", async (e) => {
  const act = ["accept", "decline", "remove", "dm", "unblock"].find((k) => e.target.closest(`[data-${k}]`));
  if (!act) return;
  const who = e.target.closest(`[data-${act}]`).dataset[act];
  try {
    const r = await post(`/friends/${encodeURIComponent(who)}/${act}`);
    if (act === "dm") return openRoom(r.room);
    if (act === "accept") toast(`You and ${who} are friends now 🎉`);
    loadState();
  } catch (err) { toast(err.message, true); }
});

$("addFriendForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("friendName").value.trim();
  if (!name) return;
  try {
    const r = await post("/friends", { username: name });
    toast(r.accepted ? `You and ${name} are friends now 🎉` : `Friend request sent to ${name}`);
    $("friendName").value = "";
    loadState();
  } catch (err) { toast(err.message, true); }
});

$("newGroupBtn").addEventListener("click", () => {
  const wrap = document.createElement("div");
  wrap.className = "ask-backdrop";
  wrap.innerHTML = `
    <form class="ask-box">
      <h3 style="margin:0 0 6px">👥 New group chat</h3>
      <p class="sub">You'll get a room code to share. Anyone with the code can join.</p>
      <input name="name" maxlength="40" placeholder="Group name, e.g. Maths study squad" required
        style="width:100%;padding:11px 13px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);margin-bottom:16px">
      <div class="ask-buttons">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Make group</button>
      </div>
    </form>`;
  document.body.appendChild(wrap);
  wrap.querySelector("input").focus();
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-close]")) wrap.remove(); });
  wrap.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await post("/groups", { name: e.target.name.value });
      wrap.remove();
      toast(`Group made! Room code: ${r.code}`);
      await loadState();
      openRoom(r.room);
    } catch (err) { toast(err.message, true); }
  });
});

$("joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("joinCode").value.trim();
  if (!code) return;
  try {
    const r = await post("/join", { code });
    $("joinCode").value = "";
    await loadState();
    openRoom(r.room);
  } catch (err) { toast(err.message, true); }
});

/* ---------- A conversation ---------- */
async function openRoom(id) {
  let r;
  try {
    r = await api(`${roomPath(id)}/messages`);
  } catch (err) {
    toast(err.message, true);
    history.replaceState(null, "", "chat.html");
    return;
  }
  current = r.room;
  shown = new Map();
  history.replaceState(null, "", `chat.html#${encodeURIComponent(id)}`);
  $("chatEmpty").classList.add("hidden");
  $("chatRoom").classList.remove("hidden");
  $("chatApp").classList.add("show-room");
  $("roomName").innerHTML = current.type === "group" ? escapeHTML(current.name)
    : `<a class="profile-link" href="${profileURL(current.name)}">${escapeHTML(current.name)}</a>`;
  $("roomSub").textContent = current.type === "group"
    ? `${current.members.length} member${current.members.length === 1 ? "" : "s"}: ${current.members.join(", ")}`
    : "Direct message";
  $("roomCodeBox").classList.toggle("hidden", current.type !== "group");
  $("roomCode").textContent = current.code || "";
  $("messages").innerHTML = r.messages.length ? "" : `<p class="muted-note msg-empty">No messages yet. Say hi! 👋</p>`;
  r.messages.forEach(addMessage);
  scrollDown(true);
  const st = state.rooms.find((x) => x.id === id);
  if (st) st.unread = 0;
  renderRooms();
  refreshSidebarBadge();
  $("msgInput").focus();
}

function addMessage(m) {
  if (shown.has(m.id)) return;
  shown.set(m.id, true);
  $("messages").querySelector(".msg-empty")?.remove();
  const mine = m.user === me.username.toLowerCase();
  const prev = $("messages").lastElementChild;
  const sameAsPrev = prev && prev.dataset.user === (m.user || "") && m.at - Number(prev.dataset.at) < 5 * 60 * 1000;
  const el = document.createElement("div");
  el.dataset.user = m.user || "";
  el.dataset.at = m.at;
  el.dataset.id = m.id;
  if (!m.user) {
    el.className = "msg system";
    el.innerHTML = `<span>${escapeHTML(m.text)}</span>`;
  } else {
    el.className = `msg ${mine ? "mine" : "theirs"} ${sameAsPrev ? "cont" : ""}`;
    el.innerHTML = `
      ${!mine && !sameAsPrev ? avatar(m.name, true) : `<span class="avatar-gap"></span>`}
      <div class="bubble-wrap">
        ${!mine && !sameAsPrev && current.type === "group" ? `<a class="msg-name profile-link" href="${profileURL(m.name)}">${escapeHTML(m.name)}</a>` : ""}
        <div class="bubble ${m.deleted ? "removed" : ""}">${m.deleted ? "Message removed by an admin" : escapeHTML(m.text)}</div>
        <div class="msg-meta"><time>${escapeHTML(timeLabel(m.at))}</time>
          ${!mine && !m.deleted ? `<button class="msg-report" data-report="${m.id}" title="Report this message">Report</button>` : ""}</div>
      </div>`;
  }
  $("messages").appendChild(el);
}
function scrollDown(force) {
  const box = $("messages");
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("msgInput").value.trim();
  if (!text || !current) return;
  $("sendBtn").disabled = true;
  try {
    const { id } = await post(`${roomPath(current.id)}/messages`, { text });
    addMessage({ id, user: me.username.toLowerCase(), name: me.username, text, at: Date.now() });
    $("msgInput").value = "";
    scrollDown(true);
  } catch (err) { toast(err.message, true); }
  $("sendBtn").disabled = false;
  $("msgInput").focus();
});

$("copyCode").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(current.code); toast(`Copied ${current.code}`); }
  catch { toast(`Room code: ${current.code}`); }
});
$("backBtn").addEventListener("click", () => {
  $("chatApp").classList.remove("show-room");
  current = null;
  history.replaceState(null, "", "chat.html");
  renderRooms();
});

// ⋯ menu: leave a group, or unfriend / block in a DM
$("roomMenuBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("roomMenu");
  menu.innerHTML = current.type === "group"
    ? `<button data-menu="copy">📋 Copy room code</button><button data-menu="leave" class="danger">🚪 Leave group</button>`
    : `<button data-menu="unfriend">Unfriend ${escapeHTML(current.name)}</button><button data-menu="block" class="danger">⛔ Block ${escapeHTML(current.name)}</button>`;
  menu.classList.toggle("hidden");
});
document.addEventListener("click", (e) => { if (!e.target.closest("#roomMenu")) $("roomMenu").classList.add("hidden"); });
$("roomMenu").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-menu]");
  if (!b) return;
  $("roomMenu").classList.add("hidden");
  const act = b.dataset.menu;
  if (act === "copy") return $("copyCode").click();
  const q = { leave: `Leave “${current.name}”? You can come back with the room code.`, unfriend: `Unfriend ${current.name}?`,
    block: `Block ${current.name}? They won't be able to message you or send you friend requests.` }[act];
  if (!(await askConfirm(q, { yes: { leave: "Leave", unfriend: "Unfriend", block: "Block" }[act], danger: act !== "unfriend" }))) return;
  try {
    if (act === "leave") await post(`${roomPath(current.id)}/leave`);
    else await post(`/friends/${encodeURIComponent(current.name)}/${act === "unfriend" ? "remove" : "block"}`);
    toast({ leave: "You left the group", unfriend: `Unfriended ${current.name}`, block: `Blocked ${current.name}` }[act]);
    $("backBtn").click();
    loadState();
  } catch (err) { toast(err.message, true); }
});

// Report a message
$("messages").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-report]");
  if (!b) return;
  if (!(await askConfirm("Report this message to the admins? They'll see it and can remove it.", { yes: "Report", danger: true }))) return;
  try {
    await post(`/messages/${b.dataset.report}/report`, { reason: "reported from chat" });
    toast("Thanks. An admin will look at it 🛡️");
  } catch (err) { toast(err.message, true); }
});

/* ---------- Live updates ---------- */
async function connect() {
  try {
    const { ticket } = await post("/ticket");
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/chat/ws?ticket=${ticket}`);
  } catch { return retry(); }
  ws.onopen = () => {
    wsTries = 0;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => ws.readyState === 1 && ws.send("ping"), 25000);
  };
  ws.onmessage = (e) => {
    if (e.data === "pong") return;
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === "message") {
      if (current && ev.room === current.id) {
        addMessage(ev.message);
        scrollDown(ev.message.user === me.username.toLowerCase());
        post(`${roomPath(current.id)}/read`, { id: ev.message.id }).catch(() => {});
      }
      const r = state.rooms.find((x) => x.id === ev.room);
      if (!r) return loadState();
      r.last = { name: ev.message.name, text: ev.message.text, at: ev.message.at };
      if (!(current && current.id === ev.room) && ev.message.user && ev.message.user !== me.username.toLowerCase()) r.unread++;
      state.rooms.sort((x, y) => ((y.last && y.last.at) || 0) - ((x.last && x.last.at) || 0));
      renderRooms();
    } else if (ev.type === "deleted" && current && ev.room === current.id) {
      const el = $("messages").querySelector(`[data-id="${ev.id}"] .bubble`);
      if (el) { el.textContent = "Message removed by an admin"; el.classList.add("removed"); }
    } else if (ev.type === "state") {
      if (ev.toast) toast(ev.toast);
      loadState();
    }
  };
  ws.onclose = () => { clearInterval(pingTimer); retry(); };
}
function retry() {
  const wait = Math.min(30000, 1000 * 2 ** wsTries++);
  setTimeout(() => { loadState(); connect(); }, wait);
}

/* ---------- Boot ---------- */
(async function init() {
  fillIcons();
  initTheme();
  $("year") && ($("year").textContent = new Date().getFullYear());
  me = await loadMe();
  if (!siteGate(me)) return;
  const games = await fetchGames();
  initAccount(me);
  initSidebar(games, "chat");
  addCreateButton();
  await loadState();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash) openRoom(fromHash);
  connect();
})();
