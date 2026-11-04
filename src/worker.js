// StudySmartly Worker
// - Serves the static site (via the ASSETS binding).
// - /api/admin/*  admin panel. Unlocked with the ADMIN_CODE secret or by
//   logging in with an account an admin has marked as admin. Saves
//   data/games.json + thumbnails to main on GitHub using GITHUB_TOKEN.
// - /api/my/*, /api/uploads/*  creators add, edit and delete their own games
//   (a link, or uploaded game files that are stored in KV and served at
//   /games/<id>/... in a sandbox so they can't touch the rest of the site).
// - /api/auth/*, /api/me, /api/play/:id  player accounts and paid games.
// - Site lock: new accounts start "pending" and the owner approves them in
//   the admin panel. Only approved accounts get the game list (/api/games),
//   games, saves and the Create tools. /data/games.json isn't public.
//   Accounts, sessions, unlocks and the links of paid games live in the DB
//   (Cloudflare KV), never in the public repo.

import { DurableObject } from "cloudflare:workers";
import { writeOverview, overviewErrorMessage } from "./overview.js";

const FILE_PATH = "data/games.json";
const IMAGE_DIR = "images";
const IMAGE_TYPES = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" };
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const PBKDF2_ITERATIONS = 20000;       // fits the free plan's 10ms CPU limit
const MAX_UPLOAD_FILES = 200;          // KV free plan: 1000 writes a day
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const MAX_GAMES_PER_CREATOR = 25;
const MAX_SAVE_BYTES = 512 * 1024;     // per player, per game

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/games/")) return serveGameFile(request, env, url).catch(() => new Response("Error", { status: 500 }));
    if (url.pathname.startsWith("/data/")) return json({ error: "Log in with an approved account." }, 403);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      return await handleApi(request, env, url);
    } catch (err) {
      return json({ error: err.message || "Server error" }, err.status || 500);
    }
  },
};

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  if (!env.DB) throw httpError(503, "The accounts database isn't set up yet (missing DB binding).");

  if (path.startsWith("/api/admin/")) return handleAdmin(request, env, path, method);

  /* ---------- Player accounts ---------- */
  if (path === "/api/auth/signup" && method === "POST") {
    const { username, password } = await request.json();
    const name = checkUsername(username);
    checkPassword(password);
    const key = `user:${name.toLowerCase()}`;
    if ((await env.DB.get(key)) && (await accessList(env).get(name.toLowerCase()))?.status !== "deleted") {
      throw httpError(409, "That username is taken.");
    }
    const salt = randomHex(16);
    const user = {
      username: name, salt, iter: PBKDF2_ITERATIONS, hash: await hashPassword(password, salt), unlocked: [],
      status: "pending", // the owner approves new accounts in the admin panel
      createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(),
      country: (request.cf && request.cf.country) || "",
    };
    await env.DB.put(key, JSON.stringify(cleanRecord(user)));
    await accessList(env).set(name.toLowerCase(), "pending");
    await logAttempt(env, request, name, "signup");
    return json({ token: await newSession(env, name), user: publicUser(user) }, 201);
  }

  if (path === "/api/auth/login" && method === "POST") {
    const { username, password } = await request.json();
    const lockName = String(username || "").trim().toLowerCase().slice(0, 20);
    // 10 wrong passwords in a row locks that username for 15 minutes.
    const lockedFor = await accessList(env).lockedFor(lockName);
    if (lockedFor > 0) {
      await logAttempt(env, request, lockName, "locked");
      throw httpError(429, `Too many wrong passwords. Try again in ${Math.ceil(lockedFor / 60)} min.`);
    }
    let user = await getUser(env, String(username || ""));
    if (user && (await accessList(env).get(user.username.toLowerCase()))?.status === "deleted") user = null;
    const ok = user && (await safeEqual(await hashPassword(String(password || ""), user.salt, user.iter), user.hash));
    if (!ok) {
      const left = await accessList(env).loginFailed(lockName);
      await logAttempt(env, request, String(username || "").trim().slice(0, 20), user ? "wrong-password" : "no-account");
      await sleep(600);
      throw httpError(401, left > 0 && left <= 3
        ? `Wrong username or password. ${left} more ${left === 1 ? "try" : "tries"} before it's locked for 15 minutes.`
        : left === 0 ? "Too many wrong passwords. Try again in 15 min." : "Wrong username or password.");
    }
    await accessList(env).loginOk(lockName);
    const status = await statusFor(env, user);
    await logAttempt(env, request, user.username, status === "approved" ? "ok" : status);
    return json({ token: await newSession(env, user.username), user: publicUser(user), mustChange: !!user.mustChange });
  }

  // Change your own password (also used after an admin reset).
  if (path === "/api/auth/password" && method === "POST") {
    const user = await currentUser(request, env);
    if (!user) throw httpError(401, "Log in first.");
    const { current, password } = await request.json();
    if (!(await safeEqual(await hashPassword(String(current || ""), user.salt, user.iter), user.hash))) {
      await sleep(600);
      throw httpError(400, "Your current password isn't right.");
    }
    checkPassword(password);
    if (password === current) throw httpError(400, "Pick a different password from the old one.");
    await setPassword(env, user, password);
    delete user.mustChange;
    await env.DB.put(`user:${user.username.toLowerCase()}`, JSON.stringify(cleanRecord(user)));
    return json({ token: await newSession(env, user.username), user: publicUser(user) });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    const token = bearer(request);
    if (token) await env.DB.delete(`session:${token}`);
    return json({ ok: true });
  }

  if (path === "/api/me" && method === "GET") {
    const user = await currentUser(request, env);
    if (!user) throw httpError(401, "Not logged in.");
    await accessList(env).touch(user.username.toLowerCase(), (request.cf && request.cf.country) || "");
    return json({ user: publicUser(user) });
  }

  // The game list, for approved accounts only.
  if (path === "/api/games" && method === "GET") {
    await approvedUser(request, env);
    const res = await env.ASSETS.fetch(new Request(new URL("/data/games.json", request.url)));
    return new Response(await res.text(), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  // Link for a paid game, only for accounts it's been unlocked for.
  const play = path.match(/^\/api\/play\/([\w-]+)$/);
  if (play && method === "GET") {
    const gameUrl = await env.DB.get(`url:${play[1]}`);
    if (!gameUrl) throw httpError(404, "That isn't a paid game.");
    const user = await approvedUser(request, env);
    if (!user.admin && !user.unlocked.includes(play[1]) && !(await ownsGame(request, env, user, play[1]))) {
      throw httpError(403, "This game hasn't been unlocked for your account yet.");
    }
    return json({ url: gameUrl });
  }

  if (path.startsWith("/api/my/") || path.startsWith("/api/uploads")) return handleCreator(request, env, url, path, method);

  /* ---------- Play counts (for "Most played") ---------- */
  if (path === "/api/plays/top" && method === "GET") {
    if (!env.PLAYS) return json({ top: [] });
    const top = await playCounter(env).top(24);
    return new Response(JSON.stringify({ top }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
    });
  }
  const hit = path.match(/^\/api\/plays\/([\w-]+)$/);
  if (hit && method === "POST") {
    const user = await currentUser(request, env).catch(() => null);
    if (env.PLAYS) await playCounter(env).hit(hit[1], request.headers.get("CF-Connecting-IP") || "", user ? user.username.toLowerCase() : "");
    return json({ ok: true });
  }

  // ✨ AI overview: written once per game version, then served from KV
  const ov = path.match(/^\/api\/overview\/([\w-]+)(\/refresh)?$/);
  if (ov) {
    const user = await approvedUser(request, env);
    const game = await liveGame(request, env, ov[1]);
    if (!game) throw httpError(404, "That game isn't on the site (yet).");
    const key = `ai:${game.id}:v${game.version || 1}`;
    if (ov[2] && method === "POST") {
      if (!user.admin && !(game.owner && game.owner.toLowerCase() === user.username.toLowerCase())) {
        throw httpError(403, "Only the game's creator or an admin can refresh the overview.");
      }
      await env.DB.delete(key);
    } else if (method === "GET") {
      const saved = await env.DB.get(key, "json");
      if (saved) return json({ status: "ready", overview: saved });
    } else {
      throw httpError(405, "Not allowed.");
    }
    // Only one writer at a time; others wait and check back.
    if (await env.DB.get(`ai-lock:${game.id}`)) return json({ status: "writing" });
    await env.DB.put(`ai-lock:${game.id}`, "1", { expirationTtl: 180 });
    try {
      const link = game.paid ? (await env.DB.get(`url:${game.id}`)) || "" : game.url;
      // Uploaded games are read from KV; link games are fetched from their site.
      const overview = await writeOverview(env, game, link);
      await env.DB.put(key, JSON.stringify(overview));
      return json({ status: "ready", overview });
    } catch (err) {
      return json({ status: "error", message: overviewErrorMessage(err) });
    } finally {
      await env.DB.delete(`ai-lock:${game.id}`);
    }
  }

  // 👍 / 👎
  if (path === "/api/votes/top" && method === "GET") {
    await approvedUser(request, env);
    return json({ top: await playCounter(env).topRated(24) });
  }
  const vote = path.match(/^\/api\/votes\/([\w-]+)$/);
  if (vote) {
    const user = await approvedUser(request, env);
    if (method === "POST") {
      const { v } = await request.json();
      if (![1, -1, 0].includes(v)) throw httpError(400, "Bad vote.");
      await playCounter(env).vote(vote[1], user.username.toLowerCase(), v);
    }
    return json(await playCounter(env).votes(vote[1], user.username.toLowerCase()));
  }

  // Recently played + favourites
  if (path === "/api/library" && method === "GET") {
    const user = await approvedUser(request, env);
    return json(await playCounter(env).library(user.username.toLowerCase()));
  }
  const fav = path.match(/^\/api\/favs\/([\w-]+)$/);
  if (fav && method === "POST") {
    const user = await approvedUser(request, env);
    const { on } = await request.json();
    await playCounter(env).setFav(user.username.toLowerCase(), fav[1], !!on);
    return json({ on: !!on });
  }

  // 🚩 Report a game
  const report = path.match(/^\/api\/reports\/([\w-]+)$/);
  if (report && method === "POST") {
    const user = await approvedUser(request, env);
    const { reason, note } = await request.json();
    if (!["broken", "inappropriate", "other"].includes(reason)) throw httpError(400, "Pick a reason.");
    const ok = await playCounter(env).report(report[1], user.username, reason, String(note || "").trim().slice(0, 300));
    if (!ok) throw httpError(429, "You already reported this game. An admin will look at it.");
    return json({ ok: true });
  }

  /* ---------- Saved progress for uploaded games ---------- */
  // /api/saves/<gameId>: saves belong to the game, not its file folder, so a
  // new uploaded version keeps everyone's progress.
  const save = path.match(/^\/api\/saves\/([\w-]+)(\/ticket)?$/);
  if (save) {
    const user = await approvedUser(request, env);
    const who = user.username.toLowerCase();
    const key = `save2:${save[1]}:${who}`;
    if (save[2] && method === "POST") {
      const { folder } = await request.json().catch(() => ({}));
      if (!/^[\w-]+$/.test(String(folder || ""))) throw httpError(400, "Missing game folder.");
      // Progress saved before saves moved to per-game keys
      if (!(await env.DB.get(key))) {
        const old = await env.DB.get(`save:${who}:${folder}`);
        if (old) await env.DB.put(key, old);
      }
      // Short-lived ticket that lets the game page load *only* this save.
      const ticket = randomHex(24);
      await env.DB.put(`ticket:${ticket}`, JSON.stringify({ user: who, game: save[1], folder }), { expirationTtl: 600 });
      return json({ ticket });
    }
    if (!save[2] && method === "PUT") {
      const text = await request.text();
      if (text.length > MAX_SAVE_BYTES) throw httpError(413, "This game's save is too big to store.");
      let data;
      try { data = JSON.parse(text).data; } catch { throw httpError(400, "Bad save data."); }
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.values(data).some((v) => typeof v !== "string")) {
        throw httpError(400, "Bad save data.");
      }
      await env.DB.put(key, JSON.stringify(data));
      return json({ ok: true, savedAt: new Date().toISOString() });
    }
    if (!save[2] && method === "DELETE") {
      await env.DB.delete(key);
      return json({ ok: true });
    }
  }

  return json({ error: "Not found" }, 404);
}

