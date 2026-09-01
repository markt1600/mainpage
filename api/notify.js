// api/notify.js
// The 07:20 SGT push digest (cron in vercel.json, five minutes after the
// dashboard cache warms). Composes one notification from data the site
// already publishes and sends it to every registered device:
//
//   · MERIDIAN pipeline: built (with issue/time/duration/pages) or MISSING
//   · the Happy Day counter
//   · birthdays today / tomorrow / a week out
//   · watchlist events starting today or tomorrow
//
// Statements are no longer a digest line: on each statement's landing
// day this cron drops a "File … statement" item straight into the
// encrypted to-do list instead (deduped by text, so re-runs are safe).
//
// Delivery uses the `tag` field, so a re-run replaces the notification
// instead of stacking a duplicate.
//
// Auth: Vercel cron sends "Authorization: Bearer $CRON_SECRET" automatically
// when that env var exists — set it and manual hits are rejected unless they
// carry ?token=<ADMIN_SECRET>. ?dry=1 (with token) returns the composed
// digest without sending, for testing.
//
// Env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, GITHUB_TOKEN,
//           optional CRON_SECRET, PUSH_STORE_KEY.

import webpush from "web-push";
import { readSubs, writeSubs } from "./_pushstore.js";
import { appendTodos } from "./_todostore.js";

const SITE = "https://marktan.ai";
const MERIDIAN_STATUS = "https://raw.githubusercontent.com/markt1600/dailymag/main/status.json";
const TZ = "Asia/Singapore";

const jfetch = async (url) => {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
};

function sgToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()); // YYYY-MM-DD
}
// "19:30" → "7.30pm" (or "8pm" on the hour); null for anything unparseable
function fmtEventTime(t) {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let h = Number(m[1]); const min = m[2];
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return min === "00" ? `${h}${ap}` : `${h}.${min}${ap}`;
}
// whole days from today (SGT) to an ISO date, both taken as calendar dates
function daysUntil(iso, today) {
  const [y1, m1, d1] = today.split("-").map(Number);
  const [y2, m2, d2] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// Keep HAPPY_DAY in sync with the same-named config in index.html.
const HAPPY_DAY = { month: 4, day: 4, firstYear: 2023 };
// Statement landing days (SGT; one day after the statement date —
// month-end statements → the 1st). This is now the only copy: the
// dashboard shows the resulting to-dos, not a separate banner.
const STATEMENTS = [
  { day: 20, text: "Citi SG CC statement" },
  { day: 24, text: "Citi US CC statement" },
  { day: 24, text: "UOB CC statement" },
  { day: 1,  text: "Citi SG bank statement" },
  { day: 1,  text: "Citi US bank statement" },
];

/* To-do items for statements landing today: "File Citi SG CC statement
   (Sep)" in the Today bucket. The month tag keeps texts distinct across
   months, which is also what the append dedupe keys on. */
function statementTodos(today) {
  const [y, m, d] = today.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // days in this month
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return STATEMENTS
    .filter((r) => d === Math.min(r.day, lastDay))
    .map((r) => ({ text: `File ${r.text} (${mon})`, ts: Date.now(), bucket: "today", doing: false }));
}

function happyDayLine(today) {
  const [y, m, d] = today.split("-").map(Number);
  const before = m < HAPPY_DAY.month || (m === HAPPY_DAY.month && d < HAPPY_DAY.day);
  const annivYear = before ? y - 1 : y;
  const years = annivYear - HAPPY_DAY.firstYear;
  if (years < 0) return null;
  const dayNum = Math.round(
    (Date.UTC(y, m - 1, d) - Date.UTC(annivYear, HAPPY_DAY.month - 1, HAPPY_DAY.day)) / 86400000
  ) + 1;
  return `♥ Happy Day ${years * 365}.${dayNum}`;
}

async function composeDigest() {
  const today = sgToday();
  const [status, birthdays, events] = await Promise.all([
    jfetch(MERIDIAN_STATUS),
    jfetch(`${SITE}/data/birthdays.json`),
    jfetch(`${SITE}/data/events.json`),
  ]);
  const lines = [];

  if (status && status.issue) {
    if (status.isoDate === today) {
      const built = (String(status.builtAt || "").match(/T(\d{2}:\d{2})/) || [])[1];
      const mins = status.buildMinutes;
      const dur = Number.isFinite(mins) && mins > 0 ? ` in ${mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m` : `${mins}m`}` : "";
      lines.push(`MERIDIAN No. ${status.issue} · built ${built || "—"}${dur} · ${status.pages || "?"}pp${status.qa === "pass" ? " · QA clean" : ""}`);
    } else {
      lines.push(`⚠ MERIDIAN hasn't published today — latest is No. ${status.issue} (${status.date || status.isoDate})`);
    }
  }

  const hd = happyDayLine(today);
  if (hd) lines.push(hd);

  const [ty] = today.split("-").map(Number);
  for (const b of Array.isArray(birthdays) ? birthdays : []) {
    if (!b || !b.month || !b.day) continue;
    for (const yr of [ty, ty + 1]) {
      const delta = daysUntil(`${yr}-${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}`, today);
      if (delta === 0) lines.push(`🎂 ${b.name}'s birthday is today`);
      else if (delta === 1) lines.push(`🎂 ${b.name}'s birthday is tomorrow`);
      else if (delta === 7) lines.push(`🎂 ${b.name}'s birthday in a week`);
      else continue;
      break;
    }
  }

  for (const e of Array.isArray(events) ? events : []) {
    if (!e || !e.act || !e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
    const delta = daysUntil(e.date, today);
    const extra = [e.venue, fmtEventTime(e.time)].filter(Boolean).map((s) => ` · ${s}`).join("");
    if (delta === 0) lines.push(`🎫 ${e.act} starts today${extra}`);
    else if (delta === 1) lines.push(`🎫 ${e.act} is tomorrow${extra}`);
  }

  const nice = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(new Date());
  return {
    title: `The Daily — ${nice}`,
    body: lines.join("\n") || "Good morning — the edition is up.",
    url: SITE,
    tag: `daily-${today}`,
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // accept: Vercel cron (Bearer CRON_SECRET) or manual with ?token=<ADMIN_SECRET>
  const cronSecret = (process.env.CRON_SECRET || "").trim();
  const adminSecret = (process.env.ADMIN_SECRET || process.env.DASHBOARD_SECRET || "").trim();
  let token = null, dry = false;
  try {
    const u = new URL(req.url, "http://x");
    token = u.searchParams.get("token");
    dry = u.searchParams.get("dry") === "1";
  } catch (_) {}
  const auth = String(req.headers.authorization || "");
  const isCron = cronSecret && auth === `Bearer ${cronSecret}`;
  const isOwner = adminSecret && token === adminSecret;
  if (cronSecret || adminSecret) {
    if (!isCron && !isOwner) { res.status(401).json({ error: "unauthorized" }); return; }
  }

  const pub = (process.env.VAPID_PUBLIC_KEY || "").trim();
  const priv = (process.env.VAPID_PRIVATE_KEY || "").trim();
  if (!pub || !priv) { res.status(503).json({ error: "VAPID keys not set" }); return; }
  webpush.setVapidDetails("mailto:markh.tan@gmail.com", pub, priv);

  const payload = await composeDigest();
  if (dry) {
    res.status(200).json({ dry: true, payload, wouldAddTodos: statementTodos(sgToday()).map((t) => t.text) });
    return;
  }

  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  if (!ghToken) { res.status(503).json({ error: "GITHUB_TOKEN not set" }); return; }

  // Statement-filing to-dos land before the push goes out; a failure here
  // must not block the digest (the dedupe makes tomorrow's retry safe).
  let todosAdded = [];
  const due = statementTodos(sgToday());
  if (due.length) {
    try { todosAdded = await appendTodos(ghToken, due); } catch (_) {}
  }

  const { subs, sha } = await readSubs(ghToken);
  if (!subs.length) { res.status(200).json({ sent: 0, todosAdded, note: "no devices registered" }); return; }

  const json = JSON.stringify(payload);
  const gone = [];
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s, json); sent++; }
    catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) gone.push(s.endpoint); // device gone — prune
    }
  }));

  if (gone.length) {
    try {
      await writeSubs(ghToken, subs.filter((s) => !gone.includes(s.endpoint)), sha,
        `push: prune ${gone.length} dead device(s)`);
    } catch (_) { /* next run will retry the prune */ }
  }

  res.status(200).json({ sent, pruned: gone.length, devices: subs.length - gone.length, todosAdded });
}
