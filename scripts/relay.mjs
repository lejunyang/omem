#!/usr/bin/env node
/**
 * A temporary, whitelisted command relay for checking omem on machines only reachable
 * over ssh from this one (e.g. a laptop on the same LAN, and a server behind it).
 *
 *   node scripts/relay.mjs [--dir .remote/relay]
 *
 * Something (a person, or an assistant that can only write files here) drops a request
 * into <dir>/inbox/<id>.json:
 *
 *   { "target": "work", "cmd": ["omem", "diag"] }
 *
 * The relay checks it against the whitelist below, runs it on the target over ssh with
 * every argument quoted (no shell expansion of what was sent), and writes
 * <dir>/outbox/<id>.json with exit code, stdout and stderr. Requests run one at a time
 * and everything is logged to <dir>/relay.log. Stop it with Ctrl+C.
 *
 * Targets live in <dir>/config.json (created on first start):
 *
 *   { "targets": {
 *       "work":   { "ssh": "work-host", "repo": "/Users/me/Projects/omem" },
 *       "server": { "via": "work", "ssh": "server-host", "repo": "/home/me/omem" } } }
 *
 * `via` runs the command from that target with a second ssh hop (it needs whatever
 * that hop needs — keys or a Kerberos ticket — to work non-interactively there).
 * `repo` is the omem checkout: `omem …` runs `node <repo>/src/cli.ts …` and git/pnpm
 * run inside it. Without `repo`, `omem` must be on PATH.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argDir = process.argv.indexOf("--dir");
const dir = resolve(argDir > 0 ? process.argv[argDir + 1] : ".remote/relay");
const inbox = join(dir, "inbox");
const outbox = join(dir, "outbox");
const done = join(dir, "done");
for (const d of [inbox, outbox, done]) mkdirSync(d, { recursive: true });
const configFile = join(dir, "config.json");
if (!existsSync(configFile)) {
  writeFileSync(configFile, JSON.stringify({ targets: { work: { ssh: "work-host", repo: "/path/to/omem" } } }, null, 2));
  console.log(`已生成 ${configFile}，填好目标后重新启动。`);
  process.exit(0);
}
const config = JSON.parse(readFileSync(configFile, "utf8"));
const log = (s) => {
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log(line);
  appendFileSync(join(dir, "relay.log"), line + "\n");
};

// ---- whitelist ----------------------------------------------------------------------

const LARK_READ = new Set(["+chat-list", "+chat-messages-list", "+threads-messages-list", "+messages-mget", "+messages-search", "+chat-search"]);
const OMEM = [
  ["diag"],
  ["peer", "list"],
  ["peer", "commands"],
  ["peer", "call"],
  ["peer", "invite"],
  ["peer", "add"],
  ["service", "status"],
  ["service", "logs"],
  ["service", "restart"],
  ["service", "start"],
  ["memories", "stats"],
  ["memories", "check"],
  ["memories", "rejections"],
  ["memories", "prune"],
  ["run"],
  ["items"],
  ["search"],
  ["pull"],
  ["agents"],
  ["space", "list"],
];
const startsWith = (cmd, prefix) => prefix.every((p, i) => cmd[i] === p);

/** Returns the argv to run on the target (relative to the repo when set), or throws why not. */
function check(cmd, target) {
  if (!Array.isArray(cmd) || !cmd.length || cmd.some((a) => typeof a !== "string" || a.length > 4000 || a.includes("\0"))) throw new Error("cmd 必须是字符串数组");
  const [prog, ...rest] = cmd;
  const repo = target.repo;
  switch (prog) {
    case "omem": {
      if (!OMEM.some((p) => startsWith(rest, p))) throw new Error(`不允许的 omem 子命令：${rest.slice(0, 2).join(" ")}`);
      if (rest[0] === "memories" && rest[1] === "prune" && !rest.includes("--dry-run")) throw new Error("memories prune 只允许 --dry-run");
      return { argv: repo ? ["node", `${repo}/src/cli.ts`, ...rest] : ["omem", ...rest], cwd: repo };
    }
    case "git": {
      const ok = [["status"], ["log"], ["diff", "--stat"], ["fetch"], ["pull", "--ff-only"], ["rev-parse"], ["branch"], ["remote", "-v"], ["show", "--stat"]];
      if (!repo) throw new Error("git 需要在目标上配置 repo");
      if (!ok.some((p) => startsWith(rest, p))) throw new Error(`不允许的 git 命令：${rest.join(" ")}`);
      return { argv: ["git", ...rest], cwd: repo };
    }
    case "pnpm": {
      const ok = [["install"], ["run", "build"], ["run", "check"], ["run", "typecheck"], ["exec", "vitest", "run"], ["--version"]];
      if (!repo) throw new Error("pnpm 需要在目标上配置 repo");
      if (!ok.some((p) => startsWith(rest, p))) throw new Error(`不允许的 pnpm 命令：${rest.join(" ")}`);
      return { argv: ["pnpm", ...rest], cwd: repo };
    }
    case "lark-cli": {
      const read = (rest[0] === "auth" && rest[1] === "status") || (rest[0] === "im" && LARK_READ.has(rest[1])) || rest[0] === "--version";
      if (!read) throw new Error("lark-cli 只允许 auth status 和 im 的只读查询");
      if (rest.includes("--as") && rest[rest.indexOf("--as") + 1] !== "user") throw new Error("lark-cli 只允许 --as user");
      return { argv: ["lark-cli", ...rest] };
    }
    case "curl": {
      // GET the local omem API only.
      const url = rest.find((a) => /^https?:\/\//.test(a));
      if (!url || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/api\//.test(url) || rest.some((a) => /^-(X|d|F|T|-data|-request|-upload|-form|o|O|-output)/.test(a))) throw new Error("curl 只允许 GET 本机 omem 的 /api/");
      return { argv: ["curl", "-sS", "--max-time", "120", ...rest] };
    }
    case "sys": {
      const [what, ...more] = rest;
      const n = String(Math.min(5000, Number(more[0]) || 200));
      const table = {
        uptime: ["uptime"],
        date: ["date"],
        hostname: ["hostname"],
        df: ["df", "-h"],
        klist: ["klist"],
        node: ["node", "--version"],
        ps: ["sh", "-c", "ps aux | grep -E 'omem|lark-cli|traex|codex|claude' | grep -v grep"],
        which: ["sh", "-c", "for c in omem node pnpm lark-cli traex codex claude git; do printf '%s: ' $c; command -v $c || echo -; done"],
        "find-repo": ["sh", "-c", "ls -d $HOME/*/omem $HOME/*/*/omem $HOME/*/*/*/omem $HOME/*/*/*/*/omem 2>/dev/null"],
        "omem-home": ["sh", "-c", "ls -la $HOME/.omem $HOME/.omem/service/logs 2>&1; du -sh $HOME/.omem/* 2>/dev/null"],
        "log-out": ["tail", "-n", n, "$HOME/.omem/service/logs/omem.out.log"],
        "log-err": ["tail", "-n", n, "$HOME/.omem/service/logs/omem.err.log"],
      };
      if (!table[what]) throw new Error(`sys 只允许：${Object.keys(table).join(", ")}`);
      return { argv: table[what], raw: what === "log-out" || what === "log-err" };
    }
    default:
      throw new Error(`不允许的程序：${prog}（omem、git、pnpm、lark-cli、curl、sys）`);
  }
}

// ---- running ------------------------------------------------------------------------

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function remoteLine({ argv, cwd, raw }) {
  // $HOME in the fixed sys commands must expand; everything sent in a request is quoted.
  const args = argv.map((a) => (raw && a.startsWith("$HOME/") ? `"${a}"` : q(a))).join(" ");
  return `${cwd ? `cd ${q(cwd)} && ` : ""}${args}`;
}
function sshArgs(name, line, depth = 0) {
  const t = config.targets[name];
  if (!t) throw new Error(`没有目标 ${name}`);
  if (depth > 3) throw new Error("via 层数过多");
  const here = `bash -lc ${q(line)}`;
  if (!t.via) return [...(t.sshOptions ?? []), "-o", "BatchMode=yes", t.ssh, here];
  return sshArgs(t.via, `ssh -o BatchMode=yes ${q(t.ssh)} ${q(here)}`, depth + 1);
}
function exec(args, timeoutMs) {
  return new Promise((res) => {
    const started = Date.now();
    const p = spawn("ssh", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout = (stdout + d).slice(-1_000_000)));
    p.stderr.on("data", (d) => (stderr = (stderr + d).slice(-200_000)));
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    for (const f of readdirSync(inbox).filter((n) => n.endsWith(".json")).sort()) {
      const id = f.replace(/\.json$/, "");
      let req;
      try {
        req = JSON.parse(readFileSync(join(inbox, f), "utf8"));
      } catch {
        continue; // still being written
      }
      renameSync(join(inbox, f), join(done, f));
      let result;
      try {
        const target = config.targets[req.target];
        if (!target) throw new Error(`没有目标 ${req.target}（可用：${Object.keys(config.targets).join(", ")}）`);
        const plan = check(req.cmd, target);
        const long = req.cmd[0] === "pnpm" || (req.cmd[0] === "omem" && (req.cmd[1] === "pull" || (req.cmd[1] === "peer" && req.cmd[2] === "call")));
        log(`${id} → ${req.target}: ${req.cmd.join(" ")}`);
        result = { id, ok: true, ...(await exec(sshArgs(req.target, remoteLine(plan)), Math.min(req.timeoutMs ?? (long ? 900_000 : 180_000), 1_800_000))) };
        log(`${id} ← code ${result.code}, ${result.ms} ms`);
      } catch (e) {
        result = { id, ok: false, error: e.message };
        log(`${id} 拒绝：${e.message}`);
      }
      writeFileSync(join(outbox, `${id}.json`), JSON.stringify({ ...result, request: req }, null, 2));
    }
  } finally {
    busy = false;
  }
}
log(`relay 启动，目录 ${dir}，目标：${Object.keys(config.targets).join(", ")}`);
setInterval(tick, 700);
