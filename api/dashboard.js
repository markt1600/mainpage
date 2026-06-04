// api/dashboard.js
// Vercel Serverless Function (Node.js runtime).
//
// Builds the daily dashboard payload:
//   1. Fetches Tokyo weather from Open-Meteo (free, no API key required)
//   2. Uses Claude (with the web_search tool) to write fresh news briefs,
//      a couple of longer "interesting story" features, an on-this-day note,
//      and a quote of the day.
//
// The ANTHROPIC_API_KEY lives ONLY here (set it in Vercel → Project →
// Settings → Environment Variables). It is never shipped to the browser.
//
// The response is edge-cached (see Cache-Control below) so Claude is called
// roughly once an hour rather than on every page view — fast and cheap.

const TOKYO = { lat: 35.6762, lon: 139.6503 };
const MODEL = "claude-haiku-4-5-20251001"; // fast + economical; swap to "claude-sonnet-4-6" for richer prose

// WMO weather interpretation codes → human label + glyph
const WMO = {
  0:  ["Clear sky", "☀"],
  1:  ["Mainly clear", "🌤"],
  2:  ["Partly cloudy", "⛅"],
  3:  ["Overcast", "☁"],
  45: ["Fog", "🌫"], 48: ["Rime fog", "🌫"],
  51: ["Light drizzle", "🌦"], 53: ["Drizzle", "🌦"], 55: ["Dense drizzle", "🌦"],
  56: ["Freezing drizzle", "🌧"], 57: ["Freezing drizzle", "🌧"],
  61: ["Light rain", "🌦"], 63: ["Rain", "🌧"], 65: ["Heavy rain", "🌧"],
  66: ["Freezing rain", "🌧"], 67: ["Freezing rain", "🌧"],
  71: ["Light snow", "🌨"], 73: ["Snow", "🌨"], 75: ["Heavy snow", "❄"],
  77: ["Snow grains", "🌨"],
  80: ["Rain showers", "🌦"], 81: ["Rain showers", "🌧"], 82: ["Violent showers", "⛈"],
  85: ["Snow showers", "🌨"], 86: ["Snow showers", "🌨"],
  95: ["Thunderstorm", "⛈"], 96: ["Thunderstorm + hail", "⛈"], 99: ["Severe thunderstorm", "⛈"],
};

function describeCode(code) {
  const hit = WMO[code];
  return hit ? { label: hit[0], glyph: hit[1] } : { label: "—", glyph: "•" };
}

async function getTokyoWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${TOKYO.lat}&longitude=${TOKYO.lon}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,apparent_temperature` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset` +
    `&timezone=Asia%2FTokyo&forecast_days=1`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const d = await res.json();

  const code = d.current?.weather_code ?? d.daily?.weather_code?.[0];
  const { label, glyph } = describeCode(code);
  const hhmm = (iso) => (iso ? iso.slice(11, 16) : null);

  return {
    unit: "°C",
    current: Math.round(d.current?.temperature_2m),
    feelsLike: Math.round(d.current?.apparent_temperature),
    high: Math.round(d.daily?.temperature_2m_max?.[0]),
    low: Math.round(d.daily?.temperature_2m_min?.[0]),
    humidity: Math.round(d.current?.relative_humidity_2m),
    wind: Math.round(d.current?.wind_speed_10m),
    condition: label,
    glyph,
    sunrise: hhmm(d.daily?.sunrise?.[0]),
    sunset: hhmm(d.daily?.sunset?.[0]),
  };
}

const SCHEMA_PROMPT = (dateStr, weather) => `You are the editor of a tasteful daily almanac published at marktan.ai. Today is ${dateStr} (Tokyo time). Current Tokyo weather: ${weather ? `${weather.current}${weather.unit}, ${weather.condition}` : "unavailable"}.

Use the web_search tool to gather what actually happened in the world in the last 24–48 hours, then compose the day's edition. Keep everything publication-grade, neutral, and suitable for a public homepage — no personal information, no rumor, no clickbait.

Return ONLY a single valid minified JSON object (no markdown, no commentary, no code fences) with EXACTLY this shape:

{
  "briefs": [
    { "headline": "short factual headline (max ~9 words)", "summary": "2 sentence neutral summary", "source": "publication name", "category": "World|Tech|Business|Japan|Science|Culture" }
  ],
  "features": [
    { "title": "a curiosity-driven, evergreen title", "body": "3–4 sentence engaging story about something genuinely interesting — science, history, ideas, the natural world, culture", "tag": "one or two words" }
  ],
  "onThisDay": "one sentence about a notable historical event on this calendar date",
  "quote": { "text": "a short, non-cliché quote", "author": "name" }
}

Provide exactly 5 briefs (mix of World, Tech, Japan, Science/Business) and exactly 3 features. Be accurate; prefer reputable sources.`;

