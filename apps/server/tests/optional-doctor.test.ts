import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  inspectOptionalDependencies,
  formatOptionalReport,
  type ProbeRunner,
} from "../src/cli/doctor.js";
import { assetPath } from "../src/paths.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "omem-optional-doctor-"));
  roots.push(root);
  return root;
}
const missing: ProbeRunner = async () => ({
  code: null,
  errorCode: "ENOENT",
  stdout: "",
  stderr: "not found",
});

describe("optional dependency diagnosis", () => {
  it("keeps a fresh base install usable and distinguishes enabled missing dependencies", async () => {
    const cwd = await workspace();
    const clean = await inspectOptionalDependencies(
      {},
      { cwd, run: missing, platform: "linux", arch: "x64" },
    );
    expect(clean.healthy).toBe(true);
    expect(clean.decisionsConfigured).toBe(false);
    expect(clean.decisionMode).toBe("auto");
    expect(clean.checks.find((check) => check.id === "osdk")?.state).toBe(
      "missing",
    );
    expect(formatOptionalReport(clean)).toContain(
      "https://github.com/lejunyang/one-sdk",
    );
    const enabled = await inspectOptionalDependencies(
      { retrieval: { enabled: true } },
      { cwd, run: missing, platform: "linux", arch: "x64" },
    );
    expect(enabled.healthy).toBe(false);
    expect(
      enabled.checks.find((check) => check.id === "model.memory-zh")?.enabled,
    ).toBe(true);
  });

  it("checks local snapshot structure by default, and only hashes models with explicit verification", async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, "osdk.toml"),
      await readFile(assetPath("config/models.toml")),
    );
    const path = join(cwd, "snapshot");
    await mkdir(join(path, "onnx"), { recursive: true });
    const names = [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "vocab.txt",
      "onnx/model_quantized.onnx",
    ];
    const files = [];
    for (const name of names) {
      const bytes = Buffer.from(name);
      await writeFile(join(path, name), bytes);
      files.push({
        path: name,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const model = {
      repository: "Xenova/bge-small-zh-v1.5",
      revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
      snapshot_path: path,
      files,
    };
    const commands: string[][] = [];
    const run: ProbeRunner = async (_command, args) => {
      commands.push(args);
      if (args[0] === "--version")
        return { code: 0, stdout: "osdk fixture", stderr: "" };
      if (args[2] !== "memory-zh")
        return { code: 1, stdout: "", stderr: "No such file" };
      return {
        code: 0,
        stdout: JSON.stringify({
          model,
          ...(args[1] === "verify" ? { status: "verified" } : {}),
        }),
        stderr: "",
      };
    };
    const options = { cwd, run, platform: "linux" as const, arch: "x64" };
    const regular = await inspectOptionalDependencies(
      { retrieval: { enabled: true } },
      options,
    );
    expect(regular.healthy).toBe(true);
    expect(
      regular.checks.find((check) => check.id === "model.memory-zh")?.state,
    ).toBe("discovered");
    expect(commands.some((args) => args[1] === "verify")).toBe(false);
    const deep = await inspectOptionalDependencies(
      { retrieval: { enabled: true } },
      { ...options, verifyModels: true },
    );
    expect(deep.healthy).toBe(true);
    expect(
      deep.checks.find((check) => check.id === "model.memory-zh")?.state,
    ).toBe("verified");
    expect(
      commands.some(
        (args) => args.join(" ") === "model verify memory-zh --json --offline",
      ),
    ).toBe(true);
    await writeFile(join(path, "onnx/model_quantized.onnx"), "incomplete");
    const damaged = await inspectOptionalDependencies(
      { retrieval: { enabled: false } },
      options,
    );
    expect(damaged.healthy).toBe(false);
    expect(
      damaged.checks.find((check) => check.id === "model.memory-zh"),
    ).toMatchObject({
      installed: true,
      state: "error",
      fix: "omem setup embedding",
    });
  });

  it("does not call an existing Python file ready when its module cannot import", async () => {
    const cwd = await workspace();
    const python = join(cwd, ".osdk/runtime/docling/venv/Scripts/python.exe");
    await mkdir(join(cwd, ".osdk/runtime/docling/venv/Scripts"), {
      recursive: true,
    });
    await writeFile(python, "present but not a working interpreter");
    const commands: { command: string; args: string[] }[] = [];
    const run: ProbeRunner = async (command, args) => {
      commands.push({ command, args });
      if (command === python)
        return {
          code: 0,
          stdout: JSON.stringify({
            python: "3.12.14",
            versions: { docling: "2.133.0" },
            missing: [],
            mismatches: [],
            importError: "No module named docling.document_converter",
          }),
          stderr: "",
        };
      return missing(command, args, { cwd, timeout: 1000 });
    };
    const report = await inspectOptionalDependencies(
      {},
      { cwd, run, platform: "win32", arch: "x64" },
    );
    expect(report.healthy).toBe(false);
    expect(
      report.checks.find((check) => check.id === "documents.python"),
    ).toMatchObject({
      installed: true,
      state: "error",
      path: python,
      fix: "omem setup documents",
    });
    expect(
      commands.find((command) => command.command === python)?.args[0],
    ).toBe("-B");
    expect(commands.some((command) => command.args.includes("sync"))).toBe(
      false,
    );
  });
});
