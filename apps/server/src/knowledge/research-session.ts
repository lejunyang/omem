/** One workflow, one fixed view. Never cache across questions or live jobs. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableDigest } from "../storage/digest.js";
import { researchSnapshot } from "./research-snapshot.js";
import type { ResearchSnapshot } from "./agent-research.js";
import type { KnowledgeRepository, KnowledgeArticle } from "./repository.js";
import type { KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";

export class ResearchSession {
  private root?: string;
  private fixed?: ResearchSnapshot;
  private identity?: string;
  private closed = false;
  constructor(private repository: KnowledgeRepository) {}
  snapshot(materials: KnowledgeMaterial[], articles: KnowledgeArticle[]) {
    if (this.closed) throw Error("Research session has ended");
    const identity = stableDigest({materials: materials.map(m=>[m.key,m.revisionId,m.digest]).sort(), articles: articles.map(a=>[a.document.key,a.revision]).sort()});
    if (this.fixed) {
      if (identity !== this.identity) throw Error("KNOWLEDGE_INPUT_CHANGED: research scope changed within workflow");
      return this.fixed;
    }
    this.root = mkdtempSync(join(tmpdir(), "omem-knowledge-session-"));
    const file = join(this.root, "snapshot.sqlite");
    const db = researchSnapshot({repository:this.repository,materials,articles,file,includeUnanchoredState:true});
    db.close();
    this.identity = identity;
    this.fixed = {file,materials:[...materials],articles:[...articles]};
    return this.fixed;
  }
  close() {
    this.closed = true;
    if (this.root) rmSync(this.root,{recursive:true,force:true});
  }
}
