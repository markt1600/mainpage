// api/push.js
// Web Push subscription management for The Daily.
//
//   GET  /api/push                 -> { publicKey }   (VAPID public key for the browser)
//   POST /api/push?token=<secret>  -> { action: "subscribe"|"unsubscribe", subscription }
//
// POST is gated by ADMIN_SECRET (or DASHBOARD_SECRET) — this is a personal
// digest (it names birthdays), so only the site owner gets to register a
// device. Subscriptions are stored encrypted in the repo; see _pushstore.js.
//
// Env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (npx web-push generate-vapid-keys),
//           GITHUB_TOKEN (already set for /admin), optional PUSH_STORE_KEY.

import { readSubs, writeSubs } from "./_pushstore.js";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { return {}; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const publicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();

  if (req.method === "GET") {
    if (!publicKey) { res.status(503).json({ error: "VAPID_PUBLIC_KEY not set" }); return; }
    res.status(200).json({ publicKey });
    return;
  }

  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

  const secret = (process.env.ADMIN_SECRET || process.env.DASHBOARD_SECRET || "").trim();
  if (!secret) { res.status(503).json({ error: "set ADMIN_SECRET to enable notifications" }); return; }
  let token = null;
  try { token = new URL(req.url, "http://x").searchParams.get("token"); } catch (_) {}
  if (token !== secret) { res.status(401).json({ error: "unauthorized" }); return; }

  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  if (!ghToken) { res.status(503).json({ error: "GITHUB_TOKEN not set" }); return; }

  const body = await readBody(req);
  const sub = body.subscription;
  const endpoint = sub && typeof sub.endpoint === "string" ? sub.endpoint : null;
  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    res.status(400).json({ error: "missing subscription.endpoint" });
    return;
  }

  // read-modify-write with one retry in case two devices race the sha
  for (let attempt = 0; ; attempt++) {
    const { subs, sha } = await readSubs(ghToken);
    let next;
    if (body.action === "unsubscribe") {
      next = subs.filter((s) => s.endpoint !== endpoint);
    } else {
      next = subs.filter((s) => s.endpoint !== endpoint);
      next.push({ ...sub, added: new Date().toISOString() });
      if (next.length > 20) next = next.slice(-20); // personal site; cap device list
    }
    try {
      await writeSubs(ghToken, next, sha, `push: ${body.action === "unsubscribe" ? "remove" : "add"} device (${next.length} total)`);
      res.status(200).json({ ok: true, devices: next.length });
      return;
    } catch (e) {
      if (attempt === 0 && /409|422/.test(String(e.message))) continue;
      res.status(500).json({ error: String(e.message || e) });
      return;
    }
  }
}
