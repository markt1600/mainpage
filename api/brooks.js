// api/brooks.js
// Personal reader cache for The Brooks Review's member stories — the
// owner is a paying member and reads his subscription here in The
// Daily's own UI instead of the site's. STRICTLY personal use:
//   · every route requires the owner's Google session (isOwner) — the
//     cached stories are never served to anyone else, ever;
//   · the cache file data/brooks.enc.json is gzip + AES-256-GCM, so
//     nothing paywalled exists in plaintext in the public repo;
//   · fetching happens with the owner's OWN membership credentials,
//     set in Vercel env — never committed.
//
//   GET                 → { posts: [{url,title,date,words}], lastSync }
//   GET ?post=<url>     → { post: {url,title,date,html} }
//   POST {sync:1}       → pull the member category with the owner's
//     credentials, add unseen stories to the cache (newest first, a
//     bounded batch per call so the first backfill spans several
//     calls), → { added, total, remaining, lastSync }
//
// Env: GITHUB_TOKEN; store key PRIVATE_STORE_KEY → PUSH_STORE_KEY →
// VAPID_PRIVATE_KEY; and either BROOKS_FEED_URL (a personal member
// feed, preferred when Memberful provides one) or BROOKS_EMAIL +
// BROOKS_PASSWORD (server-side Memberful sign-in).

import crypto from "node:crypto";
import zlib from "node:zlib";
import { sessionKey, isOwner, reqToken } from "./_session.js";

const REPO = (process.env.GITHUB_REPO || "markt1600/mainpage").trim();
const BRANCH = (process.env.GITHUB_BRANCH || "main").trim();
const PATH = "data/brooks.enc.json";
const GH = "https://api.github.com";
const SITE = "https://brooksreview.net";
const CATEGORY = `${SITE}/category/articles/member/`;
const MAX_NEW_PER_SYNC = 12;   // keep each sync inside the function timeout
const MAX_PAGES_PER_SYNC = 8;
const MAX_STORE_BYTES = 850 * 1024; // stay clear of the contents-API 1MB ceiling

function encKey() {
  const secret = (process.env.PRIVATE_STORE_KEY || process.env.PUSH_STORE_KEY || process.env.VAPID_PRIVATE_KEY || "").trim();
  if (!secret) throw new Error("no PRIVATE_STORE_KEY / PUSH_STORE_KEY / VAPID_PRIVATE_KEY set");
  return crypto.createHash("sha256").update("brooks:" + secret).digest();
}
// gzip before encrypting: ~300 HTML stories fit comfortably in one blob
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([c.update(zlib.gzipSync(JSON.stringify(obj))), c.final()]);
  return { v: 2, gz: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}
function decrypt(blob) {
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(blob.iv, "base64"));
  d.setAuthTag(Buffer.from(blob.tag, "base64"));
  const raw = Buffer.concat([d.update(Buffer.from(blob.ct, "base64")), d.final()]);
  return JSON.parse((blob.gz ? zlib.gunzipSync(raw) : raw).toString("utf8"));
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "marktan-brooks",
  };
}

