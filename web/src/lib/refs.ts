import { openCitation } from "../store";

/**
 * What clicking a reference opens: `src:<id>#L1-L9` the original at those lines, `mem:` a memory,
 * `msg:` a message, all in the citation drawer. Anything else (a `文件:行`) is not a link.
 */
export function refAction(r: string): (() => void) | null {
  const m = /^src:([^#\s]+)(?:#L(\d+)(?:-L?(\d+))?)?/.exec(r);
  if (m) return () => openCitation({ kind: "source", id: m[1], from: m[2] ? +m[2] : undefined, to: m[3] ? +m[3] : undefined }, true);
  const mm = /^(mem|msg):(\S+)/.exec(r);
  if (mm) return () => openCitation({ kind: mm[1] === "mem" ? "memory" : "message", id: mm[2] }, true);
  return null;
}
