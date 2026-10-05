import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentProfile,
  ContextManifest,
} from "../../../../packages/contracts/src/index.js";
import {
  developmentProjectSchema,
  implementationResultSchema,
  implementationReviewSchema,
  type DevelopmentProject,
  type ImplementationReview,
} from "../../../../packages/contracts/src/development.js";
import { Store } from "../store.js";
import {
  KnowledgeRepository,
  type KnowledgeArticle,
} from "../knowledge/repository.js";
import { prepareAgentResearch } from "../knowledge/agent-research.js";
import {
  RoleRuntimeGateway,
  type RoleRunTrace,
} from "../agent-runtime/gateway.js";
import { RoleBundleRegistry } from "../agent-runtime/bundles.js";
import {
  codeTools,
  fingerprint,
  git,
  runCommand,
  saveJson,
  snapshotCommit,
  type CommandResult,
} from "./workspace.js";

export type DevelopmentRun = {
  id: string;
  project: DevelopmentProject;
  requirementKey: string;
  requirementRevision: string;
  base: string;
  directory: string;
  checkout: string;
  createdAt: string;
  updatedAt: string;
  state:
    | "created"
    | "coding"
    | "checking"
    | "reviewing"
    | "ready"
    | "blocked"
    | "interrupted"
    | "failed"
    | "applied";
  attempt: number;
  pid: number | null;
  error?: string;
  head?: string;
  checks: CommandResult[];
  review?: ImplementationReview;
  reviewedFingerprint?: string;
};
export class DevelopmentRunner {
  readonly root: string;
  constructor(readonly dataDir: string) {
    this.root = join(resolve(dataDir), "development");
  }
  projectFile(name: string) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(name))
      throw Error("项目别名只能包含字母、数字、下划线和连字符");
    return join(this.root, "projects", name + ".json");
  }
  async register(alias: string, input: unknown) {
    const project = developmentProjectSchema.parse(input);
    project.repository = realpathSync(project.repository);
    const root = (
      await git(project.repository, "rev-parse", "--show-toplevel")
    ).trim();
    if (root !== project.repository)
      throw Error("repository 必须为 Git 仓库根目录");
    if (
      new Set(project.commands.map((c) => c.name)).size !==
      project.commands.length
    )
      throw Error("命令名不能重复");
    if (existsSync(this.projectFile(alias)))
      throw Error("项目已登记；请用不同别名保留原配置");
    saveJson(this.projectFile(alias), project);
    return { alias, ...project };
  }
  projects() {
    const dir = join(this.root, "projects");
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => ({
            alias: f.slice(0, -5),
            ...JSON.parse(readFileSync(join(dir, f), "utf8")),
          }))
      : [];
  }
  file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("无效开发任务 ID");
    return join(this.root, "runs", id, "run.json");
  }
  read(id: string): DevelopmentRun {
    return JSON.parse(readFileSync(this.file(id), "utf8"));
  }
  list() {
    const dir = join(this.root, "runs");
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((id) => existsSync(join(dir, id, "run.json")))
          .map((id) => this.read(id))
      : [];
  }
  save(run: DevelopmentRun) {
    run.updatedAt = new Date().toISOString();
    saveJson(this.file(run.id), run);
  }
  async create(alias: string, key: string, store: Store) {
    const project = developmentProjectSchema.parse(
      JSON.parse(readFileSync(this.projectFile(alias), "utf8")),
    );
    const repository = new KnowledgeRepository(store);
    repository.refresh();
    const article = repository.get(key);
    if (
      article?.reading?.workflow !== "requirement-followup" ||
      !article.document.requirement
    )
      throw Error("请先更新需求跟进页，生成目标、验收项和行动项");
    if (!article.current) throw Error("需求材料已有变化，请先刷新需求页再开工");
    if ((await git(project.repository, "status", "--porcelain")).trim())
      throw Error(
        "目标仓库有未提交改动，请先提交或自行保存；编码任务以当前已提交版本创建独立副本",
      );
    const base = (await git(project.repository, "rev-parse", "HEAD")).trim();
    const id = randomUUID(),
      directory = join(this.root, "runs", id),
      checkout = join(directory, "checkout");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    await git(
      dirname(directory),
      "clone",
      "--quiet",
      "--no-hardlinks",
      "--no-checkout",
      project.repository,
      checkout,
    );
    await git(checkout, "checkout", "--detach", base);
    // Do not inherit remotes capable of publishing changes; the runner only exports a patch.
    await git(checkout, "remote", "remove", "origin");
    const run: DevelopmentRun = {
      id,
      project,
      requirementKey: key,
      requirementRevision: article.revision,
      base,
      directory,
      checkout,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: "created",
      attempt: 0,
      pid: null,
      checks: [],
    };
    saveJson(join(directory, "requirement.json"), article);
    this.save(run);
    return run;
  }
  private acquire(run: DevelopmentRun) {
    const lock = join(run.directory, "lock.json");
    if (existsSync(lock)) {
      const pid = JSON.parse(readFileSync(lock, "utf8")).pid as number;
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) throw Error(`该开发任务仍由进程 ${pid} 运行`);
      unlinkSync(lock);
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid }), {
      flag: "wx",
      mode: 0o600,
    });
    return () => unlinkSync(lock);
  }
  async execute(
    id: string,
    store: Store,
    profile: AgentProfile,
    options: { signal?: AbortSignal; log?: (s: string) => void } = {},
  ) {
    const run = this.read(id);
    if (["ready", "applied"].includes(run.state))
      throw Error("任务已评审或已应用；新需求请新建任务");
    const release = this.acquire(run),
      signal = options.signal ?? new AbortController().signal;
    try {
      if (profile.transport !== "acp")
        throw Error("编码与独立评审需要 ACP Agent");
      // Native tools remain read-only. Actual edits and approved commands go through scoped MCP tools.
      if (!/(?:^|[/\\])(?:traex|traecli)(?:\.exe)?$/.test(profile.command))
        throw Error("当前编码权限适配仅验证了 Traex ACP");
      const args: string[] = [];
      for (let i = 0; i < profile.args.length; i++) {
        const arg = profile.args[i]!;
        if (arg === "--yolo") continue;
        if (
          ["-c", "--config"].includes(arg) &&
          profile.args[i + 1]?.startsWith("sandbox_mode=")
        ) {
          i++;
          continue;
        }
        args.push(arg);
      }
      const safeProfile = {
        ...profile,
        id: "traex",
        args: ["-c", 'sandbox_mode="read-only"', ...args],
      };
      const repository = new KnowledgeRepository(store);
      repository.refresh();
      const article = repository.get(
        run.requirementKey,
        run.requirementRevision,
      );
      if (!article?.document.requirement) throw Error("固定需求版本不可用");
      if (
        repository.get(run.requirementKey)?.revision !==
          run.requirementRevision ||
        !repository.get(run.requirementKey)?.current
      )
        throw Error("需求已变化；保留现有改动，请按新需求创建任务");
      const materials = article.dependencies
        .filter((d) => d.kind === "material")
        .map((d) => {
          const m = repository.resolveMaterial(d.key, d.digest)?.material;
          if (!m) throw Error("固定原件不可用");
          return m;
        });
      if (!materials.length) throw Error("缺少原始需求材料");
      const gateway = new RoleRuntimeGateway(
        new RoleBundleRegistry(),
        join(run.directory, "agents"),
      );
      run.pid = process.pid;
      delete run.error;
      this.save(run);
      const logs = join(run.directory, "checks");
      const log = (message: string) => {
        options.log?.(message);
      };
      const role = async (
        roleId: "coding-agent" | "code-reviewer",
        task: Record<string, unknown>,
      ) => {
        const context: ContextManifest = {
          schema_version: 1,
          job_id: `${run.id}:${run.attempt}:${roleId}`,
          role_id: roleId,
          trusted_context: {
            workspace_id: "personal",
            project_id: null,
            owner_id: "owner",
            observed_at: new Date().toISOString(),
            timezone: "Asia/Shanghai",
            actor_binding: { id: null, verified_by: null },
            source_kind: "file",
            is_forwarded: false,
            producer_kind: "original",
            source_epoch: 1,
            project_trusted: false,
          },
          materials: [
            {
              content_scope: "revision",
              fragment_revision_id: materials[0]!.fragments[0]!.id,
              source_revision_id: materials[0]!.revisionId,
              text: "Read the fixed originals through omem tools.",
            },
          ],
          related_memories: [],
          confirmed_corrections: [],
          task: {
            ...task,
            requirement: article.document.requirement,
            project: run.project.name,
            instructions: run.project.instructions,
            base: run.base,
            checkout: run.checkout,
          },
        };
        const result = await gateway.run({
          roleId,
          profile: safeProfile,
          context,
          signal,
          validateOutput: (out) => {
            const value =
              roleId === "coding-agent"
                ? implementationResultSchema.parse(out)
                : implementationReviewSchema.parse(out);
            const ids = article.document.requirement!.criteria.map((c) => c.id);
            if (
              value.criteria.length !== ids.length ||
              new Set(value.criteria.map((c) => c.id)).size !== ids.length ||
              ids.some((id) => !value.criteria.some((c) => c.id === id))
            )
              throw Error("逐项覆盖所有验收项，不能遗漏或新增标准");
            if (
              "verdict" in value &&
              value.verdict === "accepted" &&
              (value.criteria.some((c) => c.status !== "passed") ||
                value.findings.some((f) => f.priority !== "low"))
            )
              throw Error("仍有未通过验收或必须修复的问题，不能 accepted");
            return value;
          },
          research: (workspace, schema, validate) =>
            prepareAgentResearch({
              repository,
              materials,
              articles: [],
              workspace,
              schema,
              validate,
              tools: codeTools({
                root: run.checkout,
                base: run.base,
                project: run.project,
                readOnly: roleId === "code-reviewer",
                logs,
                signal,
                onCheck: (result) => {
                  run.checks.push(result);
                  this.save(run);
                },
              }),
              retrievalConfig: { enabled: false, osdkModel: "memory-zh" },
            }),
          emit: (type, text) => {
            if (type === "status") log(text);
          },
        });
        saveJson(join(run.directory, `${roleId}-${run.attempt}.json`), result);
        return result;
      };
      for (let cycle = 0; cycle < 3; cycle++) {
        if (signal.aborted) throw Error("CANCELLED");
        run.attempt++;
        run.state = "coding";
        this.save(run);
        log(`编码第 ${run.attempt} 轮`);
        const implementation = await role("coding-agent", {
          review: run.review ?? null,
          instruction:
            "通过代码 MCP 工具在 checkout 实施需求，读取 project_rules 和相关 skills。先读实际代码与原始材料，修复上轮问题，运行适用检查。不能提交/推送/部署，也不能修改需求标准。",
        });
        const written = implementationResultSchema.parse(implementation.result);
        if (written.blockers.length) {
          run.state = "blocked";
          run.error = written.blockers.join("\n");
          break;
        }
        run.head = await snapshotCommit(
          run.checkout,
          `omem implementation ${run.attempt}`,
        );
        run.state = "checking";
        this.save(run);
        const hostChecks: CommandResult[] = [];
        for (const command of run.project.commands.filter(
          (c) => c.required && c.purpose !== "setup",
        )) {
          log(`检查：${command.name}`);
          const result = await runCommand(
            run.checkout,
            run.project,
            command.name,
            logs,
            signal,
          );
          hostChecks.push(result);
          run.checks.push(result);
          this.save(run);
        }
        const beforeReview = await fingerprint(run.checkout);
        // A check that edits source needs another coding/review round; never silently review a different patch.
        if ((await git(run.checkout, "status", "--porcelain")).trim()) {
          run.review = {
            schema_version: 1,
            verdict: "changes_requested",
            summary: "检查命令修改了源码或生成了未忽略文件，请整理后重新验证。",
            criteria: [],
            findings: [],
          };
          continue;
        }
        run.state = "reviewing";
        this.save(run);
        log("独立评审：从原始需求、实际代码和检查结果重新核查");
        const reviewed = await role("code-reviewer", {
          checks: hostChecks,
          instruction:
            "独立评审；没有提供开发者自评。自己读 project_rules、原始材料、实际代码与完整 diff，必要时重新运行登记的检查。所有验收项都要有实际判断，缺少 GUI/Figma/运行前提就说明未验证。不能改代码，不能更改标准。",
        });
        run.review = implementationReviewSchema.parse(reviewed.result);
        const afterReview = await fingerprint(run.checkout);
        if (beforeReview !== afterReview) {
          run.state = "blocked";
          run.error = "评审期间源码发生变化，评审失效；保留副本，需重新运行";
          break;
        }
        if (
          run.review.verdict === "accepted" &&
          hostChecks.every((c) => c.exitCode === 0) &&
          hostChecks.length > 0
        ) {
          repository.refresh();
          const current = repository.get(run.requirementKey);
          if (
            current?.revision !== run.requirementRevision ||
            !current.current
          ) {
            run.state = "blocked";
            run.error =
              "编码期间需求材料发生变化；保留代码，请基于新需求重新评审";
            break;
          }
          run.reviewedFingerprint = afterReview;
          run.state = "ready";
          writeFileSync(
            join(run.directory, "changes.patch"),
            await git(run.checkout, "diff", "--binary", run.base, "HEAD"),
            { mode: 0o600 },
          );
          break;
        }
        if (!hostChecks.length) {
          run.state = "blocked";
          run.error = "项目未配置必需的测试/构建/浏览器检查，不能完成验收";
          break;
        }
        if (
          hostChecks.some((c) => c.exitCode !== 0) &&
          run.review.verdict === "accepted"
        )
          run.review = {
            ...run.review,
            verdict: "changes_requested",
            summary: "必需检查失败，需要修复后重新评审",
          };
        if (run.review.verdict === "blocked") {
          run.state = "blocked";
          break;
        }
      }
      if (!["ready", "blocked"].includes(run.state)) {
        run.state = "blocked";
        run.error =
          "本轮修复次数已用完；保留代码与评审问题，可处理前提后 resume";
      }
      this.save(run);
      return run;
    } catch (error) {
      run.state = signal.aborted ? "interrupted" : "failed";
      run.error = String(error);
      this.save(run);
      throw error;
    } finally {
      run.pid = null;
      this.save(run);
      release();
    }
  }
  async apply(id: string) {
    const run = this.read(id),
      release = this.acquire(run);
    try {
      if (run.state !== "ready" || !run.reviewedFingerprint)
        throw Error("只有独立评审通过的任务可以应用");
      if ((await fingerprint(run.checkout)) !== run.reviewedFingerprint)
        throw Error("评审后代码已变化，请重新验证");
      if (
        (await git(run.project.repository, "rev-parse", "HEAD")).trim() !==
          run.base ||
        (await git(run.project.repository, "status", "--porcelain")).trim()
      )
        throw Error("目标仓库已变化；保留补丁，请人工合并后重新验证");
      const store = new Store(this.dataDir);
      try {
        const repository = new KnowledgeRepository(store);
        repository.refresh();
        const current = repository.get(run.requirementKey);
        if (current?.revision !== run.requirementRevision || !current.current)
          throw Error("需求已变化，旧评审不能应用；请基于新需求重新评审");
      } finally {
        store.close();
      }
      const patch = join(run.directory, "changes.patch");
      // Reconstruct from the reviewed tree, rather than trusting a mutable exported patch.
      writeFileSync(
        patch,
        await git(run.checkout, "diff", "--binary", run.base, "HEAD"),
        { mode: 0o600 },
      );
      if (readFileSync(patch).length) {
        await git(run.project.repository, "apply", "--check", patch);
        await git(run.project.repository, "apply", patch);
      }
      run.state = "applied";
      this.save(run);
      return run;
    } finally {
      release();
    }
  }
}
