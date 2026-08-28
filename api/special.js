// api/special.js
// Serves MERIDIAN's owner-only special editions. Specials live ENCRYPTED at
// rest in the public dailymag repo (special-NN-5.html.enc / .pdf.enc —
// X25519 sealed box, produced by dailymag's tools/encrypt_special.mjs); this
// endpoint fetches the blob from raw.githubusercontent, decrypts it with the
// private key, and serves it — but only to the owner.
//
//   GET /api/special?file=special-85-5.html   (or .pdf)
//
// Auth: the mt_owner cookie (Domain=.marktan.ai — set by this site's Google
// login, so it rides along automatically) or ?token=<session>. Anything
// short of a valid owner session gets a plain 404 "Not found", never a 401 —
// to everyone else the specials do not exist. Fail closed.
//
// Env: MERIDIAN_SPECIALS_KEY — base64 PKCS8 DER X25519 private key. The
// matching public key is committed in dailymag (state/specials-pubkey.b64).

import crypto from "node:crypto";
import { sessionKey, isOwner, isSpecialsScope, reqToken } from "./_session.js";

const RAW = "https://raw.githubusercontent.com/markt1600/dailymag/main/";
// Vercel serverless responses cap out around 4.5 MB — bigger PDFs can't be
// served here (they still reach the reMarkable via deliver-special.yml).
const MAX_SERVE = 4_400_000;

function open(blob, privKey) {
  if (blob.length < 65 || blob.subarray(0, 4).toString() !== "MSE1") throw new Error("bad blob");
  const epk = blob.subarray(4, 36), iv = blob.subarray(36, 48), tag = blob.subarray(48, 64), ct = blob.subarray(64);
  const pub = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), epk]),
    type: "spki", format: "der",
  });
  const shared = crypto.diffieHellman({ privateKey: privKey, publicKey: pub });
  const key = crypto.hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.concat([Buffer.from("meridian-special-v1"), epk]), 32);
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

function cookieToken(req) {
  const m = /(?:^|;\s*)mt_owner=([^;]+)/.exec(String(req.headers.cookie || ""));
  return m ? decodeURIComponent(m[1]) : null;
}

function notFound(res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(404).send("<!doctype html><title>Not found</title><p style=\"font-family:system-ui,sans-serif;padding:48px 24px;color:#333\">Not found.</p>");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  let file = null;
  try { file = new URL(req.url, "http://x").searchParams.get("file"); } catch (_) {}

  // Everything below fails as a plain 404 — an unauthenticated probe learns
  // nothing, not even whether the file exists.
  if (!file || !/^special-\d+-\d+\.(html|pdf)$/.test(file)) { notFound(res); return; }
  // Accepted credentials: the FULL owner session, or the LIMITED
  // specials-scope token that rides in the .marktan.ai cookie. This is the
  // only private endpoint the scoped token unlocks.
  const skey = sessionKey();
  const cred = reqToken(req) || cookieToken(req);
  if (!cred || !(isOwner(cred, skey) || isSpecialsScope(cred, skey))) { notFound(res); return; }

  const keyB64 = (process.env.MERIDIAN_SPECIALS_KEY || "").trim();
  if (!keyB64) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(503).send("MERIDIAN_SPECIALS_KEY is not set in Vercel — cannot decrypt specials.");
    return;
  }

  try {
    const priv = crypto.createPrivateKey({ key: Buffer.from(keyB64, "base64"), type: "pkcs8", format: "der" });
    const r = await fetch(RAW + file + ".enc");
    if (!r.ok) { notFound(res); return; }
    const plain = open(Buffer.from(await r.arrayBuffer()), priv);
    if (file.endsWith(".pdf")) {
      if (plain.length > MAX_SERVE) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.status(200).send(`<!doctype html><title>On your reMarkable</title><p style="font-family:system-ui,sans-serif;padding:48px 24px;color:#333">This special's PDF (${(plain.length / 1e6).toFixed(1)} MB) is too large to serve over the web — it was delivered to your reMarkable automatically. The web edition is <a href="/api/special?file=${file.replace(/\.pdf$/, ".html")}">here</a>.</p>`);
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${file}"`);
      res.status(200).send(plain);
    } else {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(plain);
    }
  } catch (_) {
    notFound(res); // wrong key, corrupt blob, upstream failure — all identical
  }
}
