// api/dashboard.js
// Vercel Serverless Function (Node.js runtime).
//
// Builds the daily dashboard payload:
//   1. Weather for Singapore + Tokyo from Open-Meteo (free, no API key),
//      including rain chance and US AQI air quality
//   2. Market quotes (Yahoo Finance, keyless) with 5-day sparkline closes
//   3. News briefs + interesting-story features drawn from the day's MERIDIAN
//      edition (github.com/markt1600/dailymag) — reusing research already done,
//      so this function no longer runs its own web search.
//
// The response is edge-cached so the work runs about once a day rather than on
// every page view. (Sports still uses Claude in its own function.)

// Cities render top-to-bottom in this order. snow: true adds a seasonal
// (Nov-Apr) snow report — fresh snowfall today + snow depth on the ground.
const CITIES = [
  { name: "Singapore", lat: 1.3521, lon: 103.8198, tz: "Asia/Singapore" },
  { name: "Tokyo", lat: 35.6762, lon: 139.6503, tz: "Asia/Tokyo" },
  { name: "Vancouver", lat: 49.2827, lon: -123.1207, tz: "America/Vancouver" },
  { name: "Whistler", lat: 50.1163, lon: -122.9574, tz: "America/Vancouver", snow: true },
];

// FX pairs (Yahoo Finance symbols, same keyless endpoint as the markets).
const FX_PAIRS = [
  { label: "USD → SGD", symbol: "SGD=X", note: "" },
  { label: "SGD → JPY", symbol: "SGDJPY=X", note: "" },
  { label: "SGD → CAD", symbol: "SGDCAD=X", note: "" },
  { label: "USD → CAD", symbol: "CAD=X", note: "" },
];

// Public-holiday regions (Nager.Date, keyless). subdivision filters
// country feeds to holidays that apply in that province/region.
const HOLIDAY_REGIONS = [
  { code: "SG", label: "Singapore" },
  { code: "JP", label: "Japan" },
  { code: "CA", label: "Vancouver", subdivision: "CA-BC" },
  { code: "HK", label: "Hong Kong" },
  { code: "CN", label: "Shanghai" },
];

// Market instruments. label = display name, symbol = Yahoo Finance ticker.
const MARKETS = [
  { label: "Ares Management", symbol: "ARES", note: "ARES" },
  { label: "FTSE All-World", symbol: "VWRA.L", note: "VWRA.L" },
  { label: "Gold", symbol: "GC=F", note: "USD / oz" },
  { label: "S&P 500", symbol: "^GSPC", note: "SPX" },
  { label: "Berkshire", symbol: "BRK-A", note: "BRK.A" },
  { label: "Bitcoin", symbol: "BTC-USD", note: "BTC / USD" },
  { label: "NVIDIA", symbol: "NVDA", note: "NVDA" },
  { label: "SpaceX", symbol: "SPCX", note: "SPCX" },
];

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

