import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { runReviewSync } from "../src/review/sync.js";
import { runCodeSync } from "../src/code/sync.js";
import { buildReviewApp } from "../src/review/app.js";

const stores: { store: Store; dir: string }[] = [];
function setup(dir: string) {
  const store = new Store(dir);
  stores.push({ store, dir });
  return store;
}
afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    try { store.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
function git(a: string[], cwd: string) { execFileSync("git", a, { cwd, encoding: "utf8" }); }

const ID_RE = /^(file|sym|cedge|snap|cu)_[a-f0-9]{20,}$/;
function hasBadLabel(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return ID_RE.test(v) || /^[a-f0-9]{40,}$/.test(v);
}

describe("code DTO contract: action keys preserved + human labels", () => {
  it("keeps every contract field and adds display/trail links", async () => {
    const root = mkdtempSync(join(tmpdir(), "omem-dto-"));
    git(["init", "-q", root], root);
    git(["config", "user.email", "t@e.com"], root);
    git(["config", "user.name", "t"], root);
    git(["config", "commit.gpgsign", "false"], root);
    const a = join(root, "apps/server/src/greet.ts");
    mkdirSync(dirname(a), { recursive: true });
    writeFileSync(a, "export function greet(name: string) { return `hi ${name}`; }\n", "utf8");
    git(["add", "-A"], root);
    git(["commit", "-q", "-m", "init"], root);

    const dir = mkdtempSync(join(tmpdir(), "omem-dtodb-"));
    const store = setup(dir);
    await runReviewSync(store, root);
    await runCodeSync(store, root);
    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const hdr = { host: "127.0.0.1:5180", origin: "http://127.0.0.1:5181" };

    // Snapshot keeps commit/parserVersion/fileCount dirty.
    const snap = await app.inject({ method: "GET", url: "/api/review/code/current-snapshot", headers: hdr });
    expect(snap.statusCode).toBe(200);
    const sb = JSON.parse(snap.body);
    for (const k of ["snapshotId","commit","dirty","parserVersion","fileCount","changedCount","partial","capturedAt","repoId","baselineCommit"]) {
      expect(sb[k], "snapshot." + k).not.toBeUndefined();
    }
    expect(sb.shortCommit).toMatch(/^[0-9a-f]{7}$/);

    // File keeps fileId/path/language/removed.
    const files = await app.inject({ method: "GET", url: "/api/review/code/files", headers: hdr });
    const fileRows = JSON.parse(files.body);
    const greet = fileRows.find((f: any) => f.path.endsWith("greet.ts"));
    for (const k of ["fileId","path","language","sizeBytes","removed","contentHash","headSnapshotId","repoId"]) {
      expect(greet[k], "file." + k).not.toBeUndefined();
    }
    expect(greet.displayTitle).toBe("greet.ts");
    expect(greet.displayPath).toBe("apps/server/src/greet.ts");
    expect(greet.trailLink).toMatch(/^#\/code\/file\//);

    // Symbol keeps symbolId/fileId/name/qualifiedName/kind/rangeStart/rangeEnd/signature/fragmentId.
    const syms = await app.inject({ method: "GET", url: `/api/review/code/files/${greet.fileId}/symbols`, headers: hdr });
    const symRows = JSON.parse(syms.body);
    expect(symRows.length).toBeGreaterThan(0);
    for (const s of symRows) {
      for (const k of ["symbolId","fileId","snapshotId","name","qualifiedName","kind","rangeStart","rangeEnd","exported"]) {
        expect(s[k], "symbol." + k).not.toBeUndefined();
      }
      expect(s.symbolName).toBeTruthy();
      expect(s.citationLabel).toContain("greet.ts");
      expect(s.deepLink).toMatch(/^\/api\/review\/code\//);
      expect(s.trailLink).toMatch(/^#\/code\/symbol\//);
      expect(hasBadLabel(s.displayTitle)).toBe(false);
    }

    // Graph edges keep endpoints + status + actionable.
    const g = await app.inject({ method: "GET", url: "/api/review/code/graph", headers: hdr });
    const gBody = JSON.parse(g.body);
    for (const e of gBody.edges) {
      for (const k of ["edgeId","snapshotId","edgeKind","status","origin","fromSymbolId","fromFileId","toSymbolId","toFileId","createdAt","updatedAt"]) {
        expect(e[k], "edge." + k).not.toBeUndefined();
      }
      expect(typeof e.actionable).toBe("boolean");
      if (e.status === "missing" || e.status === "stale") expect(e.actionable).toBe(false);
      expect(hasBadLabel(e.displayTitle)).toBe(false);
      expect(e.deepLink).toMatch(/^\/api\/review\/code\//);
    }

    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});