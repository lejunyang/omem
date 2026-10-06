import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprint } from "../development/workspace.js";
import { developmentResult } from "../development/results.js";
import {
  attentionPolicySchema,
  workActionSchema,
  type AttentionPolicy,
  type WorkAction,
  type WorkActor,
  type WorkReceipt,
} from "../../../../packages/contracts/src/work.js";
import type { KnowledgePageService } from "../knowledge/page-service.js";
import type { KnowledgeArticle } from "../knowledge/repository.js";
import { requirementBrief } from "../knowledge/requirements.js";
import { RequirementTasks } from "../knowledge/requirement-tasks.js";
import { DevelopmentQueue } from "../development/queue.js";
import type { ResearchTool } from "../knowledge/agent-research.js";
import { stableDigest } from "../storage/digest.js";
import type { DecisionService } from "../decision/service.js";
import { decideWork, workQuestions } from "../decision/work.js";
import { queueOwnerNotice } from "../integrations/lark/owner-notice.js";
import type { WikiPageBrief } from "../../../../packages/contracts/src/knowledge.js";
import { CapabilitySession } from "../capabilities/session.js";
import {
  CapabilityReceipts,
  type ConversationScope,
} from "../capabilities/receipts.js";

type Feedback = {
  id: string;
  kind: string;
  text: string;
  materialKey: string | null;
  active: boolean;
  attention: AttentionPolicy | null;
  at: string;
};

export function assertWorkDelegation(action: WorkAction, actor: WorkActor) {
  if (actor.principalId !== "owner" || actor.visibility !== "private")
    throw Error("需求与编码操作只能由本人私聊交办");
  if (!("delegation" in action)) return;
  const quote = action.delegation.trim();
  if (!quote || !actor.userText.includes(quote))
    throw Error("操作必须来自当前用户的明确交办原话");
  if (action.operation !== "start_development") {
    const verbs =
      action.operation === "resume_development"
        ? /继续|恢复|重试|resume|retry|continue/i
        : action.operation === "apply_development"
          ? /应用|合入|放回|apply|merge/i
          : action.operation === "follow_action"
            ? /待办|跟进|关注|todo|follow/i
            : /取消|停止|不再|移除|unfollow|stop/i;
    if (
      !verbs.test(quote) ||
      (action.operation !== "unfollow_action" &&
        /(?:不要|先别|不必|暂不|别再).{0,16}(?:继续|恢复|重试|应用|合入|放回|跟进|关注|待办)|\b(?:do not|don't)\b/i.test(
          actor.userText,
        ))
    )
      throw Error("尚未收到当前用户明确交办该操作");
    return;
  }
  if (
    !quote ||
    !actor.userText.includes(quote) ||
    /(?:不要|先别|别再|不必|暂不|停止).{0,12}(?:实现|编码|开发|修复|改代码)/.test(
      actor.userText,
    ) ||
    !/(?:请|帮我|替我|你来|交给你|开始|继续|直接|去).{0,36}(?:实现|编码|开发|修复|改代码)|(?:实现|编码|开发|修复).{0,18}(?:交给你|做吧)|(?:please|start|implement|fix|build)\b/i.test(
      quote,
    )
  )
    throw Error("尚未收到当前用户明确交办实现；可先调查和跟进需求");
}

/** Owner preferences are independent from generated facts. All mutation paths
 * return durable receipts; source text and quick-model scores grant no authority. */
