// api/_todostore.js
// Shared access to the encrypted to-do store (data/todos.enc.json) —
// AES-256-GCM at rest in the public repo, unreadable without the
// server-side key. Used by api/todos.js (the list API) and
// api/notify.js (the daily cron adds statement-filing to-dos).
// Env: GITHUB_TOKEN; key from PRIVATE_STORE_KEY → PUSH_STORE_KEY →
// VAPID_PRIVATE_KEY.

import crypto from "node:crypto";

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

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "marktan-todos",
  };
}

export async function readTodos(ghToken) {
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

export async function writeTodos(ghToken, todos, sha) {
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

/* Append items (skipping any whose text already exists in the list),
   with one retry if a concurrent write races us. Returns the texts
   actually added. */
export async function appendTodos(ghToken, items) {
  for (let attempt = 0; ; attempt++) {
    const { todos, sha } = await readTodos(ghToken);
    const have = new Set(todos.map((t) => t && t.text));
    const adds = items.filter((it) => it.text && !have.has(it.text));
    if (!adds.length) return [];
    try {
      await writeTodos(ghToken, todos.concat(adds), sha);
      return adds.map((it) => it.text);
    } catch (e) {
      if (e && e.conflict && attempt < 1) continue;
      throw e;
    }
  }
}
