// api/balances.js
// Personal account panel: ElevenLabs credit balance + Claude API 30-day spend.
//
// Gating is OPTIONAL:
//   - If DASHBOARD_SECRET is set, the request must include ?token=<that secret>
//     (visit /?me=<secret>) or it returns 401. Use this to keep it private.
//   - If DASHBOARD_SECRET is NOT set, the data is returned to anyone. That's
//     fine for a low-traffic personal page if you don't mind it being public.
//
// Env vars (Vercel -> Settings -> Environment Variables):
//   ELEVENLABS_API_KEY   - elevenlabs.io -> Profile -> API key
//   ANTHROPIC_ADMIN_KEY  - console.anthropic.com -> Settings -> Organization ->
//                          Admin keys (starts "sk-ant-admin"; org owner only).
//                          This is NOT your normal ANTHROPIC_API_KEY.
//   DASHBOARD_SECRET     - optional; set it to gate this endpoint.
//
// Never cached (personal data).

// Anthropic cost_report amounts are documented as USD in lowest units (cents).
// If the spend figure looks 100x off vs your console, flip this to false.
const ANTHROPIC_AMOUNT_IS_CENTS = true;

async function elevenLabs() {
  const key = (process.env.ELEVENLABS_API_KEY || "").trim();
  if (!key) return { service: "ElevenLabs", kind: "balance", error: "ELEVENLABS_API_KEY not set" };

  const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
    headers: { "xi-api-key": key, Accept: "application/json" },
  });
  if (!res.ok) return { service: "ElevenLabs", kind: "balance", error: `ElevenLabs ${res.status}` };

  const d = await res.json();
  const used = d.character_count ?? null;
  const limit = d.character_limit ?? null;
  const remaining = used != null && limit != null ? limit - used : null;
  return {
    service: "ElevenLabs",
    kind: "balance",
    unit: "credits",
    used,
    limit,
    remaining,
    tier: d.tier || null,
    resetUnix: d.next_character_count_reset_unix || null,
  };
}

async function anthropicSpend() {
  const key = (process.env.ANTHROPIC_ADMIN_KEY || "").trim();
  if (!key) return { service: "Claude API", kind: "spend", error: "ANTHROPIC_ADMIN_KEY not set" };

  const start = new Date(Date.now() - 30 * 86400000);
  start.setUTCHours(0, 0, 0, 0);
  const url =
    `https://api.anthropic.com/v1/organizations/cost_report` +
    `?starting_at=${encodeURIComponent(start.toISOString())}&bucket_width=1d&limit=31`;

  const res = await fetch(url, {
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
  });
  if (!res.ok) return { service: "Claude API", kind: "spend", error: `Admin API ${res.status}` };

  const d = await res.json();
  let amount = 0;
  for (const bucket of d.data || []) {
    for (const r of bucket.results || []) {
      amount += parseFloat(r.amount || "0") || 0;
    }
  }
  const usd = ANTHROPIC_AMOUNT_IS_CENTS ? amount / 100 : amount;
  return { service: "Claude API", kind: "spend", spendUsd: usd, period: "last 30 days" };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const secret = process.env.DASHBOARD_SECRET;
  if (secret) {
    let token = null;
    try {
      const u = new URL(req.url, "http://x");
      token = u.searchParams.get("token") || u.searchParams.get("me");
    } catch (_) {}
    if (token !== secret) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  const [el, an] = await Promise.allSettled([elevenLabs(), anthropicSpend()]);
  const settle = (r, service, kind) =>
    r.status === "fulfilled" ? r.value : { service, kind, error: String(r.reason) };

  res.status(200).json({
    generatedAt: new Date().toISOString(),
    balances: [
      settle(el, "ElevenLabs", "balance"),
      settle(an, "Claude API", "spend"),
    ],
  });
}
