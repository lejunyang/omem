import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const alias = process.env.osdk_arg_model || "decision-startlux2b";
execFileSync("osdk", ["model", "verify", alias, "--json"], { stdio: "pipe" });
const { model } = JSON.parse(execFileSync("osdk", ["model", "show", alias, "--json"], { encoding: "utf8" }));
const output = resolve(".repo-review/runtime/decision-models/startlux");
mkdirSync(output, { recursive: true });
const child = spawn(resolve(".osdk/runtime/decision/venv/bin/python"), ["-u", resolve("scripts/startlux/evaluate.py"), model.snapshot_path, resolve(output, alias + ".json"), model.revision], {
  stdio: "inherit", env: { ...process.env, PYTHONPATH: resolve(".osdk/runtime/decision/upstream") },
});
child.on("error", error => { throw error; });
child.on("exit", code => process.exit(code ?? 1));