// Current US AQI from Open-Meteo's (also keyless) air-quality API.
async function getCityAqi(city) {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${city.lat}&longitude=${city.lon}` +
    `&current=us_aqi&timezone=${encodeURIComponent(city.tz)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Air-quality ${res.status}`);
  const d = await res.json();
  const aqi = d.current?.us_aqi;
  return Number.isFinite(aqi) ? Math.round(aqi) : null;
}

async function getCityWeather(city) {
  // Snow report only during the snow season (Nov-Apr, city-local time).
  const month = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: city.tz, month: "numeric" }).format(new Date())
  );
  const snowSeason = !!city.snow && (month >= 11 || month <= 4);

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,apparent_temperature` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset,precipitation_probability_max` +
    (snowSeason ? `,snowfall_sum&hourly=snow_depth` : ``) +
    `&timezone=${encodeURIComponent(city.tz)}&forecast_days=1`;

  // AQI comes from a separate endpoint; a failure there never blanks the weather.
  const [res, aqi] = await Promise.all([fetch(url), getCityAqi(city).catch(() => null)]);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const d = await res.json();

  const code = d.current?.weather_code ?? d.daily?.weather_code?.[0];
  const { label, glyph } = describeCode(code);
  const hhmm = (iso) => (iso ? iso.slice(11, 16) : null);
  const rain = d.daily?.precipitation_probability_max?.[0];

  // Fresh snowfall today (cm) + snow depth on the ground now (m → cm),
  // taken from the most recent hourly reading at or before the current hour.
  let snowToday = null, snowBase = null;
  if (snowSeason) {
    const sf = d.daily?.snowfall_sum?.[0];
    snowToday = Number.isFinite(sf) ? Math.round(sf * 10) / 10 : null;
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: city.tz, hour: "numeric", hourCycle: "h23" }).format(new Date())
    );
    const depths = d.hourly?.snow_depth || [];
    for (let i = Math.min(hour, depths.length - 1); i >= 0; i--) {
      if (depths[i] != null) { snowBase = Math.round(depths[i] * 100); break; }
    }
  }

  return {
    name: city.name,
    tz: city.tz,
    unit: "°C",
    current: Math.round(d.current?.temperature_2m),
    feelsLike: Math.round(d.current?.apparent_temperature),
    high: Math.round(d.daily?.temperature_2m_max?.[0]),
    low: Math.round(d.daily?.temperature_2m_min?.[0]),
    humidity: Math.round(d.current?.relative_humidity_2m),
    wind: Math.round(d.current?.wind_speed_10m),
    rainChance: Number.isFinite(rain) ? Math.round(rain) : null,
    aqi,
    snowToday,
    snowBase,
    condition: label,
    glyph,
    sunrise: hhmm(d.daily?.sunrise?.[0]),
    sunset: hhmm(d.daily?.sunset?.[0]),
  };
}

async function getCities() {
  const results = await Promise.allSettled(CITIES.map(getCityWeather));
  return results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
}

// --- Markets via Yahoo Finance's keyless chart endpoint --------------------
async function getQuote({ label, symbol, note }) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=5d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; marktan-dashboard/1.0)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${symbol}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) throw new Error(`No data for ${symbol}`);

  const price = meta.regularMarketPrice;
  const prev = meta.previousClose ?? meta.chartPreviousClose;
  const change = price != null && prev != null ? price - prev : null;
  const pct = change != null && prev ? (change / prev) * 100 : null;

  // Daily closes over the 5-day range (with matching unix timestamps),
  // for a small trend sparkline labelled with its date span.
  const stamps = result?.timestamp || [];
  const points = (result?.indicators?.quote?.[0]?.close || [])
    .map((c, i) => ({ c, t: stamps[i] ?? null }))
    .filter((p) => p.c != null);
  const closes = points.map((p) => p.c);
  const times = points.map((p) => p.t);
  if (closes.length && price != null) closes[closes.length - 1] = price; // latest point = live price

  return {
    label,
    note,
    symbol,
    price,
    change,
    pct,
    spark: closes.length >= 2 ? closes : null,
    sparkTimes: closes.length >= 2 ? times : null,
    currency: meta.currency || "USD",
  };
}

async function getMarkets() {
  const results = await Promise.allSettled(MARKETS.map(getQuote));
  const markets = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { label: MARKETS[i].label, note: MARKETS[i].note, symbol: MARKETS[i].symbol, price: null, change: null, pct: null, spark: null, sparkTimes: null, currency: null }
  );

  // Gold: also express USD/oz as SGD/kg using a live USD->SGD rate.
  try {
    const GRAMS_PER_TROY_OZ = 31.1034768;
    const gold = markets.find((m) => m.symbol === "GC=F");
    if (gold && gold.price != null) {
      const fx = await getQuote({ label: "USD/SGD", symbol: "SGD=X", note: "" }); // SGD per 1 USD
      if (fx.price) {
        const sgdPerOz = gold.price * fx.price;
        const sgdPerKg = sgdPerOz * (1000 / GRAMS_PER_TROY_OZ);
        const sgdPerHalfOz = sgdPerOz * 0.5;
        gold.extras = [
          "S$" + Math.round(sgdPerKg).toLocaleString("en-US") + " / kg",
          "S$" + Math.round(sgdPerHalfOz).toLocaleString("en-US") + " / ½oz",
        ];
      }
    }
  } catch (_) { /* leave gold as USD/oz only if FX fails */ }

  return markets;
}

// FX pairs reuse the same Yahoo quote endpoint (sparkline included).
async function getFx() {
  const results = await Promise.allSettled(FX_PAIRS.map(getQuote));
  return results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
}

// --- Public holidays via Nager.Date (keyless) -------------------------------
async function getRegionHoliday({ code, label, subdivision }) {
  const res = await fetch(`https://date.nager.at/api/v3/NextPublicHolidays/${code}`);
  if (!res.ok) throw new Error(`Nager ${res.status} for ${code}`);
  const list = await res.json();

  // Keep nationwide holidays, plus subdivision-specific ones (e.g. CA-BC).
  const applies = (h) =>
    h.global || !Array.isArray(h.counties) || h.counties.length === 0
      ? true
      : subdivision ? h.counties.includes(subdivision) : false;

  const hit = (Array.isArray(list) ? list : []).find(applies);
  return hit && hit.date && hit.name ? { region: label, name: hit.name, date: hit.date } : null;
}

async function getHolidays() {
  const results = await Promise.allSettled(HOLIDAY_REGIONS.map(getRegionHoliday));
  return results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);
}

