import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { runReviewSync } from "../src/review/sync.js";
import { runCodeSync } from "../src/code/sync.js";
import { listUnderstandings } from "../src/code/understanding-store.js";
import { buildReviewApp } from "../src/review/app.js";
import {
  buildUnderstandingModelPort,
  CodeModelUnavailableError,
} from "../src/code/understanding-model.js";
import {
  loadReviewCodeModelConfig,
  buildReviewCodeModel,
} from "../src/review/model-config.js";

type Row = Record<string, unknown>;

const stores: { store: Store; dir: string }[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-cum-"));
  const store = new Store(dir);
  stores.push({ store, dir });
  return store;
}
afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    try { store.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "omem-cum-git-"));
  git(["init", "-q", root], root);
  git(["config", "user.email", "t@example.com"], root);
  git(["config", "user.name", "tester"], root);
  git(["config", "commit.gpgsign", "false"], root);
  return root;
}
function writeFile(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}
function commitAll(root: string, message: string) {
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", message], root);
}

const ALPHA_TS = [
  "export class Alpha {",
  "  greet(): string { return 'hi'; }",
  "}",
  "export function helper(x: number): number { return x; }",
].join("\n") + "\n";

// A real local HTTP "model" — exercises the real fetch() transport, not a fake.
function startFakeModel(handler: (body: string) => { status?: number; body: unknown }) {
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const out = handler(data);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function preparedRepo() {
  const root = makeFixtureRepo();
  writeFile(root, "apps/server/src/alpha.ts", ALPHA_TS);
  commitAll(root, "init");
  const store = setup();
  await runReviewSync(store, root);
  await runCodeSync(store, root);
  const alpha = store.db
    .prepare("SELECT symbol_id FROM code_symbols WHERE name='Alpha' LIMIT 1")
    .get() as Row | undefined;
  if (!alpha) throw new Error("Alpha symbol not found");
  return { root, store, alphaId: String(alpha.symbol_id) };
}

describe("code understanding model port / generation", () => {
  it("no model configured: model-status unavailable, POST is 503, raw graph still works", async () => {
    const { root, store } = await preparedRepo();
    const app = (await buildReviewApp({ store, repoRoot: root })).app;
    const status = await app.inject("/api/review/code/model-status");
    expect(status.statusCode).toBe(200);
    expect(status.json().available).toBe(false);

    const gen = await app.inject({
      method: "POST",
      url: "/api/review/code/understandings/generate",
      payload: { targetId: "apps/server/src/alpha" },
    });
    expect(gen.statusCode).toBe(503);

    // raw graph unaffected
    const graph = await app.inject("/api/review/code/graph");
    expect(graph.statusCode).toBe(200);
    rmSync(root, { recursive: true, force: true });
  });

  it("unsupported transport throws explicitly", () => {
    expect(() => buildUnderstandingModelPort({ transport: "magic" as never })).toThrow(
      CodeModelUnavailableError,
    );
    expect(buildUnderstandingModelPort({ transport: "none" })).toBeNull();
    expect(buildUnderstandingModelPort(null)).toBeNull();
  });

  it("success path: real http model returns narrative, sealed & validated, becomes current", async () => {
    const { root, store, alphaId } = await preparedRepo();
    const narrative = {
      module_responsibilities: ["holds Alpha"],
      boundaries: ["read-only"],
      key_flows: [],
      entry_points: ["Alpha.greet"],
      exit_points: [],
      risks_and_limits: ["model-generated"],
      claims: [
        { text: "Alpha class declared", kind: "raw_fact", node_ids: [alphaId], edge_ids: [], evidence_ids: [] },
      ],
      referenced_node_ids: [alphaId],
      evidence_refs: [],
      unknowns: [],
      confidence: 0.5,
    };
    const model = await startFakeModel(() => ({ body: { text: JSON.stringify(narrative), model: "fixture-model-v1" } }));
    const app = (await buildReviewApp({
      store,
      repoRoot: root,
      codeUnderstandingModel: { transport: "http", endpoint: model.url, model: "configured-model" },
    })).app;

    const gen = await app.inject({
      method: "POST",
      url: "/api/review/code/understandings/generate",
      payload: { targetId: "apps/server/src/alpha" },
    });
    expect(gen.statusCode).toBe(200);
    const json = gen.json();
    expect(json.ok).toBe(true);
    const rows = listUnderstandings(store).filter((r) => String(r.source) === "model-generated");
    expect(rows.length).toBe(1);
    expect(String(rows[0]!.status)).toBe("generated");
    expect(String(rows[0]!.model)).toBe("fixture-model-v1"); // model id from response, not fabricated
    expect(Number(rows[0]!.seed)).toBe(0);
    expect(Number(rows[0]!.verified_by_agent)).toBe(0);
    await model.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("malformed model JSON -> failed row, zero current understanding", async () => {
    const { root, store } = await preparedRepo();
    const model = await startFakeModel(() => ({ body: { text: "not json at all" } }));
    const app = (await buildReviewApp({
      store,
      repoRoot: root,
      codeUnderstandingModel: { transport: "http", endpoint: model.url },
    })).app;
    const gen = await app.inject({
      method: "POST",
      url: "/api/review/code/understandings/generate",
      payload: { targetId: "apps/server/src/alpha" },
    });
    expect(gen.statusCode).toBe(502);
    // no model-generated current row
    expect(listUnderstandings(store).filter((r) => String(r.source) === "model-generated").length).toBe(0);
    await model.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("unknown refs in model output -> rejected row, zero current understanding", async () => {
    const { root, store } = await preparedRepo();
    const narrative = {
      module_responsibilities: ["x"],
      referenced_node_ids: ["does-not-exist"],
      claims: [],
      confidence: 0.5,
    };
    const model = await startFakeModel(() => ({ body: { text: JSON.stringify(narrative), model: "m" } }));
    const app = (await buildReviewApp({
      store,
      repoRoot: root,
      codeUnderstandingModel: { transport: "http", endpoint: model.url },
    })).app;
    const gen = await app.inject({
      method: "POST",
      url: "/api/review/code/understandings/generate",
      payload: { targetId: "apps/server/src/alpha" },
    });
    expect(gen.statusCode).toBe(422);
    expect(gen.json().errors.join(" ")).toMatch(/UNKNOWN_NODE_REFS/);
    expect(listUnderstandings(store).filter((r) => String(r.source) === "model-generated").length).toBe(0);
    await model.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("request timeout aborts the run and records a failed row", async () => {
    const { root, store } = await preparedRepo();
    const model = await startFakeModel(() => {
      // never responds within the budget
      return new Promise(() => {}) as never;
    });
    const app = (await buildReviewApp({
      store,
      repoRoot: root,
      codeUnderstandingModel: { transport: "http", endpoint: model.url },
    })).app;
    const gen = await app.inject({
      method: "POST",
      url: "/api/review/code/understandings/generate",
      payload: { targetId: "apps/server/src/alpha", timeoutMs: 300 },
    });
    expect(gen.statusCode).toBe(502);
    expect(listUnderstandings(store).filter((r) => String(r.source) === "model-generated").length).toBe(0);
    await model.close();
    rmSync(root, { recursive: true, force: true });
  });
});


describe("review model config entry (REVIEW_CODE_MODEL_CONFIG)", () => {
  it("unset path -> no model, never reads personal config", () => {
    expect(loadReviewCodeModelConfig(undefined).transport).toBe("none");
    expect(buildReviewCodeModel(undefined)).toBeNull();
  });

  it("reads only the explicit config file path and builds the http port", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "omem-cfg-")), "model.json");
    writeFileSync(f, JSON.stringify({ transport: "http", endpoint: "http://127.0.0.1:1", model: "from-file" }), "utf8");
    const cfg = loadReviewCodeModelConfig(f);
    expect(cfg.transport).toBe("http");
    expect(cfg.model).toBe("from-file");
    const port = buildReviewCodeModel(f);
    expect(port).not.toBeNull();
    expect(port!.transport).toBe("http");
    rmSync(f, { force: true });
  });

  it("rejects an explicitly unsupported transport in the config file", () => {
    const f = join(mkdtempSync(join(tmpdir(), "omem-cfg-")), "bad.json");
    writeFileSync(f, JSON.stringify({ transport: "magic" }), "utf8");
    expect(() => loadReviewCodeModelConfig(f)).toThrow(CodeModelUnavailableError);
    rmSync(f, { force: true });
  });

  it("rejects a malformed config file loudly", () => {
    const f = join(mkdtempSync(join(tmpdir(), "omem-cfg-")), "bad.json");
    writeFileSync(f, "{ not json", "utf8");
    expect(() => loadReviewCodeModelConfig(f)).toThrow(CodeModelUnavailableError);
    rmSync(f, { force: true });
  });
});