/* ---------- Creators: add / edit / delete their own games ---------- */
async function handleCreator(request, env, url, path, method) {
  const user = await approvedUser(request, env);
  if (!env.GITHUB_TOKEN) throw httpError(503, "Adding games isn't set up yet (missing GITHUB_TOKEN).");
  const isMine = (g) => g.owner && g.owner.toLowerCase() === user.username.toLowerCase();

  // My games (with the private links of my paid games)
  if (path === "/api/my/games" && method === "GET") {
    const { games } = await readGames(env);
    return json({ games: await withPrivateUrls(env, games.filter(isMine)) });
  }

  // 1. Reserve an upload: say which files are coming.
  if (path === "/api/uploads" && method === "POST") {
    requireCreator(user);
    const { files } = await request.json();
    const list = checkFileList(files);
    const id = crypto.randomUUID();
    await env.DB.put(`upload:${id}`, JSON.stringify({ owner: user.username, files: list }), { expirationTtl: 60 * 60 * 24 });
    return json({ id }, 201);
  }

  // 2. Send each file (raw bytes) to /api/uploads/<id>?path=<path>
  const up = path.match(/^\/api\/uploads\/([\w-]+)$/);
  if (up && method === "PUT") {
    const upload = await getUpload(env, up[1], user);
    const filePath = url.searchParams.get("path") || "";
    if (!(filePath in upload.files)) throw httpError(400, "That file isn't part of this upload.");
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== upload.files[filePath]) throw httpError(400, `${filePath} didn't upload completely. Try again.`);
    await env.DB.put(`file:${up[1]}/${filePath}`, bytes, { metadata: { type: mimeFor(filePath) } });
    return json({ ok: true });
  }

  // 3. Publish a game: a link, or a finished upload.
  if (path === "/api/my/games" && method === "POST") {
    requireCreator(user);
    const body = await request.json();
    const { games: existing } = await readGames(env);
    if (!user.admin && existing.filter(isMine).length >= MAX_GAMES_PER_CREATOR) {
      throw httpError(400, `You can have up to ${MAX_GAMES_PER_CREATOR} games. Delete one to add another.`);
    }
    // The game's id is public; uploaded files live under a separate, secret
    // folder id so a paid game's files can't be found from its public id.
    const id = crypto.randomUUID();
    const folder = String(body.uploadId || "");
    if (folder) {
      const upload = await getUpload(env, folder, user);
      const entry = String(body.entry || "");
      if (!(entry in upload.files) || !/\.html?$/i.test(entry)) throw httpError(400, "Pick the HTML file that starts the game.");
      const stored = await env.DB.list({ prefix: `file:${folder}/` });
      if (stored.keys.length < Object.keys(upload.files).length) throw httpError(400, "Some files didn't finish uploading. Try again.");
      body.url = `/games/${folder}/${entry.split("/").map(encodeURIComponent).join("/")}`;
    }
    const data = clean({ ...body, creator: body.creator || user.username });
    data.owner = user.username;
    const image = checkImage(body.image);
    const result = await createGame(env, id, data, image);
    if (folder) await env.DB.delete(`upload:${folder}`);
    return json({ game: result.game }, 201);
  }

  // Edit / delete one of my games, and unlock my paid games for buyers
  const mine = path.match(/^\/api\/my\/games\/([\w-]+)(?:\/(buyers|unlock|lock))?$/);
  if (mine) {
    const { games } = await readGames(env);
    const game = games.find((g) => g.id === mine[1]);
    if (!game) throw httpError(404, "That game no longer exists.");
    if (!isMine(game)) throw httpError(403, "You can only change your own games.");

    if (mine[2] === "buyers" && method === "GET") {
      const users = await listUsers(env);
      const buyers = users
        .filter((u) => u.unlocked.includes(game.id))
        .map((u) => ({ username: u.username, ...(u.unlockInfo[game.id] || {}) }));
      return json({ buyers });
    }
    if ((mine[2] === "unlock" || mine[2] === "lock") && method === "POST") {
      if (!game.paid) throw httpError(400, "This game is free, so there's nothing to unlock.");
      const { username, paidWith, note } = await request.json();
      const buyer = await getUser(env, String(username || "").trim());
      if (!buyer) throw httpError(404, `There's no account called “${String(username || "").trim()}”. Ask them to sign up first.`);
      const updated = await setUnlock(env, buyer, game.id, mine[2] === "unlock", { by: user.username, paidWith, note });
      return json({ buyer: { username: updated.username, ...(updated.unlockInfo[game.id] || {}) } });
    }

    if (!mine[2] && method === "PUT") {
      const body = await request.json();
      // Uploaded games keep their files unless a new version was uploaded.
      const privateUrl = game.paid ? await env.DB.get(`url:${game.id}`) : game.url;
      let oldFolder = "";
      if (String(privateUrl || "").startsWith("/games/")) {
        body.url = privateUrl;
        if (body.uploadId) {
          const folder = String(body.uploadId);
          const upload = await getUpload(env, folder, user);
          const entry = String(body.entry || "");
          if (!(entry in upload.files) || !/\.html?$/i.test(entry)) throw httpError(400, "Pick the HTML file that starts the game.");
          const stored = await env.DB.list({ prefix: `file:${folder}/` });
          if (stored.keys.length < Object.keys(upload.files).length) throw httpError(400, "Some files didn't finish uploading. Try again.");
          body.url = `/games/${folder}/${entry.split("/").map(encodeURIComponent).join("/")}`;
          oldFolder = (String(privateUrl).match(/^\/games\/([\w-]+)\//) || [])[1] || "";
        }
      }
      const data = clean({ ...body, creator: body.creator || user.username });
      if (body.uploadId) data.version = (game.version || 1) + 1;
      await updateGame(env, game.id, data, checkImage(body.image));
      if (body.uploadId) {
        await env.DB.delete(`upload:${body.uploadId}`);
        if (oldFolder && oldFolder !== body.uploadId) await deleteGameFiles(env, oldFolder);
      }
      return json({ ok: true });
    }
    if (!mine[2] && method === "DELETE") {
      await removeGame(env, game.id);
      return json({ ok: true });
    }
  }

  return json({ error: "Not found" }, 404);
}

// One game from the live (deployed) games list.
async function liveGame(request, env, id) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL("/data/games.json", request.url)));
    const games = await res.json();
    return (Array.isArray(games) ? games : []).find((g) => g.id === id) || null;
  } catch {
    return null;
  }
}

