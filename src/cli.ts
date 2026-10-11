#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning on Node 22/24; keep CLI output clean.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w);
});
await import("./cli-main.ts");
