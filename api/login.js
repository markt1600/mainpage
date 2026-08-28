// api/login.js
// Owner login via Google Sign-In.
//
//   GET                → { clientId } so the page can initialise Google
//                        Identity Services (null until GOOGLE_CLIENT_ID is set)
//   POST {credential}  → verify a Google ID token (signature/expiry via
//                        Google's tokeninfo endpoint, audience must match our
//                        client ID, email must be the verified owner email);
//                        on success mints a 90-day HMAC session token
//   POST {session}     → validate a previously minted session token
//
// Only markh.tan@gmail.com ever gets a session; any other Google account
// receives 403. Env vars: GOOGLE_CLIENT_ID, and one of SESSION_SECRET /
// ADMIN_SECRET / DASHBOARD_SECRET for the session HMAC key.

import { sessionKey, mintSession, checkSession, OWNER_EMAIL, SPECIALS_SCOPE } from "./_session.js";

async function verifyGoogleCredential(credential, clientId) {
  const res = await fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential)
  );
  if (!res.ok) return { error: 401 };
  const info = await res.json();
  const issOk = info.iss === "https://accounts.google.com" || info.iss === "accounts.google.com";
  const expOk = /^\d+$/.test(String(info.exp)) && Number(info.exp) * 1000 > Date.now();
  if (!issOk || !expOk || info.aud !== clientId) return { error: 401 };
  if (String(info.email_verified) !== "true" || String(info.email).toLowerCase() !== OWNER_EMAIL) {
    return { error: 403 };
  }
  return { email: OWNER_EMAIL };
}

// Sibling sites that may verify a session cross-origin (MERIDIAN's special
// editions check the shared .marktan.ai cookie against this endpoint).
const CORS_ORIGINS = new Set([
  "https://marktan.ai",
  "https://www.marktan.ai",
  "https://dailymag.marktan.ai",
]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const origin = String(req.headers.origin || "");
  if (CORS_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim() || null;

  if (req.method !== "POST") {
    res.status(200).json({ clientId });
    return;
  }

  const key = sessionKey();
  if (!clientId || !key) { res.status(503).json({ error: "login not configured" }); return; }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch (_) {}

  if (body.session) {
    const payload = checkSession(body.session, key);
    if (payload === OWNER_EMAIL) {
      // A full session also gets a fresh LIMITED token for the .marktan.ai
      // cookie (specials access only — see _session.js).
      res.status(200).json({ ok: true, user: OWNER_EMAIL, specialsToken: mintSession(SPECIALS_SCOPE, key) });
    } else if (payload === SPECIALS_SCOPE) {
      // The scoped cookie token verifies as "owner is here" (dailymag's
      // dropdown check) but never upgrades to anything more.
      res.status(200).json({ ok: true, user: OWNER_EMAIL });
    } else {
      res.status(401).json({ error: "unauthorized" });
    }
    return;
  }

  if (body.credential) {
    try {
      const v = await verifyGoogleCredential(body.credential, clientId);
      if (v.email) {
        res.status(200).json({ ok: true, user: v.email, session: mintSession(v.email, key), specialsToken: mintSession(SPECIALS_SCOPE, key) });
      } else {
        res.status(v.error).json({ error: v.error === 403 ? "not the owner" : "unauthorized" });
      }
    } catch (_) {
      res.status(502).json({ error: "could not reach Google" });
    }
    return;
  }

  res.status(400).json({ error: "missing credential or session" });
}
