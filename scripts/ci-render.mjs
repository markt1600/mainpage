// CI smoke test: serve the repo, render index.html headlessly, and fail on
// any JavaScript error. API fetches 404 locally — the page is built to fall
// back to sample data, so a clean render here means the frontend is sound.
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 2000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto("http://localhost:8899/index.html", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

const checks = {
  masthead: !!(await page.$(".masthead")),
  projects: (await page.$$("#chips .chip")).length > 0,
  markets: (await page.$$("#markets .mkt")).length > 0,
  weather: (await page.$$("#cities .weather")).length > 0,
};
await browser.close();

for (const [name, ok] of Object.entries(checks)) {
  if (!ok) { console.error(`render check failed: ${name} missing`); process.exit(1); }
}
if (errors.length) {
  console.error("page JS errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("page renders with no JS errors:", Object.keys(checks).join(", "), "all present");
