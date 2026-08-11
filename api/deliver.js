// api/deliver.js
// On-demand reMarkable delivery for MERIDIAN (dailymag.marktan.ai).
//
// The magazine's editions used to auto-upload to the reMarkable cloud on
// every publish; the tablet got cluttered. Now the reader asks: the
// "⇥ reMarkable" menu item in the magazine chrome POSTs here, and this
// endpoint fires the corresponding workflow_dispatch in the dailymag repo
// (deliver-remarkable.yml for the daily, deliver-special.yml for the
// newest special). The workflows hold the pairing secret; this endpoint
// only presses their button.
//
// Open by design, same as api/feedback.js (zero-friction on a personal
// site): no secret, CORS locked to the marktan.ai origins, and the worst
// an abuser can do is deliver the owner's own magazine to the owner's own
// tablet (the workflows are idempotent — an already-delivered issue is
// skipped, and the daily prunes to the 7 newest).

const REPO = (process.env.MERIDIAN_REPO || "markt1600/dailymag").trim();
const BRANCH = (process.env.MERIDIAN_BRANCH || "main").trim();
const GH = "https://api.github.com";
const ORIGINS = ["https://dailymag.marktan.ai", "https://marktan.ai", "https://www.marktan.ai"];
const WORKFLOWS = { edition: "deliver-remarkable.yml", special: "deliver-special.yml" };

async function readBody(req) {
  // Vercel pre-parses text/plain bodies (sent to stay preflight-free) into
  // req.body and consumes the stream — check req.body first (see feedback.js).
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body.slice(0, 1000)); } catch (_) { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").slice(0, 1000);
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

export default async function handler(req, res) {
  const origin = String(req.headers.origin || "");
  res.setHeader("Access-Control-Allow-Origin", ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

  const token = (process.env.GITHUB_TOKEN || "").trim();
  if (!token) { res.status(503).json({ error: "GITHUB_TOKEN not set" }); return; }

  const b = await readBody(req);
  const wf = WORKFLOWS[b.type === "special" ? "special" : "edition"];

  try {
    const r = await fetch(`${GH}/repos/${REPO}/actions/workflows/${wf}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "marktan-deliver",
                 "Content-Type": "application/json" },
      body: JSON.stringify({ ref: BRANCH }),
    });
    if (r.status === 204) { res.status(200).json({ ok: true, workflow: wf }); return; }
    const detail = await r.text().catch(() => "");
    res.status(502).json({ error: `dispatch ${r.status}`, detail: detail.slice(0, 300) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
