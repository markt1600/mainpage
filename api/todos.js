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
// Shortcuts automation stores). Env: GITHUB_TOKEN; key from
// PRIVATE_STORE_KEY → PUSH_STORE_KEY → VAPID_PRIVATE_KEY.
// Store access (read/write/crypto) lives in _todostore.js, shared with
// the daily cron in api/notify.js.

import { sessionKey, isOwner, reqToken } from "./_session.js";
import { readTodos as readStore, writeTodos } from "./_todostore.js";

const str = (v, max = 500) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
// GTD-ish buckets; anything unrecognised (incl. legacy items) lands in today
const BUCKETS = ["today", "next", "someday"];
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

  const secret = (process.env.ADMIN_SECRET || process.env.DASHBOARD_SECRET || "").trim();
  if (!secret) { res.status(503).json({ error: "set ADMIN_SECRET (or DASHBOARD_SECRET)" }); return; }
  const token = reqToken(req);
  if (token !== secret && !isOwner(token, sessionKey())) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  if (!ghToken) { res.status(503).json({ error: "GITHUB_TOKEN not set" }); return; }

  try {
    if (req.method === "POST") {
      let body = {};
      try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch (_) {}

      // Quick append: the server owns the read-modify-write, so callers
      // (quick-add box, voice page, watch shortcut) need no sha at all.
      if (body.add != null) {
        const text = str(body.add);
        if (!text) { res.status(400).json({ error: "empty item" }); return; }
        const bucket = bucketOf(body.bucket); // optional; quick adds land in today
        for (let attempt = 0; ; attempt++) {
          const { todos, rules, sha } = await readStore(ghToken);
          todos.push({ text, ts: Date.now(), bucket });
          try {
            const newSha = await writeTodos(ghToken, sanitize(todos), rules, sha);
            res.status(200).json({ ok: true, count: todos.length, sha: newSha });
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
