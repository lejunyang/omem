import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rankEvidence } from "../src/retrieval/ranking.js";
import { loadReviewSearchPolicy } from "../src/review/search-policy.js";
import { KeywordRetrieval } from "../src/retrieval/keyword.js";
import { Store } from "../src/store.js";
import type { SourceCandidate } from "../src/retrieval/port.js";

it("retains the strongest evidence while placing complementary evidence before mirrored passages", () => {
  const hit = (id: string, score: number, snippet: string): SourceCandidate => ({id,fragmentId:id,sourceRevisionId:id,score,snippet,provenance:{actor:null,time:null,source:"file"}});
  const hits=[hit("a",1,"current implementation"),hit("mirror",.99,"current implementation"),hit("background",.95,"design rationale")];
  const vectors=new Map([['a',new Float32Array([1,0])],['mirror',new Float32Array([1,0])],['background',new Float32Array([.6,.8])]]);
  expect(rankEvidence(hits,{text:"implementation",limit:2},vectors).map(h=>h.id)).toEqual(['a','background']);
  expect(rankEvidence(hits,{text:"implementation",limit:3},vectors).map(h=>h.id)).toContain('mirror');
  expect(rankEvidence(hits,{text:"implementation",limit:2,diversify:false},vectors).map(h=>h.id)).toEqual(['a','mirror']);
});

it("applies repository preferences before top-N and allows explicitly searching historical material", () => {
  const dir=mkdtempSync(join(tmpdir(),'review-ranking-')), store=new Store(join(dir,'db'));
  try {
    mkdirSync(join(dir,'config'));
    writeFileSync(join(dir,'config/review-search.json'),JSON.stringify({rules:[{prefix:'docs/prototype/',weight:.2}]}));
    const weight=loadReviewSearchPolicy(dir), paths=new Map<string,string>();
    for(const path of ['docs/prototype/design.md','src/current.ts']) {
      const capture=store.capture({source:'file',externalId:path,title:path,parts:[{type:'text',text:'circuit breaker retry policy'}],context:{}});
      paths.set(capture.revision.fragments[0]!.id,path);
    }
    const retrieval=new KeywordRetrieval(store.db);
    const hits=retrieval.searchSources({text:'circuit breaker',limit:1,sourceWeight:id=>weight(paths.get(id)!,'circuit breaker')});
    expect(paths.get(hits[0]!.id)).toBe('src/current.ts');
    expect(weight('docs/prototype/design.md','查原型里的 circuit breaker')).toBe(1);
    expect(weight('docs/prototype/design.md','docs/prototype/design.md')).toBe(1);
    expect(weight('docs/prototype/design.md','circuit breaker','research')).toBe(1);
    const hidden=retrieval.searchSources({text:'circuit breaker',limit:1,visible:id=>paths.get(id)!=='src/current.ts',sourceWeight:()=>1});
    expect(paths.get(hidden[0]!.id)).toBe('docs/prototype/design.md');
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

it("finds exact AST definitions through original fragments and stops boosting removed symbols", async () => {
  const {runCodeSync}=await import('../src/code/sync.js');
  const {captureRepositoryMaterials}=await import('../src/review/materials.js');
  const dir=mkdtempSync(join(tmpdir(),'review-symbol-search-')),store=new Store(join(dir,'.repo-review/runtime/db'));
  try {
    mkdirSync(join(dir,'apps'));
    writeFileSync(join(dir,'apps/widget.ts'),'export function resolveWidget() { return 42; }\n');
    store.capture({source:'manual',externalId:'note',title:'resolveWidget notes',parts:[{type:'text',text:'resolveWidget background explanation'}],context:{}});
    captureRepositoryMaterials(store,dir);
    await runCodeSync(store,dir);
    const retrieval=new KeywordRetrieval(store.db), hits=retrieval.searchSources({text:'resolveWidget',limit:1});
    expect(hits[0]!.routes).toContain('code-symbol');
    expect(retrieval.readEvidence(hits[0]!.sourceRevisionId,hits[0]!.fragmentId)!.text).toContain('export function resolveWidget');
    expect(retrieval.searchSources({text:'resolveWidget',visible:id=>id!==hits[0]!.id}).every(h=>!h.routes?.includes('code-symbol'))).toBe(true);
    writeFileSync(join(dir,'apps/widget.ts'),'export function replaceWidget() { return 43; }\n');
    captureRepositoryMaterials(store,dir);
    await runCodeSync(store,dir);
    expect(retrieval.searchSources({text:'resolveWidget'}).every(h=>!h.routes?.includes('code-symbol'))).toBe(true);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
