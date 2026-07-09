// api/notify.js
// The 07:20 SGT push digest (cron in vercel.json, five minutes after the
// dashboard cache warms). Composes one notification from data the site
// already publishes and sends it to every registered device:
//
//   · MERIDIAN pipeline: built (with issue/time/duration/pages) or MISSING
//   · birthdays today / tomorrow / a week out
//   · watchlist events starting today or tomorrow
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
// whole days from today (SGT) to an ISO date, both taken as calendar dates
function daysUntil(iso, today) {
  const [y1, m1, d1] = today.split("-").map(Number);
  const [y2, m2, d2] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
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
    if (delta === 0) lines.push(`🎫 ${e.act} starts today${e.venue ? ` · ${e.venue}` : ""}`);
    else if (delta === 1) lines.push(`🎫 ${e.act} is tomorrow${e.venue ? ` · ${e.venue}` : ""}`);
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
  if (dry) { res.status(200).json({ dry: true, payload }); return; }

  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  if (!ghToken) { res.status(503).json({ error: "GITHUB_TOKEN not set" }); return; }

  const { subs, sha } = await readSubs(ghToken);
  if (!subs.length) { res.status(200).json({ sent: 0, note: "no devices registered" }); return; }

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

  res.status(200).json({ sent, pruned: gone.length, devices: subs.length - gone.length });
}
