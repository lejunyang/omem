/** Capture UI screenshots for visual review: node scripts/screens.ts [baseUrl] [outDir] */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:4317";
const out = process.argv[3] ?? "screens";
const routes = (process.env.ROUTES ?? "/,/ask,/wiki/zustand,/wiki/zustand/flows/create-and-setstate,/items,/memory,/sources,/runs,/learn,/settings").split(",");
const widths = (process.env.WIDTHS ?? "1440,390").split(",").map(Number);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
for (const width of widths) {
  const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: (process.env.SCHEME as "light" | "dark") ?? "light" });
  for (const r of routes) {
    await page.goto(`${base}/#${r}`);
    await page.waitForTimeout(Number(process.env.WAIT ?? 1200));
    const name = `${out}/${width}-${r.replace(/[^\w-]/g, "_") || "home"}.png`;
    await page.screenshot({ path: name, fullPage: false });
    console.log(name);
  }
  await page.close();
}
await browser.close();
