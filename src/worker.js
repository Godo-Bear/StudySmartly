// StudySmartly Worker
// - Serves the static site (via the ASSETS binding).
// - /api/admin/*  admin panel. Unlocked with the ADMIN_CODE secret or by
//   logging in with an account an admin has marked as admin. Saves
//   data/games.json + thumbnails to main on GitHub using GITHUB_TOKEN.
// - /api/auth/*, /api/me, /api/play/:id  player accounts and paid games.
//   Accounts, sessions, unlocks and the links of paid games live in the DB
//   (Cloudflare KV), never in the public repo.

const FILE_PATH = "data/games.json";
const IMAGE_DIR = "images";
const IMAGE_TYPES = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" };
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const PBKDF2_ITERATIONS = 20000;       // fits the free plan's 10ms CPU limit

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
    const user = { username: name, salt, iter: PBKDF2_ITERATIONS, hash: await hashPassword(password, salt), unlocked: [], createdAt: new Date().toISOString() };
    await env.DB.put(key, JSON.stringify(user));
    return json({ token: await newSession(env, name), user: publicUser(user) }, 201);
  }

  if (path === "/api/auth/login" && method === "POST") {
    const { username, password } = await request.json();
    const user = await getUser(env, String(username || ""));
    const ok = user && (await safeEqual(await hashPassword(String(password || ""), user.salt, user.iter), user.hash));
    if (!ok) {
      await sleep(600);
      throw httpError(401, "Wrong username or password.");
    }
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
    return json({ user: publicUser(user) });
  }

  // Link for a paid game, only for accounts it's been unlocked for.
  const play = path.match(/^\/api\/play\/([\w-]+)$/);
  if (play && method === "GET") {
    const gameUrl = await env.DB.get(`url:${play[1]}`);
    if (!gameUrl) throw httpError(404, "That isn't a paid game.");
    const user = await currentUser(request, env);
    if (!user) throw httpError(401, "Log in to play this game.");
    if (!user.admin && !user.unlocked.includes(play[1])) throw httpError(403, "This game hasn't been unlocked for your account yet.");
    return json({ url: gameUrl });
  }

  return json({ error: "Not found" }, 404);
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
    const data = clean(body);
    const image = checkImage(body.image);
    if (!image) throw httpError(400, "Please upload a thumbnail picture.");
    const id = crypto.randomUUID();
    data.thumbnail = await saveImage(env, id, image, data.name);
    const realUrl = data.url;
    if (data.paid) {
      await env.DB.put(`url:${id}`, realUrl); // keep the link private
      data.url = "";
    }
    const game = { id, ...data, addedAt: new Date().toISOString() };
    const games = await mutate(env, (list) => [...list, game], `Add game: ${game.name} by ${game.creator}`);
    return json({ games: await withPrivateUrls(env, games), game }, 201);
  }

  const m = path.match(/^\/api\/admin\/games\/([\w-]+)$/);
  if (m && method === "PUT") {
    const id = m[1];
    const body = await request.json();
    const data = clean(body);
    const image = checkImage(body.image);
    if (image) data.thumbnail = await saveImage(env, id, image, data.name);
    const realUrl = data.url;
    if (data.paid) {
      await env.DB.put(`url:${id}`, realUrl);
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
    return json({ games: await withPrivateUrls(env, games) });
  }

  if (m && method === "DELETE") {
    const id = m[1];
    let removed = "", thumb = "";
    const games = await mutate(env, (list) => {
      const g = list.find((x) => String(x.id) === id);
      if (!g) throw httpError(404, "That game no longer exists.");
      removed = g.name;
      thumb = g.thumbnail || "";
      return list.filter((x) => x !== g);
    }, () => `Remove game: ${removed}`);
    await env.DB.delete(`url:${id}`);
    await deleteImage(env, thumb);
    return json({ games: await withPrivateUrls(env, games) });
  }

  /* ----- Player accounts (for unlocking paid games) ----- */
  if (path === "/api/admin/users" && method === "GET") {
    return json({ users: await listUsers(env) });
  }

  const u = path.match(/^\/api\/admin\/users\/([\w]+)(?:\/(unlock|lock|admin))?$/);
  if (u) {
    const user = await getUser(env, u[1]);
    if (!user) throw httpError(404, "That account doesn't exist.");
    const key = `user:${user.username.toLowerCase()}`;

    if (u[2] === "admin" && method === "POST") {
      const { admin } = await request.json();
      if (!admin && me && me.username === user.username) throw httpError(400, "You can't remove your own admin. Ask another admin.");
      if (admin) user.admin = true; else delete user.admin;
      await env.DB.put(key, JSON.stringify(user));
      return json({ user: publicUser(user) });
    }
    if (u[2] && method === "POST") {
      const { gameId, paidWith, note } = await request.json();
      if (!/^[\w-]+$/.test(String(gameId || ""))) throw httpError(400, "Pick a game.");
      user.unlocked = user.unlocked.filter((x) => x !== gameId);
      user.unlockInfo = user.unlockInfo || {};
      delete user.unlockInfo[gameId];
      if (u[2] === "unlock") {
        user.unlocked.push(gameId);
        // Keep a record of the payment, e.g. cash, for the owner.
        user.unlockInfo[gameId] = {
          by: me ? me.username : "admin code",
          at: new Date().toISOString(),
          paidWith: String(paidWith || "Cash").slice(0, 30),
          note: String(note || "").trim().slice(0, 100),
        };
      }
      await env.DB.put(key, JSON.stringify(user));
      return json({ user: publicUser(user) });
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
function publicUser(user) {
  return {
    username: user.username, unlocked: user.unlocked, unlockInfo: user.unlockInfo || {},
    admin: !!user.admin, createdAt: user.createdAt,
  };
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
  if (!isHttp(data.url)) throw httpError(400, "The game link must start with http:// or https://");
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
