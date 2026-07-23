// api/feedback.js
// Reader feedback for MERIDIAN (dailymag.marktan.ai): subtle 👍/👎 on each
// desk's lead article, plus free-text "notes to the editor."
//
// Why it lives HERE: the magazine's build sandbox can only read
// raw.githubusercontent.com — so votes are committed into THIS repo
// (data/meridian-feedback.json) with the GITHUB_TOKEN this project already
// has, and the 6AM build session reads them via the raw URL and adjusts the
// next edition's story selection.
//
// Open by design (zero-friction voting on a personal site): no secret, but
// hard caps — payload size, text length, entry counts — and CORS locked to
// the two marktan.ai origins. POST bodies arrive as text/plain to stay a
// "simple" CORS request (no preflight); the body is JSON regardless.

const REPO = (process.env.GITHUB_REPO || "markt1600/mainpage").trim();
const BRANCH = (process.env.GITHUB_BRANCH || "main").trim();
const PATH = "data/meridian-feedback.json";
const GH = "https://api.github.com";
const ORIGINS = ["https://dailymag.marktan.ai", "https://marktan.ai", "https://www.marktan.ai"];
const MAX_VOTES = 400, MAX_NOTES = 100;

const str = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);

function gh(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
           "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "marktan-feedback" };
}

async function readFile(token) {
  const r = await fetch(`${GH}/repos/${REPO}/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}`, { headers: gh(token) });
  if (r.status === 404) return { data: { votes: [], notes: [] }, sha: null };
  if (!r.ok) throw new Error(`read ${r.status}`);
  const j = await r.json();
  let d;
  try { d = JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8")); } catch (_) { d = {}; }
  return { data: { votes: d.votes || [], notes: d.notes || [] }, sha: j.sha || null };
}

async function writeFile(token, data, sha, message) {
  const body = { message, branch: BRANCH,
    content: Buffer.from(JSON.stringify(data, null, 1) + "\n", "utf8").toString("base64") };
  if (sha) body.sha = sha;
  const r = await fetch(`${GH}/repos/${REPO}/contents/${PATH}`, {
    method: "PUT", headers: { ...gh(token), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`write ${r.status}`);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").slice(0, 4000);
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

export default async function handler(req, res) {
  const origin = String(req.headers.origin || "");
  res.setHeader("Access-Control-Allow-Origin", ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const token = (process.env.GITHUB_TOKEN || "").trim();
  if (!token) { res.status(503).json({ error: "GITHUB_TOKEN not set" }); return; }

  try {
    if (req.method === "GET") {
      const { data } = await readFile(token);
      res.status(200).json({ votes: data.votes.slice(-50), notes: data.notes.slice(-20) });
      return;
    }
    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

    const b = await readBody(req);
    const entry = { ts: new Date().toISOString(), issue: str(b.issue, 6) };
    let kind;
    if (b.type === "vote" && (b.vote === 1 || b.vote === -1)) {
      kind = "votes";
      Object.assign(entry, { desk: str(b.desk, 40), topic: str(b.topic, 120), vote: b.vote });
      if (!entry.desk) { res.status(400).json({ error: "missing desk" }); return; }
    } else if (b.type === "note" && str(b.text, 1000)) {
      kind = "notes";
      entry.text = str(b.text, 1000);
    } else { res.status(400).json({ error: "bad payload" }); return; }

    // read-modify-write with one retry on sha races
    for (let attempt = 0; ; attempt++) {
      const { data, sha } = await readFile(token);
      data[kind].push(entry);
      data.votes = data.votes.slice(-MAX_VOTES);
      data.notes = data.notes.slice(-MAX_NOTES);
      try {
        await writeFile(token, data, sha, `meridian feedback: ${kind === "votes" ? `${entry.vote > 0 ? "👍" : "👎"} ${entry.desk}` : "editor note"} (No. ${entry.issue || "?"})`);
        res.status(200).json({ ok: true });
        return;
      } catch (e) {
        if (attempt === 0 && /409|422/.test(String(e.message))) continue;
        throw e;
      }
    }
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
