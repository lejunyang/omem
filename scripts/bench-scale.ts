/**
 * Scale benchmark: build a large synthetic library from a JSONL corpus copied
 * into several spaces, then time full-text search (one space / all spaces),
 * vector search over random vectors, and memory use.
 *
 *   node scripts/bench-scale.ts <corpus.jsonl> [--copies 10] [--home DIR] [--queries queries.jsonl] [--dims 512]
 *   node scripts/bench-scale.ts --requirements [--works 20] [--rounds 5] [--payload-kb 128]
 *   node scripts/bench-scale.ts --runs [--count 20000]
 *   node scripts/bench-scale.ts --source-purge
 *   node scripts/bench-scale.ts --code-rounds
 *   node scripts/bench-scale.ts --directory-import [--files 1200]
 *
 * Vectors are random (embedding a large corpus on CPU takes hours); they only
 * measure the cost of the vector search itself, not its quality.
 */
process.removeAllListeners("warning");
if (process.argv.includes("--directory-import")) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setTimeout: sleep } = await import("node:timers/promises");
  const { App } = await import("../src/core/app.ts");
  const { createSpace, ensurePersonalSpace } = await import("../src/core/spaces.ts");
  const { syncDirectorySpace, syncDirectoryLocally } = await import("../src/sources/import.ts");
  const at = process.argv.indexOf("--files");
  const count = at >= 0 ? Number(process.argv[at + 1]) : 1200;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("--files 要是正整数");
  const results = [];
  for (const isolated of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), "omem-bench-import-"));
    const app = App.open(home);
    ensurePersonalSpace(app);
    const root = join(home, "repo");
    mkdirSync(root);
    createSpace(app, { id: "example", name: "示例仓库", kind: "repo", rootPath: root });
    for (let i = 0; i < count; i++) writeFileSync(join(root, `sample${i}.ts`), Array.from({ length: 50 }, (_, n) => `export function example${n}(value: number) { return value + ${i}; }`).join("\n"));
    let last = performance.now(), maxGap = 0, ticks = 0;
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 5);
    try {
      await sleep(10);
      const start = performance.now();
      const report = await (isolated ? syncDirectorySpace(app, "example") : syncDirectoryLocally(app, "example"));
      const ms = performance.now() - start;
      await sleep(10);
      results.push({ isolated, files: count, imported: report.created, ms: +ms.toFixed(1), maxEventLoopGapMs: +maxGap.toFixed(1), ticks });
    } finally { clearInterval(timer); app.db.close(); rmSync(home, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify(results));
  process.exit(0);
}
if (process.argv.includes("--code-rounds")) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { App } = await import("../src/core/app.ts");
  const { ensurePersonalSpace } = await import("../src/core/spaces.ts");
  const { lastRound } = await import("../src/agents/code-tasks.ts");
  const { codeChainRounds } = await import("../src/agents/code-chain.ts");
  const results = [];
  for (const indexed of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), "omem-bench-rounds-"));
    const app = App.open(home);
    try {
      ensurePersonalSpace(app);
      if (!indexed) app.db.exec("drop index runs_continue_from; drop index runs_parent;");
      // Shaped like the resident server: about 11k runs, inputs of 1–2 KB, 50 delegations of 4 rounds.
      const insert = app.db.prepare("insert into runs(id,kind,space_id,status,title,input,output,parent_id,created_at) values(?,?,'personal','done','示例',?,'{}',?,?)");
      const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      app.db.exec("begin");
      for (let i = 0; i < 10_800; i++) insert.run(`r${i}`, "ask", JSON.stringify({ task: "示例任务正文。".repeat(100) }), i ? `r${i - 1}` : null, at(i));
      for (let d = 0; d < 50; d++) for (let k = 0; k < 4; k++) insert.run(`c${d}-${k}`, "code", JSON.stringify({ task: "示例任务正文。".repeat(100), round: k + 1, ...(k ? { continueFrom: `c${d}-0` } : {}) }), `a${d}`, at(20_000 + d * 10 + k));
      app.db.exec("commit");
      const measure = (fn: () => unknown) => {
        fn();
        const times = Array.from({ length: 50 }, () => { const start = performance.now(); fn(); return performance.now() - start; }).sort((a, b) => a - b);
        return { p50Ms: +times[25].toFixed(3), p90Ms: +times[45].toFixed(3) };
      };
      results.push({ indexed, runs: 11_000, lastRound: measure(() => lastRound(app, "c25-0")), chainRounds: measure(() => codeChainRounds(app, "a25")) });
    } finally { app.db.close(); rmSync(home, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify(results));
  process.exit(0);
}
if (process.argv.includes("--source-purge")) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { App } = await import("../src/core/app.ts");
  const { ensurePersonalSpace } = await import("../src/core/spaces.ts");
  const { purgeSource } = await import("../src/sources/store.ts");
  const results = [];
  for (const indexed of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), "omem-bench-purge-"));
    const app = App.open(home);
    try {
      ensurePersonalSpace(app);
      if (!indexed) app.db.exec("drop index symbols_source; drop index source_locations_source;");
      const source = app.db.prepare("insert into sources(id,space_id,kind,uri,title,hash,text,captured_at,updated_at) values(?,'personal','code',?,'示例文件','hash','','2026-01-01','2026-01-01')");
      const symbol = app.db.prepare("insert into symbols(source_id,space_id,name,qname,kind,line_start,line_end) values(?,'personal',?,?,'function',1,2)");
      const location = app.db.prepare("insert into source_locations(origin_space,uri,source_id) values('personal',?,?)");
      app.db.exec("begin");
      for (let i = 0; i < 20_000; i++) {
        const id = `source-${i}`;
        source.run(id, `${id}.ts`);
        location.run(`${id}.ts`, id);
        for (let j = 0; j < 5; j++) symbol.run(id, `example${j}`, `${id}.example${j}`);
      }
      app.db.exec("commit");
      const start = performance.now();
      for (let i = 0; i < 300; i++) purgeSource(app, `source-${i}`);
      results.push({ indexed, sources: 20_000, symbols: 100_000, purged: 300, ms: +(performance.now() - start).toFixed(1) });
    } finally { app.db.close(); rmSync(home, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify(results));
  process.exit(0);
}
if (process.argv.includes("--vector-loading")) {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const number = (key: string, fallback: number) => {
    const at = process.argv.indexOf(key), n = at < 0 ? fallback : Number(process.argv[at + 1]);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${key} 要是正整数`);
    return n;
  };
  const n = number("--chunks", 650_000), dims = number("--dims", 64);
  const count = number("--spaces", 130), filled = Math.min(count, number("--filled", 57));
  const engineAt = process.argv.indexOf("--engine");
  const { vectorIndex } = engineAt < 0 ? await import("../src/search/vectors.ts") : await import(pathToFileURL(resolve(process.argv[engineAt + 1])).href);
  const home = mkdtempSync(join(tmpdir(), "omem-bench-vectors-"));
  const db = new DatabaseSync(join(home, "omem.db"));
  try {
    db.exec("create table spaces(id text primary key); create table chunks(id integer primary key,space_id text,text text,embedding blob); create index chunks_text_head on chunks(length(text),substr(text,1,80)) where embedding is not null;");
    const space = db.prepare("insert into spaces values(?)");
    for (let i = 0; i < count; i++) space.run(`space-${i}`);
    const ins = db.prepare("insert into chunks values(?,?,?,?)"), v = new Float32Array(dims);
    v[0] = 1;
    db.exec("begin");
    for (let i = 0; i < n; i++) ins.run(i + 1, `space-${i % filled}`, `示例切片 ${i}`, new Uint8Array(v.buffer));
    db.exec("commit");
    if (!process.argv.includes("--without-space-index")) db.exec("create index chunks_vector_space on chunks(space_id,id) where embedding is not null");
    const idx = vectorIndex();
    idx.clear();
    const app = { db } as import("../src/core/app.ts").App;
    const passes = [];
    for (let pass = 0; pass < 2; pass++) {
      let last = performance.now(), maxLagMs = 0, ticks = 0;
      const timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last); last = now; ticks++; }, 5);
      const start = performance.now();
      await idx.prepare(app);
      const ms = performance.now() - start;
      await new Promise((ok) => setTimeout(ok, 10));
      clearInterval(timer);
      passes.push({ pass: pass + 1, ms: +ms.toFixed(1), maxLagMs: +maxLagMs.toFixed(1), ticks });
    }
    console.log(JSON.stringify({ chunks: n, dims, spaces: count, filled, passes, cache: idx.stats() }));
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
  process.exit(0);
}
if (process.argv.includes("--runs")) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { App } = await import("../src/core/app.ts");
  const { ensurePersonalSpace } = await import("../src/core/spaces.ts");
  const { listRuns, countRuns } = await import("../src/agents/runs.ts");
  const { lookupId } = await import("../src/core/lookup.ts");
  const at = process.argv.indexOf("--count");
  const count = at < 0 ? 20000 : Number(process.argv[at + 1]);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("--count 要是正整数");
  const home = mkdtempSync(join(tmpdir(), "omem-bench-runs-"));
  const app = App.open(home);
  try {
    ensurePersonalSpace(app);
    const id = (i: number) => `r${i.toString(36).padStart(19, "0")}`;
    const target = id(Math.floor(count / 2));
    const insert = app.db.prepare("insert into runs(id,kind,space_id,status,title,input,created_at) values(?,'ask','personal','done',?,?,'2026-01-01')");
    app.db.exec("begin");
    for (let i = 0; i < count; i++) insert.run(id(i), `示例问答 ${i}`, JSON.stringify({ task: `${"示例任务正文。".repeat(150)}${i % 1000 === 0 ? target : ""}` }));
    app.db.exec("commit");
    const measure = (fn: () => unknown) => {
      fn();
      const times = Array.from({ length: 20 }, () => { const start = performance.now(); fn(); return performance.now() - start; }).sort((a, b) => a - b);
      return { p50Ms: +times[10].toFixed(3), p90Ms: +times[18].toFixed(3) };
    };
    const text = { q: target, spaceId: "personal", brief: true, limit: 40 };
    const exact = { id: target, spaceId: "personal", brief: true, limit: 40 };
    console.log(JSON.stringify({ count, textSearch: measure(() => [listRuns(app, text), countRuns(app, text)]), exactRun: measure(() => [listRuns(app, exact), countRuns(app, exact)]), globalId: measure(() => lookupId(app, target)) }));
  } finally { app.db.close(); rmSync(home, { recursive: true, force: true }); }
  process.exit(0);
}
if (process.argv.includes("--requirements")) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { App } = await import("../src/core/app.ts");
  const { ensurePersonalSpace } = await import("../src/core/spaces.ts");
  const { createRun, setRunOutput } = await import("../src/agents/runs.ts");
  const { saveReqs } = await import("../src/items/requirements.ts");
  const { addMaterials } = await import("../src/items/materials.ts");
  const { upsertItem } = await import("../src/items/store.ts");
  const { reqWork } = await import("../src/items/work.ts");
  const option = (key: string, fallback: number) => {
    const at = process.argv.indexOf(key);
    const value = at < 0 ? fallback : Number(process.argv[at + 1]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} 要是正整数`);
    return value;
  };
  const works = option("--works", 20), rounds = option("--rounds", 5), bytes = option("--payload-kb", 128) * 1024;
  const home = mkdtempSync(join(tmpdir(), "omem-bench-requirements-"));
  const app = App.open(home);
  try {
    ensurePersonalSpace(app);
    const { keys } = saveReqs(app, [{ op: "add", key: "page", kind: "page", title: "退款验收" }], { by: "user", label: "本人" }, { defaultSpace: "personal", canWrite: () => {}, canRead: () => {} });
    const item = upsertItem(app, undefined, { spaceId: "personal", title: "退款改造", kind: "todo", userId: "owner" }, "user");
    addMaterials(app, item.id, [{ kind: "req", ref: keys.page }], "owner", "user");
    const payload = "+code\n".repeat(Math.ceil(bytes / 6)).slice(0, bytes);
    for (let w = 0; w < works; w++) {
      let root = "";
      for (let round = 0; round < rounds; round++) {
        const r = createRun(app, { kind: "code", spaceId: "personal", title: `退款 ${w} · 第 ${round + 1} 轮`, input: root ? { continueFrom: root } : {} });
        root ||= r.id;
        setRunOutput(app, r.id, { verdict: "approved", patches: [{ patch: payload }] });
        app.db.prepare("update runs set status = 'done' where id = ?").run(r.id);
      }
      addMaterials(app, item.id, [{ kind: "run", ref: root }], "owner", "user");
    }
    const prepare = app.db.prepare.bind(app.db);
    let queries = 0;
    app.db.prepare = (sql) => { queries++; return prepare(sql); };
    const ms: number[] = [];
    for (let i = 0; i < 20; i++) {
      queries = 0;
      const start = performance.now();
      if (reqWork(app, keys.page, "owner").length !== works) throw new Error("编码列表不完整");
      ms.push(performance.now() - start);
    }
    ms.sort((a, b) => a - b);
    console.log(JSON.stringify({ works, rounds: works * rounds, payloadMb: works * rounds * bytes / 1e6, queries, p50Ms: +ms[10].toFixed(2), p90Ms: +ms[18].toFixed(2) }));
  } finally { app.db.close(); rmSync(home, { recursive: true, force: true }); }
  process.exit(0);
}
const { existsSync, readFileSync, statSync } = await import("node:fs");
const { join } = await import("node:path");
const { App } = await import("../src/core/app.ts");
const { createSpace, ensurePersonalSpace, findSpace } = await import("../src/core/spaces.ts");
const { upsertSource } = await import("../src/sources/store.ts");
const { search } = await import("../src/search/search.ts");
const { one, run, tx } = await import("../src/core/db.ts");
const embeddings = await import("../src/search/embeddings.ts");

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const corpusPath = args[0];
const copies = Number(opt("--copies", "10"));
const dims = Number(opt("--dims", "512"));
const home = opt("--home", join(process.cwd(), ".scratch", "bench-scale"));
const queriesPath = opt("--queries", "");

