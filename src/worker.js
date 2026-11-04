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
    if (await env.DB.get(key)) throw httpError(409, "That username is taken.");
    const salt = randomHex(16);
    const user = {
      username: name, salt, iter: PBKDF2_ITERATIONS, hash: await hashPassword(password, salt), unlocked: [],
      status: "pending", // the owner approves new accounts in the admin panel
      createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(),
      country: (request.cf && request.cf.country) || "",
    };
    await env.DB.put(key, JSON.stringify(user));
    await logAttempt(env, request, name, "signup");
    return json({ token: await newSession(env, name), user: publicUser(user) }, 201);
  }

  if (path === "/api/auth/login" && method === "POST") {
    const { username, password } = await request.json();
    const user = await getUser(env, String(username || ""));
    const ok = user && (await safeEqual(await hashPassword(String(password || ""), user.salt, user.iter), user.hash));
    if (!ok) {
      await logAttempt(env, request, String(username || "").trim().slice(0, 20), user ? "wrong-password" : "no-account");
      await sleep(600);
      throw httpError(401, "Wrong username or password.");
    }
    await logAttempt(env, request, user.username, statusOf(user) === "approved" ? "ok" : statusOf(user));
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
    if (!user.lastSeen || Date.now() - new Date(user.lastSeen).getTime() > 60 * 60 * 1000) {
      user.lastSeen = new Date().toISOString();
      if (request.cf && request.cf.country) user.country = request.cf.country;
      await env.DB.put(`user:${user.username.toLowerCase()}`, JSON.stringify(user));
    }
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
    if (env.PLAYS) await playCounter(env).hit(hit[1], request.headers.get("CF-Connecting-IP") || "");
    return json({ ok: true });
  }

  /* ---------- Saved progress for uploaded games ---------- */
  const save = path.match(/^\/api\/saves\/([\w-]+)(\/ticket)?$/);
  if (save) {
    const user = await approvedUser(request, env);
    const key = `save:${user.username.toLowerCase()}:${save[1]}`;
    if (save[2] && method === "POST") {
      // Short-lived ticket that lets the game page load *only* this save.
      const ticket = randomHex(24);
      await env.DB.put(`ticket:${ticket}`, JSON.stringify({ user: user.username.toLowerCase(), folder: save[1] }), { expirationTtl: 600 });
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
      // Uploaded games keep their files; only the details change.
      const privateUrl = game.paid ? await env.DB.get(`url:${game.id}`) : game.url;
      if (String(privateUrl || "").startsWith("/games/")) body.url = privateUrl;
      const data = clean({ ...body, creator: body.creator || user.username });
      await updateGame(env, game.id, data, checkImage(body.image));
      return json({ ok: true });
    }
    if (!mine[2] && method === "DELETE") {
      await removeGame(env, game.id);
      return json({ ok: true });
    }
  }

  return json({ error: "Not found" }, 404);
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
      if (t && t.folder === m[1]) saved = (await env.DB.get(`save:${t.user}:${m[1]}`, "json")) || {};
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

  if (path === "/api/admin/logins" && method === "GET") {
    const page = await env.DB.list({ prefix: "log:", limit: 200 });
    return json({ logins: page.keys.map((k) => k.metadata).filter(Boolean) });
  }

  /* ----- Player accounts (for unlocking paid games) ----- */
  if (path === "/api/admin/users" && method === "GET") {
    return json({ users: await listUsers(env) });
  }

  const u = path.match(/^\/api\/admin\/users\/([\w]+)(?:\/(unlock|lock|admin|status))?$/);
  if (u) {
    const user = await getUser(env, u[1]);
    if (!user) throw httpError(404, "That account doesn't exist.");
    const key = `user:${user.username.toLowerCase()}`;

    if (u[2] === "status" && method === "POST") {
      const { status } = await request.json();
      if (!["approved", "pending", "blocked"].includes(status)) throw httpError(400, "Unknown status.");
      if (status !== "approved" && me && me.username === user.username) throw httpError(400, "You can't lock your own account.");
      user.status = status;
      user.statusBy = me ? me.username : "admin code";
      user.statusAt = new Date().toISOString();
      await env.DB.put(key, JSON.stringify(user));
      return json({ user: publicUser(user) });
    }
    if (u[2] === "admin" && method === "POST") {
      const { admin } = await request.json();
      if (!admin && me && me.username === user.username) throw httpError(400, "You can't remove your own admin. Ask another admin.");
      if (admin) { user.admin = true; user.status = "approved"; } else delete user.admin;
      await env.DB.put(key, JSON.stringify(user));
      return json({ user: publicUser(user) });
    }
    if (u[2] && method === "POST") {
      const { gameId, paidWith, note } = await request.json();
      if (!/^[\w-]+$/.test(String(gameId || ""))) throw httpError(400, "Pick a game.");
      const updated = await setUnlock(env, user, gameId, u[2] === "unlock", { by: me ? me.username : "admin code", paidWith, note });
      return json({ user: publicUser(updated) });
    }
    if (!u[2] && method === "DELETE") {
      if (me && me.username === user.username) throw httpError(400, "You can't delete your own account here.");
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
  await env.DB.put(`user:${user.username.toLowerCase()}`, JSON.stringify(user));
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
    admin: !!user.admin, status: statusOf(user), createdAt: user.createdAt,
    lastSeen: user.lastSeen || "", country: user.country || "",
  };
}
// The logged-in account, if the owner has approved it.
async function approvedUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw httpError(401, "Log in to use StudySmartly.");
  const status = statusOf(user);
  if (status === "blocked") throw httpError(403, "This account has been blocked by the owner.");
  if (status !== "approved") throw httpError(403, "The owner hasn't unlocked your account yet.");
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
  await env.DB.put(`session:${token}`, username.toLowerCase(), { expirationTtl: SESSION_TTL });
  return token;
}
function bearer(request) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
  return m ? m[1] : "";
}
async function currentUser(request, env) {
  const token = bearer(request);
  if (!token) return null;
  const name = await env.DB.get(`session:${token}`);
  return name ? getUser(env, name) : null;
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
    this.recent = new Map(); // "ip|game" -> time, to ignore spam clicks
  }

  async hit(id, ip) {
    if (!/^[\w-]{1,64}$/.test(id)) return;
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
}
