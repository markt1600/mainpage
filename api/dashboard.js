// api/dashboard.js
// Vercel Serverless Function (Node.js runtime).
//
// Builds the daily dashboard payload:
//   1. Weather for Singapore + Tokyo from Open-Meteo (free, no API key),
//      including rain chance and US AQI air quality
//   2. Market quotes (Yahoo Finance, keyless) with 5-day sparkline closes
//   3. News briefs + interesting-story features via Claude (with web search)
//
// ANTHROPIC_API_KEY lives ONLY here (Vercel → Settings → Environment Variables);
// it is never shipped to the browser. The response is edge-cached so the heavy
// work runs about once an hour rather than on every page view.

const MODEL = "claude-haiku-4-5-20251001"; // fast + economical; swap to "claude-sonnet-4-6" for richer prose

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

// --- Editorial content via Claude ------------------------------------------
const SCHEMA_PROMPT = (dateStr) => `You are the editor of a tasteful daily tech & lifestyle almanac published at marktan.ai. Today is ${dateStr}.

Use the web_search tool to find the most interesting recent stories in technology, gadgets, gear, design, apps, gaming, lifestyle, and Singapore property from the past few days. Your searches are restricted to a curated set of publications (Uncrate, Gear Patrol, Gizmodo, Engadget, and Stacked Homes — the Singapore property site) — surface what's genuinely notable, cool, or useful from them. Aim to include at least one Stacked Homes property story when they have something recent worth reading.

IMPORTANT: Write every text value as clean PLAIN TEXT only. Do NOT include citation markers, footnotes, reference numbers, HTML tags (such as <cite>), or markdown of any kind. Just natural prose.

Return ONLY a single valid minified JSON object (no markdown, no commentary, no code fences) with EXACTLY this shape:

{
  "briefs": [
    { "headline": "short punchy headline (max ~9 words)", "summary": "2 sentence summary", "source": "publication name", "url": "full https URL of the original article, copied exactly from your search results", "category": "Tech|Gadgets|Gear|Apps|Lifestyle|Design|Auto|Gaming|Property" }
  ],
  "features": [
    { "title": "an engaging title", "body": "3-4 sentence write-up of a cool product, gadget, or tech/lifestyle story worth a look", "tag": "one or two words", "source": "publication name", "url": "full https URL of the original article, copied exactly from your search results" }
  ],
  "onThisDay": "one sentence about a notable event in tech or technology history on this calendar date",
  "quote": { "text": "a short, non-cliche quote (ideally about design, technology, or craft)", "author": "name" }
}

Provide exactly 5 briefs and exactly 3 features, drawn from the publications above. Be accurate and specific — name the actual products, companies, and apps. Every brief and feature MUST include the "url" of the article it came from — copy the URL verbatim from the search results, never invent or shorten one. If you truly cannot determine the article URL, use an empty string.`;

// Remove any citation/markup the model might still emit, just in case.
const clean = (s) =>
  typeof s === "string"
    ? s
        .replace(/<\/?cite[^>]*>/gi, "")   // <cite index="..."> ... </cite>
        .replace(/<[^>]+>/g, "")            // any other stray tags
        .replace(/\[\d+(?:[-,:]\d+)*\]/g, "") // [1] [1-14] style refs
        .replace(/\s+/g, " ")
        .trim()
    : s;

// Only pass along real-looking http(s) article URLs.
const cleanUrl = (u) =>
  typeof u === "string" && /^https?:\/\/\S+$/i.test(u.trim()) ? u.trim() : null;

const cleanBrief = (b) => ({
  headline: clean(b.headline),
  summary: clean(b.summary),
  source: clean(b.source),
  url: cleanUrl(b.url),
  category: clean(b.category),
});
const cleanFeature = (f) => ({
  title: clean(f.title),
  body: clean(f.body),
  tag: clean(f.tag),
  source: clean(f.source),
  url: cleanUrl(f.url),
});

// POST to the Anthropic API, retrying on rate-limit (429) and overloaded
// (529) responses with the server-suggested wait, so the news and sports
// calls can tolerate landing in the same tokens-per-minute window.
async function anthropicFetch(key, body, attempts = 3) {
  let res;
  for (let i = 0; i < attempts; i++) {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if ((res.status === 429 || res.status === 529) && i < attempts - 1) {
      const wait = Math.min(Number(res.headers.get("retry-after")) || 15, 25);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    break;
  }
  return res;
}

async function generateEdition(key, dateStr) {
  const tools = [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3,
      allowed_domains: ["uncrate.com", "gearpatrol.com", "gizmodo.com", "engadget.com", "stackedhomes.com"],
    },
  ];
  const messages = [{ role: "user", content: SCHEMA_PROMPT(dateStr) }];

  // Web-search turns can return stop_reason "pause_turn" before the model has
  // written its final answer. When that happens we feed the partial turn back
  // (preserving the search-result blocks) and let it resume, up to a few times.
  let data;
  for (let turn = 0; turn < 6; turn++) {
    const res = await anthropicFetch(key, { model: MODEL, max_tokens: 6000, messages, tools });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`);
    }

    data = await res.json();
    if (data.stop_reason === "pause_turn" && Array.isArray(data.content)) {
      messages.push({ role: "assistant", content: data.content });
      continue;
    }
    break;
  }
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    // Tolerate code fences despite the prompt forbidding them.
    .replace(/```(?:json)?/gi, "")
    .trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON found in model output (stop: ${data.stop_reason || "?"})`);
  }
  const parsed = JSON.parse(text.slice(start, end + 1));

  return {
    briefs: Array.isArray(parsed.briefs) ? parsed.briefs.slice(0, 6).map(cleanBrief) : [],
    features: Array.isArray(parsed.features) ? parsed.features.slice(0, 4).map(cleanFeature) : [],
    onThisDay: clean(parsed.onThisDay) || null,
    quote: parsed.quote ? { text: clean(parsed.quote.text), author: clean(parsed.quote.author) } : null,
  };
}

async function getEdition(dateStr) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ...FALLBACK_EDITION, _note: "ANTHROPIC_API_KEY not set — showing sample edition." };

  // One retry: an occasional malformed/truncated answer shouldn't sink the
  // whole day's edition (this path runs about once per day via cron).
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await generateEdition(key, dateStr);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const FALLBACK_EDITION = {
  briefs: [
    { headline: "Set ANTHROPIC_API_KEY to go live", summary: "This is sample copy. Once your key is configured in Vercel, real briefs appear here each morning.", source: "marktan.ai", category: "Tech" },
    { headline: "Built on Vercel serverless", summary: "Your API key stays server-side and is never exposed to visitors. Responses are edge-cached for speed.", source: "Vercel", category: "Tech" },
    { headline: "Weather and markets are live regardless", summary: "Conditions come from Open-Meteo and quotes from Yahoo, neither of which needs a key.", source: "Open-Meteo", category: "Asia" },
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
    edition = await getEdition(dateStr);
  } catch (err) {
    edition = { ...FALLBACK_EDITION, _note: `Edition unavailable: ${err.message}` };
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
