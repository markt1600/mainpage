# The Daily — marktan.ai

A single-page daily dashboard in an editorial / broadsheet style: weather for Singapore, Tokyo, Vancouver, and Whistler, live market quotes, AI-written tech & lifestyle news with links to the original articles, Strava mileage, upcoming birthdays, and a quote of the day — gathered fresh each morning.

Built as one static page plus a few Vercel serverless functions. No framework, no build step.

## What's on the page

| Section | Source | Needs a key? |
|---|---|---|
| Projects bar | `PROJECTS` array in `index.html` | No |
| Weather (Singapore, Tokyo, Vancouver, Whistler — incl. rain chance & US AQI; Whistler adds a Nov–Apr snow report) | Open-Meteo forecast + air-quality APIs | No |
| Markets (8 quotes, 5-day sparklines with date spans; gold also in S$/kg) | Yahoo Finance chart API | No |
| Exchange rates (USD→SGD, SGD→JPY, SGD→CAD, USD→CAD) | Yahoo Finance chart API | No |
| Public holidays (next per region: Singapore, Japan, Vancouver/BC, Hong Kong, Shanghai) | Nager.Date API | No |
| Stories & Briefs (with "read at source" links) | Claude + web search over Uncrate, Gear Patrol, Gizmodo, Engadget | `ANTHROPIC_API_KEY` |
| On This Day + Quote of the Day | Same Claude call | `ANTHROPIC_API_KEY` |
| Fitness (24h / 7d / 30d distance & run pace) | Strava API | Strava env vars |
| Account balances (ElevenLabs credits, Claude API 30-day spend) | ElevenLabs + Anthropic Admin APIs | See below |
| Happy Day counter (relationship day count, ticks over at midnight SGT) | `HAPPY_DAY` config in `index.html` | Private: `?me=` link only |
| Birthdays (shown 7 days before → 3 days after) | `BIRTHDAYS` array in `index.html` | Private: `?me=` link only |

Sections whose keys aren't configured simply hide themselves — the page is never empty.

**Personal sections** (Happy Day, birthdays, balances) only appear when visiting with the private link `/?me=<secret>`, so casual visitors see just the almanac. Note the birthday/Happy Day data is only *hidden* for public visitors — it still ships in the page source; balances are gated server-side by `DASHBOARD_SECRET`.

## Files

- **`index.html`** — the whole frontend. Fetches `/api/dashboard`, `/api/fitness`, and `/api/balances` and renders them. If the dashboard call fails (e.g. opening the file locally), it falls back to a sample edition instead of breaking.
- **`api/dashboard.js`** — weather, markets, and the Claude-written edition (briefs, features, on-this-day, quote). Each story includes the URL of the original article, validated server-side before it reaches the page. The edition call retries once on a malformed answer.
- **`api/fitness.js`** — Strava summary. Exchanges a long-lived refresh token for an access token on each run; cached ~1h.
- **`api/balances.js`** — ElevenLabs credits + Claude API 30-day spend. Never cached. Optionally gated: set `DASHBOARD_SECRET` and visit `/?me=<secret>` to see it; without the secret set, it's public.
- **`vercel.json`** — 60s `maxDuration` for the dashboard function (web search can be slow) and a daily cron that warms the cache.

## Caching & cost

`/api/dashboard` is edge-cached for ~24 hours (`s-maxage=86400`), so the paid Claude call runs roughly **once per day**. The cron (`0 21 * * *` UTC = 05:00 SGT / 06:00 JST) generates each morning's edition before you wake up; visitors share the cached copy. The "↻ new stories" link in the footer forces a fresh, uncached generation on demand.

## Environment variables

Set these in Vercel → Settings → Environment Variables:

| Variable | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `dashboard.js` | From https://console.anthropic.com. Required for the news edition. |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN` | `fitness.js` | Refresh token from a one-time OAuth authorization with scope `activity:read_all`. |
| `ELEVENLABS_API_KEY` | `balances.js` | elevenlabs.io → Profile → API key. |
| `ANTHROPIC_ADMIN_KEY` | `balances.js` | Admin key (`sk-ant-admin…`) from console → Settings → Organization → Admin keys. Not the same as `ANTHROPIC_API_KEY`. |
| `DASHBOARD_SECRET` | `balances.js` | Optional. If set, balances only appear when visiting `/?me=<secret>`. |

Keys live only in the serverless functions and are never sent to the browser.

## Deploy

**Option A — GitHub + Vercel dashboard (easiest)**
1. Push this repo to GitHub.
2. In Vercel, *Add New → Project* and import it. No framework preset, no build command.
3. Add the environment variables above (at minimum `ANTHROPIC_API_KEY`).
4. Deploy, then *Settings → Domains* → add your domain.

**Option B — Vercel CLI**
```bash
npm i -g vercel
vercel                                    # first deploy (preview)
vercel env add ANTHROPIC_API_KEY production
vercel --prod                             # deploy to production
```

## Customising

In **`index.html`**:
- **Projects** — edit the `PROJECTS` array near the top of the `<script>`; each entry is `{ name, url }`.
- **Birthdays** — edit the `BIRTHDAYS` array; each entry is `{ name, month, day }`.
- **Happy Day** — the `HAPPY_DAY` constant holds the anniversary (`month`, `day`) and `firstYear`. The display reads `<completed years × 365>.<day of the current relationship year>`, with day 1 on the anniversary, resetting each year at midnight Singapore time.

In **`api/dashboard.js`**:
- **Model** — `MODEL` defaults to `claude-haiku-4-5-20251001` (fast, cheap). Swap for a Sonnet model for richer prose.
- **Cities** — edit the `CITIES` array (name, lat/lon, timezone). Panels render top-to-bottom in array order.
- **Tickers** — edit the `MARKETS` array (display label + Yahoo Finance symbol).
- **FX pairs** — edit the `FX_PAIRS` array (Yahoo symbols like `SGDJPY=X`).
- **Holiday regions** — edit `HOLIDAY_REGIONS` (Nager.Date country codes; optional `subdivision` like `CA-BC`).
- **News sources & section sizes** — the allowed publications live in the `allowed_domains` list; the prompt (`SCHEMA_PROMPT`) asks for 5 briefs + 3 features.
- **Refresh rate / cost** — change `s-maxage=86400` in the `Cache-Control` header and the cron schedule in `vercel.json`.

## Local preview

Opening `index.html` directly (or serving it statically) works — it shows the sample edition since `/api/*` isn't running. To exercise the real functions locally, run `vercel dev` with your env vars available.

## Notes

- A cold, uncached edition takes ~20–30s to generate (web search); `maxDuration` is 60s to allow for it. Thanks to `stale-while-revalidate`, visitors almost always get the instant cached copy.
- Story links come from the model's search results and are validated to be real `http(s)` URLs on both the server and the client; a story without a usable URL renders unlinked rather than guessing.
- If the edition ever fails outright, the page shows sample copy plus a note with the reason at the bottom.
