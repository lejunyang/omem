import { openCitation } from "../store";

/**
 * What clicking a reference opens: `src:<id>#L1-L9` the original at those lines, `mem:` a memory,
 * `msg:` a message, all in the citation drawer. With a run, `路径:行` (or `路径:起-止`) opens that
 * file of the run's repositories; without one it is not a link.
 */
export function refAction(r: string, runId?: string): (() => void) | null {
  const f = runId ? /^([\w@.~/-]+\.[\w]+)(?::(\d+)(?:-L?(\d+))?)?$/.exec(r.trim().replace(/^`|`$/g, "")) : null;
  if (f && runId) return () => openCitation({ kind: "file", runId, path: f[1], from: f[2] ? +f[2] : undefined, to: f[3] ? +f[3] : f[2] ? +f[2] : undefined }, true);
  const m = /^src:([^#\s]+)(?:#L(\d+)(?:-L?(\d+))?)?/.exec(r);
  if (m) return () => openCitation({ kind: "source", id: m[1], from: m[2] ? +m[2] : undefined, to: m[3] ? +m[3] : undefined }, true);
  const mm = /^(mem|msg):(\S+)/.exec(r);
  if (mm) return () => openCitation({ kind: mm[1] === "mem" ? "memory" : "message", id: mm[2] }, true);
  return null;
}
