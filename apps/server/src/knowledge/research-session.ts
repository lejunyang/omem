/** One workflow, one fixed view. Never cache across questions or live jobs. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableDigest } from "../storage/digest.js";
import { buildResearchSnapshot } from "./snapshot-build.js";
import type { ResearchSnapshot } from "./agent-research.js";
import type { KnowledgeRepository, KnowledgeArticle } from "./repository.js";
import type { KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";

export class ResearchSession {
  private root?: string;
  private fixed?: ResearchSnapshot;
  private identity?: string;
  private building?: Promise<ResearchSnapshot>;
  private closed = false;
  private controller = new AbortController();
  constructor(private repository: KnowledgeRepository) {}
  async snapshot(materials: KnowledgeMaterial[], articles: KnowledgeArticle[], signal?: AbortSignal) {
    if (this.closed) throw Error("Research session has ended");
    signal?.throwIfAborted();
    const identity = stableDigest({materials: materials.map(m=>[m.key,m.revisionId,m.digest]).sort(), articles: articles.map(a=>[a.document.key,a.revision]).sort()});
    if (this.identity) {
      if (identity !== this.identity) throw Error("KNOWLEDGE_INPUT_CHANGED: research scope changed within workflow");
      return this.wait(this.fixed ? Promise.resolve(this.fixed) : this.building!,signal);
    }
    this.root = mkdtempSync(join(tmpdir(), "omem-knowledge-session-"));
    const file = join(this.root, "snapshot.sqlite");
    this.identity = identity;
    this.building = buildResearchSnapshot({repository:this.repository,materials,articles,file,includeUnanchoredState:true,signal:this.controller.signal}).then(timing=>{
      if(this.closed)throw Error("Research session has ended");
      return this.fixed = {identity:randomUUID(),file,materials:[...materials],articles:[...articles],buildTiming:timing};
    });
    return this.wait(this.building,signal);
  }
  private async wait(promise:Promise<ResearchSnapshot>,signal?:AbortSignal) {
    if (!signal) return promise;
    let abort!:()=>void;
    const cancellation = new Promise<never>((_resolve,reject)=>{
      abort=()=>reject(signal.reason);
      signal.addEventListener("abort",abort,{once:true});
      if(signal.aborted)abort();
    });
    try { return await Promise.race([promise,cancellation]); }
    finally { signal.removeEventListener("abort",abort); }
  }
  close() {
    this.closed = true;
    this.controller.abort(Error("Research session has ended"));
    if (this.root) rmSync(this.root,{recursive:true,force:true});
  }
}
