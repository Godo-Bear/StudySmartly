// StudySmartly chat: friends, direct messages and group chats with room codes.
// One Durable Object (ChatHub) keeps everything in its own SQLite database
// and holds a live WebSocket to each open chat page, so messages arrive
// instantly. The Worker checks the player's login before calling it.

import { DurableObject } from "cloudflare:workers";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I mix-ups
const MAX_MESSAGE = 1000;
const MAX_GROUP = 50;

class ChatError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ChatError(status, message); };

export class ChatHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS friends (a TEXT NOT NULL, b TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (a, b));
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, code TEXT UNIQUE, created_by TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members (room TEXT NOT NULL, user TEXT NOT NULL, joined INTEGER NOT NULL, last_read INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (room, user));
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, user TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS messages_room ON messages (room, id);
      CREATE TABLE IF NOT EXISTS blocks (blocker TEXT NOT NULL, blocked TEXT NOT NULL, PRIMARY KEY (blocker, blocked));
      CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, message INTEGER NOT NULL, reporter TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL, resolved_by TEXT);
      CREATE TABLE IF NOT EXISTS tickets (t TEXT PRIMARY KEY, user TEXT NOT NULL, exp INTEGER NOT NULL);
    `);
    this.recentSends = new Map(); // user -> [times], to slow down spam
  }

  /* ---------- helpers ---------- */
  one(q, ...a) { return this.sql.exec(q, ...a).toArray()[0]; }
  all(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  remember(me, name) {
    this.sql.exec("INSERT INTO people (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name", me, name);
  }
  nameOf(id) { return (this.one("SELECT name FROM people WHERE id = ?", id) || {}).name || id; }
  pair(x, y) { return x < y ? [x, y] : [y, x]; }
  blockedEither(x, y) { return !!this.one("SELECT 1 FROM blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)", x, y, y, x); }
  isMember(room, me) { return !!this.one("SELECT 1 FROM members WHERE room = ? AND user = ?", room, me); }
  needMember(room, me) { if (!this.isMember(room, me)) fail(403, "You're not in that chat."); }
  // Send an event to every open chat page of these people
  push(users, event) {
    const data = JSON.stringify(event);
    for (const u of new Set(users)) for (const ws of this.ctx.getWebSockets(u)) { try { ws.send(data); } catch {} }
  }
  membersOf(room) { return this.all("SELECT user FROM members WHERE room = ?", room).map((r) => r.user); }
  systemMessage(room, text) {
    const at = Date.now();
    const id = this.one("INSERT INTO messages (room, user, text, at) VALUES (?, '', ?, ?) RETURNING id", room, text, at).id;
    this.push(this.membersOf(room), { type: "message", room, message: { id, user: "", name: "", text, at } });
  }
  newCode() {
    for (;;) {
      const r = crypto.getRandomValues(new Uint8Array(6));
      const s = [...r].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
      const code = `${s.slice(0, 3)}-${s.slice(3)}`;
      if (!this.one("SELECT 1 FROM rooms WHERE code = ?", code)) return code;
    }
  }
  // Wrap each action so errors come back as { error, status } over RPC
  run(fn) {
    try { return { ok: true, ...(fn() || {}) }; } catch (e) {
      if (e instanceof ChatError) return { error: e.message, status: e.status };
      throw e;
    }
  }

  /* ---------- live connection ---------- */
  ticket(me, name) {
    this.remember(me, name);
    const t = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.sql.exec("DELETE FROM tickets WHERE exp < ?", Date.now());
    this.sql.exec("INSERT INTO tickets (t, user, exp) VALUES (?, ?, ?)", t, me, Date.now() + 60_000);
    return { ticket: t };
  }
  async fetch(request) {
    const t = new URL(request.url).searchParams.get("ticket") || "";
    const row = this.one("SELECT user FROM tickets WHERE t = ? AND exp > ?", t, Date.now());
    if (!row || request.headers.get("Upgrade") !== "websocket") return new Response("Not allowed", { status: 403 });
    this.sql.exec("DELETE FROM tickets WHERE t = ?", t);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [row.user]); // tagged with the player, survives hibernation
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, msg) { if (msg === "ping") ws.send("pong"); }
  async webSocketClose(ws, code) { try { ws.close(code, "bye"); } catch {} }

  /* ---------- reading ---------- */
  state(me, name) {
    this.remember(me, name);
    const rows = this.all("SELECT a, b, status, requested_by FROM friends WHERE a = ? OR b = ?", me, me);
    const other = (r) => (r.a === me ? r.b : r.a);
    const friends = rows.filter((r) => r.status === "accepted").map((r) => this.nameOf(other(r))).sort((x, y) => x.localeCompare(y));
    const incoming = rows.filter((r) => r.status === "pending" && r.requested_by !== me).map((r) => this.nameOf(other(r)));
    const outgoing = rows.filter((r) => r.status === "pending" && r.requested_by === me).map((r) => this.nameOf(other(r)));
    const rooms = this.all(`
      SELECT r.id, r.type, r.name, r.code, m.last_read,
        (SELECT COUNT(*) FROM members WHERE room = r.id) AS members,
        (SELECT COUNT(*) FROM messages x WHERE x.room = r.id AND x.id > m.last_read AND x.user != ? AND x.user != '' AND x.deleted = 0
           AND x.user NOT IN (SELECT blocked FROM blocks WHERE blocker = ?)) AS unread,
        (SELECT id FROM messages WHERE room = r.id ORDER BY id DESC LIMIT 1) AS last_id
      FROM rooms r JOIN members m ON m.room = r.id AND m.user = ?`, me, me, me);
    for (const r of rooms) {
      const last = r.last_id ? this.one("SELECT user, text, at, deleted FROM messages WHERE id = ?", r.last_id) : null;
      r.last = last ? { name: last.user ? this.nameOf(last.user) : "", text: last.deleted ? "Message removed" : last.text.slice(0, 80), at: last.at } : null;
      if (r.type === "dm") {
        const o = this.membersOf(r.id).find((u) => u !== me) || "";
        r.name = this.nameOf(o);
        r.with = this.nameOf(o);
      }
      delete r.last_id; delete r.last_read;
    }
    rooms.sort((x, y) => ((y.last && y.last.at) || 0) - ((x.last && x.last.at) || 0));
    const blocked = this.all("SELECT blocked FROM blocks WHERE blocker = ?", me).map((r) => this.nameOf(r.blocked));
    return { friends, incoming, outgoing, rooms, blocked };
  }
  unread(me) {
    const r = this.one(`SELECT COALESCE(SUM((SELECT COUNT(*) FROM messages x WHERE x.room = m.room AND x.id > m.last_read AND x.user != ? AND x.user != '' AND x.deleted = 0
        AND x.user NOT IN (SELECT blocked FROM blocks WHERE blocker = ?))), 0) AS n FROM members m WHERE m.user = ?`, me, me, me);
    const req = this.one("SELECT COUNT(*) AS n FROM friends WHERE (a = ? OR b = ?) AND status = 'pending' AND requested_by != ?", me, me, me);
    return { unread: r.n, requests: req.n };
  }
  messages(me, room, before) {
    return this.run(() => {
      this.needMember(room, me);
      const r = this.one("SELECT id, type, name, code, created_by FROM rooms WHERE id = ?", room);
      const rows = this.all(`SELECT id, user, text, at, deleted FROM messages WHERE room = ? AND id < ?
        AND user NOT IN (SELECT blocked FROM blocks WHERE blocker = ?) ORDER BY id DESC LIMIT 60`, room, before || 1e15, me).reverse();
      const messages = rows.map((m) => ({ id: m.id, user: m.user, name: m.user ? this.nameOf(m.user) : "", text: m.deleted ? "" : m.text, deleted: !!m.deleted, at: m.at }));
      if (rows.length) this.sql.exec("UPDATE members SET last_read = MAX(last_read, ?) WHERE room = ? AND user = ?", rows[rows.length - 1].id, room, me);
      const members = this.membersOf(room).map((u) => this.nameOf(u)).sort((x, y) => x.localeCompare(y));
      const withName = r.type === "dm" ? this.nameOf(this.membersOf(room).find((u) => u !== me) || "") : "";
      return { room: { id: r.id, type: r.type, name: r.type === "dm" ? withName : r.name, code: r.code, members }, messages, more: rows.length === 60 };
    });
  }
  markRead(me, room, id) {
    this.sql.exec("UPDATE members SET last_read = MAX(last_read, ?) WHERE room = ? AND user = ?", id, room, me);
    return { ok: true };
  }

  /* ---------- friends ---------- */
  friendRequest(me, name, other, otherName) {
    return this.run(() => {
      this.remember(me, name);
      this.remember(other, otherName);
      if (other === me) fail(400, "That's you!");
      if (this.blockedEither(me, other)) fail(403, "You can't add that person.");
      const [a, b] = this.pair(me, other);
      const row = this.one("SELECT status, requested_by FROM friends WHERE a = ? AND b = ?", a, b);
      if (row && row.status === "accepted") fail(400, `You're already friends with ${otherName}.`);
      if (row && row.requested_by === me) fail(400, `You already sent ${otherName} a request.`);
      if (row) { // they asked first: that's a yes
        this.sql.exec("UPDATE friends SET status = 'accepted', at = ? WHERE a = ? AND b = ?", Date.now(), a, b);
        this.push([me, other], { type: "state" });
        return { accepted: true };
      }
      this.sql.exec("INSERT INTO friends (a, b, status, requested_by, at) VALUES (?, ?, 'pending', ?, ?)", a, b, me, Date.now());
      this.push([other], { type: "state", toast: `${name} sent you a friend request` });
      return { sent: true };
    });
  }
  respond(me, other, accept) {
    return this.run(() => {
      const [a, b] = this.pair(me, other);
      const row = this.one("SELECT requested_by FROM friends WHERE a = ? AND b = ? AND status = 'pending'", a, b);
      if (!row || row.requested_by === me) fail(404, "That request isn't there anymore.");
      if (accept) this.sql.exec("UPDATE friends SET status = 'accepted', at = ? WHERE a = ? AND b = ?", Date.now(), a, b);
      else this.sql.exec("DELETE FROM friends WHERE a = ? AND b = ?", a, b);
      this.push([me, other], { type: "state" });
    });
  }
  unfriend(me, other) {
    const [a, b] = this.pair(me, other);
    this.sql.exec("DELETE FROM friends WHERE a = ? AND b = ?", a, b);
    this.push([me, other], { type: "state" });
    return { ok: true };
  }
  block(me, other, on) {
    return this.run(() => {
      if (other === me) fail(400, "That's you!");
      if (on) {
        this.sql.exec("INSERT OR IGNORE INTO blocks (blocker, blocked) VALUES (?, ?)", me, other);
        const [a, b] = this.pair(me, other);
        this.sql.exec("DELETE FROM friends WHERE a = ? AND b = ?", a, b);
      } else {
        this.sql.exec("DELETE FROM blocks WHERE blocker = ? AND blocked = ?", me, other);
      }
      this.push([me, other], { type: "state" });
    });
  }

  /* ---------- chats ---------- */
  directMessage(me, other) {
    return this.run(() => {
      const [a, b] = this.pair(me, other);
      if (!this.one("SELECT 1 FROM friends WHERE a = ? AND b = ? AND status = 'accepted'", a, b)) fail(403, "You can only message friends.");
      const id = `dm:${a}:${b}`;
      if (!this.one("SELECT 1 FROM rooms WHERE id = ?", id)) {
        this.sql.exec("INSERT INTO rooms (id, type, created_by, at) VALUES (?, 'dm', ?, ?)", id, me, Date.now());
        this.sql.exec("INSERT OR IGNORE INTO members (room, user, joined) VALUES (?, ?, ?), (?, ?, ?)", id, a, Date.now(), id, b, Date.now());
      }
      return { room: id };
    });
  }
  createGroup(me, name, groupName) {
    return this.run(() => {
      this.remember(me, name);
      const n = String(groupName || "").trim().slice(0, 40);
      if (!n) fail(400, "Give your group a name.");
      const mine = this.one("SELECT COUNT(*) AS c FROM rooms WHERE type = 'group' AND created_by = ?", me).c;
      if (mine >= 20) fail(400, "You've made a lot of groups. Delete or leave some first.");
      const id = `g:${crypto.randomUUID()}`;
      const code = this.newCode();
      this.sql.exec("INSERT INTO rooms (id, type, name, code, created_by, at) VALUES (?, 'group', ?, ?, ?, ?)", id, n, code, me, Date.now());
      this.sql.exec("INSERT INTO members (room, user, joined) VALUES (?, ?, ?)", id, me, Date.now());
      this.systemMessage(id, `${name} made the group. Share the room code ${code} so friends can join.`);
      return { room: id, code };
    });
  }
  join(me, name, code) {
    return this.run(() => {
      this.remember(me, name);
      const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const r = c.length === 6 && this.one("SELECT id, name FROM rooms WHERE type = 'group' AND code = ?", `${c.slice(0, 3)}-${c.slice(3)}`);
      if (!r) fail(404, "No group has that room code. Check it and try again.");
      if (this.isMember(r.id, me)) return { room: r.id };
      if (this.one("SELECT COUNT(*) AS c FROM members WHERE room = ?", r.id).c >= MAX_GROUP) fail(400, "That group is full.");
      this.sql.exec("INSERT INTO members (room, user, joined) VALUES (?, ?, ?)", r.id, me, Date.now());
      this.systemMessage(r.id, `${name} joined with the room code.`);
      this.push(this.membersOf(r.id), { type: "state" });
      return { room: r.id };
    });
  }
  leave(me, name, room) {
    return this.run(() => {
      this.needMember(room, me);
      const r = this.one("SELECT type FROM rooms WHERE id = ?", room);
      if (r.type !== "group") fail(400, "You can't leave a direct message. Unfriend or block instead.");
      this.sql.exec("DELETE FROM members WHERE room = ? AND user = ?", room, me);
      this.systemMessage(room, `${name} left the group.`);
      this.push([me, ...this.membersOf(room)], { type: "state" });
    });
  }
  send(me, name, room, text) {
    return this.run(() => {
      this.remember(me, name);
      this.needMember(room, me);
      const t = String(text || "").trim();
      if (!t) fail(400, "Type a message first.");
      if (t.length > MAX_MESSAGE) fail(400, `Messages can be up to ${MAX_MESSAGE} characters.`);
      // At most 8 messages in 10 seconds
      const now = Date.now();
      const times = (this.recentSends.get(me) || []).filter((x) => now - x < 10_000);
      if (times.length >= 8) fail(429, "Slow down a bit!");
      times.push(now);
      this.recentSends.set(me, times);
      const members = this.membersOf(room);
      const r = this.one("SELECT type FROM rooms WHERE id = ?", room);
      if (r.type === "dm") {
        const other = members.find((u) => u !== me);
        if (other && this.blockedEither(me, other)) fail(403, "You can't message this person.");
      }
      const id = this.one("INSERT INTO messages (room, user, text, at) VALUES (?, ?, ?, ?) RETURNING id", room, me, t, now).id;
      this.sql.exec("UPDATE members SET last_read = ? WHERE room = ? AND user = ?", id, room, me);
      const blockers = new Set(this.all("SELECT blocker FROM blocks WHERE blocked = ?", me).map((x) => x.blocker));
      this.push(members.filter((u) => !blockers.has(u)), { type: "message", room, message: { id, user: me, name, text: t, at: now } });
      return { id };
    });
  }
  report(me, messageId, reason) {
    return this.run(() => {
      const m = this.one("SELECT room FROM messages WHERE id = ?", messageId);
      if (!m) fail(404, "That message isn't there anymore.");
      this.needMember(m.room, me);
      if (this.one("SELECT 1 FROM reports WHERE message = ? AND reporter = ? AND resolved_by IS NULL", messageId, me)) fail(400, "You already reported that message.");
      this.sql.exec("INSERT INTO reports (message, reporter, reason, at) VALUES (?, ?, ?, ?)", messageId, me, String(reason || "").slice(0, 200), Date.now());
    });
  }

  /* ---------- admins ---------- */
  adminReports() {
    const rows = this.all(`SELECT r.id, r.message, r.reporter, r.reason, r.at, r.resolved_by, m.user, m.text, m.deleted, m.room, rm.type, rm.name
      FROM reports r JOIN messages m ON m.id = r.message JOIN rooms rm ON rm.id = m.room ORDER BY r.resolved_by IS NOT NULL, r.id DESC LIMIT 100`);
    return {
      reports: rows.map((r) => ({
        id: r.id, messageId: r.message, reporter: this.nameOf(r.reporter), reason: r.reason, at: r.at, resolvedBy: r.resolved_by,
        from: this.nameOf(r.user), text: r.text, deleted: !!r.deleted,
        where: r.type === "group" ? `group “${r.name}”` : `direct message (${this.membersOf(r.room).map((u) => this.nameOf(u)).join(" & ")})`,
      })),
    };
  }
  adminDeleteMessage(messageId, by) {
    const m = this.one("SELECT room FROM messages WHERE id = ?", messageId);
    if (!m) return { ok: true };
    this.sql.exec("UPDATE messages SET deleted = 1 WHERE id = ?", messageId);
    this.sql.exec("UPDATE reports SET resolved_by = ? WHERE message = ? AND resolved_by IS NULL", by, messageId);
    this.push(this.membersOf(m.room), { type: "deleted", room: m.room, id: messageId });
    return { ok: true };
  }
  adminResolve(reportId, by) {
    this.sql.exec("UPDATE reports SET resolved_by = ? WHERE id = ?", by, reportId);
    return { ok: true };
  }
  // A deleted account disappears from chat
  forget(me) {
    this.sql.exec("DELETE FROM friends WHERE a = ? OR b = ?", me, me);
    this.sql.exec("DELETE FROM members WHERE user = ?", me);
    for (const ws of this.ctx.getWebSockets(me)) { try { ws.close(1000, "account deleted"); } catch {} }
    return { ok: true };
  }
}
