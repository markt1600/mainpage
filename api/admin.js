// api/admin.js
// Backend for the /admin page: read + edit the Birthdays and Events lists.
//
// Storage is GitHub-committed JSON — each save is a commit to
//   data/birthdays.json / data/events.json  on markt1600/mainpage,
// which is both the version history and (after Vercel redeploys) the file
// the live dashboard fetches. There is no database.
//
// Auth: every request must carry the shared secret as ?token=<secret>
//   (ADMIN_SECRET, or DASHBOARD_SECRET if ADMIN_SECRET isn't set). Without
//   either secret configured the endpoint refuses to run at all, so the
//   editor is never accidentally left open.
//
// Env vars (Vercel -> Settings -> Environment Variables):
//   GITHUB_TOKEN   - fine-grained PAT with Contents: Read & Write on
//                    markt1600/mainpage. Server-only; never sent to browser.
//   ADMIN_SECRET   - password for /admin (falls back to DASHBOARD_SECRET).
//   GITHUB_REPO    - optional; "owner/repo", defaults to markt1600/mainpage.
//   GITHUB_BRANCH  - optional; defaults to "main".

const REPO = (process.env.GITHUB_REPO || "markt1600/mainpage").trim();
const BRANCH = (process.env.GITHUB_BRANCH || "main").trim();
const GH = "https://api.github.com";

const FILES = {
  events: "data/events.json",
  birthdays: "data/birthdays.json",
};

function str(v, max = 300) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
}
// "YYYY-MM-DD" or null
function isoDate(v) {
  const s = str(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function intIn(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}
function httpUrl(v) {
  const s = str(v, 500);
  return /^https?:\/\//i.test(s) ? s : "";
}

// Normalise incoming lists to exactly the shape the frontend expects, dropping
// anything malformed. Never trust the client blindly — this is committed code.
function sanitize(kind, data) {
  if (!Array.isArray(data)) throw new Error("expected an array");
  if (data.length > 500) throw new Error("too many entries");
  if (kind === "birthdays") {
    return data
      .map((b) => ({
        name: str(b && b.name, 80),
        month: intIn(b && b.month, 1, 12),
        day: intIn(b && b.day, 1, 31),
      }))
      .filter((b) => b.name && b.month && b.day);
  }
  if (kind === "events") {
    return data
      .map((e) => ({
        act: str(e && e.act, 120),
        kind: str(e && e.kind, 40),
        date: isoDate(e && e.date),
        endDate: isoDate(e && e.endDate),
        venue: str(e && e.venue, 120),
        status: str(e && e.status, 60),
        note: str(e && e.note, 200),
        url: httpUrl(e && e.url),
      }))
      .filter((e) => e.act);
  }
  throw new Error("unknown list");
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "marktan-admin",
  };
}

// Fetch a data file's parsed contents + blob sha (sha is needed to commit an
// update). A missing file (first-ever save) resolves to { data: [], sha: null }.
async function readFile(token, path) {
  const url = `${GH}/repos/${REPO}/contents/${path}?ref=${encodeURIComponent(BRANCH)}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (res.status === 404) return { data: [], sha: null };
  if (!res.ok) throw new Error(`GitHub read ${res.status}`);
  const j = await res.json();
  let data = [];
  try {
    data = JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8"));
  } catch (_) {
    data = [];
  }
  return { data: Array.isArray(data) ? data : [], sha: j.sha || null };
}

// Commit a new version of a data file. Passing the current sha guards against
// clobbering a concurrent edit (GitHub 409s on a stale sha).
async function writeFile(token, path, list, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(list, null, 2) + "\n", "utf8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH}/repos/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GitHub write ${res.status}${txt ? ": " + txt.slice(0, 200) : ""}`);
  }
  const j = await res.json();
  return j.content && j.content.sha ? j.content.sha : null;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { return {}; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const secret = (process.env.ADMIN_SECRET || process.env.DASHBOARD_SECRET || "").trim();
  if (!secret) {
    res.status(503).json({ error: "admin disabled: set ADMIN_SECRET (or DASHBOARD_SECRET) in Vercel" });
    return;
  }
  let token = null;
  try {
    const u = new URL(req.url, "http://x");
    token = u.searchParams.get("token") || u.searchParams.get("me");
  } catch (_) {}
  if (token !== secret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  if (!ghToken) {
    res.status(503).json({ error: "GITHUB_TOKEN not set — cannot read or commit data files" });
    return;
  }

  try {
    if (req.method === "GET") {
      const [events, birthdays] = await Promise.all([
        readFile(ghToken, FILES.events),
        readFile(ghToken, FILES.birthdays),
      ]);
      res.status(200).json({
        repo: REPO,
        branch: BRANCH,
        events: { list: sanitize("events", events.data), sha: events.sha },
        birthdays: { list: sanitize("birthdays", birthdays.data), sha: birthdays.sha },
      });
      return;
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const kind = body && body.type;
      if (!FILES[kind]) {
        res.status(400).json({ error: "type must be 'events' or 'birthdays'" });
        return;
      }
      const list = sanitize(kind, body.data);
      const sha = await writeFile(
        ghToken,
        FILES[kind],
        list,
        body.sha || null,
        `admin: update ${kind} (${list.length} entries)`
      );
      res.status(200).json({ ok: true, type: kind, count: list.length, sha });
      return;
    }

    res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    const msg = String(e && e.message || e);
    const code = /409/.test(msg) ? 409 : 500;
    res.status(code).json({ error: msg });
  }
}
