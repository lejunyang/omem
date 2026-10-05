import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DevelopmentProject } from "../../../../packages/contracts/src/development.js";
import type { ResearchTool } from "../knowledge/agent-research.js";
import { stableDigest } from "../storage/digest.js";
const execute = promisify(execFile);

export function saveJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}
export async function git(root: string, ...args: string[]) {
  return (
    await execute(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      {
        cwd: root,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) =>
                ![
                  "GIT_DIR",
                  "GIT_WORK_TREE",
                  "GIT_COMMON_DIR",
                  "GIT_INDEX_FILE",
                  "GIT_OBJECT_DIRECTORY",
                  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                ].includes(key),
            ),
          ),
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    )
  ).stdout;
}
/** Resolve every existing component. MCP cannot follow links out of the checkout. */
export function codePath(root: string, path: string) {
  const full = resolve(root, path),
    rel = relative(root, full);
  if (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(".." + sep) ||
    rel.split(sep).includes(".git")
  )
    throw Error("代码路径必须位于本次工作副本内，且不能访问 .git");
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw Error("代码工具不跟随符号链接");
  }
  return full;
}
export async function sourceFiles(root: string) {
  return [
    ...new Set(
      (
        await git(
          root,
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
        )
      )
        .split("\0")
        .filter(Boolean),
    ),
  ];
}
export async function fingerprint(root: string) {
  const entries = [];
  for (const file of (await sourceFiles(root)).sort()) {
    const path = resolve(root, file);
    const stat = (() => {
      try {
        return lstatSync(path);
      } catch {
        return null;
      }
    })();
    entries.push([
      file,
      stat?.mode ?? null,
      stat?.isSymbolicLink()
        ? `link:${readlinkSync(path)}`
        : stat?.isFile()
          ? stableDigest(readFileSync(codePath(root, file)))
          : "deleted",
    ]);
  }
  return stableDigest(entries);
}
export async function snapshotCommit(root: string, message: string) {
  await git(root, "add", "-A");
  if ((await git(root, "diff", "--cached", "--name-only")).trim())
    await git(
      root,
      "-c",
      "user.name=omem",
      "-c",
      "user.email=local@omem.invalid",
      "commit",
      "-m",
      message,
    );
  return (await git(root, "rev-parse", "HEAD")).trim();
}
export function applicableRules(
  root: string,
  file: string,
  project: DevelopmentProject,
) {
  const full = codePath(root, file);
  let dir =
    existsSync(full) && lstatSync(full).isDirectory() ? full : dirname(full);
  const dirs: string[] = [];
  while (dir === root || dir.startsWith(root + sep)) {
    dirs.unshift(dir);
    if (dir === root) break;
    dir = dirname(dir);
  }
  const paths = [
    ...project.ruleFiles,
    ...dirs.flatMap((d) =>
      ["AGENTS.md", "CLAUDE.md"].map((n) => relative(root, join(d, n))),
    ),
  ];
  return [...new Set(paths)]
    .filter((p) => existsSync(codePath(root, p)))
    .map((path) => ({
      path,
      text: readFileSync(codePath(root, path), "utf8"),
    }));
}
export type CommandResult = {
  name: string;
  purpose: string;
  exitCode: number;
  at: string;
  log: string;
  sourceFingerprint: string;
};
export async function runCommand(
  root: string,
  project: DevelopmentProject,
  name: string,
  logs: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const command = project.commands.find((c) => c.name === name);
  if (!command) throw Error("未知检查命令；只能运行本次项目登记的命令");
  const cwd = codePath(root, command.cwd);
  const before = await fingerprint(root);
  let stdout = "",
    stderr = "",
    exitCode = 0;
  try {
    const result = await execute(command.command, command.args, {
      cwd,
      signal,
      timeout: command.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            ![
              "OMEM_TOKEN",
              "GIT_DIR",
              "GIT_WORK_TREE",
              "GIT_INDEX_FILE",
            ].includes(key),
        ),
      ),
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const e = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message: string;
    };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? e.message;
    exitCode = typeof e.code === "number" ? e.code : 1;
  }
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const file = join(logs, `${name}-${randomUUID()}.log`);
  writeFileSync(
    file,
    `${command.command} ${command.args.join(" ")}\n${stdout}\n${stderr}`,
    { mode: 0o600 },
  );
  return {
    name,
    purpose: command.purpose,
    exitCode,
    at: new Date().toISOString(),
    log: file,
    sourceFingerprint: before,
  };
}
export function codeTools(input: {
  root: string;
  base: string;
  project: DevelopmentProject;
  readOnly: boolean;
  logs: string;
  signal?: AbortSignal;
  onCheck: (result: CommandResult) => void;
}): ResearchTool[] {
  const { root, project } = input;
  const rulesRead = new Map<string, string>();
  const requireRules = (path: string) => {
    for (const rule of applicableRules(root, path, project))
      if (rulesRead.get(rule.path) !== stableDigest(rule.text))
        throw Error(`修改前须读取 project_rules: ${rule.path}`);
  };
  const tools: ResearchTool[] = [
    {
      name: "project_rules",
      description:
        "Read project instructions and the ancestor rules for a file. Nested rules govern their directory. Includes configured command inventory and skill entry points; read applicable SKILL.md with read_code before relevant work.",
      shape: { path: z.string().default(".") },
      run: async ({ path }) => {
        const rules = applicableRules(root, path, project);
        rules.forEach((r) => rulesRead.set(r.path, stableDigest(r.text)));
        return {
          instructions: project.instructions,
          rules,
          commands: project.commands,
          skills: (await sourceFiles(root)).filter((f) =>
            /(?:^|\/)(?:\.agents|\.claude|\.trae)\/skills\/.*\/SKILL\.md$/.test(
              f,
            ),
          ),
        };
      },
    },
    {
      name: "list_code",
      description:
        "List tracked and non-ignored new files in the implementation checkout; optional path substring.",
      shape: {
        filter: z.string().default(""),
        offset: z.number().int().nonnegative().default(0),
      },
      run: async ({ filter, offset }) => {
        const files = (await sourceFiles(root)).filter((f) =>
          f.includes(filter),
        );
        return {
          total: files.length,
          files: files.slice(offset, offset + 300),
          nextOffset: offset + 300 < files.length ? offset + 300 : null,
        };
      },
    },
    {
      name: "read_code",
      description:
        "Read implementation code or a project skill with line numbers and content hash. This is the actual editable checkout, distinct from original captured evidence.",
      shape: {
        path: z.string(),
        startLine: z.number().int().positive().default(1),
        endLine: z.number().int().positive().optional(),
      },
      run: ({ path, startLine, endLine }) => {
        const text = readFileSync(codePath(root, path), "utf8"),
          lines = text.split("\n");
        return {
          path,
          hash: stableDigest(text),
          totalLines: lines.length,
          text: lines
            .slice(startLine - 1, endLine ?? startLine + 499)
            .map((l, i) => `${i + startLine}: ${l}`)
            .join("\n"),
        };
      },
    },
    {
      name: "search_code",
      description:
        "Search a literal term in code; paginate matches and optionally filter paths. Read matches and nearby callers to understand context.",
      shape: {
        query: z.string().min(1),
        pathFilter: z.string().default(""),
        offset: z.number().int().nonnegative().default(0),
      },
      run: async ({ query, pathFilter, offset }) => {
        const matches: { path: string; line: number; text: string }[] = [];
        for (const path of (await sourceFiles(root)).filter((f) =>
          f.includes(pathFilter),
        )) {
          try {
            const bytes = readFileSync(codePath(root, path));
            if (bytes.includes(0) || bytes.length > 2_000_000) continue;
            bytes
              .toString()
              .split("\n")
              .forEach((text, i) => {
                if (text.toLowerCase().includes(query.toLowerCase()))
                  matches.push({ path, line: i + 1, text });
              });
          } catch {
            /* Deleted or linked paths remain visible through list_code/diff. */
          }
        }
        return {
          total: matches.length,
          matches: matches.slice(offset, offset + 100),
          nextOffset: offset + 100 < matches.length ? offset + 100 : null,
        };
      },
    },
    {
      name: "inspect_changes",
      description:
        "Inspect the entire diff against the original base, including staged and unstaged edits; new files are listed separately until captured by the host.",
      shape: {},
      run: async () => ({
        diff: await git(root, "diff", input.base, "--"),
        status: await git(root, "status", "--short"),
        base: input.base,
      }),
    },
    {
      name: "run_project_command",
      readOnly: false,
      description:
        "Run a registered setup/test/build/browser/design command by exact name. Commands are trusted project configuration, not taken from source materials. Returns real exit code and log; read log with read_check_log.",
      shape: { name: z.string() },
      run: async ({ name }) => {
        const result = await runCommand(
          root,
          project,
          name,
          input.logs,
          input.signal,
        );
        input.onCheck(result);
        return {
          ...result,
          output: readFileSync(result.log, "utf8").slice(-24000),
        };
      },
    },
    {
      name: "read_check_log",
      description:
        "Read the full output of a check performed during this run, with pagination.",
      shape: {
        file: z.string(),
        offset: z.number().int().nonnegative().default(0),
      },
      run: ({ file, offset }) => {
        const text = readFileSync(codePath(input.logs, file), "utf8");
        return {
          text: text.slice(offset, offset + 24000),
          nextOffset: offset + 24000 < text.length ? offset + 24000 : null,
        };
      },
    },
  ];
  if (!input.readOnly)
    tools.push(
      {
        name: "write_code",
        readOnly: false,
        description:
          "Create or replace a UTF-8 code file after project_rules. expectedHash must match read_code (null only for a new file). Use the actual repository conventions and keep changes scoped to the requirement.",
        shape: {
          path: z.string(),
          expectedHash: z.string().nullable(),
          text: z.string(),
        },
        run: ({ path, expectedHash, text }) => {
          const full = codePath(root, path);
          requireRules(path);
          const hash = existsSync(full)
            ? stableDigest(readFileSync(full, "utf8"))
            : null;
          if (hash !== expectedHash)
            throw Error("文件已变化；先重新读取，不覆盖新内容");
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, text);
          return { path, hash: stableDigest(text) };
        },
      },
      {
        name: "delete_code",
        readOnly: false,
        description:
          "Delete a file only after reading its hash and applicable rules.",
        shape: { path: z.string(), expectedHash: z.string() },
        run: ({ path, expectedHash }) => {
          const full = codePath(root, path);
          requireRules(path);
          if (stableDigest(readFileSync(full, "utf8")) !== expectedHash)
            throw Error("文件已变化");
          unlinkSync(full);
          return { deleted: path };
        },
      },
    );
  return tools;
}
