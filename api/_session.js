// api/_session.js
// Owner session tokens: after Google Sign-In verifies the owner, we mint a
// long-lived HMAC-signed session so the page stays logged in after the
// short-lived Google ID token expires. Format: base64url(email).exp.sig
// Key is derived from SESSION_SECRET (or ADMIN_SECRET / DASHBOARD_SECRET).

import crypto from "node:crypto";

const SESSION_DAYS = 90;

export function sessionKey() {
  const s = (process.env.SESSION_SECRET || process.env.ADMIN_SECRET || process.env.DASHBOARD_SECRET || "").trim();
  return s ? crypto.createHash("sha256").update("owner-session:" + s).digest() : null;
}

const sign = (payload, key) => crypto.createHmac("sha256", key).update(payload).digest("base64url");

export function mintSession(email, key) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const payload = `${Buffer.from(email).toString("base64url")}.${exp}`;
  return `${payload}.${sign(payload, key)}`;
}

// Returns the email inside a valid, unexpired session token; null otherwise.
export function checkSession(token, key) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const want = Buffer.from(sign(payload, key));
  const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  if (!/^\d+$/.test(parts[1]) || Number(parts[1]) < Date.now()) return null;
  try { return Buffer.from(parts[0], "base64url").toString(); } catch (_) { return null; }
}