async function readStore(ghToken) {
  const res = await fetch(`${GH}/repos/${REPO}/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders(ghToken), cache: "no-store" });
  if (res.status === 404) return { posts: [], lastSync: null, sha: null };
  if (!res.ok) throw new Error(`GitHub read ${res.status}`);
  const j = await res.json();
  try {
    const d = decrypt(JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8")));
    return { posts: Array.isArray(d.posts) ? d.posts : [], lastSync: d.lastSync || null, sha: j.sha || null };
  } catch (_) {
    return { posts: [], lastSync: null, sha: j.sha || null };
  }
}

async function writeStore(ghToken, posts, lastSync, sha) {
  // size guard: drop the oldest stories if the blob would crowd the
  // contents-API limit (they can be re-read on the site itself)
  let keep = posts;
  let payload = encrypt({ posts: keep, lastSync });
  while (Buffer.from(JSON.stringify(payload)).length > MAX_STORE_BYTES && keep.length > 20) {
    keep = keep.slice(0, keep.length - 10);
    payload = encrypt({ posts: keep, lastSync });
  }
  const body = {
    message: `brooks: cache update (${keep.length} stories)`,
    content: Buffer.from(JSON.stringify(payload) + "\n", "utf8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH}/repos/${REPO}/contents/${PATH}`, {
    method: "PUT",
    headers: { ...ghHeaders(ghToken), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 409) { const err = new Error("conflict"); err.conflict = true; throw err; }
  if (!res.ok) throw new Error(`GitHub write ${res.status}`);
  const j = await res.json();
  return { sha: j.content && j.content.sha ? j.content.sha : null, posts: keep };
}

/* ---------------- authenticated fetching ---------------- */

// Minimal cookie jar across brooksreview.net + memberful redirects.
function makeJar() {
  const jars = new Map(); // host → Map(name → value)
  const hostOf = (u) => new URL(u).hostname;
  return {
    absorb(url, res) {
      const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      if (!cookies.length) return;
      const jar = jars.get(hostOf(url)) || new Map();
      for (const c of cookies) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      jars.set(hostOf(url), jar);
    },
    header(url) {
      const jar = jars.get(hostOf(url));
      return jar && jar.size ? [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") : "";
    },
  };
}

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" };

// fetch with the jar, following redirects manually so cookies stick
// across the brooksreview.net ↔ memberful.com hops
async function jarFetch(jar, url, opts = {}) {
  let current = url;
  for (let hop = 0; hop < 12; hop++) {
    const headers = { ...UA, ...(opts.headers || {}) };
    const cookie = jar.header(current);
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(current, {
      method: hop === 0 ? (opts.method || "GET") : "GET",
      headers,
      body: hop === 0 ? opts.body : undefined,
      redirect: "manual",
    });
    jar.absorb(current, res);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    return { res, url: current };
  }
  throw new Error("too many redirects");
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const unesc = (s) => String(s).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;|&#8217;/g, "'").replace(/&#8211;/g, "–").replace(/&#8212;/g, "—").replace(/&#8220;/g, "“").replace(/&#8221;/g, "”").replace(/&nbsp;/g, " ");

// The anonymous page shows this instead of the story — its absence is
// how we verify the login actually worked.
const GATE_MARK = /must be a <a[^>]*>member<\/a> to read/i;

async function memberLogin(jar) {
  const email = (process.env.BROOKS_EMAIL || "").trim();
  const password = (process.env.BROOKS_PASSWORD || "").trim();
  if (!email || !password) throw new Error("set BROOKS_FEED_URL, or BROOKS_EMAIL + BROOKS_PASSWORD, in Vercel env");

  // entering via the site's own auth endpoint carries the right
  // return-path state through Memberful and back
  let { res, url } = await jarFetch(jar, `${SITE}/?memberful_endpoint=auth`);
  let html = await res.text();
  if (!/memberful\.com\/auth\/sign_in/.test(url) && !/authenticity_token/.test(html)) {
    // no sign-in form — maybe already authenticated via carried cookies
    return;
  }
  const token = (html.match(/name="authenticity_token"\s+value="([^"]+)"/) || [])[1];
  const action = (html.match(/<form[^>]*action="([^"]+)"/) || [])[1] || "/auth/sign_in";
  if (!token) throw new Error("couldn't find the Memberful sign-in form");
  const signInUrl = new URL(action, url).toString();
  const form = new URLSearchParams({
    authenticity_token: token,
    "session[email]": email,
    "session[password]": password,
  });
  ({ res, url } = await jarFetch(jar, signInUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(signInUrl).origin, Referer: signInUrl },
    body: form.toString(),
  }));
  const after = await res.text();
  if (/authenticity_token/.test(after) && /sign_in/.test(url)) {
    throw new Error("Memberful sign-in rejected — check BROOKS_EMAIL / BROOKS_PASSWORD");
  }
  // make sure the WordPress side received the session
  await jarFetch(jar, `${SITE}/?memberful_endpoint=auth`);
}

// list {url,title,date} entries from one member-category page
export function parseCategory(html) {
  const out = [];
  const re = /<h2 class="wp-block-post-title[^"]*">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)(?=<h2 class="wp-block-post-title|$)/g;
  let m;
  while ((m = re.exec(html))) {
    const date = (m[3].match(/datetime="([^"]+)"/) || [])[1] || null;
    out.push({ url: m[1], title: unesc(m[2].replace(/<[^>]+>/g, "").trim()), date });
  }
  return out;
}

// pull the story body out of a (logged-in) post page and defang it
export function extractContent(html) {
  const start = html.indexOf('<div class="entry-content');
  if (start < 0) return null;
  const from = html.indexOf(">", start) + 1;
  const stops = ["<footer", '<div class="wp-block-post-navigation', '<div class="wp-block-comments', "<nav"];
  let end = html.length;
  for (const s of stops) {
    const i = html.indexOf(s, from);
    if (i > -1 && i < end) end = i;
  }
  let body = html.slice(from, end);
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "")
    .trim();
  // trailing closers left over from slicing at a stop marker
  body = body.replace(/(<\/div>\s*)+$/g, "");
  return body;
}

