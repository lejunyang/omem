/**
 * Screenshots for visual review, and a check for what sticks out:
 *   node scripts/screens.ts [baseUrl] [outDir] [--report-only]
 * ROUTES (comma-separated, after `#`), WIDTHS (default 1440,390), WAIT (ms), SCHEME, MOTION, CHROMIUM.
 * Each route at each width is captured, then checked (scripts/overflow-check.ts): elements past the viewport,
 * text or boxes running past their own container, text cut off by a clipping ancestor. The problems are
 * printed with a selector path and how many pixels; any problem exits non-zero unless OVERFLOW_REPORT_ONLY=1
 * or --report-only.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { overflowIssues, overflowReport, reportOnly } from "./overflow-check.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const base = args[0] ?? "http://127.0.0.1:4317";
const out = args[1] ?? "screens";
const routes = (process.env.ROUTES ?? "/,/ask,/wiki/zustand,/wiki/zustand/flows/create-and-setstate,/items,/memory,/sources,/runs,/learn,/settings").split(",");
const widths = (process.env.WIDTHS ?? "1440,390").split(",").map(Number);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let problems = 0;
for (const width of widths) {
  // Charts draw themselves in when first seen; a screenshot wants them drawn (MOTION=1 keeps the motion).
  const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: (process.env.SCHEME as "light" | "dark") ?? "light", reducedMotion: process.env.MOTION ? "no-preference" : "reduce" });
  for (const r of routes) {
    await page.goto(`${base}/#${r}`);
    await page.waitForTimeout(Number(process.env.WAIT ?? 1200));
    const name = `${out}/${width}-${r.replace(/[^\w-]/g, "_") || "home"}.png`;
    await page.screenshot({ path: name, fullPage: false });
    const issues = await overflowIssues(page);
    problems += issues.length;
    console.log(name);
    console.log(overflowReport(`[${width}] ${r}`, issues));
  }
  await page.close();
}
await browser.close();
if (problems) {
  console.log(`\n共 ${problems} 处溢出${reportOnly() ? "（只报告，不算失败）" : ""}`);
  if (!reportOnly()) process.exitCode = 1;
}
