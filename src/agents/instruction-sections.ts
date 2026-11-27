import { runKinds, type RunKind } from "./run-kinds.ts";

export type InstructionScene = { kind?: RunKind; chat: boolean; awareness?: boolean; situation?: boolean };
const known = new Set<string>(["chat", "background", "memory-write", "awareness", "situation", ...runKinds]);

export class UnknownScene extends Error {}

export function sceneWords(scene: InstructionScene, tools: Set<string>) {
  return [scene.chat ? "chat" : "background", ...(scene.kind ? [scene.kind] : []),
    ...(tools.has("remember") || tools.has("supersede") ? ["memory-write"] : []),
    ...(scene.awareness ? ["awareness"] : []), ...(scene.situation ? ["situation"] : [])];
}

/** Validate every alternative, including a section hidden by a tool or capability. */
export function toolSections(text: string, tools: Set<string>, localTools = true, scene: string[] = [], matched?: string[], unavailable?: ReadonlySet<string>) {
  const available = (body: string) => !unavailable || ![...body.matchAll(/\b[a-z][a-z0-9_]*\b/g)].some(([word]) => unavailable.has(word));
  return text.replace(/\r\n/g, "\n").split(/(?=^## )/m).flatMap(part => {
    const header = /^(## [^\n]*\n)((?:<!-- (?:tools|needs|when): [^\n]*? -->\n?)+)/.exec(part);
    if (!header) return available(part) ? [part] : [];
    let allowed = true;
    const alternatives: boolean[] = [];
    for (const [, kind, value] of header[2].matchAll(/<!-- (tools|needs|when): (.*?) -->/g)) {
      const words = value.trim().split(/\s+/);
      if (kind === "when") {
        for (const word of words) {
          if (!known.has(word.replace(/^!/, ""))) throw new UnknownScene(`${header[1].trim()} 有未知场景词：${word}`);
        }
        alternatives.push(words.every(word => word.startsWith("!") ? !scene.includes(word.slice(1)) : scene.includes(word)));
      } else if (kind === "tools") {
        allowed &&= words.some(word => tools.has(word));
      } else {
        allowed &&= value === "local" ? localTools : value === "tools" && tools.size > 0;
      }
    }
    const body = header[1] + part.slice(header[0].length);
    if (!allowed || (alternatives.length && !alternatives.includes(true)) || !available(body)) return [];
    if (alternatives.length) matched?.push(body.trimEnd());
    return [body];
  }).join("").trim();
}
