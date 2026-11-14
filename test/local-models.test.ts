import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelSource, OSDK_MODELS, osdkModelDir, prepareLocalModel, setOsdkForTests } from "../src/search/local-models.ts";
import { RERANKER, EMBEDDINGS } from "../src/setup.ts";

const RERANK = "onnx-community/bge-reranker-v2-m3-ONNX";
afterEach(() => setOsdkForTests(null));

/** A stand-in for osdk: which aliases it has, and what a download does. */
function fakeOsdk(opts: { available?: boolean; has?: Record<string, string>; sync?: (alias: string) => Promise<void> } = {}) {
  const has: Record<string, string> = { ...(opts.has ?? {}) };
  const synced: string[] = [];
  setOsdkForTests({
    available: () => opts.available ?? true,
    path: (alias) => has[alias] ?? null,
    sync: async (k) => {
      synced.push(k.alias);
      await opts.sync?.(k.alias);
      has[k.alias] = mkdtempSync(join(tmpdir(), "omem-model-"));
    },
  });
  return { has, synced };
}

describe("where a local model comes from", () => {
  it("without osdk a model named by its hub id is downloaded by transformers.js itself", async () => {
    fakeOsdk({ available: false });
    expect(modelSource(RERANK)).toMatchObject({ via: "hub", osdk: false, known: true });
    expect(osdkModelDir(RERANK)).toBeNull();
    await expect(prepareLocalModel(RERANK)).resolves.toBeNull();
  });

  it("with osdk the pinned copy is used when it is there, and a directory the owner set is left alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "omem-model-"));
    fakeOsdk({ has: { "rerank-m3": dir } });
    expect(modelSource(RERANK)).toMatchObject({ via: "osdk", path: dir });
    expect(osdkModelDir(RERANK)).toBe(dir);
    expect(modelSource(dir)).toMatchObject({ via: "local", known: false });
    expect(osdkModelDir(dir)).toBeNull();
    // A model omem does not hand to osdk stays with the hub.
    expect(modelSource("someone/another-model")).toMatchObject({ via: "hub", osdk: true, known: false });
  });

  it("downloads through osdk once, says so while it runs, and loads from its directory afterwards", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const osdk = fakeOsdk({ sync: () => gate });
    const first = prepareLocalModel(RERANK);
    const second = prepareLocalModel(RERANK);
    expect(modelSource(RERANK)).toMatchObject({ via: "hub", syncing: true });
    release();
    const path = await first;
    expect(await second).toBe(path);
    expect(osdk.synced).toEqual(["rerank-m3"]);
    expect(modelSource(RERANK)).toMatchObject({ via: "osdk", path });
    expect(osdkModelDir(RERANK)).toBe(path);
    await expect(prepareLocalModel(RERANK)).resolves.toBe(path);
    expect(osdk.synced).toHaveLength(1);
  });

  it("falls back to the hub when osdk cannot get it, and does not try again straight away", async () => {
    let tries = 0;
    fakeOsdk({ sync: async () => { tries++; throw new Error("连不上下载源"); } });
    await expect(prepareLocalModel(RERANK)).resolves.toBeNull();
    expect(modelSource(RERANK)).toMatchObject({ via: "hub", error: "连不上下载源" });
    await expect(prepareLocalModel(RERANK)).resolves.toBeNull();
    expect(tries).toBe(1);
  });

  it("names the same models as `omem setup` and osdk.toml", () => {
    expect(OSDK_MODELS[RERANKER.repo]).toMatchObject({ alias: RERANKER.alias, files: RERANKER.files });
    expect(OSDK_MODELS[RERANKER.repo].source).toBe(`hf:${RERANKER.repo}@${RERANKER.revision}`);
    for (const e of EMBEDDINGS) expect(OSDK_MODELS[e.repo]?.alias, e.repo).toBe(e.alias);
  });
});
