/** Minimal hash router for the review Code Wiki. No vue-router: the app state
 * is a small discriminated view plus an optional trail stack encoded as hash
 * segments. Parsing is defensive — a corrupt hash falls back to overview. */
import type { TrailFrame, TrailFrameKind } from "./trail";
import { MAX_TRAIL } from "./trail";

export type WikiView =
  | { name: "overview" }
  | { name: "graph" }
  | { name: "structure" }
  | { name: "module"; module: string }
  | { name: "file"; fileId: string; line?: number };

export type WikiRoute = {
  view: WikiView;
  trail: TrailFrame[];
};

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export function parseHash(hash: string): WikiRoute {
  let raw = hash.replace(/^#\/?/, "");
  if (!raw) return { view: { name: "overview" }, trail: [] };
  const lineMatch = raw.match(/[?&]line=(\d+)/);
  const queryLine = lineMatch ? Number(lineMatch[1]) : undefined;

  // Pull off a trailing /trail/<kind>/<id>/... suffix, then parse the view.
  let trail: TrailFrame[] = [];
  const trailIdx = raw.indexOf("/trail/");
  if (trailIdx >= 0) {
    const trailRaw = raw.slice(trailIdx + "/trail/".length).split("?")[0];
    const tparts = trailRaw.split("/");
    for (let i = 0; i + 1 < tparts.length; i += 2) {
      const kind = decode(tparts[i]) as TrailFrameKind;
      const id = decode(tparts[i + 1]);
      if (!kind || !id) continue;
      trail.push({ kind, id, title: id });
    }
    trail = trail.slice(0, MAX_TRAIL);
    raw = raw.slice(0, trailIdx);
  }
  raw = raw.split("?")[0];

  const parts = raw.split("/");
  const head = parts[0];

  if (head === "overview") return { view: { name: "overview" }, trail };
  if (head === "structure") return { view: { name: "structure" }, trail };
  if (head === "graph") return { view: { name: "graph" }, trail };
  if (head === "module" && parts[1])
    return { view: { name: "module", module: decode(parts[1]) }, trail };
  if (head === "file" && parts[1]) {
    const view: WikiView = { name: "file", fileId: decode(parts[1]) };
    if (queryLine) view.line = queryLine;
    return { view, trail };
  }
  if (head === "trail") return { view: { name: "graph" }, trail };
  return { view: { name: "overview" }, trail };
}

export function writeHash(route: WikiRoute): string {
  const v = route.view;
  let base = "#/overview";
  if (v.name === "structure") base = "#/structure";
  else if (v.name === "graph") base = "#/graph";
  else if (v.name === "module") base = "#/module/" + encodeURIComponent(v.module);
  else if (v.name === "file")
    base =
      "#/file/" +
      encodeURIComponent(v.fileId) +
      (v.line ? "?line=" + v.line : "");
  if (route.trail.length) {
    const segs = route.trail
      .slice(0, MAX_TRAIL)
      .map((f) => encodeURIComponent(f.kind) + "/" + encodeURIComponent(f.id))
      .join("/");
    return base + "/trail/" + segs;
  }
  return base;
}