// Creators can always play their own paid games (checked against the live games list).
async function ownsGame(request, env, user, id) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL("/data/games.json", request.url)));
    const games = await res.json();
    const g = (Array.isArray(games) ? games : []).find((x) => x.id === id);
    return !!(g && g.owner && g.owner.toLowerCase() === user.username.toLowerCase());
  } catch {
    return false;
  }
}

async function getUpload(env, id, user) {
  const raw = await env.DB.get(`upload:${id}`);
  if (!raw) throw httpError(404, "That upload expired. Please upload the files again.");
  const upload = JSON.parse(raw);
  if (upload.owner !== user.username) throw httpError(403, "That isn't your upload.");
  return upload;
}

// Validate the list of files a creator wants to upload.
function checkFileList(files) {
  if (!Array.isArray(files) || !files.length) throw httpError(400, "Pick your game's files.");
  if (files.length > MAX_UPLOAD_FILES) throw httpError(400, `Games can have up to ${MAX_UPLOAD_FILES} files.`);
  const list = {};
  let total = 0;
  for (const f of files) {
    const p = String(f && f.path || "");
    const size = Number(f && f.size);
    if (!isSafePath(p)) throw httpError(400, `“${p.slice(0, 80)}” isn't an allowed file name.`);
    if (!Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw httpError(400, `${p} is too big (max 20 MB per file).`);
    total += size;
    list[p] = size;
  }
  if (total > MAX_UPLOAD_BYTES) throw httpError(400, "That game is too big (max 40 MB).");
  if (!Object.keys(list).some((p) => /\.html?$/i.test(p))) throw httpError(400, "Your game needs an .html file.");
  return list;
}
function isSafePath(p) {
  return p.length > 0 && p.length <= 200 && !p.startsWith("/") && !p.includes("\\")
    && p.split("/").every((part) => part && part !== "." && part !== "..")
    && /^[\w\-. /@()+,'&!~\[\]]+$/.test(p);
}

/* ---------- Serving uploaded games ---------- */
// Uploaded games are served with a CSP sandbox: they run as their own
// separate origin, so their scripts can't read StudySmartly logins.
const SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock allow-downloads allow-orientation-lock allow-presentation";
// Sandboxed pages can't use the browser's localStorage, so games get a
// stand-in. When a logged-in player opens the game, the play page passes a
// short-lived "save ticket"; we put that player's saved progress into the
// stand-in before the game starts, and every change is sent to the play
// page (postMessage), which saves it to the player's account.
function storageShim(saved) {
  return `<script>(function(){var S=${saved ? JSON.stringify(saved).replace(/</g, "\\u003c") : "null"};` +
    `function m(seed,sync){var d={},t;if(seed)for(var k in seed)if(Object.prototype.hasOwnProperty.call(seed,k))d[k]=String(seed[k]);` +
    `function ch(){if(!sync)return;clearTimeout(t);t=setTimeout(function(){try{parent.postMessage({type:"ss-save",data:d},"*")}catch(e){}},400)}` +
    `return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},` +
    `setItem:function(k,v){k=String(k);v=String(v);if(d[k]!==v){d[k]=v;ch()}},` +
    `removeItem:function(k){k=String(k);if(k in d){delete d[k];ch()}},clear:function(){d={};ch()},` +
    `key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}` +
    `function use(n,st){try{window[n].getItem("x")}catch(e){try{Object.defineProperty(window,n,{value:st,configurable:true})}catch(_){}}}` +
    `use("localStorage",m(S,S!==null));use("sessionStorage",m(null,false));` +
    `try{parent.postMessage({type:"ss-ready",saving:S!==null},"*")}catch(e){}})();</script>`;
}

async function serveGameFile(request, env, url) {
  const m = url.pathname.match(/^\/games\/([\w-]+)\/(.*)$/);
  if (!m || !env.DB) return env.ASSETS.fetch(request);
  let filePath;
  try { filePath = decodeURIComponent(m[2]); } catch { return new Response("Bad path", { status: 400 }); }
  if (filePath === "" || filePath.endsWith("/")) filePath += "index.html";
  if (!isSafePath(filePath)) return new Response("Not found", { status: 404 });

  const { value, metadata } = await env.DB.getWithMetadata(`file:${m[1]}/${filePath}`, "arrayBuffer");
  if (!value) return new Response("Not found", { status: 404, headers: { "Content-Security-Policy": SANDBOX_CSP } });

  const type = (metadata && metadata.type) || mimeFor(filePath);
  const headers = {
    "Content-Type": type,
    "Content-Security-Policy": SANDBOX_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=300",
  };
  if (type.startsWith("text/html")) {
    // A valid save ticket for this game folder loads the player's progress.
    let saved = null;
    const ticket = url.searchParams.get("ss_save") || "";
    if (/^[a-f0-9]{48}$/.test(ticket)) {
      const t = await env.DB.get(`ticket:${ticket}`, "json");
      if (t && t.folder === m[1]) {
        saved = (await env.DB.get(t.game ? `save2:${t.game}:${t.user}` : `save:${t.user}:${m[1]}`, "json")) || {};
      }
    }
    let html = new TextDecoder().decode(value);
    // Put the shim right after <!doctype> so the page doesn't drop into quirks mode.
    html = html.replace(/^(\uFEFF?\s*<!doctype[^>]*>)?/i, (d) => (d || "") + storageShim(saved));
    return new Response(html, { headers: { ...headers, "Cache-Control": "no-store" } });
  }
  return new Response(value, { headers });
}

const MIME = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json",
  txt: "text/plain; charset=utf-8", xml: "application/xml", svg: "image/svg+xml", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon",
  bmp: "image/bmp", avif: "image/avif", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
  mp4: "video/mp4", webm: "video/webm", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  wasm: "application/wasm", data: "application/octet-stream", glb: "model/gltf-binary", gltf: "model/gltf+json",
};
function mimeFor(p) {
  return MIME[(p.split(".").pop() || "").toLowerCase()] || "application/octet-stream";
}

async function deleteGameFiles(env, id) {
  let cursor;
  do {
    const page = await env.DB.list({ prefix: `file:${id}/`, cursor });
    await Promise.all(page.keys.map((k) => env.DB.delete(k.name)));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

/* ---------- Games: shared by the admin panel and creators ---------- */
async function createGame(env, id, data, image) {
  if (!image) throw httpError(400, "Please upload a thumbnail picture.");
  data.thumbnail = await saveImage(env, id, image, data.name);
  if (data.paid) {
    await env.DB.put(`url:${id}`, data.url); // keep the link private
    data.url = "";
  }
  const game = { id, ...data, addedAt: new Date().toISOString() };
  const games = await mutate(env, (list) => {
    if (list.some((g) => g.id === id)) throw httpError(409, "That game was already added.");
    return [...list, game];
  }, `Add game: ${game.name} by ${game.creator}`);
  return { games, game };
}

async function updateGame(env, id, data, image) {
  if (image) data.thumbnail = await saveImage(env, id, image, data.name);
  if (data.paid) {
    await env.DB.put(`url:${id}`, data.url);
    data.url = "";
  }
  let oldThumb = "";
  const games = await mutate(env, (list) => {
    const g = list.find((x) => String(x.id) === id);
    if (!g) throw httpError(404, "That game no longer exists.");
    oldThumb = g.thumbnail || "";
    Object.assign(g, data, { updatedAt: new Date().toISOString() });
    if (!data.paid) delete g.paid;
    if (!data.price) delete g.price;
    return list;
  }, `Update game: ${data.name}`);
  if (!data.paid) await env.DB.delete(`url:${id}`); // now free: link is public again
  if (image && oldThumb !== data.thumbnail) await deleteImage(env, oldThumb);
  return games;
}

async function removeGame(env, id) {
  let removed = "", thumb = "", link = "";
  const games = await mutate(env, (list) => {
    const g = list.find((x) => String(x.id) === id);
    if (!g) throw httpError(404, "That game no longer exists.");
    removed = g.name;
    thumb = g.thumbnail || "";
    link = g.url || "";
    return list.filter((x) => x !== g);
  }, () => `Remove game: ${removed}`);
  link = (await env.DB.get(`url:${id}`)) || link;
  await env.DB.delete(`url:${id}`);
  await deleteImage(env, thumb);
  const folder = link.match(/^\/games\/([\w-]+)\//);
  if (folder) await deleteGameFiles(env, folder[1]);
  return games;
}

/* ---------- Admin API ---------- */
async function handleAdmin(request, env, path, method) {
  if (!env.ADMIN_CODE || !env.GITHUB_TOKEN) {
    throw httpError(503, "Admin isn't set up yet: add the ADMIN_CODE and GITHUB_TOKEN secrets in Cloudflare.");
  }
  // Admins get in with the admin code OR with an admin account's login.
  const code = request.headers.get("X-Admin-Code") || "";
  let me = null;
  if (!(code && (await safeEqual(code, env.ADMIN_CODE)))) {
    me = await currentUser(request, env);
    if (!me || !me.admin) {
      if (code) {
        await sleep(600); // slow down guessing
        throw httpError(401, "Wrong admin code.");
      }
      throw httpError(401, me ? "Your account isn't an admin." : "Log in with an admin account or use the admin code.");
    }
  }

  if (path === "/api/admin/login" && method === "POST") {
    return json({ ok: true, via: me ? "account" : "code", user: me ? publicUser(me) : null });
  }

  if (path === "/api/admin/games" && method === "GET") {
    return json({ games: await withPrivateUrls(env, (await readGames(env)).games) });
  }

  if (path === "/api/admin/games" && method === "POST") {
    const body = await request.json();
    const { games, game } = await createGame(env, crypto.randomUUID(), clean(body), checkImage(body.image));
    return json({ games: await withPrivateUrls(env, games), game }, 201);
  }

  const m = path.match(/^\/api\/admin\/games\/([\w-]+)$/);
  if (m && method === "PUT") {
    const body = await request.json();
    const games = await updateGame(env, m[1], clean(body), checkImage(body.image));
    return json({ games: await withPrivateUrls(env, games) });
  }

  if (m && method === "DELETE") {
    const games = await removeGame(env, m[1]);
    return json({ games: await withPrivateUrls(env, games) });
  }

  if (path === "/api/admin/reports" && method === "GET") {
    return json({ reports: await playCounter(env).reports() });
  }
  const rr = path.match(/^\/api\/admin\/reports\/(\d+)\/resolve$/);
  if (rr && method === "POST") {
    await playCounter(env).resolveReport(Number(rr[1]), me ? me.username : "admin code");
    return json({ ok: true });
  }

  if (path === "/api/admin/logins" && method === "GET") {
    const page = await env.DB.list({ prefix: "log:", limit: 200 });
    return json({ logins: page.keys.map((k) => k.metadata).filter(Boolean) });
  }

  /* ----- Player accounts (for unlocking paid games) ----- */
  if (path === "/api/admin/users" && method === "GET") {
    const [all, live] = await Promise.all([listUsers(env), accessList(env).all()]);
    const users = [];
    for (const u of all) {
      const row = live[u.username.toLowerCase()];
      if (row && row.status === "deleted") continue;
      if (row && row.status && !u.admin) u.status = row.status;
      if (row && row.lastSeen) u.lastSeen = row.lastSeen;
      if (row && row.country) u.country = row.country;
      u.creatorUntil = (row && row.creatorUntil) || 0;
      u.creator = !!u.admin || creatorActive(u.creatorUntil);
      users.push(u);
    }
    return json({ users });
  }

  const u = path.match(/^\/api\/admin\/users\/([\w]+)(?:\/(unlock|lock|admin|status|password|creator))?$/);
  if (u) {
    const user = await getUser(env, u[1]);
    if (!user) throw httpError(404, "That account doesn't exist.");
    const key = `user:${user.username.toLowerCase()}`;
    user._creatorUntil = ((await accessList(env).get(user.username.toLowerCase())) || {}).creatorUntil || 0;

    if (u[2] === "creator" && method === "POST") {
      // days: 0 = take it away, -1 = forever, otherwise that many days from now
      const { days } = await request.json();
      const d = Number(days);
      if (!Number.isFinite(d) || d < -1 || d > 3650) throw httpError(400, "Pick how long.");
      const until = d === -1 ? -1 : d === 0 ? 0 : Date.now() + d * 24 * 60 * 60 * 1000;
      await accessList(env).setCreator(user.username.toLowerCase(), until);
      return json({ user: publicUser({ ...user, _status: await statusFor(env, user), _creatorUntil: until }) });
    }
    if (u[2] === "password" && method === "POST") {
      // A readable temporary password; they choose their own at next log in.
      const words = ["maple", "rocket", "tiger", "comet", "pixel", "river", "cloud", "lemon", "orbit", "zebra", "panda", "storm"];
      const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
      const temp = `${pick()}-${pick()}-${100 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900)}`;
      await setPassword(env, user, temp);
      user.mustChange = true;
      await env.DB.put(key, JSON.stringify(cleanRecord(user)));
      await accessList(env).loginOk(user.username.toLowerCase()); // clear any lockout
      return json({ temp });
    }
    if (u[2] === "status" && method === "POST") {
      const { status } = await request.json();
      if (!["approved", "pending", "blocked"].includes(status)) throw httpError(400, "Unknown status.");
      if (status !== "approved" && me && me.username === user.username) throw httpError(400, "You can't lock your own account.");
      await accessList(env).set(user.username.toLowerCase(), status);
      return json({ user: publicUser({ ...user, _status: status }) });
    }
    if (u[2] === "admin" && method === "POST") {
      const { admin } = await request.json();
      if (!admin && me && me.username === user.username) throw httpError(400, "You can't remove your own admin. Ask another admin.");
      if (admin) user.admin = true; else delete user.admin;
      await env.DB.put(key, JSON.stringify(cleanRecord(user)));
      if (admin) await accessList(env).set(user.username.toLowerCase(), "approved");
      return json({ user: publicUser({ ...user, _status: await statusFor(env, user) }) });
    }
    if (u[2] && method === "POST") {
      const { gameId, paidWith, note } = await request.json();
      if (!/^[\w-]+$/.test(String(gameId || ""))) throw httpError(400, "Pick a game.");
      const updated = await setUnlock(env, user, gameId, u[2] === "unlock", { by: me ? me.username : "admin code", paidWith, note });
      return json({ user: publicUser(updated) });
    }
    if (!u[2] && method === "DELETE") {
      if (me && me.username === user.username) throw httpError(400, "You can't delete your own account here.");
      await accessList(env).set(user.username.toLowerCase(), "deleted");
      await env.DB.delete(key);
      return json({ ok: true });
    }
  }

  return json({ error: "Not found" }, 404);
}

/* ---------- Accounts ---------- */
// Unlock (or lock again) a paid game for an account, keeping a payment record.
async function setUnlock(env, user, gameId, unlock, { by, paidWith, note } = {}) {
  user.unlocked = user.unlocked.filter((x) => x !== gameId);
  user.unlockInfo = user.unlockInfo || {};
  delete user.unlockInfo[gameId];
  if (unlock) {
    user.unlocked.push(gameId);
    user.unlockInfo[gameId] = {
      by: String(by || "").slice(0, 30),
      at: new Date().toISOString(),
      paidWith: String(paidWith || "Cash").slice(0, 30),
      note: String(note || "").trim().slice(0, 100),
    };
  }
  await env.DB.put(`user:${user.username.toLowerCase()}`, JSON.stringify(cleanRecord(user)));
  return user;
}

function checkUsername(v) {
  const name = String(v || "").trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw httpError(400, "Usernames are 3-20 letters, numbers or _.");
  return name;
}
function checkPassword(v) {
  if (typeof v !== "string" || v.length < 6) throw httpError(400, "Passwords need at least 6 characters.");
  if (v.length > 200) throw httpError(400, "That password is too long.");
}
async function getUser(env, name) {
  if (!/^[A-Za-z0-9_]{1,20}$/.test(name)) return null;
  const raw = await env.DB.get(`user:${name.toLowerCase()}`);
  if (!raw) return null;
  const user = JSON.parse(raw);
  user.unlocked = Array.isArray(user.unlocked) ? user.unlocked : [];
  return user;
}
// Login log for the admin panel. Newest first (keys sort by inverted time),
// kept for 30 days. Everything is in the key's metadata so one list call reads it.
async function logAttempt(env, request, username, result) {
  try {
    const at = Date.now();
    const key = `log:${String(9999999999999 - at).padStart(13, "0")}:${randomHex(3)}`;
    const cf = request.cf || {};
    await env.DB.put(key, "", {
      expirationTtl: 60 * 60 * 24 * 30,
      metadata: {
        username: String(username || "").slice(0, 20), result, at: new Date(at).toISOString(),
        country: cf.country || "", city: String(cf.city || "").slice(0, 40),
        device: deviceOf(request.headers.get("User-Agent") || ""),
      },
    });
  } catch {}
}
function deviceOf(ua) {
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "Chromebook"
    : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Unknown";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${browser} on ${os}` : os;
}

// Accounts made before the site lock existed have no status: they stay approved.
function statusOf(user) {
  return user.admin ? "approved" : user.status || "approved";
}
function publicUser(user) {
  return {
    username: user.username, unlocked: user.unlocked, unlockInfo: user.unlockInfo || {},
    admin: !!user.admin, status: user._status || statusOf(user), createdAt: user.createdAt,
    creator: !!user.admin || creatorActive(user._creatorUntil || 0), creatorUntil: user._creatorUntil || 0,
    mustChange: !!user.mustChange,
    lastSeen: user.lastSeen || "", country: user.country || "",
  };
}
// The live TRUE/FALSE setting. It lives in its own Durable Object so it's
// instant everywhere and no other save (last seen, unlocks…) can undo it.
// Accounts with no entry (made before the lock) fall back to their record.
function accessList(env) {
  return env.ACCESS.get(env.ACCESS.idFromName("all"));
}
async function statusFor(env, user) {
  if (user.admin) return "approved";
  if (user._status) return user._status;
  const row = await accessList(env).get(user.username.toLowerCase());
  return (row && row.status) || statusOf(user);
}

// Creator access: admins always; others while an admin has it switched on.
function creatorActive(until) {
  return until === -1 || (until > 0 && until > Date.now());
}
function isCreator(user) {
  return !!user.admin || creatorActive(user._creatorUntil || 0);
}
function requireCreator(user) {
  if (!isCreator(user)) throw httpError(403, "Only creator accounts can add games. Ask an admin to make your account a creator account.");
}

// The logged-in account, if the owner has approved it.
async function approvedUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw httpError(401, "Log in to use StudySmartly.");
  const status = await statusFor(env, user);
  if (status === "blocked") throw httpError(403, "This account has been blocked by the owner.");
  if (status !== "approved") throw httpError(403, "The owner hasn't unlocked your account yet.");
  if (user.mustChange) throw httpError(403, "Choose a new password first (your password was reset).");
  return user;
}
async function listUsers(env) {
  const users = [];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: "user:", cursor });
    const batch = await Promise.all(page.keys.map((k) => env.DB.get(k.name)));
    for (const raw of batch) if (raw) users.push(publicUser({ unlocked: [], ...JSON.parse(raw) }));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && users.length < 2000);
  return users.sort((a, b) => a.username.localeCompare(b.username));
}
async function newSession(env, username) {
  const token = randomHex(32);
  await env.DB.put(`session:${token}`, JSON.stringify({ u: username.toLowerCase(), t: Date.now() }), { expirationTtl: SESSION_TTL });
  return token;
}
// New password: sessions made before now stop working.
async function setPassword(env, user, password) {
  user.salt = randomHex(16);
  user.iter = PBKDF2_ITERATIONS;
  user.hash = await hashPassword(password, user.salt);
  user.pwChangedAt = Date.now();
}
// Strip the per-request extras before saving an account record.
function cleanRecord(user) {
  const { _status, _creatorUntil, ...rest } = user;
  return rest;
}
function bearer(request) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
  return m ? m[1] : "";
}
async function currentUser(request, env) {
  const token = bearer(request);
  if (!token) return null;
  const raw = await env.DB.get(`session:${token}`);
  if (!raw) return null;
  let name = raw, made = 0; // older sessions are just the username
  if (raw.startsWith("{")) { try { const v = JSON.parse(raw); name = v.u; made = v.t || 0; } catch { return null; } }
  const [user, row] = await Promise.all([getUser(env, name), accessList(env).get(name)]);
  if (!user || (row && row.status === "deleted")) return null;
  if (user.pwChangedAt && made < user.pwChangedAt) return null; // logged out by a password change
  user._status = user.admin ? "approved" : (row && row.status) || statusOf(user);
  user._creatorUntil = (row && row.creatorUntil) || 0;
  if (row && row.lastSeen) user.lastSeen = row.lastSeen;
  return user;
}
async function hashPassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

