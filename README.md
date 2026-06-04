# The Daily — marktan.ai

A single-page daily dashboard: live Tokyo weather, AI-written news briefs, and a few interesting stories — gathered fresh each morning. Built as a static page plus one Vercel serverless function, in an editorial / broadsheet style.

## How it works

- **`index.html`** — the page visitors see. Static, no build step. It fetches `/api/dashboard` and renders it. If that call ever fails (e.g. local preview before your key is set) it shows a tasteful sample edition instead of breaking.
- **`api/dashboard.js`** — a Vercel serverless function. It pulls Tokyo weather from Open-Meteo (free, no key) and asks Claude — with the web search tool — to write the day's briefs, features, an on-this-day note, and a quote. It returns JSON.
- Your `ANTHROPIC_API_KEY` lives **only** in that function (as a Vercel environment variable) and is never sent to the browser.
- The response carries `Cache-Control: s-maxage=3600, stale-while-revalidate=86400`, so Vercel's edge serves a cached copy instantly and only re-calls Claude about once an hour. A daily cron (`vercel.json`, 06:00 JST) warms the cache each morning.

## Deploy

**Option A — GitHub + Vercel dashboard (easiest)**
1. Push this folder to a GitHub repo.
2. In Vercel, *Add New → Project* and import the repo. No framework preset needed; no build command.
3. *Settings → Environment Variables* → add `ANTHROPIC_API_KEY` = your key (get one at https://console.anthropic.com). Apply to Production.
4. Deploy. Then *Settings → Domains* → add `marktan.ai` and follow the DNS instructions.

**Option B — Vercel CLI**
```bash
npm i -g vercel
cd marktan-dashboard
vercel            # first deploy (preview)
vercel env add ANTHROPIC_API_KEY production
vercel --prod     # deploy to production
```

## Add a project to the top bar

Edit the `PROJECTS` array near the top of the `<script>` in `index.html`:

```js
const PROJECTS = [
  { name: "Choose Your Own Adventure", url: "https://choose.marktan.ai" },
  { name: "Retirement Calculator",     url: "https://retire.marktan.ai" },
  { name: "Excite Bike",               url: "https://excite.marktan.ai" },
  { name: "Your Next Thing",           url: "https://next.marktan.ai" }, // ← just add a line
];
```

Commit and push — Vercel redeploys automatically.

## Tuning

All in `api/dashboard.js`:
- **Model** — `MODEL` defaults to `claude-haiku-4-5-20251001` (fast, cheap). For richer prose swap to `claude-sonnet-4-6`.
- **Refresh rate / cost** — change `s-maxage=3600` (seconds) in the `Cache-Control` header. Larger = fewer Claude calls.
- **Section sizes** — the prompt asks for 5 briefs + 3 features; edit `SCHEMA_PROMPT`.
- **City** — change the `TOKYO` coordinates and the `user_location` block to relocate the weather and news bias.

## Local preview

Opening `index.html` directly works — it falls back to the sample edition since `/api/dashboard` isn't running. To exercise the real function locally, run `vercel dev` (it reads your env vars).

## Notes

- Web search calls can take 15–30s on a cold cache; `maxDuration` is set to 60s in `vercel.json` to allow for it. Thanks to stale-while-revalidate, visitors almost always get the instant cached copy while refreshes happen in the background.
- The weather panel works even without an API key, so the page is never empty.
