# The Daily — marktan.ai

A single-page daily dashboard in an editorial / broadsheet style: weather for Singapore, Tokyo, Vancouver, and Whistler, live market quotes, AI-written tech & lifestyle news with links to the original articles, Strava mileage, upcoming birthdays, and a quote of the day — gathered fresh each morning.

Built as one static page plus a few Vercel serverless functions. No framework, no build step.

## What's on the page

| Section | Source | Needs a key? |
|---|---|---|
| Projects bar | `PROJECTS` array in `index.html` | No |
| Markets (8 quotes, 5-day sparklines with date spans; gold also in S$/kg) | Yahoo Finance chart API | No |
| Exchange rates (USD→SGD, USD→JPY, SGD→JPY, SGD→CAD, USD→CAD) | Yahoo Finance chart API | No |
| Weather (Singapore, Tokyo, Vancouver, Whistler — incl. rain chance & US AQI; Whistler adds a Nov–Apr snow report) | Open-Meteo forecast + air-quality APIs | No |
| Stories & Briefs (deep-linked to the desk) | The day's **MERIDIAN** edition — `feed.json` from `github.com/markt1600/dailymag` (dailymag.marktan.ai). No web search here. | No |
| Quote of the Day + edition provenance line | MERIDIAN's "From the Desk" quote (same `feed.json`) | No |
| MERIDIAN pipeline tile (header) — green "No. N · built 06:47 · 24pp · QA clean", red past 07:15 SGT if today's issue hasn't landed, grey before that | `status.json` from `github.com/markt1600/dailymag`, committed by each build after its QA gate; re-checked every 10 min | No |
| Sports · Last 24 Hours (only while a major event is on — World Cup, Grand Slams, Tour de France, Olympics, late playoff rounds, F1…) | Claude + web search (`/api/sports`) | `ANTHROPIC_API_KEY` |
| Fitness (24h / 7d / 30d distance & run pace) | Strava API | Strava env vars |
| COE premiums (latest bidding exercise, all 5 categories) | LTA dataset via data.gov.sg API | No |
| Account balances (ElevenLabs credits, Claude API 30-day spend) — inside the owner-only **For Mark · Private** section | ElevenLabs + Anthropic Admin APIs | See below |
| Happy Day counter (relationship day count, ticks over at midnight SGT) | `HAPPY_DAY` config in `index.html` | No |
| Birthdays (shown 7 days before → 3 days after) | `data/birthdays.json` — edit at **`/admin`** (inline `BIRTHDAYS` array in `index.html` is the fallback) | No |
| Events watchlist (concerts, races, fitness, motorsport — finished events drop off) | `data/events.json` — edit at **`/admin`** (inline `EVENTS` array in `index.html` is the fallback) | No |
| Personal calendar (owner-only): Outlook-style month/week views, Sunday-first, multi-day events as continuous bars, recurring events (weekly/monthly/yearly), birthdays as annual dots | Public events + birthdays + the encrypted private list (`/api/private-events`) | Login |
| Statements · To File (owner-only): statement reminders appear on their day and persist until dismissed | `REMINDERS` config in `index.html`; dismissals in `localStorage` | Login |
| Public holidays (next per region: Singapore, Japan, Vancouver/BC, Hong Kong, Shanghai) | Nager.Date API | No |
| 🔔 Morning digest push (07:20 SGT: build status, birthdays, event starts) | Web Push via `/api/notify` cron — see **Notifications** below | VAPID keys |

Sections whose keys aren't configured simply hide themselves — the page is never empty.

Account balances live inside the owner-only **For Mark · Private** section and appear only while logged in (below).

**Owner login (Google Sign-In):** the footer has a small `login` link that swaps itself for Google's sign-in button. `api/login.js` verifies the Google ID token (signature/expiry via Google's tokeninfo endpoint, audience must match `GOOGLE_CLIENT_ID`, and the verified email must be the owner's — any other Google account gets 403) and mints a 90-day HMAC session (`api/_session.js`, keyed off `SESSION_SECRET` → `ADMIN_SECRET` → `DASHBOARD_SECRET`). The session lives in `localStorage` and is re-verified server-side on every load. While logged in, the body gets the `owner` class, any element with class `owner-only` becomes visible (there's a "For Mark · Private" placeholder section wired up), the balances inside it are fetched with the session token, and `/admin` opens without its password. `logout` clears the session. Logged-out visitors see the page exactly as before.

Setup (one-time): in Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID** (Web application) with `https://marktan.ai` as an authorized JavaScript origin, then set `GOOGLE_CLIENT_ID` in Vercel. Until it's set, the login link explains it isn't configured yet.

## Files

