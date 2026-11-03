// StudySmartly Worker
// - Serves the static site (via the ASSETS binding).
// - Handles /api/* for the admin panel. Admins unlock with the ADMIN_CODE
//   secret; the Worker then saves data/games.json to the main branch on GitHub
//   using the GITHUB_TOKEN secret (which never reaches the browser).

const FILE_PATH = "data/games.json";

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
  if (!env.ADMIN_CODE || !env.GITHUB_TOKEN) {
    return json({ error: "Admin isn't set up yet: add the ADMIN_CODE and GITHUB_TOKEN secrets in Cloudflare." }, 503);
  }

  // Every API call must carry the admin code.
  const code = request.headers.get("X-Admin-Code") || "";
  if (!(await safeEqual(code, env.ADMIN_CODE))) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return json({ error: "Wrong admin code." }, 401);
  }

  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (path === "/api/login" && method === "POST") return json({ ok: true });

  if (path === "/api/games" && method === "GET") {
    const { games } = await readGames(env);
    return json({ games });
  }

  if (path === "/api/games" && method === "POST") {
    const data = clean(await request.json());
    const game = { id: crypto.randomUUID(), ...data, addedAt: new Date().toISOString() };
    const games = await mutate(env, (list) => [...list, game], `Add game: ${game.name} by ${game.creator}`);
    return json({ games, game }, 201);
  }

  const m = path.match(/^\/api\/games\/([\w-]+)$/);
  if (m && method === "PUT") {
    const data = clean(await request.json());
    let name = data.name;
    const games = await mutate(env, (list) => {
      const g = list.find((x) => String(x.id) === m[1]);
      if (!g) throw httpError(404, "That game no longer exists.");
      Object.assign(g, data, { updatedAt: new Date().toISOString() });
      return list;
    }, `Update game: ${name}`);
    return json({ games });
  }

  if (m && method === "DELETE") {
    let removed = "";
    const games = await mutate(env, (list) => {
      const g = list.find((x) => String(x.id) === m[1]);
      if (!g) throw httpError(404, "That game no longer exists.");
      removed = g.name;
      return list.filter((x) => x !== g);
    }, () => `Remove game: ${removed}`);
    return json({ games });
  }

  return json({ error: "Not found" }, 404);
}

/* ---------- Validation ---------- */
function clean(body) {
  const str = (v, max) => String(v ?? "").trim().slice(0, max);
  const data = {
    name: str(body.name, 60),
    creator: str(body.creator, 60),
    url: str(body.url, 500),
    category: str(body.category, 30),
    thumbnail: str(body.thumbnail, 500),
    description: str(body.description, 400),
  };
  if (!data.name || !data.creator || !data.url) throw httpError(400, "Name, creator and link are required.");
  if (!isHttp(data.url)) throw httpError(400, "The game link must start with http:// or https://");
  if (data.thumbnail && !isHttp(data.thumbnail)) throw httpError(400, "The thumbnail must be an http(s) link.");
  return data;
}
function isHttp(u) {
  try { return ["http:", "https:"].includes(new URL(u).protocol); } catch { return false; }
}

/* ---------- GitHub storage ---------- */
async function gh(env, path, opts = {}) {
  const repo = env.GITHUB_REPO || "Godo-Bear/StudySmartly";
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
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