// Admin view: put the private links of paid games back in.
async function withPrivateUrls(env, games) {
  return Promise.all(games.map(async (g) =>
    g.paid ? { ...g, url: (await env.DB.get(`url:${g.id}`)) || "" } : g));
}

/* ---------- Validation ---------- */
function clean(body) {
  const str = (v, max) => String(v ?? "").trim().slice(0, max);
  const data = {
    name: str(body.name, 60),
    creator: str(body.creator, 60),
    url: str(body.url, 500),
    category: str(body.category, 30),
    description: str(body.description, 400),
    paid: body.paid === true,
    price: str(body.price, 30),
  };
  if (!data.paid) delete data.paid;
  if (!data.paid || !data.price) delete data.price;
  if (!data.name || !data.creator || !data.url) throw httpError(400, "Name, creator and link are required.");
  if (!isHttp(data.url) && !/^\/games\/[\w-]+\/\S+$/.test(data.url)) throw httpError(400, "The game link must start with http:// or https://");
  return data;
}
function isHttp(u) {
  try { return ["http:", "https:"].includes(new URL(u).protocol); } catch { return false; }
}

/* ---------- Thumbnails ---------- */
function checkImage(image) {
  if (!image) return null;
  const ext = IMAGE_TYPES[image.type];
  if (!ext) throw httpError(400, "Thumbnail must be a PNG, JPG, WebP or GIF picture.");
  const data = String(image.data || "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(data)) throw httpError(400, "That picture couldn't be read.");
  if ((data.length * 3) / 4 > MAX_IMAGE_BYTES) throw httpError(400, "That picture is too big.");
  return { data, ext };
}

// Commit the picture to images/ on main. Each upload gets a new name so the
// browser never shows an old cached picture.
async function saveImage(env, id, image, name) {
  const path = `${IMAGE_DIR}/${id}-${Date.now().toString(36)}.${image.ext}`;
  await gh(env, `/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Upload thumbnail: ${name}`,
      content: image.data,
      branch: env.GITHUB_BRANCH || "main",
    }),
  });
  return path;
}