- **`index.html`** — the whole frontend. Fetches `/api/dashboard`, `/api/fitness`, and `/api/balances` and renders them. If the dashboard call fails (e.g. opening the file locally), it falls back to a sample edition instead of breaking.
- **`api/dashboard.js`** — weather, markets, FX, holidays, and the day's edition. The **Stories & Briefs come from MERIDIAN**: it fetches `feed.json` from `github.com/markt1600/dailymag` (published each morning ~7am SGT), maps the desk leads into features (MERIDIAN's cover-teaser top picks) + briefs, and deep-links each back to its desk at dailymag.marktan.ai. No web search runs here — the research is MERIDIAN's. If today's feed hasn't published yet, the raw file is simply the most recent edition (the "last good" stories, dated in the provenance line).
- **`api/sports.js`** — major-event sports results. Its own endpoint (and a cron an hour after the news one) so the two web-search Claude calls never share a rate-limit minute; returns an empty list when nothing major is on, and the section hides itself.
- **`api/fitness.js`** — Strava summary. Exchanges a long-lived refresh token for an access token on each run; cached ~1h.
- **`api/balances.js`** — ElevenLabs credits + Claude API 30-day spend. Never cached. Gated: with `DASHBOARD_SECRET` set, requests need a valid owner login session (Google Sign-In); without the secret set, it's public.
- **`api/admin.js`** — backend for the admin editor. Password-gated (`ADMIN_SECRET`, or `DASHBOARD_SECRET` if that's unset). `GET` returns the current lists; `POST` commits an edited list to `data/*.json` via the GitHub Contents API (needs `GITHUB_TOKEN`). Each save is a commit, so git history *is* the audit trail; the current blob `sha` is round-tripped so a concurrent edit 409s instead of silently clobbering.
- **`data/birthdays.json`, `data/events.json`** — the authoritative Birthdays & Events lists the dashboard fetches. Edited through `/admin`; the inline arrays in `index.html` remain as an offline/local-preview fallback.
- **`api/assist.js`** — the admin page's Claude calendar assistant: takes free-form text, a pasted screenshot, or an uploaded file (image, PDF sent as a native document block, or .docx/.txt/.csv/.ics/.md/.eml — Word text is extracted in the browser, no libraries) plus both event lists, returns proposed adds (routed public/private) and deletions for review. Nothing commits until the owner confirms — confirming saves the ticked changes straight to the relevant list(s); the manual Save buttons are only for edits made directly in the tables. Uses `ANTHROPIC_API_KEY`.
- **`api/private-events.js`** — the private calendar list (travel, personal items). Committed as `data/private-events.enc.json`, AES-256-GCM encrypted (key: `PRIVATE_STORE_KEY` → `PUSH_STORE_KEY` → `VAPID_PRIVATE_KEY`) since the repo is public; GET/POST gated by the owner session or admin secret, with sha-guarded writes.
- **`admin.html`** (served at **`/admin`**) — a self-contained CRUD editor for the two lists: add/edit/delete rows in tables, then Save. The password is remembered in `localStorage`; you can also deep-link with `/admin?token=<secret>`. `noindex`.
- **`vercel.json`** — 60s `maxDuration` for the dashboard/sports functions, 15s for admin, a `/admin → /admin.html` rewrite, and the daily crons that warm the cache.

## Notifications (PWA + Web Push)

The site is an installable PWA (`manifest.json` + `sw.js`) that can deliver a **07:20 SGT morning digest** to your lock screen with the browser closed: MERIDIAN build status (or a ⚠ if it hasn't published), birthdays today/tomorrow/in a week, and watchlist events starting today or tomorrow.

- **Enable:** tap the 🔔 in the footer and enter the admin password (registration is owner-only — the digest names birthdays). On **iPhone**, first Share → **Add to Home Screen**, then open the installed app and tap the bell (iOS only allows push for home-screen apps). Android/desktop Chrome work from the normal browser.
- **Pieces:** `api/push.js` (GET = VAPID public key; POST = register/remove a device), `api/notify.js` (composes + sends the digest; cron `20 23 * * *` UTC = 07:20 SGT; `?token=<ADMIN_SECRET>&dry=1` previews without sending), `sw.js` (receives pushes; the `tag` field means re-sends replace rather than stack).
- **Storage:** device subscriptions live in `data/push-subs.enc.json` — committed to this **public** repo, so they're AES-256-GCM **encrypted at rest** (key derived from `PUSH_STORE_KEY`, falling back to `VAPID_PRIVATE_KEY`); endpoints are private capability URLs and never appear in plaintext.
- Notifications can't be pushed by anyone else: sending requires the VAPID private key, and `/api/notify` additionally rejects callers without `CRON_SECRET` (sent automatically by Vercel's cron) or the admin token.

## Admin (`/admin`)

Editing Birthdays and Events no longer means touching `index.html`. Visit **`/admin`** — if you're signed in on the dashboard (Google owner login) it opens straight into the editor, no separate password; otherwise enter the admin password. Edit both lists in a table UI. There's also a direct link in the **For Mark · Private** section. **Saving commits the JSON to GitHub** (`data/birthdays.json` / `data/events.json`) — which is the version history — and the change goes live once Vercel finishes the redeploy triggered by that commit (~a minute). The dashboard fetches the JSON files at load and only falls back to the inline arrays if the fetch fails, so the committed files always win in production.

Requires two env vars (below): `ADMIN_SECRET` for the password and `GITHUB_TOKEN` (fine-grained, **Contents: Read & Write** on `markt1600/mainpage`) so the function can read and commit. If neither `ADMIN_SECRET` nor `DASHBOARD_SECRET` is set, `/admin` refuses to run — it never opens unprotected.

## Caching & cost

`/api/dashboard` is edge-cached for ~24 hours (`s-maxage=86400`). The Stories & Briefs no longer run a paid web search — they're a cheap fetch of MERIDIAN's `feed.json` — so the daily cost is essentially just the sports call. The cron (`15 23 * * *` UTC = **07:15 SGT**) warms the cache *after* MERIDIAN publishes (it builds ~06:00–07:00 SGT), so the morning edition reflects that day's MERIDIAN. The "↻ new stories" link in the footer forces a fresh, uncached fetch on demand.

## Environment variables

Set these in Vercel → Settings → Environment Variables:

| Variable | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sports.js` | From https://console.anthropic.com. Now used only by the sports function; the dashboard's Stories & Briefs come from MERIDIAN and need no key. |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN` | `fitness.js` | Refresh token from a one-time OAuth authorization with scope `activity:read_all`. |
| `ELEVENLABS_API_KEY` | `balances.js` | elevenlabs.io → Profile → API key. |
| `ANTHROPIC_ADMIN_KEY` | `balances.js` | Admin key (`sk-ant-admin…`) from console → Settings → Organization → Admin keys. Not the same as `ANTHROPIC_API_KEY`. |
| `DASHBOARD_SECRET` | `balances.js`, `admin.js` | Optional. If set, balances are gated behind the owner login; also the fallback password for `/admin` when `ADMIN_SECRET` isn't set. |
| `ADMIN_SECRET` | `admin.js` | Password for the `/admin` editor. Falls back to `DASHBOARD_SECRET`; if neither is set, `/admin` is disabled. |
| `GITHUB_TOKEN` | `admin.js`, `push.js`, `notify.js` | Fine-grained personal access token with **Contents: Read & Write** on `markt1600/mainpage`. Lets `/admin` and the push endpoints read and commit `data/*.json`. Server-only. Optional: `GITHUB_REPO` / `GITHUB_BRANCH` override the defaults `markt1600/mainpage` / `main`. |
| `MERIDIAN_DELIVER_TOKEN` | `deliver.js` | Fine-grained personal access token with **Actions: Read & Write** on `markt1600/dailymag`. Lets the magazine's "⇥ reMarkable" menu item fire the delivery workflows (`deliver-remarkable.yml` / `deliver-special.yml`) on demand. Until it's set the endpoint 502s and the menu item falls back to opening the GitHub Actions page. Optional: `MERIDIAN_REPO` / `MERIDIAN_BRANCH` override `markt1600/dailymag` / `main`. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `push.js`, `notify.js` | Web Push signing keypair (`npx web-push generate-vapid-keys`). The public key goes to the browser; the private key signs every send — without it nobody can push to your devices. |
| `CRON_SECRET` | `notify.js` | Recommended. Vercel sends it as a Bearer header on cron invocations; when set, manual `/api/notify` hits need `?token=<ADMIN_SECRET>` instead. |
| `GOOGLE_CLIENT_ID` | `login.js` | OAuth client ID (Web application) from Google Cloud Console with `https://marktan.ai` as an authorized JavaScript origin. Enables the footer's Google Sign-In owner login. |
| `SESSION_SECRET` | `_session.js` | Optional. Dedicated HMAC key for owner login sessions; defaults to `ADMIN_SECRET`, then `DASHBOARD_SECRET`. |
| `PRIVATE_STORE_KEY` | `private-events.js` | Optional. Dedicated encryption key for the private calendar file; defaults to `PUSH_STORE_KEY`, then `VAPID_PRIVATE_KEY`. |
| `PUSH_STORE_KEY` | `_pushstore.js` | Optional. Separate encryption key for the committed subscription file; defaults to `VAPID_PRIVATE_KEY`. |

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
- **Birthdays** — edit at **`/admin`** (writes `data/birthdays.json`). Each entry is `{ name, month, day }`. They also appear in the personal calendar as small annual dot items (distinct from event blocks). The inline `BIRTHDAYS` array here is only the offline fallback.
- **Events** — edit at **`/admin`** (writes `data/events.json`). Each entry is `{ act, kind, date, endDate, time, repeat, venue, status, note, url }` where `kind` is a short type label ("Concert", "Race", "Fitness", "Motorsport", …) shown on the card, `time` is an optional HH:MM (24h) shown on the card and used for the timed calendar download, `repeat` is an optional `"weekly" | "monthly" | "yearly"` that makes the entry recur in the personal calendar (occurrences keep the original's duration; dates that don't exist — the 31st in a short month, Feb 29 — are skipped) and adds an `RRULE` to the calendar download, and `date: null` marks it TBA. Past events disappear automatically. The inline `EVENTS` array here is only the offline fallback.
- **Cost basis** — the `COST_BASIS` map (Yahoo symbol → average buy-in price) draws a green border around a market tile when the live price is at/above your average and a red border when below.
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
