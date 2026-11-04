// AI overview for a game: Cloudflare's free Workers AI reads the game's own
// files and explains it. Written once per game (and again when a new version
// is uploaded, or when an admin/the creator presses Refresh), then saved in KV.

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TEXT_FILE = /\.(html?|m?js|css|json|txt|md|xml|svg)$/i;
// This model reads about 24,000 tokens at once, so the files have to fit in
// roughly 60,000 characters. Bigger files (usually libraries) are skipped and
// listed for the AI so it knows they exist.
const MAX_FILE_CHARS = 40_000;
const MAX_TOTAL_CHARS = 60_000;

// What the overview looks like (structured output, so it's easy to show)
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "goal", "howToPlay", "controls", "tips", "goodFor"],
  properties: {
    summary: { type: "string", description: "2-3 friendly sentences: what the game is." },
    goal: { type: "string", description: "One sentence: how you win, or what you're trying to do." },
    howToPlay: { type: "array", items: { type: "string" }, description: "3-6 short steps to get started." },
    controls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["input", "action"],
        properties: { input: { type: "string" }, action: { type: "string" } },
      },
      description: "Keys / mouse / touch and what they do. Empty if none could be found.",
    },
    tips: { type: "array", items: { type: "string" }, description: "2-4 tips that come from how the game actually works." },
    goodFor: { type: "string", description: "One sentence on what skills it uses, e.g. reaction time, planning, maths." },
  },
};

const SYSTEM = `You write the "AI overview" shown under a game on StudySmartly, a site where friends share web games they made.
You are given the game's details and its source files. Read the code to work out what the game really does: the goal, how scoring or winning works, the controls (look at key, mouse and touch handlers), and anything a new player should know.
Write for a 10-16 year old: short, clear sentences, friendly, no jargon, no code. Only describe what the code shows; if something isn't clear from the files, leave it out rather than guess. If no controls can be found, return an empty controls list.`;

// Gather the game's text files: uploaded games from KV, link games by fetching the page.
async function readGameFiles(env, link) {
  const files = [];
  const skipped = [];
  let total = 0;
  const add = (path, text) => {
    if (text.length > MAX_FILE_CHARS) return skipped.push(`${path} (${Math.round(text.length / 1000)}k characters, probably a library)`);
    if (total + text.length > MAX_TOTAL_CHARS) return skipped.push(`${path} (over the size budget)`);
    total += text.length;
    files.push({ path, text });
  };

  const folder = (link.match(/^\/games\/([\w-]+)\//) || [])[1];
  if (folder) {
    // Uploaded: every text file in the game's folder, the start page first
    const keys = [];
    let cursor;
    do {
      const page = await env.DB.list({ prefix: `file:${folder}/`, cursor });
      keys.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    const entry = decodeURIComponent(link.slice(`/games/${folder}/`.length).split("?")[0] || "index.html");
    const paths = keys.map((k) => k.slice(`file:${folder}/`.length))
      .sort((a, b) => (b === entry) - (a === entry) || a.length - b.length);
    for (const p of paths) {
      if (!TEXT_FILE.test(p)) { skipped.push(`${p} (not a text file)`); continue; }
      add(p, (await env.DB.get(`file:${folder}/${p}`)) || "");
    }
    return { files, skipped };
  }

  // Link: the page itself plus its scripts on the same site
  const res = await fetch(link, { headers: { "User-Agent": "StudySmartly-Overview/1.0" }, redirect: "follow" });
  if (!res.ok) throw new Error(`Couldn't open the game's page (${res.status}).`);
  const html = await res.text();
  add(new URL(res.url).pathname || "index.html", html);
  const base = new URL(res.url);
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 15);
  for (const src of scripts) {
    let u;
    try { u = new URL(src, base); } catch { continue; }
    if (u.origin !== base.origin) { skipped.push(`${src} (from another site)`); continue; }
    try {
      const r = await fetch(u.href, { headers: { "User-Agent": "StudySmartly-Overview/1.0" } });
      if (r.ok) add(u.pathname, await r.text());
    } catch {}
  }
  return { files, skipped };
}

export async function writeOverview(env, game, link) {
  const { files, skipped } = await readGameFiles(env, link);
  if (!files.length) throw new Error("Couldn't find any of the game's files to read.");

  const details = [
    `Name: ${game.name}`,
    `Made by: ${game.creator || "unknown"}`,
    game.category ? `Category: ${game.category}` : "",
    game.description ? `Creator's description: ${game.description}` : "",
    skipped.length ? `Files not included: ${skipped.join("; ")}` : "",
  ].filter(Boolean).join("\n");

  if (!env.AI) throw new Error("The AI isn't set up (missing AI binding).");
  const fileText = files.map((f) => `<file path="${f.path.replace(/"/g, "'")}">\n${f.text}\n</file>`).join("\n");
  const result = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Game details:\n${details}\n\nThe game's files:\n${fileText}\n\nWrite the overview for this game as JSON.` },
    ],
    response_format: { type: "json_schema", json_schema: SCHEMA },
    max_tokens: 1500,
    temperature: 0.3,
  });

  // JSON mode returns an object; some models return it as a string.
  let overview = result && result.response;
  if (typeof overview === "string") {
    const m = overview.match(/\{[\s\S]*\}/);
    try { overview = JSON.parse(m ? m[0] : overview); } catch { throw new Error("The AI's answer couldn't be read. Try Refresh."); }
  }
  if (!overview || typeof overview !== "object") throw new Error("The AI didn't send an overview. Try Refresh.");
  return { ...tidy(overview), filesRead: files.length, writtenAt: new Date().toISOString() };
}

// Keep only the fields we show, in the right shapes, whatever the AI sent.
function tidy(o) {
  const str = (v, max = 600) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const list = (v, n) => (Array.isArray(v) ? v.map((x) => str(x, 300)).filter(Boolean).slice(0, n) : []);
  return {
    summary: str(o.summary),
    goal: str(o.goal, 300),
    howToPlay: list(o.howToPlay, 8),
    controls: (Array.isArray(o.controls) ? o.controls : [])
      .map((c) => ({ input: str(c && c.input, 60), action: str(c && c.action, 160) }))
      .filter((c) => c.input && c.action).slice(0, 12),
    tips: list(o.tips, 6),
    goodFor: str(o.goodFor, 300),
  };
}

export function overviewErrorMessage(err) {
  const msg = String((err && err.message) || "");
  if (/neuron|quota|daily|limit/i.test(msg)) return "The free AI has done its work for today. Try again tomorrow.";
  if (/AI binding/i.test(msg)) return msg;
  return msg && msg.length < 140 ? msg : "Couldn't write the overview. Try again later.";
}