// --- Editorial content: reuse the day's MERIDIAN edition --------------------
// marktan's Stories & Briefs are drawn from MERIDIAN (github.com/markt1600/
// dailymag), which publishes a fresh twelve-desk edition each morning (~7am
// SGT) and emits a compact `feed.json` of its top stories. We fetch that and
// map the desk leads into features + briefs — no web search here, so we never
// duplicate the research MERIDIAN already did. Each story deep-links back to
// its desk in the edition. If today's feed hasn't published yet, the raw file
// is simply the most recent edition — the "last good" stories, clearly dated.
const MERIDIAN_FEED = "https://raw.githubusercontent.com/markt1600/dailymag/main/feed.json";
const MERIDIAN_SITE = "https://dailymag.marktan.ai";

// Sanitise any stray markup/citation cruft; keep values as clean plain text.
const clean = (s) =>
  typeof s === "string"
    ? s
        .replace(/<\/?cite[^>]*>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\[\d+(?:[-,:]\d+)*\]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    : s;

const meridianLink = (s) =>
  s && s.anchor ? `${MERIDIAN_SITE}/#${String(s.anchor).replace(/^#/, "")}` : MERIDIAN_SITE;

// Fetch the MERIDIAN feed (light retry) and map desk leads -> features + briefs.
async function getEdition() {
  let feed, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(MERIDIAN_FEED, { cache: "no-store" });
      if (!res.ok) throw new Error(`MERIDIAN feed ${res.status}`);
      feed = await res.json();
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  if (!feed) throw lastErr || new Error("MERIDIAN feed unavailable");

  const stories = Array.isArray(feed.stories) ? feed.stories.filter((s) => s && s.headline) : [];
  // Editor's own ranking: cover-teaser picks (featured) lead, then desk order.
  const ranked = [...stories].sort((a, b) => (b.featured === true) - (a.featured === true));

  const features = ranked.slice(0, 3).map((s) => ({
    title: clean(s.headline),
    body: clean(s.dek),
    tag: clean(s.desk),
    source: `MERIDIAN · ${clean(s.desk)}`,
    url: meridianLink(s),
  }));
  const briefs = ranked.slice(3, 8).map((s) => ({
    headline: clean(s.headline),
    summary: clean(s.dek),
    source: "MERIDIAN",
    category: clean(s.category || s.desk),
    url: meridianLink(s),
  }));

  const q = feed.quote;
  return {
    briefs,
    features,
    macro: feed.macro && Array.isArray(feed.macro.reads) && feed.macro.reads.length ? feed.macro : null,
    // Provenance line (fills the bottom band); notes which edition these are from.
    onThisDay: feed.issue
      ? `Today's stories are drawn from MERIDIAN No. ${feed.issue}${feed.date ? " · " + clean(feed.date) : ""} — read the full twelve-desk edition at dailymag.marktan.ai.`
      : null,
    quote: q && q.text ? { text: clean(q.text), author: clean(q.author) } : null,
  };
}

// Shown only if the MERIDIAN feed can't be reached at all (rare — the raw file
// is always the last good edition). Weather/markets stay live regardless.
const FALLBACK_EDITION = {
  briefs: [],
  features: [
    { title: "MERIDIAN edition unavailable", body: "Today's stories come from the MERIDIAN daily edition, which couldn't be reached just now. Weather and markets above are live; stories return on the next refresh.", tag: "Notice", source: "MERIDIAN", url: MERIDIAN_SITE },
  ],
  macro: null,
  onThisDay: null,
  quote: null,
};

export default async function handler(req, res) {
  // Edge cache for ~24h: the edition (stories + markets) is generated about
  // once a day. The morning cron (vercel.json) warms it; visitors share the
  // cached copy, so the paid Claude call runs roughly once per day.
  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=86400");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "Asia/Singapore",
  }).format(now);

  // Weather, markets, FX, holidays, and the edition run independently so
  // one failing never blanks the others.
  const [citiesR, marketsR, fxR, holidaysR] = await Promise.allSettled([
    getCities(), getMarkets(), getFx(), getHolidays(),
  ]);
  const cities = citiesR.status === "fulfilled" ? citiesR.value : [];
  const markets = marketsR.status === "fulfilled" ? marketsR.value : [];
  const fx = fxR.status === "fulfilled" ? fxR.value : [];
  const holidays = holidaysR.status === "fulfilled" ? holidaysR.value : [];

  let edition;
  try {
    edition = await getEdition();
  } catch (err) {
    edition = { ...FALLBACK_EDITION, _note: `MERIDIAN feed unavailable: ${err.message}` };
    // Never cache a failed edition for the full day — let the next visitor
    // (or the next page load) retry within a few minutes instead.
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  }

  res.status(200).json({
    generatedAt: now.toISOString(),
    dateStr,
    cities,
    markets,
    fx,
    holidays,
    ...edition,
  });
}
