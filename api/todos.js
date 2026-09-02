// api/todos.js
// Mark's private to-do list — shown only in the For Mark section. Same
// encrypted-at-rest pattern as the private calendar: the committed file
// data/todos.enc.json is AES-256-GCM ciphertext, unreadable without the
// server-side key even though the repo is public.
//
//   GET  ?token=              → { todos: [{text, ts, bucket, doing}...],
//                                 rules: [{text, freq, day, month?}...], sha }
//   POST { todos?, rules?, sha } → save the provided piece(s); the other is
//                               preserved (stale sha → 409). rules are the
//                               recurring schedules managed in /admin —
//                               freq "monthly" (on `day`) or "yearly" (on
//                               `month`/`day`); the daily cron re-adds the
//                               item on schedule with a month/year tag.
//   POST { add: "text" }      → convenience append (server does the
//                               read-modify-write, one retry on a race) —
//                               this is what the quick-add box, the voice
//                               page, and the Apple Watch shortcut use.
//
// Auth: owner login session or the admin secret (the secret is what a
// Shortcuts automation stores). The cross-subdomain owner cookie (the
// specials-scope token) is also accepted, but ONLY for {add} — that's
// how recipe.marktan.ai sends card items to the shopping bucket (CORS
// below). Env: GITHUB_TOKEN; key from PRIVATE_STORE_KEY →
// PUSH_STORE_KEY → VAPID_PRIVATE_KEY.
// Store access (read/write/crypto) lives in _todostore.js, shared with
// the daily cron in api/notify.js.

import { sessionKey, isOwner, isSpecialsScope, reqToken } from "./_session.js";
import { readTodos as readStore, writeTodos } from "./_todostore.js";

// Sibling sites allowed to call this API from the browser (the recipe
// app sends card items to the shopping bucket). Never reflect other
// origins.
const CORS_ORIGINS = new Set([
  "https://recipe.marktan.ai",
  "https://marktan.ai",
  "https://www.marktan.ai",
]);

const str = (v, max = 500) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
// GTD-ish buckets plus the shopping list; anything unrecognised (incl.
// legacy items) lands in today
const BUCKETS = ["today", "next", "someday", "shopping"];
const bucketOf = (v) => (BUCKETS.includes(String(v)) ? String(v) : "today");

function sanitize(data) {
  if (!Array.isArray(data)) throw new Error("expected an array");
  if (data.length > 500) throw new Error("too many entries");
  return data
    .map((t) => ({
      text: str(t && t.text),
      ts: Number.isFinite(Number(t && t.ts)) ? Number(t.ts) : Date.now(),
      bucket: bucketOf(t && t.bucket),
      doing: !!(t && t.doing), // "in progress" — started but not yet complete
    }))
    .filter((t) => t.text);
}

function sanitizeRules(data) {
  if (!Array.isArray(data)) throw new Error("expected an array");
  if (data.length > 100) throw new Error("too many rules");
  const clamp = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  return data
    .map((r) => {
      const freq = (r && r.freq) === "yearly" ? "yearly" : "monthly";
      const o = { text: str(r && r.text), freq, day: clamp(r && r.day, 1, 31, 1) };
      if (freq === "yearly") o.month = clamp(r && r.month, 1, 12, 1);
      return o;
    })
    .filter((r) => r.text);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // CORS for the allowlisted sibling sites (preflight carries no auth,
  // so answer it before the token check).
  const origin = String(req.headers && req.headers.origin || "");
  if (CORS_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const secret = (process.env.ADMIN_SECRET || process.env.DASHBOARD_SECRET || "").trim();
  if (!secret) { res.status(503).json({ error: "set ADMIN_SECRET (or DASHBOARD_SECRET)" }); return; }
  const token = reqToken(req);
  const skey = sessionKey();
  const full = token === secret || isOwner(token, skey);
  // The cross-subdomain owner cookie (the specials-scope token) may ONLY
  // append items — deliberately: an XSS on any sibling subdomain that
  // steals the cookie can add junk to the list, never read or rewrite it.
  const appendOnly = !full && isSpecialsScope(token, skey);
  if (!full && !appendOnly) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (appendOnly && req.method !== "POST") { res.status(401).json({ error: "unauthorized" }); return; }
  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  if (!ghToken) { res.status(503).json({ error: "GITHUB_TOKEN not set" }); return; }

  try {
    if (req.method === "POST") {
      let body = {};
      try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch (_) {}
      if (appendOnly && body.add == null) { res.status(401).json({ error: "unauthorized" }); return; }

      // Quick append: the server owns the read-modify-write, so callers
      // (quick-add box, voice page, watch shortcut, the recipe app) need
      // no sha at all. `add` is one text or an array of them; array adds
      // skip texts already on the list (a re-sent recipe card must not
      // double every ingredient).
      if (body.add != null) {
        const batch = Array.isArray(body.add);
        const texts = (batch ? body.add.slice(0, 100) : [body.add]).map((v) => str(v)).filter(Boolean);
        if (!texts.length) { res.status(400).json({ error: "empty item" }); return; }
        const bucket = bucketOf(body.bucket); // optional; quick adds land in today
        for (let attempt = 0; ; attempt++) {
          const { todos, rules, sha } = await readStore(ghToken);
          const have = new Set(todos.map((t) => t && t.text));
          const fresh = batch ? texts.filter((t) => !have.has(t)) : texts;
          if (!fresh.length) {
            res.status(200).json({ ok: true, added: 0, skipped: texts.length, count: todos.length, sha });
            return;
          }
          const next = todos.concat(fresh.map((text) => ({ text, ts: Date.now(), bucket })));
          try {
            const newSha = await writeTodos(ghToken, sanitize(next), rules, sha);
            res.status(200).json({ ok: true, added: fresh.length, skipped: texts.length - fresh.length, count: next.length, sha: newSha });
            return;
          } catch (e) {
            if (e && e.conflict && attempt < 1) continue; // raced another write — reread once
            throw e;
          }
        }
      }

      // Full save of either piece; the piece not sent is carried forward
      // (the list pages send todos only, /admin may send either or both).
      const cur = await readStore(ghToken);
      const todos = body.todos !== undefined ? sanitize(body.todos) : cur.todos;
      const rules = body.rules !== undefined ? sanitizeRules(body.rules) : cur.rules;
      const sha = await writeTodos(ghToken, todos, rules, body.sha || cur.sha);
      res.status(200).json({ sha, count: todos.length, rules: rules.length });
    } else {
      const { todos, rules, sha } = await readStore(ghToken);
      res.status(200).json({ todos, rules, sha });
    }
  } catch (err) {
    if (err && err.conflict) { res.status(409).json({ error: "conflict — reload, the list changed" }); return; }
    res.status(502).json({ error: String(err && err.message || err).slice(0, 200) });
  }
}
