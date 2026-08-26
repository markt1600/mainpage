// api/login.js
// Owner login for the dashboard. POST {token} (or GET ?token=) — if the
// token matches ADMIN_SECRET (or DASHBOARD_SECRET as fallback), returns the
// owner identity; otherwise 401. The page stores the entered password in
// localStorage and re-verifies here on every load, so owner-only content
// only ever renders after this endpoint confirms.

import crypto from "node:crypto";

const OWNER_EMAIL = "markh.tan@gmail.com";

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const secret = (process.env.ADMIN_SECRET || process.env.DASHBOARD_SECRET || "").trim();
  if (!secret) { res.status(503).json({ error: "no owner secret configured" }); return; }

  let token = null;
  try {
    const u = new URL(req.url, "http://x");
    token = u.searchParams.get("token");
  } catch (_) {}
  if (!token && req.method === "POST") {
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      token = body && body.token;
    } catch (_) {}
  }

  if (token && safeEqual(token, secret)) {
    res.status(200).json({ ok: true, user: OWNER_EMAIL });
  } else {
    res.status(401).json({ error: "unauthorized" });
  }
}
