// api/brooks-img.js
// Image proxy for the owner's Brooks Review reader (/brooks): story
// images render through marktan.ai so nothing on the page points
// off-site. Owner session only (the token rides the query string
// because <img> can't send headers), source locked to the site's own
// uploads, nothing stored — fetched on view, cached by the browser.

import { sessionKey, isOwner, reqToken } from "./_session.js";

const ALLOWED = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" &&
      (url.hostname === "brooksreview.net" || url.hostname.endsWith(".brooksreview.net") ||
       (/^i[0-2]\.wp\.com$/.test(url.hostname) && url.pathname.startsWith("/brooksreview.net/")));
  } catch (_) { return false; }
};

export default async function handler(req, res) {
  if (!isOwner(reqToken(req), sessionKey())) {
    res.status(401).end();
    return;
  }
  let src = null;
  try { src = new URL(req.url, "http://x").searchParams.get("src"); } catch (_) {}
  if (!src || !ALLOWED(src)) { res.status(400).json({ error: "bad src" }); return; }

  try {
    const r = await fetch(src, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; marktan-reader/1.0)", Referer: "https://brooksreview.net/" },
    });
    if (!r.ok) { res.status(502).json({ error: `upstream ${r.status}` }); return; }
    const type = r.headers.get("content-type") || "application/octet-stream";
    if (!/^image\//.test(type)) { res.status(502).json({ error: "not an image" }); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "private, max-age=604800"); // a week, per-browser
    res.status(200).end(buf);
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e).slice(0, 120) });
  }
}
