// Compare the same local SQLite library on both search implementations. Pass an optional baseline
// module next to search.ts so its relative imports resolve; see docs/v2/acceptance.md.
import { deepStrictEqual } from "node:assert";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { search } from "../src/search/search.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "../test/helpers.ts";

const baseline: typeof search | undefined = process.argv[2]
  ? (await import(pathToFileURL(resolve(process.argv[2])).href)).search
  : undefined;
const app = testApp();
const before: number[] = [];
const after: number[] = [];
async function timed(fn: typeof search, query: string, times: number[], warm: boolean) {
  const start = performance.now();
  const hits = await fn(app, query, { spaces: ["personal"], limit: 10 });
  if (!warm) times.push(performance.now() - start);
  return hits;
}
function summary(values: number[]) {
  values.sort((a, b) => a - b);
  return { queries: values.length, p50Ms: values[Math.ceil(values.length * 0.5) - 1], p95Ms: values[Math.ceil(values.length * 0.95) - 1] };
}
try {
  for (let i = 0; i < 300; i++) upsertSource(app, {
    spaceId: "personal", kind: "doc", uri: "sample/" + i, title: "示例" + i, text: `分组 ${i % 10} 测试资料 ${i}`,
  });
  for (let i = 0; i < 220; i++) {
    const query = "分组 " + (i % 10);
    // Alternate who goes first to share cache warmup and host load.
    const first = baseline && i % 2 === 0 ? await timed(baseline, query, before, i < 20) : undefined;
    const hits = await timed(search, query, after, i < 20);
    if (baseline) deepStrictEqual(hits, first ?? await timed(baseline, query, before, i < 20));
  }
  console.log({ ...(baseline && { before: summary(before) }), after: summary(after) });
} finally {
  app.db.close();
  rmSync(app.home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