async function getEdition(dateStr, weather) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ...FALLBACK_EDITION, _note: "ANTHROPIC_API_KEY not set — showing sample edition." };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      messages: [{ role: "user", content: SCHEMA_PROMPT(dateStr, weather) }],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 6,
          user_location: {
            type: "approximate",
            city: "Tokyo",
            country: "JP",
            timezone: "Asia/Tokyo",
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  // Extract the JSON object even if the model wrapped it in stray characters.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON found in model output");
  const parsed = JSON.parse(text.slice(start, end + 1));

  return {
    briefs: Array.isArray(parsed.briefs) ? parsed.briefs.slice(0, 6) : [],
    features: Array.isArray(parsed.features) ? parsed.features.slice(0, 4) : [],
    onThisDay: parsed.onThisDay || null,
    quote: parsed.quote || null,
  };
}

// Used when the API key is missing or Claude is unreachable, so the page
// always renders something elegant.
const FALLBACK_EDITION = {
  briefs: [
    { headline: "Set ANTHROPIC_API_KEY to go live", summary: "This is sample copy. Once your key is configured in Vercel, real briefs appear here each morning.", source: "marktan.ai", category: "Tech" },
    { headline: "Built on Vercel serverless", summary: "Your API key stays server-side and is never exposed to visitors. Responses are edge-cached for speed.", source: "Vercel", category: "Tech" },
    { headline: "Weather is live regardless", summary: "Tokyo conditions come from Open-Meteo and need no key, so the weather panel works immediately.", source: "Open-Meteo", category: "Japan" },
    { headline: "Add projects in seconds", summary: "Edit the PROJECTS array in index.html to list new Vibe Code experiments at the top of the page.", source: "marktan.ai", category: "World" },
    { headline: "Refreshes roughly hourly", summary: "Cache-Control headers keep Claude from being called on every visit, controlling cost cleanly.", source: "marktan.ai", category: "Business" },
  ],
  features: [
    { title: "The map is not the territory", body: "A reminder that every dashboard is a curated lens, not the whole world. Configure your key and this corner fills with genuinely surprising stories each day.", tag: "Ideas" },
    { title: "Why mornings feel like fresh starts", body: "Sample feature copy. Real editions surface science, history and culture worth a moment of your attention.", tag: "Science" },
    { title: "Small sites, big ideas", body: "The web still rewards the personal homepage. This one gathers the day for you in a single glance.", tag: "Culture" },
  ],
  onThisDay: "Configure your API key to surface a notable event for today's date.",
  quote: { text: "We are what we repeatedly do.", author: "Will Durant" },
};

export default async function handler(req, res) {
  // Edge cache: serve cached copy instantly, refresh in the background.
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=3600, stale-while-revalidate=86400"
  );
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "Asia/Tokyo",
  }).format(now);

  // Weather and edition run independently so one failing never blanks the other.
  const [weatherResult, ] = await Promise.allSettled([getTokyoWeather()]);
  const weather = weatherResult.status === "fulfilled" ? weatherResult.value : null;

  let edition;
  try {
    edition = await getEdition(dateStr, weather);
  } catch (err) {
    edition = { ...FALLBACK_EDITION, _note: `Edition unavailable: ${err.message}` };
  }

  // ---- TEMP DEBUG (remove these 3 lines + keyStatus/envKeys below once fixed) ----
  const envKeys = Object.keys(process.env).filter((k) => /anthro|claude|api[_-]?key/i.test(k));
  const keyStatus = process.env.ANTHROPIC_API_KEY
    ? `present(len ${process.env.ANTHROPIC_API_KEY.length})`
    : "absent";
  // --------------------------------------------------------------------------------

  res.status(200).json({
    keyStatus, // TEMP DEBUG
    envKeys,   // TEMP DEBUG
    generatedAt: now.toISOString(),
    dateStr,
    tokyo: weather,
    ...edition,
  });
}
