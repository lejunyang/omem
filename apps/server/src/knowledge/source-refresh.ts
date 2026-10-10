/** Compact hashes survive latest-only originals; they cannot reconstruct old
 * source. Rebinding proposes a NEW artifact, never redirects an old citation. */
import * as ts from "typescript";
import { stableDigest } from "../storage/digest.js";
import { materialSections } from "./structure.js";
import { bindKnowledgeQuotes, type KnowledgeArticle } from "./repository.js";
import type { KnowledgeDocument, KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";

const metadata = (m:KnowledgeMaterial)=>stableDigest([m.title,m.path,m.namespace,m.actorId,m.actorVerifiedBy,m.eventAt,m.quoted,m.forwarded,m.images]);
function syntax(m:KnowledgeMaterial) {
  if (!/\.[cm]?[jt]sx?$/.test(m.path ?? m.title) || m.images.length) return null;
  const sf = ts.createSourceFile(m.path ?? m.title,m.text,ts.ScriptTarget.Latest,true);
  if ((sf as ts.SourceFile & {parseDiagnostics:unknown[]}).parseDiagnostics.length) return null;
  const leaves:unknown[]=[];
  const visit = (node:ts.Node)=>{
    const children=node.getChildren(sf).filter(n=>n.kind!==ts.SyntaxKind.JSDocComment);
    if(children.length)children.forEach(visit);
    else leaves.push([node.kind,node.getText(sf)]);
  };
  visit(sf);
  return stableDigest(leaves);
}
const textAt = (m:KnowledgeMaterial,start:number,end:number)=>m.text.split("\n").slice(start-1,end).join("\n");
function anchor(m:KnowledgeMaterial,start:number,end:number) {
  const context=materialSections(m).filter(s=>s.startLine<=start && s.endLine>=end)
    .sort((a,b)=>(a.endLine-a.startLine)-(b.endLine-b.startLine))[0];
  if(!context)return null;
  return {title:context.title,kind:context.kind,hash:stableDigest(textAt(m,context.startLine,context.endLine)),
    offset:start-context.startLine,length:end-start+1,rangeHash:stableDigest(textAt(m,start,end))};
}
export function sourceFootprints(document:KnowledgeDocument, materials:Map<string,KnowledgeMaterial>) {
  const keys=new Set([...document.citations.filter(c=>c.target.kind==="material").map(c=>c.target.key),
    ...document.sections.flatMap(s=>(s.reviewSources ?? []).map(r=>r.key))]);
  return [...keys].flatMap(key=>{
    const m=materials.get(key);if(!m)return [];
    return [{key,digest:m.digest,revisionId:m.revisionId,metadata:metadata(m),syntax:syntax(m),
      citations:document.citations.filter(c=>c.target.kind==="material" && c.target.key===key).map(c=>({key:c.key,anchor:anchor(m,c.target.startLine!,c.target.endLine!)})),
      backgrounds:document.sections.flatMap(s=>(s.reviewSources ?? []).filter(r=>r.key===key).map(r=>({section:s.key,startLine:r.startLine,endLine:r.endLine,anchor:anchor(m,r.startLine,r.endLine)})))}];
  });
}
type Footprint=ReturnType<typeof sourceFootprints>[number];
export function refreshSourceBindings(previous:KnowledgeArticle, materials:Map<string,KnowledgeMaterial>) {
  const saved=previous.generation.trace.sourceFootprints as Footprint[]|undefined;
  if(!saved?.length)return null;
  // Uncited investigation can carry decisive premises. Without a saved anchor
  // for a changed background input, return to ordinary investigation.
  if((previous.investigation ?? []).some(i=>materials.get(i.key)?.digest!==i.digest &&
    !previous.dependencies.some(d=>d.kind==="material" && d.key===i.key)))return null;
  const document=structuredClone(previous.document);
  const changedCitations:string[]=[],changedSections=new Set<string>(),bindings:unknown[]=[];
  for(const dependency of previous.dependencies) {
    if(dependency.kind!=="material")continue;
    const m=materials.get(dependency.key);if(!m)return null;
    const old=saved.find(f=>f.key===m.key && f.digest===dependency.digest);
    if(old && old.metadata!==metadata(m))return null;
    if(m.digest===dependency.digest)continue;
    // Changed execution, provenance, images or an unknown parser needs normal
    // investigation. Equal syntax is eligibility, not semantic acceptance.
    if(!old?.syntax || old.metadata!==metadata(m) || syntax(m)!==old.syntax)return null;
    const locate=(a:NonNullable<ReturnType<typeof anchor>>|null)=>{
      if(!a)return null;
      const matches=materialSections(m).filter(s=>s.title===a.title && s.kind===a.kind && stableDigest(textAt(m,s.startLine,s.endLine))===a.hash);
      if(matches.length!==1)return null;
      const startLine=matches[0]!.startLine+a.offset,endLine=startLine+a.length-1;
      return endLine<=matches[0]!.endLine && stableDigest(textAt(m,startLine,endLine))===a.rangeHash ? {startLine,endLine} : null;
    };
    for(const c of document.citations.filter(c=>c.target.kind==="material" && c.target.key===m.key)) {
      const range=locate(old.citations.find(s=>s.key===c.key)?.anchor ?? null);if(!range)return null;
      Object.assign(c.target,range);changedCitations.push(c.key);
      document.sections.filter(s=>s.body.includes(`[[${c.key}]]`)).forEach(s=>changedSections.add(s.key));
    }
    for(const s of document.sections) for(const r of s.reviewSources ?? [])if(r.key===m.key) {
      const range=locate(old.backgrounds.find(b=>b.section===s.key && b.startLine===r.startLine && b.endLine===r.endLine)?.anchor ?? null);
      if(!range)return null;Object.assign(r,range);changedSections.add(s.key);
    }
    bindings.push({key:m.key,previousDigest:dependency.digest,currentDigest:m.digest,previousRevision:old.revisionId,currentRevision:m.revisionId});
  }
  if(!bindings.length)return null;
  bindKnowledgeQuotes(document,materials);
  return {document,changedCitations,changedSections:[...changedSections],bindings,previousRevision:previous.revision};
}
