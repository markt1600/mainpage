// api/networth.js
// Net worth for the For Mark section — components plus a per-day value
// history, stored AES-256-GCM encrypted in the public repo
// (data/networth.enc.json) like the private calendar and to-dos. Nothing
// about money is ever committed in plaintext.
//
// A component is either
//   { label, ccy: "SGD"|"USD", amount }                      — fixed amount
//   { label, symbol, qty }                                   — market-valued:
//     qty × the symbol's live Yahoo price (price currency read from Yahoo;
//     USD converted at the live USD/SGD rate). VWRA.L and ARES work this way.
// Liabilities are negative amounts.
//
//   GET  ?token=  → { components (with computed values), totals:{usd,sgd,fx},
//                     changes:{day,month,ytd}, sha, asOf }
//        Fetches live FX + share prices, totals everything, and — once per
//        Singapore day, on the first owner load — appends a snapshot to the
//        history (what the change figures compare against).
//   POST { components, sha } → update components (409 on a stale sha);
//        today's snapshot is refreshed so edits show up immediately.
//
// Changes (in SGD): day = vs the most recent snapshot before today; month =
// vs the last snapshot of the previous calendar month; ytd = vs the last
// snapshot of the previous year. Each falls back to the oldest snapshot
// available, and is null until there is anything to compare against.
//
// Pricing is all-or-nothing: if FX or any share price can't be fetched the
// request fails rather than recording a snapshot with a hole in it.
//
// Auth: owner session or admin secret. Env: GITHUB_TOKEN; key from
// PRIVATE_STORE_KEY → PUSH_STORE_KEY → VAPID_PRIVATE_KEY.

import crypto from "node:crypto";
import { sessionKey, checkSession } from "./_session.js";

const REPO = (process.env.GITHUB_REPO || "markt1600/mainpage").trim();
const BRANCH = (process.env.GITHUB_BRANCH || "main").trim();
const PATH = "data/networth.enc.json";
const GH = "https://api.github.com";
const MAX_HISTORY = 800; // ~2 years of daily snapshots

function encKey() {
  const secret = (process.env.PRIVATE_STORE_KEY || process.env.PUSH_STORE_KEY || process.env.VAPID_PRIVATE_KEY || "").trim();
  if (!secret) throw new Error("no PRIVATE_STORE_KEY / PUSH_STORE_KEY / VAPID_PRIVATE_KEY set");
  return crypto.createHash("sha256").update("networth:" + secret).digest();
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}
function decrypt(blob) {
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(blob.iv, "base64"));
  d.setAuthTag(Buffer.from(blob.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.ct, "base64")), d.final()]).toString("utf8"));
}

const str = (v, max = 80) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

// Settings ride in the same encrypted blob — the breakeven number is as
// sensitive as the balances. breakeven = the net worth at which the owner's
// budget is exactly covered at the chosen withdrawal rate.
function sanitizeSettings(s) {
  const amount = Number(s && s.breakeven);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    breakeven: amount,
    breakevenCcy: String(s && s.breakevenCcy).toUpperCase() === "USD" ? "USD" : "SGD",
    withdrawalRate: Number.isFinite(Number(s && s.withdrawalRate)) ? Number(s.withdrawalRate) : null,
  };
}

function sanitizeComponents(data) {
  if (!Array.isArray(data)) throw new Error("expected an array");
  if (data.length > 40) throw new Error("too many components");
  return data
    .map((c) => {
      const symbol = str(c && c.symbol, 16).toUpperCase();
      const qty = Number(c && c.qty);
      if (symbol && Number.isFinite(qty) && qty > 0) {
        return { label: str(c && c.label), symbol, qty };
      }
      return {
        label: str(c && c.label),
        ccy: String(c && c.ccy).toUpperCase() === "USD" ? "USD" : "SGD",
        amount: Number.isFinite(Number(c && c.amount)) ? Number(c.amount) : 0,
      };
    })
    .filter((c) => c.label);
}

// The store starts EMPTY on purpose: this file is committed to a public
// repo, so no component, label, or amount may ever appear in source.
// Values are entered through /admin (or a one-time authenticated POST) and
// exist only inside the encrypted blob.
const SEED = [];

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "marktan-networth",
  };
}

async function readStore(ghToken) {
  const res = await fetch(`${GH}/repos/${REPO}/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders(ghToken), cache: "no-store" });
  if (res.status === 404) return { components: SEED, history: [], settings: null, sha: null };
  if (!res.ok) throw new Error(`GitHub read ${res.status}`);
  const j = await res.json();
  try {
    const d = decrypt(JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8")));
    return {
      components: Array.isArray(d.components) ? d.components : SEED,
      history: Array.isArray(d.history) ? d.history : [],
      settings: d.settings || null,
      sha: j.sha || null,
    };
  } catch (_) {
    return { components: SEED, history: [], settings: null, sha: j.sha || null };
  }
}

async function writeStore(ghToken, components, history, settings, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(encrypt({ components, history, settings })) + "\n", "utf8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH}/repos/${REPO}/contents/${PATH}`, {
    method: "PUT",
    headers: { ...ghHeaders(ghToken), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 409) { const err = new Error("conflict"); err.conflict = true; throw err; }
  if (!res.ok) throw new Error(`GitHub write ${res.status}`);
  const j = await res.json();
  return j.content && j.content.sha ? j.content.sha : null;
}

// Yahoo chart meta: live price + its trading currency (keyless; the same
// source as the dashboard's market tiles).
async function yahooMeta(symbol) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) throw new Error(`${symbol} fetch ${r.status}`);
  const meta = (await r.json())?.chart?.result?.[0]?.meta;
  const px = meta?.regularMarketPrice;
  if (!Number.isFinite(px) || px <= 0) throw new Error(`${symbol}: no price`);
  return { px, currency: String(meta.currency || "USD").toUpperCase() };
}

function sgtToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Value every component (market rows via live prices), returning display
// rows + totals. Throws if any needed price is missing — all-or-nothing.
async function priceAndTotal(components) {
  const fx = (await yahooMeta("SGD=X")).px; // USD → SGD
  const symbols = [...new Set(components.filter((c) => c.symbol).map((c) => c.symbol))];
  const metas = Object.fromEntries(await Promise.all(symbols.map(async (s) => [s, await yahooMeta(s)])));
  let sgd = 0;
  const rows = components.map((c) => {
    if (c.symbol) {
      const m = metas[c.symbol];
      const native = c.qty * m.px; // in the symbol's trading currency
      const inSgd = m.currency === "SGD" ? native : native * fx; // non-SGD treated as USD
      sgd += inSgd;
      return { label: c.label, ccy: m.currency === "SGD" ? "SGD" : "USD", amount: native, symbol: c.symbol, qty: c.qty, px: m.px, live: true };
    }
    sgd += c.ccy === "USD" ? c.amount * fx : c.amount;
    return { label: c.label, ccy: c.ccy, amount: c.amount };
  });
  return { rows, totals: { sgd, usd: sgd / fx, fx } };
}

// Surplus/deficit vs the breakeven budget, in SGD terms.
function breakevenFor(settings, totals) {
  const s = sanitizeSettings(settings);
  if (!s) return null;
  const bkSgd = s.breakevenCcy === "USD" ? s.breakeven * totals.fx : s.breakeven;
  return { ...s, surplusSgd: totals.sgd - bkSgd, surplusUsd: (totals.sgd - bkSgd) / totals.fx };
}

// changes vs history, in SGD (abs + pct)
function changesFor(history, today, nowSgd) {
  const prior = history.filter((h) => h && h.d && h.d < today).sort((a, b) => (a.d < b.d ? -1 : 1));
  const pick = (pred) => {
    const c = prior.filter(pred);
    return c.length ? c[c.length - 1] : (prior.length ? prior[0] : null);
  };
  const month = today.slice(0, 7), year = today.slice(0, 4);
  const mk = (snap) => snap ? { sgd: nowSgd - snap.sgd, pct: snap.sgd ? ((nowSgd - snap.sgd) / Math.abs(snap.sgd)) * 100 : null, since: snap.d } : null;
  return {
    day: mk(prior.length ? prior[prior.length - 1] : null),
    month: mk(pick((h) => h.d.slice(0, 7) < month)),
    ytd: mk(pick((h) => h.d.slice(0, 4) < year)),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // OWNER SESSION ONLY — deliberately stricter than the other admin APIs:
  // the shared secret also lives in phone/watch shortcut URLs, and financial
  // data should never be one leaked shortcut away.
  let token = null;
  try { token = new URL(req.url, "http://x").searchParams.get("token"); } catch (_) {}
  const skey = sessionKey();
  if (!skey || !checkSession(token, skey)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const ghToken = (process.env.GITHUB_TOKEN || "").trim();
  if (!ghToken) { res.status(503).json({ error: "GITHUB_TOKEN not set" }); return; }

  try {
    const today = sgtToday();

    if (req.method === "POST") {
      let body = {};
      try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch (_) {}
      const components = sanitizeComponents(body.components);
      const cur = await readStore(ghToken);
      const settings = body.settings !== undefined ? sanitizeSettings(body.settings) : cur.settings;
      const { rows, totals } = await priceAndTotal(components);
      // refresh today's snapshot so edits are reflected in the change figures
      const history = cur.history.filter((h) => h && h.d !== today).concat([{ d: today, sgd: totals.sgd, usd: totals.usd, fx: totals.fx }]).slice(-MAX_HISTORY);
      const sha = await writeStore(ghToken, components, history, settings, body.sha || cur.sha, "networth: update");
      res.status(200).json({ components: rows, totals, changes: changesFor(history, today, totals.sgd), breakeven: breakevenFor(settings, totals), sha, asOf: today });
      return;
    }

    const { components, history, settings, sha } = await readStore(ghToken);
    const { rows, totals } = await priceAndTotal(components);
    let outSha = sha, outHistory = history;
    if (!history.some((h) => h && h.d === today)) {
      // first load of the SGT day — record the snapshot the future compares to
      outHistory = history.concat([{ d: today, sgd: totals.sgd, usd: totals.usd, fx: totals.fx }]).slice(-MAX_HISTORY);
      try {
        outSha = await writeStore(ghToken, components, outHistory, settings, sha, `networth: daily snapshot ${today}`);
      } catch (e) {
        if (!(e && e.conflict)) throw e; // a concurrent snapshot already landed — fine
      }
    }
    res.status(200).json({ components: rows, totals, changes: changesFor(outHistory, today, totals.sgd), breakeven: breakevenFor(settings, totals), sha: outSha, asOf: today });
  } catch (err) {
    if (err && err.conflict) { res.status(409).json({ error: "conflict — reload" }); return; }
    res.status(502).json({ error: String(err && err.message || err).slice(0, 200) });
  }
}
