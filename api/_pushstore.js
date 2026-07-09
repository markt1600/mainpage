// api/_pushstore.js  (underscore = helper module, not a deployed endpoint)
//
// Push-subscription storage. Same GitHub-committed-JSON pattern as /admin,
// with one twist: the repo is PUBLIC, and push endpoints are private
// capability URLs — so the committed file is AES-256-GCM ciphertext, not
// plaintext. The key never leaves the serverless env (derived from
// PUSH_STORE_KEY, falling back to VAPID_PRIVATE_KEY, which is set anyway).
// Without the private key an endpoint can't be pushed to, and without the
// store key it can't even be read — belt and braces.

import crypto from "node:crypto";

const REPO = (process.env.GITHUB_REPO || "markt1600/mainpage").trim();
const BRANCH = (process.env.GITHUB_BRANCH || "main").trim();
const PATH = "data/push-subs.enc.json";
const GH = "https://api.github.com";

function key() {
  const secret = (process.env.PUSH_STORE_KEY || process.env.VAPID_PRIVATE_KEY || "").trim();
  if (!secret) throw new Error("no PUSH_STORE_KEY / VAPID_PRIVATE_KEY set");
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function decrypt(blob) {
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(blob.iv, "base64"));
  d.setAuthTag(Buffer.from(blob.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.ct, "base64")), d.final()]).toString("utf8"));
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "marktan-push",
  };
}

// -> { subs: [...], sha } ; missing file (first run) -> { subs: [], sha: null }
export async function readSubs(token) {
  const res = await fetch(`${GH}/repos/${REPO}/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}`, {
    headers: ghHeaders(token),
  });
  if (res.status === 404) return { subs: [], sha: null };
  if (!res.ok) throw new Error(`GitHub read ${res.status}`);
  const j = await res.json();
  try {
    const blob = JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8"));
    const subs = decrypt(blob);
    return { subs: Array.isArray(subs) ? subs : [], sha: j.sha || null };
  } catch (_) {
    // undecryptable (key rotated?) — treat as empty rather than bricking subscribe
    return { subs: [], sha: j.sha || null };
  }
}

export async function writeSubs(token, subs, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(encrypt(subs), null, 1) + "\n", "utf8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH}/repos/${REPO}/contents/${PATH}`, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub write ${res.status}`);
}
