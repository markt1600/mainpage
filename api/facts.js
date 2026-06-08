// api/facts.js
// "Did You Know" panel: 2-3 web-search-VERIFIED facts (and quotes) about a
// rotating set of notable people, Haruki Murakami always included.
//
// This lives in its own endpoint (separate from /api/dashboard) so its
// web-searching Claude call never runs in the same minute as the news call —
// which keeps a single edition under the org's input-tokens-per-minute limit.
// A second daily cron (see vercel.json), scheduled an hour after the news cron,
// warms this independently.
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

const cleanFact = (f) => ({
  subject: clean(f.subject),
  fact: clean(f.fact),
  quote: clean(f.quote),
  source: clean(f.source),
});

const FALLBACK_FACTS = [
  { subject: "Haruki Murakami", fact: "He ran a Tokyo jazz bar called Peter Cat before becoming a writer, and is a dedicated marathon runner.", quote: "Pain is inevitable. Suffering is optional.", source: "What I Talk About When I Talk About Running" },
  { subject: "Carl Sagan", fact: "He helped design the golden records carried aboard the Voyager probes, a greeting to any future finders.", quote: "We are made of star-stuff.", source: "Cosmos" },
  { subject: "Stephen Hawking", fact: "His book A Brief History of Time spent years on bestseller lists despite its dense subject matter.", quote: "Look up at the stars and not down at your feet.", source: "Cambridge University" },
];

const FACTS_PROMPT = `You are compiling a short "Did You Know" panel for a personal dashboard.

ALWAYS include Haruki Murakami. Then pick 2 more of these people (vary the selection for freshness): Carl Sagan, Stephen Hawking, Kurt Cobain, or Bon Jovi (the band or Jon Bon Jovi). That is 3 people total.

For EACH person, use the web_search tool to find and VERIFY against reputable sources in your search results:
  1. ONE genuinely interesting, ideally lesser-known fact about them.
  2. ONE short, genuine quote actually said or written by them (keep it under ~20 words).
Only include a fact or quote you can actually corroborate from your search results. If you cannot verify the exact wording and attribution of the quote, set "quote" to an empty string rather than guessing — NEVER fabricate or misattribute a quote (or a fact). Avoid tired clichés.

Write all values as clean PLAIN TEXT — no citation markers, footnotes, reference numbers, brackets, HTML, or markdown. Do NOT wrap the quote in quotation marks; provide just the words.

Return ONLY a single valid minified JSON object (no markdown, no code fences) of EXACTLY this shape:
{ "facts": [ { "subject": "name", "fact": "1-2 sentence verified fact", "quote": "a short verified quote, or empty string if unverifiable", "source": "the website or publication you verified against" } ] }

Provide exactly 3 facts (Haruki Murakami plus 2 others), including ONLY content you actually verified.`;

async function getFacts() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return FALLBACK_FACTS;
  try {
    const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];
    const messages = [{ role: "user", content: FACTS_PROMPT }];

    // Resume the turn if web search pauses it before the JSON is written.
    let data;
    for (let turn = 0; turn < 4; turn++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages, tools }),
      });
      if (!res.ok) return FALLBACK_FACTS;
      data = await res.json();
      if (data.stop_reason === "pause_turn" && Array.isArray(data.content)) {
        messages.push({ role: "assistant", content: data.content });
        continue;
      }
      break;
    }

    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s === -1 || e === -1) return FALLBACK_FACTS;
    const parsed = JSON.parse(text.slice(s, e + 1));
    const facts = Array.isArray(parsed.facts)
      ? parsed.facts.slice(0, 3).map(cleanFact).filter((f) => f.fact)
      : [];
    return facts.length ? facts : FALLBACK_FACTS;
  } catch (_) {
    return FALLBACK_FACTS;
  }
}

export default async function handler(req, res) {
  // ~24h edge cache; the daily facts cron (vercel.json) warms it an hour after
  // the news cron so the two web-search calls never share a minute.
  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=86400");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const facts = await getFacts();
  res.status(200).json({ generatedAt: new Date().toISOString(), facts });
}
