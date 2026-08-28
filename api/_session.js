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

// The one owner. Session payloads either equal this (full owner session)
// or carry a scope prefix (limited tokens — see SPECIALS_SCOPE).
export const OWNER_EMAIL = "markh.tan@gmail.com";

// The LIMITED token that rides in the .marktan.ai cookie so sibling
// subdomains (dailymag's specials) can verify the owner. Deliberately a
// different payload from the full session: an XSS on any subdomain that
// steals the cookie gets specials access only — never admin, the private
// calendar, to-dos, or net worth. Those accept isOwner() exclusively.
export const SPECIALS_SCOPE = "specials:" + OWNER_EMAIL;

// True only for a valid FULL owner session — the localStorage token minted
// by Google Sign-In. Every private API must use this (never truthiness of
// checkSession, which would also accept scoped tokens).
export function isOwner(token, key) {
  return !!key && checkSession(token, key) === OWNER_EMAIL;
}

// True for the limited specials cookie token.
export function isSpecialsScope(token, key) {
  return !!key && checkSession(token, key) === SPECIALS_SCOPE;
}

// Credential extraction: Authorization: Bearer <token> preferred (stays out
// of request logs); ?token= kept as a fallback for shortcuts and old links.
export function reqToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers && req.headers.authorization || ""));
  if (m) return m[1].trim();
  try { return new URL(req.url, "http://x").searchParams.get("token"); } catch (_) { return null; }
}

// Returns the payload inside a valid, unexpired session token; null otherwise.
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
