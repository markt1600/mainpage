// api/_birthstore.js
// Encrypted birthdays store (data/birthdays.enc.json) — birthdays are
// personal info, so like the private calendar / to-dos / net worth they
// live AES-256-GCM encrypted in the public repo, owner-only on the site.
//
// One-time migration: the list used to be committed in PLAINTEXT as
// data/birthdays.json. On the first read after this deploys, that legacy
// file's contents are encrypted into the new store and the plaintext
// file is deleted from the repo. (Older revisions remain in git history
// until history is purged.)
//
// Used by api/admin.js (the editor), api/private-events.js (the
// dashboard's owner section), and api/notify.js (the push digest).
// Env: GITHUB_TOKEN; key from PRIVATE_STORE_KEY → PUSH_STORE_KEY →
// VAPID_PRIVATE_KEY.

import crypto from "node:crypto";

const REPO = (process.env.GITHUB_REPO || "markt1600/mainpage").trim();
const BRANCH = (process.env.GITHUB_BRANCH || "main").trim();
const ENC_PATH = "data/birthdays.enc.json";
const LEGACY_PATH = "data/birthdays.json";
const GH = "https://api.github.com";

function encKey() {
  const secret = (process.env.PRIVATE_STORE_KEY || process.env.PUSH_STORE_KEY || process.env.VAPID_PRIVATE_KEY || "").trim();
  if (!secret) throw new Error("no PRIVATE_STORE_KEY / PUSH_STORE_KEY / VAPID_PRIVATE_KEY set");
  return crypto.createHash("sha256").update("birthdays:" + secret).digest();
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

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "marktan-birthdays",
  };
}

export async function writeBirthdays(ghToken, list, sha, message) {
  const body = {
    message: message || `birthdays: update (${list.length} entries)`,
    content: Buffer.from(JSON.stringify(encrypt(list), null, 1) + "\n", "utf8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH}/repos/${REPO}/contents/${ENC_PATH}`, {
    method: "PUT",
    headers: { ...ghHeaders(ghToken), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 409) { const err = new Error("conflict"); err.conflict = true; throw err; }
  if (!res.ok) throw new Error(`GitHub write ${res.status}`);
  const j = await res.json();
  return j.content && j.content.sha ? j.content.sha : null;
}

export async function readBirthdays(ghToken) {
  const res = await fetch(`${GH}/repos/${REPO}/contents/${ENC_PATH}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders(ghToken), cache: "no-store" });
  if (res.ok) {
    const j = await res.json();
    try {
      const list = decrypt(JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8")));
      return { list: Array.isArray(list) ? list : [], sha: j.sha || null };
    } catch (_) {
      return { list: [], sha: j.sha || null }; // undecryptable — treat as empty
    }
  }
  if (res.status !== 404) throw new Error(`GitHub read ${res.status}`);

  // No encrypted store yet — migrate the legacy plaintext file if present.
  const leg = await fetch(`${GH}/repos/${REPO}/contents/${LEGACY_PATH}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders(ghToken), cache: "no-store" });
  if (!leg.ok) return { list: [], sha: null };
  const lj = await leg.json();
  let list = [];
  try { list = JSON.parse(Buffer.from(lj.content || "", "base64").toString("utf8")); } catch (_) {}
  if (!Array.isArray(list)) list = [];
  let sha = null;
  try {
    sha = await writeBirthdays(ghToken, list, null, "birthdays: migrate to encrypted store");
    await fetch(`${GH}/repos/${REPO}/contents/${LEGACY_PATH}`, {
      method: "DELETE",
      headers: { ...ghHeaders(ghToken), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "birthdays: remove plaintext file (now encrypted)", sha: lj.sha, branch: BRANCH }),
    });
  } catch (_) {
    // a concurrent request migrated first, or the write failed — either
    // way the data is still readable; the next read sorts itself out
  }
  return { list, sha };
}
