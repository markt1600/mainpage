// api/fitness.js
// Pulls your Strava activities and summarises distance + average speed over
// the last 24h / 7 days / 30 days.
//
// Strava uses OAuth. The server holds a long-lived REFRESH token and exchanges
// it for a short-lived access token on each run. See setup steps in chat.
//
// Env vars (Vercel -> Settings -> Environment Variables):
//   STRAVA_CLIENT_ID
//   STRAVA_CLIENT_SECRET
//   STRAVA_REFRESH_TOKEN   (from the one-time authorization, scope activity:read_all)
//
// Cached ~1h so we stay well within Strava's rate limits.

const TOKEN_URL = "https://www.strava.com/api/v3/oauth/token";
const ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";

async function getAccessToken() {
  const client_id = (process.env.STRAVA_CLIENT_ID || "").trim();
  const client_secret = (process.env.STRAVA_CLIENT_SECRET || "").trim();
  const refresh_token = (process.env.STRAVA_REFRESH_TOKEN || "").trim();
  if (!client_id || !client_secret || !refresh_token) {
    throw new Error("Strava env vars not set");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id, client_secret, grant_type: "refresh_token", refresh_token }),
  });
  if (!res.ok) throw new Error(`Strava token ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error("Strava token: no access_token");
  return j.access_token;
}

async function getActivities(token, afterEpoch) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const url = `${ACTIVITIES_URL}?after=${afterEpoch}&per_page=200&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Strava activities ${res.status}`);
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    all.push(...arr);
    if (arr.length < 200) break;
  }
  return all;
}

function summarize(activities, sinceEpoch) {
  let distM = 0, count = 0;          // all activities → total distance
  let runDistM = 0, runMovingS = 0;  // runs only → average speed
  for (const a of activities) {
    const t = Date.parse(a.start_date) / 1000;
    if (Number.isNaN(t) || t < sinceEpoch) continue;
    distM += a.distance || 0;
    count += 1;
    const sport = a.sport_type || a.type || "";
    if (/run/i.test(sport)) {        // Run, TrailRun, VirtualRun, etc.
      runDistM += a.distance || 0;
      runMovingS += a.moving_time || 0;
    }
  }
  return {
    km: distM / 1000,                                       // all activity types
    avgKmh: runMovingS > 0 ? (runDistM / runMovingS) * 3.6 : null, // runs only
    count,
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;

  try {
    const token = await getAccessToken();
    const activities = await getActivities(token, now - 30 * DAY);
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      windows: {
        d1: summarize(activities, now - 1 * DAY),
        d7: summarize(activities, now - 7 * DAY),
        d30: summarize(activities, now - 30 * DAY),
      },
    });
  } catch (err) {
    res.status(200).json({ error: String(err.message || err) });
  }
}
