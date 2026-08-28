// api/transcribe.js
// Voice → text for the to-do page's hold-to-record button. The browser
// records a short clip (MediaRecorder) and POSTs it here; we run it through
// ElevenLabs Speech-to-Text (Scribe) — the same ELEVENLABS_API_KEY the
// balances tile already uses — and return the transcript. The caller then
// adds it to the list via /api/todos.
//
//   POST { audio: <base64>, mime: "audio/webm" } → { text }
//
// Auth: owner session or admin secret. Clips are capped ~3 MB (a voice memo
// is far smaller; Vercel bodies cap at ~4.5 MB).

import { sessionKey, checkSession } from "./_session.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const secret = (process.env.ADMIN_SECRET || process.env.DASHBOARD_SECRET || "").trim();
  if (!secret) { res.status(503).json({ error: "set ADMIN_SECRET (or DASHBOARD_SECRET)" }); return; }
  let token = null;
  try { token = new URL(req.url, "http://x").searchParams.get("token"); } catch (_) {}
  const skey = sessionKey();
  if (token !== secret && !(skey && checkSession(token, skey))) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const apiKey = (process.env.ELEVENLABS_API_KEY || "").trim();
  if (!apiKey) { res.status(503).json({ error: "ELEVENLABS_API_KEY not set" }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  let body = {};
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch (_) {}
  const b64 = String(body.audio || "");
  const mime = /^audio\/[\w.+-]+$/.test(String(body.mime)) ? String(body.mime) : "audio/webm";
  if (!b64) { res.status(400).json({ error: "no audio" }); return; }
  if (b64.length > 4_200_000) { res.status(413).json({ error: "clip too long" }); return; }

  let audio;
  try { audio = Buffer.from(b64, "base64"); } catch (_) { res.status(400).json({ error: "bad audio" }); return; }

  try {
    const form = new FormData();
    form.append("model_id", "scribe_v1");
    form.append("file", new Blob([audio], { type: mime }), "note." + (mime.split("/")[1] || "webm").replace(/[^\w]/g, ""));
    const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      res.status(502).json({ error: `ElevenLabs ${r.status}: ${detail.slice(0, 160)}` });
      return;
    }
    const j = await r.json();
    const text = String(j.text || "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (!text) { res.status(422).json({ error: "no speech detected" }); return; }
    res.status(200).json({ text });
  } catch (err) {
    res.status(502).json({ error: String(err && err.message || err).slice(0, 200) });
  }
}
