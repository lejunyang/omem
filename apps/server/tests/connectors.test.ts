import { it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileInput, gitInput } from "../src/connectors.js";
const exec = promisify(execFile);
it("allows bounded plain text but denies escaped symlinks and binary files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omem-input-"));
  try {
    const root = join(dir, "root");
    await mkdir(root);
    await writeFile(join(root, "note.txt"), "工作记录");
    await writeFile(join(dir, "outside.txt"), "outside");
    await symlink(join(dir, "outside.txt"), join(root, "escape"));
    expect((await fileInput(join(root, "note.txt"), [root])).parts[0]).toEqual({
      type: "text",
      text: "工作记录",
    });
    await expect(fileInput(join(root, "escape"), [root])).rejects.toThrow(
      "outside configured",
    );
    await writeFile(join(root, "binary"), Buffer.from([0, 0, 0]));
    await expect(fileInput(join(root, "binary"), [root])).rejects.toThrow(
      "Binary",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("reads a fixed Git revision, not uncommitted workspace changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omem-git-"));
  try {
    const run = (args: string[]) => exec("git", args, { cwd: dir });
    await run(["init", "-q"]);
    await writeFile(join(dir, "note.txt"), "committed");
    await run(["add", "note.txt"]);
    await run([
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-qm",
      "fixture",
    ]);
    await writeFile(join(dir, "note.txt"), "uncommitted");
    const result = await gitInput(dir, "note.txt", "HEAD", [dir]);
    expect(result.parts[0]).toEqual({ type: "text", text: "committed" });
    expect(result.upstreamVersion).toMatch(/^[a-f0-9]{40}$/);
    await expect(gitInput(dir, "../outside", "HEAD", [dir])).rejects.toThrow(
      "Invalid repository path",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