// Best effort: remove an old uploaded picture we no longer use.
async function deleteImage(env, path) {
  if (!path || !path.startsWith(`${IMAGE_DIR}/`) || path.includes("..")) return;
  try {
    const branch = env.GITHUB_BRANCH || "main";
    const file = await gh(env, `/contents/${path}?ref=${encodeURIComponent(branch)}`);
    await gh(env, `/contents/${path}`, {
      method: "DELETE",
      body: JSON.stringify({ message: `Remove old thumbnail ${path}`, sha: file.sha, branch }),
    });
  } catch {}
}

/* ---------- GitHub storage ---------- */
async function gh(env, path, opts = {}) {
  const repo = env.GITHUB_REPO || "Godo-Bear/StudySmartly";
  const api = env.GITHUB_API || "https://api.github.com"; // overridable for local testing
  const res = await fetch(`${api}/repos/${repo}${path}`, {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "StudySmartly-Worker",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    let msg = `GitHub error ${res.status}`;
    try { msg = `GitHub: ${(await res.json()).message}`; } catch {}
    if (res.status === 401) msg = "GitHub rejected the GITHUB_TOKEN secret. Check it in Cloudflare.";
    throw httpError(res.status === 409 ? 409 : 502, msg);
  }
  return res.json();
}

async function readGames(env) {
  const branch = env.GITHUB_BRANCH || "main";
  try {
    const file = await gh(env, `/contents/${FILE_PATH}?ref=${encodeURIComponent(branch)}`);
    const parsed = JSON.parse(b64decode(file.content));
    return { games: Array.isArray(parsed) ? parsed : parsed.games || [], sha: file.sha };
  } catch (err) {
    if (/404|Not Found/.test(err.message)) return { games: [], sha: null };
    throw err;
  }
}

// Read latest -> apply change -> commit. Retry if someone saved at the same time.
async function mutate(env, change, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { games, sha } = await readGames(env);
    const next = change(games);
    try {
      await gh(env, `/contents/${FILE_PATH}`, {
        method: "PUT",
        body: JSON.stringify({
          message: typeof message === "function" ? message() : message,
          content: b64encode(JSON.stringify(next, null, 2) + "\n"),
          branch: env.GITHUB_BRANCH || "main",
          ...(sha ? { sha } : {}),
        }),
      });
      return next;
    } catch (err) {
      if (err.status !== 409 || attempt === 2) throw err;
    }
  }
}

