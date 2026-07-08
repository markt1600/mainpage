// api/sports.js
// "Sports · Last 24 Hours" panel: when a MAJOR sports event is underway
// (World Cup, Olympics, Tour de France, Grand Slams, golf majors, late
// playoff rounds, F1 …), Claude + web search summarise the past day's
// results. When nothing major is on, it returns an empty list and the
// section hides itself on the page.
//
// This lives in its own endpoint (separate from /api/dashboard) so its
// web-searching Claude call never runs in the same minute as the news call —
// which keeps a single edition under the org's input-tokens-per-minute limit.
// A second daily cron (see vercel.json), scheduled an hour after the news
// cron, warms this independently.
//
// Uses ANTHROPIC_API_KEY (server-side only). Edge-cached ~24h.

const MODEL = "claude-haiku-4-5-20251001";

// Strip any citation markup / stray tags the model might emit.
const clean = (s) =>
  typeof s === "string"
    ? s
        .replace(/<\/?cite[^>]*>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\[\d+(?:[-,:]\d+)*\]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    : s;

const cleanUrl = (u) =>
  typeof u === "string" && /^https?:\/\/\S+$/i.test(u.trim()) ? u.trim() : null;

const cleanEvent = (e) => ({
  event: clean(e.event),
  headline: clean(e.headline),
  summary: clean(e.summary),
  scorelines: Array.isArray(e.scorelines) ? e.scorelines.map(clean).filter(Boolean).slice(0, 5) : [],
  source: clean(e.source),
  url: cleanUrl(e.url),
});

const SPORTS_PROMPT = (dateStr) => `You are compiling a "Sports - Last 24 Hours" panel for a personal daily dashboard. Today is ${dateStr} (Singapore time).

STEP 1 - Use the web_search tool to determine whether a MAJOR sports event is currently underway, or concluded within the past ~24 hours. Major means marquee events only:
- FIFA World Cup, Olympic Games (summer or winter), Tour de France
- Tennis Grand Slams: Wimbledon, French Open, US Open, Australian Open
- Golf majors: the Masters, PGA Championship, US Open, The Open
- The semifinal or final stages of major competitions: Champions League, NBA Conference Finals/Finals, NFL playoffs/Super Bowl, World Series, Rugby/Cricket World Cups, and similar
- A Formula 1 Grand Prix race weekend
Ordinary regular-season fixtures do NOT count.

STEP 2 - If NO such event is on, return exactly: {"events":[]}

STEP 3 - If one or more are on, return up to 3 events. For each, summarise the past 24 hours: who played whom, the actual scores, key goals/moments/performances, and what it means (who advances, who leads the standings). Only report results you actually found in your search results - never invent scores. If an event is on but had no matches/stage in the past 24 hours, skip it.

Write every value as clean PLAIN TEXT - no citation markers, footnotes, reference numbers, HTML, or markdown.

Return ONLY a single valid minified JSON object (no markdown, no code fences) of EXACTLY this shape:
{"events":[{"event":"competition name","headline":"short punchy headline (max ~10 words)","summary":"2-3 sentences with the key results and moments, including actual scores","scorelines":["compact result lines, e.g. Spain 2-1 France (aet)"],"source":"publication you used","url":"full https URL of a source article, copied exactly from your search results"}]}`;

// POST to the Anthropic API, retrying on rate-limit (429) and overloaded
// (529) responses with the server-suggested wait, so this call can tolerate
// landing in the same tokens-per-minute window as the news call.
async function anthropicFetch(key, body, attempts = 3) {
  let res;
  for (let i = 0; i < attempts; i++) {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
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

async function getSports(dateStr) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return [];
  try {
    const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
    const messages = [{ role: "user", content: SPORTS_PROMPT(dateStr) }];

    // Resume the turn if web search pauses it before the JSON is written.
    let data;
    for (let turn = 0; turn < 6; turn++) {
      const res = await anthropicFetch(key, { model: MODEL, max_tokens: 3500, messages, tools });
      if (!res.ok) return [];
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
      .replace(/```(?:json)?/gi, "")
      .trim();
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s === -1 || e === -1 || e <= s) return [];
    const parsed = JSON.parse(text.slice(s, e + 1));
    return Array.isArray(parsed.events)
      ? parsed.events.slice(0, 3).map(cleanEvent).filter((ev) => ev.headline && ev.summary)
      : [];
  } catch (_) {
    return []; // fail soft: the section simply doesn't appear
  }
}

export default async function handler(req, res) {
  // ~24h edge cache; the daily sports cron (vercel.json) warms it an hour
  // after the news cron so the two web-search calls never share a minute.
  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=86400");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const dateStr = new Intl.DateTimeFormat("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "Asia/Singapore",
  }).format(new Date());

  const events = await getSports(dateStr);
  res.status(200).json({ generatedAt: new Date().toISOString(), events });
}