const fresh = !existsSync(join(home, "omem.db"));
const app = App.open(home);
ensurePersonalSpace(app);
const docs = readFileSync(corpusPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string; title?: string });
const mb = () => Math.round(process.memoryUsage().rss / 1e6);
const time = async <T>(f: () => Promise<T> | T) => {
  const t = performance.now();
  const r = await f();
  return { r, ms: performance.now() - t };
};

if (fresh) {
  const t0 = performance.now();
  for (let c = 0; c < copies; c++) {
    const id = `s${c}`;
    if (!findSpace(app, id)) createSpace(app, { id, name: id, kind: "topic" });
    for (const d of docs) upsertSource(app, { spaceId: id, kind: "doc", uri: d.id, title: d.title ?? d.text.slice(0, 30), text: d.text });
    console.error(`space ${id}: ${docs.length} docs, ${Math.round((performance.now() - t0) / 1000)} s, rss ${mb()} MB`);
  }
  // Random unit vectors, written straight into chunks.
  const n = one<{ n: number }>(app.db, "select count(*) n from chunks")!.n;
  const upd = app.db.prepare("update chunks set embedding = ? where id = ?");
  const ids = app.db.prepare("select id from chunks").all() as { id: number }[];
  tx(app.db, () => {
    for (const { id } of ids) {
      const v = new Float32Array(dims);
      let s = 0;
      for (let k = 0; k < dims; k++) s += (v[k] = Math.random() - 0.5) ** 2;
      s = Math.sqrt(s);
      for (let k = 0; k < dims; k++) v[k] /= s;
      upd.run(new Uint8Array(v.buffer), id);
    }
  });
  run(app.db, "insert into kv(key,value) values('embedding_model', 'bench') on conflict(key) do update set value = excluded.value");
  console.error(`built ${n} chunks in ${Math.round((performance.now() - t0) / 1000)} s`);
}

