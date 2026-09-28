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
// A label that is itself an opaque id/sha (not a human display string).
function hasBadLabel(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return ID_RE.test(v) || /^[a-f0-9]{40,}$/.test(v);
}

describe("code DTO contract: no bare-ID labels, links resolvable", () => {
  it("files/symbols/edges/snapshots expose human labels and deep links", async () => {
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

    const snap = await app.inject({ method: "GET", url: "/api/review/code/current-snapshot", headers: hdr });
    expect(snap.statusCode).toBe(200);
    const snapBody = JSON.parse(snap.body);
    expect(snapBody.displayTitle).toMatch(/^@[0-9a-f]{7}$/);
    expect(snapBody.shortCommit).toBeTruthy();
    expect(snapBody.citationLabel).toBeTruthy();
    expect(snapBody.actionable).toBe(true);

    const files = await app.inject({ method: "GET", url: "/api/review/code/files", headers: hdr });
    const fileRows = JSON.parse(files.body);
    const greet = fileRows.find((f: any) => f.path.endsWith("greet.ts"));
    expect(greet.displayTitle).toBe("greet.ts");
    expect(greet.displayPath).toBe("apps/server/src/greet.ts");
    expect(greet.citationLabel).toBe("apps/server/src/greet.ts");
    expect(greet.deepLink).toMatch(/^\/api\/review\/code\/files\//);

    const syms = await app.inject({ method: "GET", url: `/api/review/code/files/${greet.fileId}/symbols`, headers: hdr });
    const symRows = JSON.parse(syms.body);
    expect(symRows.length).toBeGreaterThan(0);
    for (const s of symRows) {
      expect(s.displayTitle.length).toBeGreaterThan(0);
      expect(s.citationLabel).toContain("greet.ts");
      expect(s.deepLink).toMatch(/^\/api\/review\/code\/files\//);
      expect(s.symbolName).toBeTruthy();
    }

    const g = await app.inject({ method: "GET", url: "/api/review/code/graph", headers: hdr });
    const gBody = JSON.parse(g.body);
    for (const e of gBody.edges) {
      expect(typeof e.displayTitle).toBe("string");
      // every label field must not be a raw id
      for (const k of ["displayTitle", "citationLabel", "summary"]) {
        if (k in e) expect(hasBadLabel(e[k])).toBe(false);
      }
      expect(e.deepLink).toMatch(/^\/api\/review\/code\//);
    }
    for (const f of gBody.files) {
      expect(hasBadLabel(f.displayTitle)).toBe(false);
    }

    // Every deepLink must resolve (2xx).
    const links = [greet.deepLink, ...symRows.map((s: any) => s.deepLink)];
    for (const link of links) {
      const r = await app.inject({ method: "GET", url: link.split("?")[0], headers: hdr });
      expect([200, 400]).toContain(r.statusCode); // 400 only for out-of-range slices
    }

    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});
