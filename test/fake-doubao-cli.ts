import { appendFileSync, fstatSync, readFileSync } from "node:fs";

// Behaves like `doubao` in the ways omem relies on: argument errors for the probe, the reply on
// stdout, the session on stderr. Replies "echo:<prompt>" (the file's content when told to read one).
const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const models: Record<string, string[]> = { Auto: ["low", "medium", "high"], "Pro 1": ["low", "medium", "high", "xhigh", "max"] };

if (args.includes("--help")) {
  if (process.env.FAKE_HELP_LOG) appendFileSync(process.env.FAKE_HELP_LOG, "help\n");
  console.log(process.env.FAKE_CWD_HELP ?? "  -C <dir>  工作目录，必须放在业务参数之前");
  process.exit(0);
}
// Even -p with an inline prompt reads non-terminal stdin. The native bridge cannot read /dev/null.
const input = fstatSync(0);
if (input.isCharacterDevice()) {
  console.error("invalid_arguments: 无法以 UTF-8 格式读取标准输入。");
  process.exit(2);
}
if (input.isSocket()) {
  console.error("internal_error: 无法连接标准输入，任务未启动。请重试");
  process.exit(1);
}
if (process.env.FAKE_DIRECTORY) {
  const directory = opt("-C") ?? opt("--cwd") ?? opt("--directory");
  if (directory && args.indexOf(directory) > args.indexOf("-p")) process.exit(2);
  console.log(JSON.stringify({cwd:process.cwd(),directory})); process.exit(0);
}

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
const context = readFileSync(0, "utf8");
if (context) prompt += `\n\n${context}`;
if (prompt === "fail") {
  console.log("Error: 无法启动主任务");
  process.exit(1);
}
console.error(JSON.stringify({ type: "session", session_id: resume ?? "s-1" }));
if (prompt.endsWith("fail-after-session")) {
  console.log("Error: 任务中断");
  process.exit(1);
}
if (process.env.FAKE_PERMISSION) {
  console.log(JSON.stringify({ better: "平", tier: process.env.FAKE_TIER, reason: opt("--permission-mode") }));
  process.exit(0);
}
console.log(`echo:${prompt} model=${model ?? ""} effort=${effort ?? ""} env=${process.env.OMEM_TOKEN ?? ""}`);