const chunks = one<{ n: number }>(app.db, "select count(*) n from chunks")!.n;
const sources = one<{ n: number }>(app.db, "select count(*) n from sources")!.n;
const dbSize = statSync(join(home, "omem.db")).size;
console.log(`library: ${sources} sources, ${chunks} chunks, db ${Math.round(dbSize / 1e6)} MB`);

const queries = queriesPath ? readFileSync(queriesPath, "utf8").split("\n").filter(Boolean).slice(0, 30).map((l) => (JSON.parse(l) as { text: string }).text) : docs.slice(0, 30).map((d) => d.text.slice(5, 25));
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
async function bench(label: string, f: (q: string) => Promise<unknown>) {
  const ms: number[] = [];
  for (const q of queries) ms.push((await time(() => f(q))).ms);
  console.log(`${label.padEnd(34)} p50 ${pct(ms, 0.5).toFixed(0).padStart(5)} ms  p90 ${pct(ms, 0.9).toFixed(0).padStart(5)} ms  rss ${mb()} MB`);
}

app.config.embeddings.provider = "none";
await bench("fts, one space", (q) => search(app, q, { spaces: ["s3"], limit: 20 }));
await bench("fts, all spaces", (q) => search(app, q, { limit: 20 }));

// Vector search cost with a fake embedder: the query vector is random too.
app.config.embeddings.provider = "local";
embeddings.setEmbedderForTests({
  id: "bench",
  async embed(texts: string[]) {
    return texts.map(() => {
      const v = new Float32Array(dims);
      for (let k = 0; k < dims; k++) v[k] = Math.random() - 0.5;
      return v;
    });
  },
});
const first = await time(() => embeddings.vectorSearch(app, "warm", ["s3"], 50));
console.log(`vector cache load (one space)       ${first.ms.toFixed(0)} ms  rss ${mb()} MB`);
await bench("vector, one space", (q) => embeddings.vectorSearch(app, q, ["s3"], 50));
const all = await time(() => embeddings.vectorSearch(app, "warm", undefined, 50));
console.log(`vector cache load (all spaces)      ${all.ms.toFixed(0)} ms  rss ${mb()} MB`);
await bench("vector, all spaces", (q) => embeddings.vectorSearch(app, q, undefined, 50));
await bench("hybrid search, all spaces", (q) => search(app, q, { limit: 20 }));
