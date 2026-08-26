// api/private-events.js
// The PRIVATE calendar list — travel plans, personal items — shown only
// inside the For Mark section's calendar, never in the public events
// watchlist. This repo is public, so the committed file
// data/private-events.enc.json is AES-256-GCM ciphertext (same pattern as
// the push-subscription store): without the server-side key the file is
// unreadable even though it's in the open repo.
//
//   GET  ?token=  → { events: [...], sha }
//   POST { events, sha } → sanitize, encrypt, commit; → { sha, count }
//     (a stale sha returns 409 so concurrent edits don't clobber)
//
// Auth: admin secret or a valid owner login session (like /api/admin).
// Env: GITHUB_TOKEN; key from PRIVATE_STORE_KEY → PUSH_STORE_KEY →
// VAPID_PRIVATE_KEY.

import crypto from "node:crypto";
import { sessionKey, checkSession } from "./_session.js";

const REPO = (process.env.GITHUB_REPO || "markt1600/mainpage").trim();
const BRANCH = (process.env.GITHUB_BRANCH || "main").trim();
const PATH = "data/private-events.enc.json";
const GH = "https://api.github.com";

function encKey() {
  const secret = (process.env.PRIVATE_STORE_KEY || process.env.PUSH_STORE_KEY || process.env.VAPID_PRIVATE_KEY || "").trim();
  if (!secret) throw new Error("no PRIVATE_STORE_KEY / PUSH_STORE_KEY / VAPID_PRIVATE_KEY set");
  return crypto.createHash("sha256").update("private-events:" + secret).digest();
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

const str = (v, max = 300) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v, 10)) ? str(v, 10) : null);
const hhmm = (v) => (/^\d{1,2}:\d{2}$/.test(str(v, 5)) ? str(v, 5) : null);

function sanitize(data) {
  if (!Array.isArray(data)) throw new Error("expected an array");
  if (data.length > 500) throw new Error("too many entries");
  return data
    .map((e) => ({
      act: str(e && e.act, 120),
      kind: str(e && e.kind, 40) || "Personal",
      date: isoDate(e && e.date),
      endDate: isoDate(e && e.endDate),
      time: hhmm(e && e.time),
      repeat: ["weekly", "monthly", "yearly"].includes(str(e && e.repeat, 10)) ? str(e && e.repeat, 10) : null,
      venue: str(e && e.venue, 120),
      status: str(e && e.status, 60),
      note: str(e && e.note, 300),
      url: /^https?:\/\//i.test(str(e && e.url, 500)) ? str(e && e.url, 500) : "",
    }))
    .filter((e) => e.act && e.date);
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "marktan-private-cal",
  };
}

async function readStore(ghToken) {
  const res = await fetch(`${GH}/repos/${REPO}/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders(ghToken) });
  if (res.status === 404) return { events: [], sha: null };
  if (!res.ok) throw new Error(`GitHub read ${res.status}`);
  const j = await res.json();
  try {
    const events = decrypt(JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8")));
    return { events: Array.isArray(events) ? events : [], sha: j.sha || null };
  } catch (_) {
    return { events: [], sha: j.sha || null }; // undecryptable (key rotated?) — treat as empty
  }
}

async function writeStore(ghToken, events, sha) {
  const body = {
    message: `private calendar: update (${events.length} entr${events.length === 1 ? "y" : "ies"})`,
    content: Buffer.from(JSON.stringify(encrypt(events), null, 1) + "\n", "utf8").toString("base64"),
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
  let token = null;
  try { token = new URL(req.url, "http://x").searchParams.get("token"); } catch (_) {}
  const skey = sessionKey();
  if (token !== secret && !(skey && checkSession(token, skey))) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  if (!ghToken) { res.status(503).json({ error: "GITHUB_TOKEN not set" }); return; }

  try {
    if (req.method === "POST") {
      let body = {};
      try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch (_) {}
      const events = sanitize(body.events);
      const sha = await writeStore(ghToken, events, body.sha || null);
      res.status(200).json({ sha, count: events.length });
    } else {
      const { events, sha } = await readStore(ghToken);
      res.status(200).json({ events, sha });
    }
  } catch (err) {
    if (err && err.conflict) { res.status(409).json({ error: "conflict — reload, the list changed" }); return; }
    res.status(502).json({ error: String(err && err.message || err).slice(0, 200) });
  }
}
