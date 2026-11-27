#!/usr/bin/env node
const { spawn } = require("node:child_process");

const { CODEX_OMEM_EXEC, CODEX_OMEM_ORIGINAL_PATH, CODEX_PATH, ...env } = process.env;
const [file, ...prefix] = JSON.parse(CODEX_OMEM_EXEC);
if (CODEX_OMEM_ORIGINAL_PATH) env.CODEX_PATH = CODEX_OMEM_ORIGINAL_PATH;
const args = [...prefix, ...process.argv.slice(2)];
if (process.execve) {
  process.execve(file, [file, ...args], env);
} else {
  const child = spawn(file, args, { env, stdio: "inherit", windowsHide: true });
  child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
