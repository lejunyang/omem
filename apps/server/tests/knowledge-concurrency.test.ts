import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Store } from "../src/store.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";

it("waits for a real concurrent writer instead of losing a knowledge operation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-busy-"));
  const initial = new Store(dir); initial.close();
  let store: Store | undefined;
  const child = spawn(process.execPath, ["--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.stdout.write('ready\\n');setTimeout(()=>{db.exec('COMMIT');db.close();},250);", join(dir, "omem.sqlite")], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
    store = new Store(dir); new KnowledgeRepository(store);
    const result = store.capture({ source: "manual", externalId: "waited", title: "Concurrent capture", parts: [{ type: "text", text: "Fixed material remains available." }], context: {} });
    expect(result.revision.fragments[0]!.text).toBe("Fixed material remains available.");
    expect(await exited).toBe(0);
  } finally { if (child.exitCode === null) child.kill(); store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
