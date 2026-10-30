import { readFileSync } from "node:fs";

// Behaves like `doubao` in the ways omem relies on: argument errors for the probe, the reply on
// stdout, the session on stderr. Replies "echo:<prompt>" (the file's content when told to read one).
const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const models: Record<string, string[]> = { Auto: ["low", "medium", "high"], "Pro 1": ["low", "medium", "high", "xhigh", "max"] };

const model = opt("--model");
if (model && !models[model]) {
  console.log(`Error: Unsupported --model value. Available models: ${Object.keys(models).join(", ")}. Start doubao without --model and use /model to view available models.`);
  process.exit(1);
}
const effort = opt("--effort");
if (effort && model && !models[model].includes(effort)) {
  console.log(`Error: This model does not support the selected reasoning effort. Available levels: ${models[model].join(", ")}.`);
  process.exit(1);
}
const resume = opt("--resume");
if (resume === "1") {
  console.log("Error: IM request failed: 712017001");
  process.exit(1);
}
let prompt = opt("-p") ?? "";
const file = /读取文件 (.+?)（UTF-8）/.exec(prompt)?.[1];
if (file) prompt = readFileSync(file, "utf8");
if (prompt === "fail") {
  console.log("Error: 无法启动主任务");
  process.exit(1);
}
console.error(JSON.stringify({ type: "session", session_id: resume ?? "s-1" }));
console.log(`echo:${prompt} model=${model ?? ""} effort=${effort ?? ""} env=${process.env.OMEM_TOKEN ?? ""}`);