/* ---------- Utils ---------- */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function randomHex(bytes) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  return new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
}
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
// Compare hashes so the check takes the same time whatever the input.
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/* ---------- Play counter ----------
   One Durable Object (with its own small SQLite database) counts plays.
   It's on Cloudflare's free plan, and unlike KV it's fine with a write on
   every play. Each visitor counts at most once per game every 30 minutes. */
function playCounter(env) {
  return env.PLAYS.get(env.PLAYS.idFromName("all"));
}

export class PlayCounter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS plays (id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS votes (game TEXT NOT NULL, user TEXT NOT NULL, v INTEGER NOT NULL, PRIMARY KEY (game, user))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS recent (user TEXT NOT NULL, game TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user, game))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS favs (user TEXT NOT NULL, game TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user, game))");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, user TEXT NOT NULL,
      reason TEXT NOT NULL, note TEXT, at TEXT NOT NULL, resolved_by TEXT, resolved_at TEXT)`);
    this.recent = new Map(); // "ip|game" -> time, to ignore spam clicks
  }

  async hit(id, ip, user) {
    if (!/^[\w-]{1,64}$/.test(id)) return;
    if (user) {
      this.sql.exec("INSERT INTO recent (user, game, at) VALUES (?, ?, ?) ON CONFLICT(user, game) DO UPDATE SET at = excluded.at", user, id, Date.now());
      this.sql.exec("DELETE FROM recent WHERE user = ? AND game NOT IN (SELECT game FROM recent WHERE user = ? ORDER BY at DESC LIMIT 20)", user, user);
    }
    const key = `${ip}|${id}`;
    const now = Date.now();
    if (ip && now - (this.recent.get(key) || 0) < 30 * 60 * 1000) return;
    this.recent.set(key, now);
    if (this.recent.size > 5000) this.recent.clear();
    this.sql.exec("INSERT INTO plays (id, count) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET count = count + 1", id);
  }

  async top(n) {
    return this.sql.exec("SELECT id, count FROM plays ORDER BY count DESC LIMIT ?", n).toArray();
  }

  async vote(game, user, v) {
    if (v === 0) this.sql.exec("DELETE FROM votes WHERE game = ? AND user = ?", game, user);
    else this.sql.exec("INSERT INTO votes (game, user, v) VALUES (?, ?, ?) ON CONFLICT(game, user) DO UPDATE SET v = excluded.v", game, user, v);
  }
  async votes(game, user) {
    const r = this.sql.exec("SELECT SUM(v = 1) AS up, SUM(v = -1) AS down FROM votes WHERE game = ?", game).toArray()[0] || {};
    const mine = this.sql.exec("SELECT v FROM votes WHERE game = ? AND user = ?", game, user).toArray()[0];
    return { up: r.up || 0, down: r.down || 0, mine: mine ? mine.v : 0 };
  }
  async topRated(n) {
    return this.sql.exec(`SELECT game AS id, SUM(v = 1) AS up, SUM(v = -1) AS down FROM votes GROUP BY game
      HAVING up > 0 ORDER BY (up - down) DESC, up DESC LIMIT ?`, n).toArray();
  }

  async library(user) {
    const recent = this.sql.exec("SELECT game FROM recent WHERE user = ? ORDER BY at DESC LIMIT 12", user).toArray().map((r) => r.game);
    const favs = this.sql.exec("SELECT game FROM favs WHERE user = ? ORDER BY at DESC", user).toArray().map((r) => r.game);
    return { recent, favs };
  }
  async setFav(user, game, on) {
    if (on) this.sql.exec("INSERT OR IGNORE INTO favs (user, game, at) VALUES (?, ?, ?)", user, game, Date.now());
    else this.sql.exec("DELETE FROM favs WHERE user = ? AND game = ?", user, game);
  }

  // One open report per person per game.
  async report(game, user, reason, note) {
    const open = this.sql.exec("SELECT id FROM reports WHERE game = ? AND lower(user) = lower(?) AND resolved_at IS NULL", game, user).toArray()[0];
    if (open) return false;
    this.sql.exec("INSERT INTO reports (game, user, reason, note, at) VALUES (?, ?, ?, ?, ?)", game, user, reason, note, new Date().toISOString());
    return true;
  }
  async reports() {
    return this.sql.exec(`SELECT id, game, user, reason, note, at, resolved_by AS resolvedBy, resolved_at AS resolvedAt FROM reports
      ORDER BY resolved_at IS NOT NULL, id DESC LIMIT 200`).toArray();
  }
  async resolveReport(id, by) {
    this.sql.exec("UPDATE reports SET resolved_by = ?, resolved_at = ? WHERE id = ?", by, new Date().toISOString(), id);
  }
}

export class AccessList extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS access (username TEXT PRIMARY KEY, status TEXT, updated TEXT, last_seen TEXT, country TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS fails (username TEXT PRIMARY KEY, count INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0)");
    try { this.sql.exec("ALTER TABLE access ADD COLUMN creator_until INTEGER NOT NULL DEFAULT 0"); } catch {} // already there
  }
  // Seconds until this username can try again (0 = not locked).
  async lockedFor(username) {
    const r = this.sql.exec("SELECT locked_until FROM fails WHERE username = ?", username).toArray()[0];
    return r ? Math.max(0, Math.round((r.locked_until - Date.now()) / 1000)) : 0;
  }
  // Records a wrong password; returns tries left before the lock (0 = just locked).
  async loginFailed(username) {
    const r = this.sql.exec("SELECT count, locked_until FROM fails WHERE username = ?", username).toArray()[0];
    let count = r && r.locked_until < Date.now() && r.locked_until > 0 ? 1 : (r ? r.count + 1 : 1);
    let lockedUntil = 0;
    if (count >= 10) { lockedUntil = Date.now() + 15 * 60 * 1000; }
    this.sql.exec("INSERT INTO fails (username, count, locked_until) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until",
      username, lockedUntil ? 0 : count, lockedUntil);
    return lockedUntil ? 0 : 10 - count;
  }
  async loginOk(username) {
    this.sql.exec("DELETE FROM fails WHERE username = ?", username);
  }
  async get(username) {
    const r = this.sql.exec("SELECT status, last_seen, country, creator_until FROM access WHERE username = ?", username).toArray()[0];
    return r ? { status: r.status, lastSeen: r.last_seen || "", country: r.country || "", creatorUntil: r.creator_until || 0 } : null;
  }
  async set(username, status) {
    this.sql.exec(`INSERT INTO access (username, status, updated) VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET status = excluded.status, updated = excluded.updated`,
      username, status, new Date().toISOString());
  }
  async setCreator(username, until) {
    this.sql.exec(`INSERT INTO access (username, creator_until) VALUES (?, ?)
      ON CONFLICT(username) DO UPDATE SET creator_until = excluded.creator_until`, username, until);
  }
  // "Last on": at most one write every 5 minutes per account.
  async touch(username, country) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    this.sql.exec(`INSERT INTO access (username, last_seen, country) VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET last_seen = excluded.last_seen, country = COALESCE(NULLIF(excluded.country, ''), country)
      WHERE last_seen IS NULL OR last_seen < ?`,
      username, now.toISOString(), country, cutoff);
  }
  async all() {
    const out = {};
    for (const r of this.sql.exec("SELECT username, status, last_seen, country, creator_until FROM access").toArray()) {
      out[r.username] = { status: r.status, lastSeen: r.last_seen || "", country: r.country || "", creatorUntil: r.creator_until || 0 };
    }
    return out;
  }
}
