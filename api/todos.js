// api/todos.js
// Mark's private to-do list — shown only in the For Mark section. Same
// encrypted-at-rest pattern as the private calendar: the committed file
// data/todos.enc.json is AES-256-GCM ciphertext, unreadable without the
// server-side key even though the repo is public.
//
//   GET  ?token=              → { todos: [{text, ts}...], sha }
//   POST { todos, sha }       → full save (stale sha → 409)
//   POST { add: "text" }      → convenience append (server does the
//                               read-modify-write, one retry on a race) —
//                               this is what the quick-add box, the voice
//                               page, and the Apple Watch shortcut use.
//
// Auth: owner login session or the admin secret (the secret is what a
// Shortcuts automation stores). Env: GITHUB_TOKEN; key from
// PRIVATE_STORE_KEY → PUSH_STORE_KEY → VAPID_PRIVATE_KEY.

import crypto from "node:crypto";
import { sessionKey, isOwner, reqToken } from "./_session.js";

const REPO = (process.env.GITHUB_REPO || "markt1600/mainpage").trim();
const BRANCH = (process.env.GITHUB_BRANCH || "main").trim();
const PATH = "data/todos.enc.json";
const GH = "https://api.github.com";

function encKey() {
  const secret = (process.env.PRIVATE_STORE_KEY || process.env.PUSH_STORE_KEY || process.env.VAPID_PRIVATE_KEY || "").trim();
  if (!secret) throw new Error("no PRIVATE_STORE_KEY / PUSH_STORE_KEY / VAPID_PRIVATE_KEY set");
  return crypto.createHash("sha256").update("todos:" + secret).digest();
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}
function decrypt(blob) {
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(blob.iv, "base64"));
  d.setAuthTag(Buffer.from(blob.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.ct, "base64")), d.final()]).toString("utf8"));
}

const str = (v, max = 500) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

function sanitize(data) {
  if (!Array.isArray(data)) throw new Error("expected an array");
  if (data.length > 500) throw new Error("too many entries");
  return data
    .map((t) => ({ text: str(t && t.text), ts: Number.isFinite(Number(t && t.ts)) ? Number(t.ts) : Date.now() }))
    .filter((t) => t.text);
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "marktan-todos",
  };
}

async function readStore(ghToken) {
  const res = await fetch(`${GH}/repos/${REPO}/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders(ghToken), cache: "no-store" });
  if (res.status === 404) return { todos: [], sha: null };
  if (!res.ok) throw new Error(`GitHub read ${res.status}`);
  const j = await res.json();
  try {
    const todos = decrypt(JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8")));
    return { todos: Array.isArray(todos) ? todos : [], sha: j.sha || null };
  } catch (_) {
    return { todos: [], sha: j.sha || null }; // undecryptable — treat as empty
  }
}

async function writeStore(ghToken, todos, sha) {
  const body = {
    message: `todos: update (${todos.length} item${todos.length === 1 ? "" : "s"})`,
    content: Buffer.from(JSON.stringify(encrypt(todos), null, 1) + "\n", "utf8").toString("base64"),
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
  return j.content && j.content.sha ? j.content.sha : null;
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
        for (let attempt = 0; ; attempt++) {
          const { todos, sha } = await readStore(ghToken);
          todos.push({ text, ts: Date.now() });
          try {
            const newSha = await writeStore(ghToken, sanitize(todos), sha);
            res.status(200).json({ ok: true, count: todos.length, sha: newSha });
            return;
          } catch (e) {
            if (e && e.conflict && attempt < 1) continue; // raced another write — reread once
            throw e;
          }
        }
      }

      const todos = sanitize(body.todos);
      const sha = await writeStore(ghToken, todos, body.sha || null);
      res.status(200).json({ sha, count: todos.length });
    } else {
      const { todos, sha } = await readStore(ghToken);
      res.status(200).json({ todos, sha });
    }
  } catch (err) {
    if (err && err.conflict) { res.status(409).json({ error: "conflict — reload, the list changed" }); return; }
    res.status(502).json({ error: String(err && err.message || err).slice(0, 200) });
  }
}