export class AssistantWork {
  readonly store;
  readonly inputs: CapabilityReceipts;
  readonly actions: RequirementTasks;
  constructor(
    readonly pages: KnowledgePageService,
    readonly development: DevelopmentQueue,
    readonly decisions?: DecisionService,
  ) {
    this.store = pages.repository.store;
    this.inputs = new CapabilityReceipts(this.store);
    this.actions = new RequirementTasks(this.store);
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS assistant_focus(
      requirement_key TEXT PRIMARY KEY,version INTEGER NOT NULL,attention TEXT NOT NULL,initial_attention TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_work_feedback(
      id TEXT PRIMARY KEY,requirement_key TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,material_key TEXT,attention TEXT,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_work_receipts(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_requirement_notices(requirement_key TEXT PRIMARY KEY,state TEXT NOT NULL);`);
  }
  private plan(key: string) {
    const p = this.pages.repository.pages().find((p) => p.key === key)?.plan;
    if (p?.workflow !== "requirement-followup") throw Error("需求跟进不存在");
    return p;
  }
  private ensure(key: string) {
    const plan = this.plan(key),
      policy = attentionPolicySchema.parse(plan.attention ?? {});
    this.store.db
      .prepare("INSERT OR IGNORE INTO assistant_focus VALUES(?,1,?,?,?)")
      .run(
        key,
        JSON.stringify(policy),
        JSON.stringify(policy),
        new Date().toISOString(),
      );
    return this.store.db
      .prepare("SELECT * FROM assistant_focus WHERE requirement_key=?")
      .get(key)!;
  }
  feedback(key: string): Feedback[] {
    return this.store.db
      .prepare(
        "SELECT * FROM assistant_work_feedback WHERE requirement_key=? ORDER BY created_at,id",
      )
      .all(key)
      .map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        text: String(r.text),
        materialKey: r.material_key ? String(r.material_key) : null,
        attention: r.attention ? JSON.parse(String(r.attention)) : null,
        active: !!r.active,
        at: String(r.created_at),
      }));
  }
  status(key: string) {
    const plan = this.plan(key);
    const row = this.store.db
      .prepare("SELECT * FROM assistant_focus WHERE requirement_key=?")
      .get(key);
    this.pages.repository.refresh();
    const article = this.pages.repository.get(key);
    return {
      key,
      title: plan.title,
      goal: plan.goal,
      version: Number(row?.version ?? 1),
      attention: row
        ? (JSON.parse(String(row.attention)) as AttentionPolicy)
        : attentionPolicySchema.parse(plan.attention ?? {}),
      contextIds: plan.contextIds ?? [],
      materialKeys: plan.materialKeys ?? [],
      maintenance: this.pages.maintenance.status(key),
      current: article?.current ?? false,
      revision: article?.revision ?? null,
      requirement: article?.document.requirement ?? null,
      actionLinks:
        article?.reading?.workflow === "requirement-followup"
          ? this.actions.board(key).links
          : [],
      questions: article?.document.questions ?? [],
      feedback: this.feedback(key),
      development: this.development
        .list()
        .filter((t) => t.key === key)
        .map((t) => this.taskView(t)),
    };
  }
  private taskView(t: ReturnType<DevelopmentQueue["read"]>) {
    return {
      id: t.id,
      key: t.key,
      project: t.project,
      state: t.job.state,
      operation: t.operation,
      phase: t.run?.state ?? "queued",
      message: t.message,
      error: t.job.lastError ?? t.run?.error,
      checks: t.run?.checks.map((c) => ({
        name: c.name,
        exitCode: c.exitCode,
      })),
      review: t.run?.review,
      runId: t.runId,
      outcome: t.runId ? developmentResult(this.store, t.runId) : null,
      conversationId: t.conversationId,
      createdAt: t.createdAt,
      delivery: t.run
        ? {
            location: "isolated_checkout",
            checkout: t.run.checkout,
            sourceRepository: t.run.project.repository,
            base: t.run.base,
            head: t.run.head,
            requirementRevision: t.run.requirementRevision,
            applied: t.run.state === "applied",
            meaning:
              t.run.state === "applied"
                ? "已将本次补丁应用到登记仓库；没有由此推断已推送或上线。"
                : "编码和检查在独立副本进行；ready 表示副本完成本地检查与独立评审。登记仓库尚未应用补丁，原代码不变是预期行为。",
          }
        : null,
    };
  }
  async result(taskId: string, startLine = 1, limit = 200) {
    const task = this.development.read(taskId),
      run = task.run;
    if (!run)
      return {
        ...this.taskView(task),
        diff: null,
        matchesReviewed: null,
        inspectionError: null,
        reason: "尚未建立编码副本",
      };
    const patch = join(run.directory, "changes.patch");
    const lines = existsSync(patch)
      ? readFileSync(patch, "utf8").split("\n")
      : null;
    let matchesReviewed: boolean | null = null,
      inspectionError: string | null = null;
    if (run.reviewedFingerprint) {
      try {
        matchesReviewed =
          (await fingerprint(run.checkout)) === run.reviewedFingerprint;
      } catch (error) {
        inspectionError =
          error instanceof Error ? error.message : String(error);
      }
    }
    return {
      ...this.taskView(task),
      matchesReviewed,
      reviewedFingerprint: run.reviewedFingerprint ?? null,
      inspectionError,
      checks: run.checks,
      diff: lines
        ? {
            origin: "saved_reviewed_patch",
            startLine,
            totalLines: lines.length,
            text: lines.slice(startLine - 1, startLine - 1 + limit).join("\n"),
            nextLine:
              startLine - 1 + limit < lines.length ? startLine + limit : null,
          }
        : null,
      note: "检查和评审对应本次独立副本。已保存差异对应评审时的结果；matchesReviewed 为 false 或 null 时不能声称当前文件仍与已评审版本一致。不要在旧原件或登记仓库重跑检查来否定独立副本的结果。",
    };
  }
  catalog() {
    return {
      requirements: this.pages.repository
        .pages()
        .filter((p) => p.plan?.workflow === "requirement-followup")
        .map((p) => {
          const s = this.status(p.key);
          return {
            key: s.key,
            title: s.title,
            goal: s.goal,
            version: s.version,
            attention: s.attention,
            contextIds: s.contextIds,
            maintenance: s.maintenance,
            current: s.current,
          };
        }),
      projects: this.development.runner.projects().map((p) => ({
        alias: p.alias,
        name: p.name,
        repository: p.repository,
        commands: p.commands,
        capabilities: p.capabilities ?? [],
      })),
      development: this.development.list().map((t) => this.taskView(t)),
      capabilities: {
        tracking: this.pages.available,
        coding: !!this.development.profile,
        provider: "traex",
        externalCapabilities: this.development.runner.capabilities.list(),
      },
    };
  }
  capabilitySession(
    directory: string,
    signal?: AbortSignal,
    onActivity?: () => void,
    scope?: ConversationScope,
  ) {
    const registry = this.development.runner.capabilities;
    return new CapabilitySession(
      registry,
      registry.references(registry.list().map((p) => p.id)),
      {
        directory: join(directory, "external-inputs"),
        cwd: directory,
        signal,
        onActivity,
        decisions: this.decisions,
        onReceipt: scope
          ? (from, id) => this.inputs.save(scope, from, id)
          : undefined,
      },
    );
  }
  tools(): ResearchTool[] {
    return [
      {
        name: "work_catalog",
        readOnly: true,
        description:
          "List saved requirement follows, attention policies, registered coding projects and durable development tasks. Read before selecting identities; do not ask the user to run CLI commands.",
        shape: {},
        run: () => this.catalog(),
      },
      {
        name: "work_status",
        readOnly: true,
        description:
          "Read current requirement facts, actions and their personal todo links, human feedback, attention/version and background coding/check/review status. Use revision and action IDs for follow_action/unfollow_action.",
        shape: { key: z.string() },
        run: ({ key }) => this.status(key),
      },
      {
        name: "work_result",
        readOnly: true,
        description:
          "Read a development task's delivery location, saved reviewed patch (paginated), actual check results and independent review. Before proposing apply_development, require phase=ready and matchesReviewed=true and copy reviewedFingerprint. Does not rerun checks or apply a patch.",
        shape: {
          taskId: z.string(),
          startLine: z.number().int().positive().default(1),
          limit: z.number().int().min(1).max(400).default(200),
        },
        run: ({ taskId, startLine, limit }) =>
          this.result(taskId, startLine, limit),
      },
      {
        name: "work_triage",
        readOnly: true,
        description:
          "Optional fast-model advice on relevance, change type and missing background of one material against a requirement's attention. Not permission or verified facts. Unknown/unavailable means investigate normally.",
        shape: { key: z.string(), materialKey: z.string() },
        run: async ({ key, materialKey }, snapshot) => {
          const m = snapshot.materials.find((m) => m.key === materialKey);
          if (!m) throw Error("材料不在本次范围");
          const state = this.status(key);
          const result = this.decisions
            ? await this.decisions.decide(
                {
                  attention: state.attention,
                  goal: state.goal,
                  requirement: state.requirement,
                  material: {
                    title: m.title,
                    text: m.text.slice(0, 12000),
                    partial: m.text.length > 12000,
                  },
                },
                workQuestions,
              )
            : null;
          return {
            result,
            adviceOnly: true,
            next: result
              ? "根据相关性决定先读哪里；冲突和缺背景先补查。不得用分数改变事实或授权。"
              : "快速决策不可用，按原流程调查。",
          };
        },
      },
    ];
  }
  async context(userText: string) {
    const catalog = this.catalog();
    const decision = await decideWork(this.decisions, {
      current_user_message: userText,
      requirements: catalog.requirements,
    });
    return {
      ...catalog,
      decision,
      decisionUsage:
        "建议调查方向；不构成交办、事实更新或过滤授权。含糊时先读已有需求。",
    };
  }
  async investigationHints(plan: WikiPageBrief, signal: AbortSignal) {
    if (plan.workflow !== "requirement-followup" || !this.decisions)
      return undefined;
    const old = this.pages.repository.get(plan.key);
    const known = new Map(
      [
        ...(old?.investigation ?? []),
        ...(old?.dependencies.filter((d) => d.kind === "material") ?? []),
      ].map((d) => [d.key, d.digest]),
    );
    const changed = this.pages.repository
      .materialsForPlan(plan)
      .filter((m) => known.get(m.key) !== m.digest);
    const leads = [];
    for (const material of changed.slice(0, 6)) {
      signal.throwIfAborted();
      const decision = await decideWork(this.decisions, {
        attention: plan.attention,
        goal: plan.goal,
        previous_requirement: old?.document.requirement,
        changed_material: {
          key: material.key,
          title: material.title,
          text: material.text.slice(0, 8000),
          partial: material.text.length > 8000,
        },
      });
      leads.push({ key: material.key, decision });
      if (!decision) break;
    }
    signal.throwIfAborted();
    leads.sort(
      (a, b) =>
        (b.decision?.answers.focus?.probabilities.direct ?? 0) -
        (a.decision?.answers.focus?.probabilities.direct ?? 0),
    );
    return {
      changedMaterialKeys: changed.map((m) => m.key),
      prioritizedLeads: leads,
      instruction:
        "快速模型仅建议优先补读的变化，不是事实或操作许可。直接相关和可能冲突的材料先读；低分不得覆盖用户反馈或移除原材料。结合原件自行决定相关性、缺失背景和重要变化。",
    };
  }
  apply(value: WorkAction, actor: WorkActor): WorkReceipt {
    const action = workActionSchema.parse(value);
    assertWorkDelegation(action, actor);
    return this.store.tx(() => this.applyInTransaction(action, actor));
  }
  private applyInTransaction(
    action: WorkAction,
    actor: WorkActor,
  ): WorkReceipt {
    const signature = stableDigest({ action, actor });
    const previous = this.store.db
      .prepare("SELECT * FROM assistant_work_receipts WHERE request_id=?")
      .get(actor.requestId);
    if (previous) {
      if (previous.digest !== signature)
        throw Error("同一请求已应用不同操作，请读取现状");
      return JSON.parse(String(previous.body));
    }
    let receipt: WorkReceipt;
    if (action.operation === "track") {
      const key = `requirement:${actor.requestId}`;
      const plan = {
        ...requirementBrief({
          key,
          title: action.title,
          goal: action.goal,
          ...(action.contextIds.length
            ? { contextIds: action.contextIds }
            : {}),
        }),
        materialKeys: action.materialKeys,
        attention: { ...action.attention, instruction: actor.userText },
      };
      this.pages.save(
        plan,
        this.pages.repository.pages().some((p) => p.key === key),
      );
      this.ensure(key);
      this.pages.maintenance.setEnabled(key, true);
      receipt = {
        tool: "work_action",
        operation: action.operation,
        key,
        message: `已开始跟进「${action.title}」，后台将结合所选材料调查并更新；当前已排队。`,
      };
    } else if (action.operation === "start_development") {
      const task = this.development.enqueue(
        action.key,
        action.project,
        actor,
        action.capabilities,
        action.inputReceipts,
      );
      receipt = {
        tool: "work_action",
        operation: action.operation,
        key: action.key,
        taskId: task.id,
        message: `已交办「${this.plan(action.key).title}」的实现。后台将编码、检查并独立评审，有结果会通知你；你也可以直接询问进度。现在尚未完成。`,
      };
    } else if (
      action.operation === "resume_development" ||
      action.operation === "apply_development"
    ) {
      const task = this.development.continueTask(
        action.taskId,
        actor,
        action.operation === "apply_development"
          ? action.reviewedFingerprint
          : undefined,
      );
      receipt = {
        tool: "work_action",
        operation: action.operation,
        key: task.key,
        taskId: task.id,
        message: task.message,
      };
    } else if (
      action.operation === "follow_action" ||
      action.operation === "unfollow_action"
    ) {
      const current = this.actions.board(action.key);
      if (current.revision !== action.expectedRevision)
        throw Error("需求页已变化，请重新读取当前行动项");
      const board =
        action.operation === "follow_action"
          ? this.actions.follow(
              action.key,
              action.actionId,
              action.expectedRevision,
            )
          : this.actions.unfollow(action.key, action.actionId);
      const link = board.links.find((l) => l.action_id === action.actionId);
      if (
        !link ||
        (action.operation === "follow_action" && (!link.task_id || link.error))
      )
        throw Error(String(link?.error ?? "行动项尚未关联个人待办"));
      receipt = {
        tool: "work_action",
        operation: action.operation,
        key: action.key,
        personalTaskId: link.task_id ? String(link.task_id) : undefined,
        message:
          action.operation === "follow_action"
            ? "已将行动项关联到个人待办；需求更新后会继续同步到同一条事项。你手动修改待办时会保留你的调整。"
            : "已停止同步这个行动项，原个人待办仍保留。",
      };
    } else if (action.operation === "cancel_development") {
      const task = this.development.cancel(action.taskId, actor.requestId);
      receipt = {
        tool: "work_action",
        operation: action.operation,
        taskId: task.id,
        message: task.message,
      };
    } else {
      if (!("expectedVersion" in action)) throw Error("不支持的需求操作");
      const plan = this.plan(action.key),
        row = this.ensure(action.key);
      if (Number(row.version) !== action.expectedVersion)
        throw Error("关注设置已变化，请重新读取后调整");
      if (action.operation === "feedback") {
        if (!actor.userText.includes(action.text))
          throw Error("反馈必须来自当前用户原话");
        let materialKey: string | null = null;
        if (action.kind === "correction") {
          const capture = this.store.capture(
            {
              source: "manual",
              externalId: `requirement-feedback:${actor.requestId}`,
              title: `${plan.title}：用户补充`,
              parts: [{ type: "text", text: action.text }],
              context: {
                conversationId: actor.conversationId,
                event: "requirement-feedback",
              },
            },
            { learning: false, notify: false },
          );
          materialKey = this.pages.repository
            .materials()
            .find((m) => m.revisionId === capture.revision.id)!.key;
        }
        if (action.kind === "attention" && !action.attention)
          throw Error("请给出调整后的关注点与排除项");
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO assistant_work_feedback(id,requirement_key,kind,text,material_key,attention,created_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            actor.requestId,
            action.key,
            action.kind,
            action.text,
            materialKey,
            action.attention
              ? JSON.stringify({
                  ...action.attention,
                  instruction: action.text,
                })
              : null,
            new Date().toISOString(),
          );
        this.updatePlan(action.key);
      } else if (action.operation === "revoke_feedback") {
        const changed = this.store.db
          .prepare(
            "UPDATE assistant_work_feedback SET active=0 WHERE id=? AND requirement_key=? AND active=1",
          )
          .run(action.feedbackId, action.key);
        if (!changed.changes) throw Error("没有可撤销的反馈");
        this.updatePlan(action.key);
      } else if (action.operation === "scope") {
        const feedbackKeys = this.feedback(action.key).flatMap((f) =>
          f.active && f.materialKey ? [f.materialKey] : [],
        );
        this.pages.save(
          {
            ...plan,
            contextIds: action.contextIds.length
              ? action.contextIds
              : undefined,
            materialKeys: [
              ...new Set([...action.materialKeys, ...feedbackKeys]),
            ],
          },
          true,
        );
      } else if (
        action.operation === "pause" ||
        action.operation === "resume"
      ) {
        this.pages.maintenance.setEnabled(
          action.key,
          action.operation === "resume",
        );
        if (action.operation === "resume") this.pages.refresh(action.key);
      } else this.pages.refresh(action.key);
      this.store.db
        .prepare(
          "UPDATE assistant_focus SET version=version+1,updated_at=? WHERE requirement_key=?",
        )
        .run(new Date().toISOString(), action.key);
      const verb = {
        feedback: "已保存反馈并重新调查",
        revoke_feedback: "已撤销反馈并重新调查",
        scope: "已调整跟进的材料范围",
        pause: "已暂停自动跟进",
        resume: "已恢复跟进",
        refresh: "已安排重新调查",
      }[action.operation];
      receipt = {
        tool: "work_action",
        operation: action.operation,
        key: action.key,
        message: `${verb}：${plan.title}。${action.operation === "feedback" || action.operation === "revoke_feedback" ? "需求页更新后会反映调查结果。" : ""}`,
      };
    }
    this.store.db
      .prepare("INSERT INTO assistant_work_receipts VALUES(?,?,?)")
      .run(actor.requestId, signature, JSON.stringify(receipt));
    return receipt;
  }
  private updatePlan(key: string) {
    const plan = this.plan(key),
      history = this.feedback(key),
      row = this.ensure(key);
    const attention =
      history.filter((f) => f.active && f.attention).at(-1)?.attention ??
      JSON.parse(String(row.initial_attention));
    const feedbackKeys = new Set(
      history.flatMap((f) => (f.materialKey ? [f.materialKey] : [])),
    );
    const materialKeys = [
      ...(plan.materialKeys ?? []).filter((k) => !feedbackKeys.has(k)),
      ...history.flatMap((f) =>
        f.active && f.materialKey ? [f.materialKey] : [],
      ),
    ];
    this.pages.save({ ...plan, attention, materialKeys }, true);
    this.store.db
      .prepare("UPDATE assistant_focus SET attention=? WHERE requirement_key=?")
      .run(JSON.stringify(attention), key);
  }
  published(article: KnowledgeArticle) {
    if (
      !article.current ||
      !article.document.requirement ||
      !this.pages.maintenance.status(article.document.key)?.enabled
    )
      return;
    const key = article.document.key,
      state = article.document.requirement;
    const previous = this.store.db
      .prepare(
        "SELECT state FROM assistant_requirement_notices WHERE requirement_key=?",
      )
      .get(key);
    const before = previous
      ? (JSON.parse(String(previous.state)) as typeof state)
      : null;
    if (before && stableDigest(before) === stableDigest(state)) return;
    const changes = before
      ? [
          ...(before.objective !== state.objective
            ? [`目标调整：${state.objective}`]
            : []),
          ...(stableDigest(before.nonGoals) !== stableDigest(state.nonGoals)
            ? [`非目标调整：${state.nonGoals.join("、") || "无"}`]
            : []),
          ...before.criteria
            .filter((c) => !state.criteria.some((n) => n.id === c.id))
            .map((c) => `验收项移出当前范围：${c.description}`),
          ...before.actions
            .filter((a) => !state.actions.some((n) => n.id === a.id))
            .map((a) => `行动不再列入当前需求，已有个人待办保留：${a.title}`),
          ...state.criteria
            .filter(
              (c) =>
                !before.criteria.some(
                  (p) =>
                    stableDigest({ ...p, evidence: [] }) ===
                    stableDigest({ ...c, evidence: [] }),
                ),
            )
            .map(
              (c) =>
                `${c.description}：${{ missing: "尚未实现", implemented: "已有实现", verified: "已验收", released: "已发布", uncertain: "待核实" }[c.status]}`,
            ),
          ...state.actions
            .filter(
              (a) =>
                !before.actions.some(
                  (p) =>
                    stableDigest({ ...p, evidence: [] }) ===
                    stableDigest({ ...a, evidence: [] }),
                ),
            )
            .map((a) => `${a.title}：${a.detail}`),
        ]
      : [`已形成需求与 ${state.criteria.length} 项验收：${state.objective}`];
    if (!changes.length && article.reading?.attention?.notifications === "all")
      changes.push(article.document.summary);
    this.store.tx(() => {
      this.store.db
        .prepare(
          "INSERT INTO assistant_requirement_notices VALUES(?,?) ON CONFLICT(requirement_key) DO UPDATE SET state=excluded.state",
        )
        .run(key, JSON.stringify(state));
      if (!changes.length) return;
      const body = changes.slice(0, 8).join("\n"),
        title = `需求进展：${article.document.title}`;
      const change = this.store.record("requirement", title, null, null, body);
      queueOwnerNotice(
        this.store.db,
        change,
        title,
        body,
        new Date().toISOString(),
        this.store.applications.externalDeliveryTiming(
          new Date().toISOString(),
        ),
      );
    });
  }
}