// personal member feed, when one is configured (RSS or JSON Feed)
async function fetchFeedPosts(feedUrl) {
  const res = await fetch(feedUrl, { headers: UA, cache: "no-store" });
  if (!res.ok) throw new Error(`member feed ${res.status}`);
  const text = await res.text();
  if (text.trim().startsWith("{")) {
    const j = JSON.parse(text);
    return (j.items || []).map((it) => ({
      url: it.url || it.id,
      title: it.title || "Untitled",
      date: it.date_published || null,
      html: it.content_html || esc(it.content_text || ""),
    }));
  }
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(text))) {
    const block = m[1];
    const pick = (tag) => {
      const mm = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
      return mm ? mm[1].trim() : null;
    };
    const html = pick("content:encoded") || pick("description") || "";
    items.push({ url: pick("link"), title: unesc(pick("title") || "Untitled"), date: pick("pubDate"), html });
  }
  return items;
}

async function sync(store) {
  const feedUrl = (process.env.BROOKS_FEED_URL || "").trim();
  const known = new Set(store.posts.map((p) => p.url));
  const fresh = [];

  if (feedUrl) {
    for (const it of await fetchFeedPosts(feedUrl)) {
      if (it.url && !known.has(it.url)) fresh.push({ ...it, html: it.html, added: Date.now() });
    }
    return { fresh, remaining: false };
  }

  const jar = makeJar();
  await memberLogin(jar);

  // walk category pages collecting unseen story links
  const unseen = [];
  let pagesWithOnlyKnown = 0;
  for (let page = 1; page <= MAX_PAGES_PER_SYNC; page++) {
    const pageUrl = page === 1 ? CATEGORY : `${CATEGORY}page/${page}/`;
    const { res } = await jarFetch(jar, pageUrl);
    if (!res.ok) break;
    const entries = parseCategory(await res.text());
    if (!entries.length) break;
    const newHere = entries.filter((e) => !known.has(e.url));
    unseen.push(...newHere);
    if (!newHere.length) {
      pagesWithOnlyKnown++;
      if (pagesWithOnlyKnown >= 2 && store.posts.length) break; // caught up
    }
    if (unseen.length >= MAX_NEW_PER_SYNC) break;
  }

  let gated = false;
  for (const e of unseen.slice(0, MAX_NEW_PER_SYNC)) {
    const { res } = await jarFetch(jar, e.url);
    if (!res.ok) continue;
    const html = await res.text();
    const body = extractContent(html);
    if (!body) continue;
    if (GATE_MARK.test(body)) { gated = true; continue; } // login didn't take
    fresh.push({ url: e.url, title: e.title, date: e.date, html: body, added: Date.now() });
  }
  if (gated && !fresh.length) throw new Error("the site still shows the member gate — login didn't stick");

  // more to backfill if we hit the per-call cap
  const remaining = unseen.length > MAX_NEW_PER_SYNC || (unseen.length === MAX_NEW_PER_SYNC && fresh.length > 0);
  return { fresh, remaining };
}

const wordsOf = (html) => String(html).replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // OWNER ONLY — this is the owner's paid subscription, cached for his
  // own reading. No secret path, no scoped cookie, nothing shared.
  if (!isOwner(reqToken(req), sessionKey())) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  if (!ghToken) { res.status(503).json({ error: "GITHUB_TOKEN not set" }); return; }

  try {
    const store = await readStore(ghToken);

    if (req.method === "POST") {
      const { fresh, remaining } = await sync(store);
      let posts = store.posts, sha = store.sha;
      const lastSync = new Date().toISOString();
      if (fresh.length || !store.lastSync) {
        const merged = [...fresh, ...store.posts].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
        const w = await writeStore(ghToken, merged, lastSync, store.sha);
        posts = w.posts; sha = w.sha;
      }
      res.status(200).json({ added: fresh.length, total: posts.length, remaining, lastSync });
      return;
    }

    let postUrl = null;
    try { postUrl = new URL(req.url, "http://x").searchParams.get("post"); } catch (_) {}
    if (postUrl) {
      const p = store.posts.find((x) => x.url === postUrl);
      if (!p) { res.status(404).json({ error: "not cached" }); return; }
      res.status(200).json({ post: p });
      return;
    }
    res.status(200).json({
      posts: store.posts.map((p) => ({ url: p.url, title: p.title, date: p.date, words: wordsOf(p.html) })),
      lastSync: store.lastSync,
    });
  } catch (err) {
    if (err && err.conflict) { res.status(409).json({ error: "conflict — try again" }); return; }
    res.status(502).json({ error: String(err && err.message || err).slice(0, 300) });
  }
}
