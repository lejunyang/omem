/**
 * Minimal ACP agent for tests: it connects to the MCP servers the client gives
 * it, searches the knowledge base for the user's message, stores a memory and
 * answers. It exercises the real host path (ACP client, stdio MCP bridge, tool
 * tokens, run events) without a model.
 */
import { PassThrough, Readable, Writable } from "node:stream";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSideConnection, ndJsonStream, RequestError, type McpServer } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sessions = new Map<string, McpServer[]>();
const cwds = new Map<string, string>();
// FAKE_SYSTEM=1: take the client's systemPrompt (ACP, append mode) on new and resumed sessions.
const takesSystem = process.env.FAKE_SYSTEM === "1";
const systems = new Map<string, string>();
const systemText = (p: { systemPrompt?: { content?: { text?: string }[] } }) => p.systemPrompt?.content?.map((b) => b.text ?? "").join("\n\n");
// This SDK drops request fields it does not know (systemPrompt), so read them from the raw lines.
const newSystems: (string | undefined)[] = [];
const input = new PassThrough();
let rawLine = "";
process.stdin.on("data", (chunk: Buffer) => {
  rawLine += chunk.toString("utf8");
  let nl: number;
  while ((nl = rawLine.indexOf("\n")) >= 0) {
    const line = rawLine.slice(0, nl);
    rawLine = rawLine.slice(nl + 1);
    let m: { method?: string; params?: { sessionId?: string } };
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "session/new") newSystems.push(systemText(m.params as never));
    else if ((m.method === "session/resume" || m.method === "session/load") && m.params?.sessionId) {
      const system = systemText(m.params as never);
      if (system !== undefined) systems.set(m.params.sessionId, system);
    }
  }
  input.write(chunk);
});
process.stdin.on("end", () => input.end());
// FAKE_MODE=echo: answer with the session, whether it was resumed, its system prompt and this turn's text.
const echo = process.env.FAKE_MODE === "echo";
const turns = new Map<string, number>();
const resumed = new Set<string>();
// FAKE_MODE=thread: no tools, answer with what the host sent (for session/thread tests).
const threadMode = process.env.FAKE_MODE === "thread";
const delay = Number(process.env.FAKE_DELAY ?? 0);
/** Sessions with a turn in progress, and what was steered into each (FAKE_STEER). */
const inTurn = new Set<string>();
const steeredIn = new Map<string, string[]>();
// FAKE_LEGACY=1: models via session.models + session/set_model, gemini-style mode ids.
const legacy = process.env.FAKE_LEGACY === "1";
// FAKE_STALL=before: print the traex skills notice, then never answer (provider not starting).
// FAKE_STALL=after: answer one chunk, then hang (a stalled turn).
const stall = process.env.FAKE_STALL;
// FAKE_QUEUE=ms: report provider queue_begin, wait, queue_end, then answer.
const queueMs = Number(process.env.FAKE_QUEUE ?? 0);
// FAKE_TRAE=1: traex-style queue status (session_info_update._meta.trae.queueStatus) and a
// reasoning_effort option that only exists while a model that has it is selected.
const trae = process.env.FAKE_TRAE === "1";
/** A fixed answer for every prompt (a judge that always says the same thing). */
const fixed = process.env.FAKE_SAY;
const TRAE_EFFORTS: Record<string, string[]> = { m1: [], m2: ["low", "medium", "high"], m3: ["low", "xhigh"] };
const traeOptions = (model: string) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: Object.keys(TRAE_EFFORTS).map((v) => ({ value: v, name: v })) },
  ...(TRAE_EFFORTS[model].length ? [{ id: "reasoning_effort", name: "Effort", category: "thought_level", type: "select", currentValue: TRAE_EFFORTS[model][0], options: TRAE_EFFORTS[model].map((v) => ({ value: v, name: v })) }] : []),
];
const state = { model: "m1", mode: "default" };
new AgentSideConnection(
  (conn) => ({
    async initialize() {
      return {
        protocolVersion: 1,
        agentCapabilities: { mcpCapabilities: { http: false }, sessionCapabilities: { ...(threadMode || echo || process.env.FAKE_MODE === "tasks" ? { resume: {} } : {}), ...(process.env.FAKE_DELETE_LOG ? { delete: {} } : {}), ...(takesSystem ? { systemPrompt: {} } : {}) } },
        agentInfo: { name: "fake-agent", version: "1" },
      } as never;
    },
    async newSession(p) {
      const id = `s${process.pid}-${sessions.size + 1}`;
      sessions.set(id, p.mcpServers);
      cwds.set(id, p.cwd);
      const system = newSystems.shift();
      if (system !== undefined) systems.set(id, system);
      if (legacy)
        return {
          sessionId: id,
          modes: { currentModeId: "default", availableModes: ["default", "autoEdit", "yolo"].map((m) => ({ id: m, name: m })) },
          models: { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "M1" }, { modelId: "m2", name: "M2" }] },
        } as never;
      if (trae) return { sessionId: id, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "default" }] }, configOptions: traeOptions("m1") } as never;
      return { sessionId: id, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "default" }, { id: "read-only", name: "ro" }] } };
    },
    async setSessionConfigOption(p: { configId: string; value: unknown }) {
      if (p.configId === "model") state.model = String(p.value);
      return { configOptions: traeOptions(state.model) } as never;
    },
    async resumeSession(p: { sessionId: string; mcpServers?: McpServer[]; cwd?: string }) {
      sessions.set(p.sessionId, p.mcpServers ?? []);
      if (p.cwd) cwds.set(p.sessionId, p.cwd);
      resumed.add(p.sessionId);
      return { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "default" }] }, ...(trae ? { configOptions: traeOptions(state.model) } : {}) } as never;
    },
    async setSessionMode(p: { modeId: string }) {
      state.mode = p.modeId;
      return {};
    },
    async extMethod(method: string, params: Record<string, unknown>) {
      if (method === "session/set_model") state.model = String(params.modelId);
      // FAKE_STEER: takes words mid-turn the way codex-acp's `_session/steering` does.
      if (method === "_session/steering") {
        if (!process.env.FAKE_STEER) throw Object.assign(new Error("Method not found"), { code: -32601 });
        const id = String(params.sessionId);
        if (!inTurn.has(id)) return { outcome: "promptRequired" };
        const text = ((params.prompt as { text?: string }[]) ?? []).map((b) => b.text ?? "").join("");
        steeredIn.set(id, [...(steeredIn.get(id) ?? []), ...[...text.matchAll(/本人（[^）]*）：([^\n]*)/g)].map((m) => m[1])]);
        return { outcome: "injected" };
      }
      return {};
    },
    async authenticate() {
      return {};
    },
    async deleteSession(p: { sessionId: string }) {
      if (process.env.FAKE_DELETE_FAIL_FILE && existsSync(process.env.FAKE_DELETE_FAIL_FILE))
        throw new RequestError(-32603, "Internal error", { details: "session still active" });
      if (process.env.FAKE_DELETE_LOG) appendFileSync(process.env.FAKE_DELETE_LOG, p.sessionId + "\n");
      if (process.env.FAKE_HISTORY_ROOT) {
        const from = join(process.env.FAKE_HISTORY_ROOT, "sessions", `rollout-${p.sessionId}.jsonl`);
        if (existsSync(from)) {
          const archived = join(process.env.FAKE_HISTORY_ROOT, "archived_sessions");
          mkdirSync(archived, { recursive: true });
          renameSync(from, join(archived, `rollout-${p.sessionId}.jsonl`));
        }
      }
      return {};
    },
    async cancel() {},
    async prompt(p) {
      const prompt = p.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
      // FAKE_PROMPT_LOG=file: each turn's prompt, one JSON string a line (what the host sent).
      if (process.env.FAKE_PROMPT_LOG) appendFileSync(process.env.FAKE_PROMPT_LOG, JSON.stringify(prompt) + "\n");
      const say =(text: string) => conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
      // FAKE_QUOTA=1: Codex with the plan's quota spent (the message as text, then "Internal error" with codexErrorInfo).
      if (process.env.FAKE_QUOTA === "1") {
        const message = "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again in 2 hours.";
        await say(`${message}\n\n`);
        throw RequestError.internalError({ message, codexErrorInfo: "usageLimitExceeded" });
      }
      // FAKE_DIE=1: the agent process dies in the middle of a turn (a crash, OOM kill).
      if (process.env.FAKE_DIE === "1") {
        await say("我先看一下……");
        setTimeout(() => process.exit(1), 20);
        await new Promise(() => {});
      }
      if (process.env.FAKE_USAGE) {
        const values = process.env.FAKE_USAGE.split(",").map(Number);
        const used = values[Math.min(turns.get(p.sessionId) ?? 0, values.length - 1)];
        if (Number.isFinite(used)) await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "usage_update", used, size: 1000 } });
        if (process.env.FAKE_OTHER_USAGE) await conn.sessionUpdate({ sessionId: "unrelated-session", update: { sessionUpdate: "usage_update", used: 950, size: 1000 } });
      }
      if (process.env.FAKE_MODE === "wiki") {
        const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
        const client = new Client({ name: "fake-wiki", version: "1" });
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map(e => [e.name, e.value])) } as Record<string, string> }));
        try {
          const names = (await client.listTools()).tools.map(t => t.name);
          const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
          const read = await call("list_sources", { space: "materials" });
          const blockedRead = await call("list_sources", { space: "excluded" });
          const blockedWrite = await call("write_page", { space: "materials", page: "forbidden", title: "禁止", summary: "禁止", body: "禁止" });
          const planner = names.includes("submit_plan");
          if (planner) await call("submit_plan", { pages: [{ slug: "overview", title: "概览", kind: "guide", question: "如何开始？", outline: "以示例说明", entry_points: ["materials:README.md"] }] });
          const written = await call("write_page", { page: planner ? "index" : "overview", title: planner ? "目录" : "概览", kind: planner ? "index" : "guide", summary: "示例说明", body: planner ? "- [[overview|概览]]" : "示例正文" });
          await say(JSON.stringify({ prompt, read, blockedRead, blockedWrite, written }));
        } finally { await client.close(); }
        return { stopReason: "end_turn" as const };
      }
      // FAKE_MODE=design: the designer (src/designs). Assessing someone else's design: it reads the document,
      // hands in what the author decided with concerns; assessing again, it first leaves out the old
      // concern (refused), then gives its state. Writing an own design: one decision with every field.
      if (process.env.FAKE_MODE === "design") {
        const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
        const client = new Client({ name: "fake-design", version: "1" });
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
        try {
          const direct = new Set((await client.listTools()).tools.map((t) => t.name));
          const call = (name: string, args: Record<string, unknown>) => client.callTool(direct.has(name) ? { name, arguments: args } : { name: "omem_call", arguments: { tool: name, args } });
          const text = (r: Awaited<ReturnType<typeof call>>) => ((r.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join("");
          if (process.env.FAKE_DESIGN === "none") { await say("看完了，没交"); return { stopReason: "end_turn" as const }; }
          if (prompt.includes("# 评估技术方案")) {
            const ref = /src:([A-Za-z0-9_-]+)/.exec(prompt)?.[1];
            const doc = ref ? await call("read_source", { source: ref }) : null;
            const decisions = [
              { kind: "change", title: "退款金额改由订单服务计算", fields: { behavior: { brief: "三个页面各算一遍 → 都调订单服务" } }, concerns: [{ level: "problem", text: "对账报表读的是落库前的金额，方案没有改它", where: ["report/daily.ts:88"] }, { level: "question", text: "旧订单的退款记录要不要回填" }] },
              { kind: "add", title: "部分发货的订单按已发货行退", stated: false, fields: { behavior: { brief: "方案没写部分发货" } } },
            ];
            if (prompt.includes("## 上一版的评估")) {
              const missing = await call("submit_design", { facts: [{ text: "文档第 2 版补了对账报表" }], decisions: [{ ...decisions[0], id: "D1", concerns: [] }] });
              const done = await call("submit_design", {
                facts: [{ text: "文档第 2 版补了对账报表" }],
                decisions: [{ ...decisions[0], id: "D1", concerns: [{ id: "C2", level: "problem", text: "对账报表读的是落库前的金额，方案没有改它", state: "resolved", note: "第 2 版改了报表" }, { id: "C3", level: "question", text: "旧订单的退款记录要不要回填", state: "open" }] }, { ...decisions[1], id: "D2" }],
                concerns: [{ id: "C1", level: "risk", text: "没写发布顺序", state: "dropped", note: "第 2 版写了" }],
                note: "文档第 2 版",
              });
              await say(`重新评估 ${JSON.stringify({ missing: missing.isError ? text(missing) : null, done: done.isError ? text(done) : "ok" })}`);
              return { stopReason: "end_turn" as const };
            }
            const r = await call("submit_design", { facts: [{ text: "退款金额现在在三个地方算", refs: ref ? [`src:${ref}`] : [] }], decisions, concerns: [{ level: "risk", text: "没写发布顺序" }] });
            await say(`评估完成 ${JSON.stringify({ read: doc && !doc.isError, submitted: r.isError ? text(r) : "ok", hasDoc: prompt.includes("## 方案文档"), hasRepo: prompt.includes("## 要核对的仓库"), hasNote: prompt.includes("## 本人关心的") })}`);
            return { stopReason: "end_turn" as const };
          }
          if (prompt.includes("# 写方案")) {
            const field = (brief: string) => ({ brief });
            const r = await call("submit_design", {
              facts: [{ text: "退款金额在两个页面各算一遍", refs: ["refund.ts:1"] }],
              decisions: [{
                kind: "change", title: "退款金额在订单行上算，页面不再自己合计", reqs: ["退款只算已发货行"],
                fields: { behavior: { brief: "页面合计 → computeRefund", table: { head: ["情况", "现在", "改后"], rows: [["部分发货", "全退", "只退已发货行"]] } }, where: field("order/refund.ts 一处"), callers: field("导出任务"), migration: field("不涉及：只改计算") },
                question: { text: "运费怎么退", options: ["按金额比例", "按件数比例"], recommended: 0 },
              }],
            });
            await say(`写好了 ${r.isError ? text(r) : "ok"}`);
            return { stopReason: "end_turn" as const };
          }
          await say("不认识的任务");
        } finally { await client.close(); }
        return { stopReason: "end_turn" as const };
      }
      // FAKE_MODE=tasks: a delegation driven by tasks (code-loop.ts). The coder splits the work, commits
      // each task with its Omem-Task line and says it is done; review-lead plans the review and rules
      // (the business finding is fixed without the owner, the naming nit goes to the owner); the
      // business check finds that its fix broke something the first time (so it is reverted and redone).
      if (process.env.FAKE_MODE === "tasks") {
        // The round's task asking for a split (the coder role says something alike, so match the task's words).
        const PLAN_ASK = "做法见角色说明里的“修改项”）。先用 `plan_tasks` 拆分";
        const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
        const client = new Client({ name: "fake-tasks", version: "1" });
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
        let direct: Set<string> | null = null;
        const call = async (name: string, args: Record<string, unknown>) => {
          direct ??= new Set((await client.listTools()).tools.map((t) => t.name));
          const r = await client.callTool(direct.has(name) || !direct.has("omem_call") ? { name, arguments: args } : { name: "omem_call", arguments: { tool: name, args } });
          if (process.env.FAKE_TOOL_LOG) appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify({ name, args, error: r.isError ? r.content : null }) + "\n");
          return r;
        };
        try {
          if (prompt.includes("只输出一个 JSON")) { await say("{}"); return { stopReason: "end_turn" as const }; }
          // FAKE_DESIGN_NEEDED: the designer before coding (designs/work.ts). A first version with a question
          // for the owner; asked again with what the owner said, the next version under the same id.
          if (prompt.includes("# 写方案")) {
            const again = prompt.includes("## 上一版");
            const r = await call("submit_design", {
              facts: [{ text: "退款金额在退款单和对账两处各算一遍", refs: ["refund.ts:1"] }],
              decisions: [{
                ...(again ? { id: "D1" } : {}),
                kind: "change", title: again ? "退款金额只在 refund.ts 里算，对账直接调用" : "退款金额在 refund.ts 里算", reqs: ["退款只按未发货的行计算"],
                fields: { behavior: { brief: "全退 → 只退未发货的行", table: { head: ["情况", "现在", "改后"], rows: [["部分发货", "全退", "只退未发货的行"]] } }, where: { brief: "refund.ts 一处" }, callers: { brief: "对账脚本" }, migration: { brief: "不涉及：只改计算" } },
                question: { text: "运费怎么退", options: ["按金额比例", "按件数比例"], recommended: 0 },
              }],
              ...(again ? { note: "按意见改了对账" } : {}),
            });
            await say(`写好了 ${r.isError ? JSON.stringify(r.content) : "ok"}${again ? "（第二版）" : ""}`);
            return { stopReason: "end_turn" as const };
          }
          // The check before coding (business-analyst): the history of the file, then the brief.
          if (prompt.includes("# 编码前检查")) {
            const history = await call("code_history", { space: "shop-api", paths: ["refund.ts"] });
            const said = ((history.content as { text: string }[])[0]?.text ?? "").includes("最近的提交") ? "提交记录里只有初始化" : "没有记录";
            await call("submit_brief", {
              ...(process.env.FAKE_DESIGN_NEEDED ? { design: { needed: true, why: "要改退款金额在退款单和对账之间的分工" } } : {}),
              summary: `改退款计算会影响退款单列表和对账（${said}）`,
              impacts: [{ text: "对账脚本按退款金额汇总，金额口径变了要一起改", where: ["refund.ts"] }],
              history: [{ text: "以前把未发货的行也算进了退款", refs: ["run:r-old"] }],
              regressions: [{ text: "退款金额的单元测试", how: "node --test refund.test.ts", auto: true }, { text: "退款单列表展示的金额", how: "打开退款单列表看金额", auto: false }],
            });
            await say("查完了");
            return { stopReason: "end_turn" as const };
          }
          // Conflicts the host hands over (a helper's commits picked onto the work branch): keep both sides.
          if (prompt.includes("# 解决 Git 冲突")) {
            const cwd = cwds.get(p.sessionId)!;
            const files = [...prompt.matchAll(/^- (\S+)$/gm)].map((m) => m[1]).filter((f) => existsSync(join(cwd, f)));
            for (const f of files) {
              writeFileSync(join(cwd, f), readFileSync(join(cwd, f), "utf8").replace(/^(<{7}|={7}|>{7}).*\r?\n/gm, ""));
              execFileSync("git", ["add", f], { cwd });
            }
            await say(`合并了两边：${files.join("、")}`);
            return { stopReason: "end_turn" as const };
          }
          // The coder asks the check that raised its task: the check answers from its own session.
          if (prompt.includes("在工作中向你请教") && prompt.includes("## 它的问题")) {
            await say("要去掉的是 shipped 为 true 的行，未发货的行照常退。");
            return { stopReason: "end_turn" as const };
          }
          // review-lead rules on a dispute: the reviewer is right about T1, the coder about the rest.
          if (prompt.includes("# 裁决异议")) {
            for (const m of prompt.matchAll(/^### T(\d+) /gm)) await call("rule_dispute", { task: `T${m[1]}`, decision: m[1] === "1" ? "reviewer" : "coder", note: m[1] === "1" ? "需求第 3 条写明已发货的行不退，评审说得对" : "这条路径走不到，异议成立" });
            await say("裁决完成");
            return { stopReason: "end_turn" as const };
          }
          if (prompt.includes("# 决定这次评审看什么")) {
            const second = process.env.FAKE_OVERLAP && !prompt.includes("上次评审以后") ? { second_look: [{ name: "review-business", focus: "支付渠道" }] } : {};
            await call("plan_review", { checks: [{ name: "reviewer", focus: "退款金额的边界" }, { name: "review-business", focus: "已发货的行" }], skipped: [{ name: "review-style", reason: "没有新增文件" }], ...second, summary: "改的是退款计算，功能和业务各看一遍" });
            await say("计划好了");
            return { stopReason: "end_turn" as const };
          }
          if (prompt.includes("你这次只做需求拆分")) {
            await call("submit_change_points", { change_points: [{ id: "C1", title: "只退未发货的行", status: "done", locations: [{ file: "refund.ts" }] }] });
            await say("拆分完成");
            return { stopReason: "end_turn" as const };
          }
          // review-lead on what a second look found: everything it raised is new, accepted.
          if (prompt.includes("# 裁决复看的问题")) {
            const section = prompt.slice(prompt.indexOf("## 复看提的问题"));
            const ids = [...section.slice(0, section.indexOf("## 这次交办按修改项推进")).matchAll(/^- #(\d+) \[/gm)].map((m) => Number(m[1]));
            await call("rule_review", { rulings: ids.map((id) => ({ id, decision: "accept" })), verdict: ids.length ? "revise" : "approve", summary: "复看的问题都要改" });
            await say("裁决完成");
            return { stopReason: "end_turn" as const };
          }
          const leadRound = /你在裁决第 (\d+) 轮/.exec(prompt)?.[1];
          if (leadRound) {
            const ids = [...prompt.matchAll(/- #(\d+) \[([^\]]+)\] (?:\S+ )?([^\n]+)/g)].map((m) => ({ id: Number(m[1]), tag: m[2], title: m[3] }));
            const rulings = ids.map((x) => x.title.includes("命名") ? { id: x.id, decision: "accept", owner: { question: "退款函数要不要统一改名成 refundable？", options: ["改名", "保持现状"] } } : { id: x.id, decision: "accept" });
            await call("rule_review", { rulings, verdict: rulings.length ? "revise" : "approve", summary: rulings.length ? "业务问题直接改，命名问本人" : "没有要改的" });
            await say("裁决完成");
            return { stopReason: "end_turn" as const };
          }
          if (prompt.includes("# 验证修改项")) {
            const tasks = [...prompt.matchAll(/^### T(\d+) (.+)$/gm)].map((m) => ({ seq: Number(m[1]), title: m[2] }));
            const results = tasks.map((t) => !t.title.includes("已发货行不能退") ? { task: `T${t.seq}`, verdict: "fixed" }
              : process.env.FAKE_OVERLAP ? (prompt.includes("没改好") ? { task: `T${t.seq}`, verdict: "fixed" } : { task: `T${t.seq}`, verdict: "not_fixed", note: "部分发货的订单还没处理" })
              : !prompt.includes("改出了新问题") ? { task: `T${t.seq}`, verdict: "regressed", note: "过滤写反了，未发货的行也被去掉了" } : { task: `T${t.seq}`, verdict: "fixed" });
            await call("verify_tasks", { results });
            await say("验证完成");
            return { stopReason: "end_turn" as const };
          }
          if (prompt.includes("## 这次是复看")) {
            if (process.env.FAKE_LOOK_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_LOOK_DELAY)));
            const findings = prompt.includes("上次评审以后") ? [] : [{ severity: "major", file: "refund.ts", line: 1, title: "退款要按支付渠道分开算", suggestion: "按支付渠道分组后再算" }];
            const res = await call("submit_review", { verdict: findings.length ? "changes_requested" : "approved", summary: "复看", findings });
            await say(`结论：${findings.length ? "需要修改" : "通过"}${res.isError ? JSON.stringify(res.content) : ""}`);
            return { stopReason: "end_turn" as const };
          }
          const check = /你负责的评审项：(\S+)/.exec(prompt)?.[1];
          if (check) {
            const later = prompt.includes("上次评审以后");
            const findings = later ? [] : check === "业务" ? [{ severity: "major", file: "refund.ts", line: 1, title: "已发货行不能退", suggestion: "过滤已发货行" }] : [{ severity: "nit", title: "命名可以更具体" }];
            await call("submit_review", { verdict: findings.length ? "changes_requested" : "approved", summary: `${check}评审`, findings });
            await say(`结论：${findings.length ? "需要修改" : "通过"}`);
            return { stopReason: "end_turn" as const };
          }
          // The coder: split first if asked, then each task in its own commit.
          const cwd = cwds.get(p.sessionId)!;
          const commit = (seq: number, line: string) => {
            appendFileSync(join(cwd, "refund.ts"), `${line}\n`);
            execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", `T${seq} 的改动\n\nOmem-Task: T${seq}`], { cwd });
          };
          let seqs: number[] = [];
          // FAKE_PARALLEL: three tasks, two handed to helpers, the first done here.
          if (process.env.FAKE_PARALLEL && prompt.includes(PLAN_ASK)) {
            const made = await call("plan_tasks", { tasks: [{ title: "退款只算未发货的行" }, { title: "运费按比例退" }, { title: "补退款说明" }], rounds: 3 });
            const planned = [...String((made.content as { text: string }[])[0].text).matchAll(/T(\d+) /g)].map((m) => Number(m[1]));
            const sent = await call("dispatch_tasks", { groups: [{ tasks: [`T${planned[1]}`], note: "只改运费" }, { tasks: [`T${planned[2]}`] }] });
            if (sent.isError) await say(`分派失败 ${JSON.stringify(sent.content)}`);
            seqs = [planned[0]];
          } else if (prompt.includes(PLAN_ASK)) {
            const byDesign = prompt.includes("## 方案（");
            if (byDesign) await call("plan_tasks", { tasks: [{ title: "不存在的决定", decision: "D9" }] });
            const made = await call("plan_tasks", { tasks: [{ title: "退款只算未发货的行", done_when: "已发货的行不计入退款", ...(byDesign ? { decision: "D1" } : {}) }, { title: "补退款测试", done_when: "有覆盖已发货行的测试" }], rounds: 6 });
            seqs = [...String((made.content as { text: string }[])[0].text).matchAll(/T(\d+) /g)].map((m) => Number(m[1]));
          } else seqs = [...prompt.matchAll(/^### T(\d+) /gm)].map((m) => Number(m[1]));
          // FAKE_ONE_PER_TURN: like a coder that does one task and ends its turn.
          if (process.env.FAKE_ONE_PER_TURN) seqs = seqs.slice(0, 1);
          for (const seq of [...new Set(seqs)]) {
            // Unsure about the business finding the first time: ask the check that raised it.
            if (prompt.includes(`### T${seq} 已发货行不能退`) && !prompt.includes("问业务")) await call("ask_reviewer", { task: `T${seq}`, question: "过滤的是已发货还是未发货的行？" });
            // The test task is left uncommitted, as a sandbox that cannot write Git would: finish_task commits it.
            if (seq === 2 && prompt.includes(PLAN_ASK)) appendFileSync(join(cwd, "refund.test.ts"), "// 已发货的行不退\n");
            else commit(seq, `export const t${seq} = ${Date.now() % 1000};`);
            if (process.env.FAKE_SHOTS && process.env.OMEM_ARTIFACTS && prompt.includes(PLAN_ASK)) {
              mkdirSync(join(process.env.OMEM_ARTIFACTS, "改后"), { recursive: true });
              writeFileSync(join(process.env.OMEM_ARTIFACTS, "改后", `T${seq}-退款单.png`), Buffer.from("89504e470d0a1a0a", "hex"));
              // …and one for the other task, under its own folder, before it gets to it.
              if (seq === seqs[0] && seqs[1]) {
                mkdirSync(join(process.env.OMEM_ARTIFACTS, `T${seqs[1]}`), { recursive: true });
                writeFileSync(join(process.env.OMEM_ARTIFACTS, `T${seqs[1]}`, "测试报告.txt"), "2 passed");
              }
            }
            await call("finish_task", { task: `T${seq}`, summary: `做完了 T${seq}，跑了测试`, ...(seq === 1 && prompt.includes("## 方案（") ? { deviation: "对账脚本也顺手改成调用 refund.ts", simpler: "导出任务也可以改成同一个函数，这次没做" } : {}) });
          }
          // FAKE_OVERLAP: still at work while its checks verify and a second look runs; what comes back
          // in a tool result (not fixed, new from the second look) is done in this same turn.
          if (process.env.FAKE_OVERLAP && seqs.length && !prompt.includes(PLAN_ASK) && !prompt.includes("## 还在你这一轮的项")) {
            for (let i = 0; i < 150; i++) {
              await new Promise((r) => setTimeout(r, 200));
              const text = ((await call("search", { query: "退款" })).content as { text: string }[]).map((c) => c.text).join("\n");
              const back = [...text.matchAll(/^- T(\d+)「[^\n]*\n\s+在这一轮接着改/gm)].map((m) => Number(m[1]));
              const added = /复看（另一个模型）新发现：([^\n]*)，已经加给你这一轮/.exec(text);
              const fresh = added ? [...added[1].matchAll(/T(\d+)「/g)].map((m) => Number(m[1])) : [];
              for (const seq of [...back, ...fresh]) {
                commit(seq, `export const t${seq}b = ${i};`);
                await call("finish_task", { task: `T${seq}`, summary: `按反馈改了 T${seq}` });
                seqs.push(seq);
              }
              if (added) break;
            }
          }
          // FAKE_DERIVED: without a design, what it changed as a change description at the end.
          if (process.env.FAKE_DERIVED && prompt.includes(PLAN_ASK)) {
            const r = await call("submit_design", { decisions: [{ kind: "change", title: "退款只算未发货的行", fields: { behavior: { brief: "全退 → 只退未发货的行" } }, tasks: [...new Set(seqs)].slice(0, 1) }] });
            await say(`变更说明 ${r.isError ? JSON.stringify(r.content) : "ok"}`);
          }
          await say(`做完了 ${seqs.map((n) => `T${n}`).join("、")}`);
        } finally { await client.close(); }
        return { stopReason: "end_turn" as const };
      }
      // FAKE_MODE=review: the coder edits a file in its worktree; a review check reports with
      // submit_review — the "业务" check asks for a change, the others approve.
      if (process.env.FAKE_MODE === "review") {
        const check = /你负责的评审项：(\S+)/.exec(prompt)?.[1];
        // Host one-shot judgements (tier estimate, triage): keep the conditions' choice.
        if (prompt.includes("只输出一个 JSON")) {
          await say("{}");
          return { stopReason: "end_turn" as const };
        }
        // review-lead: accept the business finding, reject the rest, ask for one more round of business only.
        const leadRound = /你在裁决第 (\d+) 轮/.exec(prompt)?.[1];
        if (leadRound) {
          const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
          const client = new Client({ name: "fake-lead", version: "1" });
          await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
          try {
            const tools = (await client.listTools()).tools.map((t) => t.name);
            const ids = [...prompt.matchAll(/- #(\d+) \[([^\]]+)\]/g)].map((m) => ({ id: Number(m[1]), tag: m[2] }));
            const rulings = ids.map((x) => (x.tag.startsWith("业务") && x.tag.includes("严重") ? { id: x.id, decision: "accept" } : { id: x.id, decision: "reject", note: "不影响这次需求" }));
            // Against a design: what came of each decision, and the assessment's concern now.
            const byDesign = prompt.includes("## 方案：") ? { decisions: [{ id: "D1", done: "partly", deviation: "金额在网关里又算了一遍", concerns: [{ id: "C1", state: "resolved", note: "分支改了对账" }] }] } : {};
            const res = await client.callTool({ name: "rule_review", arguments: { rulings, verdict: rulings.some((r) => r.decision === "accept") ? "revise" : "approve", summary: `第 ${leadRound} 轮：业务问题要改`, change_request: "1. refund.ts:1 已发货行不能退：过滤已发货行", rerun: ["review-business"], ...byDesign } });
            await say(`负责人结论
${JSON.stringify({ tools, error: res.isError ? res.content : null })}`);
          } finally { await client.close(); }
          return { stopReason: "end_turn" as const };
        }
        // The split of a branch review against a design: files under decisions, one file not in the diff refused first.
        if (prompt.includes("把改动归到方案的决定上")) {
          const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
          const client = new Client({ name: "fake-design-split", version: "1" });
          await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
          try {
            const direct = new Set((await client.listTools()).tools.map((t) => t.name));
            const call = (name: string, args: Record<string, unknown>) => client.callTool(direct.has(name) ? { name, arguments: args } : { name: "omem_call", arguments: { tool: name, args } });
            const text = (r: Awaited<ReturnType<typeof call>>) => ((r.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join("");
            const bad = await call("submit_change_points", { decisions: [{ decision: "D1", files: ["nope.ts"] }] });
            const ok = await call("submit_change_points", { decisions: [{ decision: "D1", files: ["refund.ts", "lines.ts"] }] });
            await say(`归属 ${JSON.stringify({ bad: bad.isError ? text(bad) : "accepted", ok: ok.isError ? text(ok) : text(ok) })}`);
          } finally { await client.close(); }
          return { stopReason: "end_turn" as const };
        }
        // The requirement split: one change point, with one made-up source id corrected after the tool refuses it.
        if (prompt.includes("你这次只做需求拆分")) {
          const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
          const client = new Client({ name: "fake-split", version: "1" });
          await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
          try {
            const point = { id: "C1", title: "只退未发货的行", status: "done", locations: [{ file: "refund.ts", start: 1, end: 3 }] };
            // Reworking an earlier split by the owner's note: the point goes under a page; a parent that is not there is refused.
            if (prompt.includes("## 之前的拆分")) {
              const badTree = await client.callTool({ name: "submit_change_points", arguments: { change_points: [{ ...point, parent: "M9" }] } });
              await client.callTool({ name: "submit_change_points", arguments: { change_points: [{ id: "M1", title: "退款申请页", status: "done" }, { ...point, parent: "M1" }] } });
              await say(`重新整理 ${JSON.stringify(badTree.isError ?? false)} ${prompt.includes("## 本人这次的要求\n\n按页面分组")}`);
              return { stopReason: "end_turn" as const };
            }
            const bad = await client.callTool({ name: "submit_change_points", arguments: { change_points: [{ ...point, refs: ["src:s0nothere00000000"] }] } });
            await client.callTool({ name: "submit_change_points", arguments: { change_points: [point] } });
            await say(`拆分完成 ${JSON.stringify(bad.isError ?? false)}`);
          } finally { await client.close(); }
          return { stopReason: "end_turn" as const };
        }
        // Git conflicts the host hands over: keep both sides and stage them (FAKE_CONFLICT=giveup leaves them).
        if (prompt.includes("# 解决 Git 冲突")) {
          const cwd = cwds.get(p.sessionId)!;
          const files = [...prompt.matchAll(/^- (\S+)$/gm)].map((m) => m[1]).filter((f) => existsSync(join(cwd, f)));
          if (process.env.FAKE_CONFLICT !== "giveup") for (const f of files) {
            writeFileSync(join(cwd, f), readFileSync(join(cwd, f), "utf8").replace(/^(<{7}|={7}|>{7}).*\r?\n/gm, ""));
            execFileSync("git", ["add", f], { cwd });
          }
          await say(process.env.FAKE_CONFLICT === "giveup" ? "解决不了" : `合并了两边：${files.join("、")}`);
          return { stopReason: "end_turn" as const };
        }
        if (!check) {
          // FAKE_CODER_LOG: what the coder was sent, one JSON line per turn.
          if (process.env.FAKE_CODER_LOG) appendFileSync(process.env.FAKE_CODER_LOG, JSON.stringify({ session: p.sessionId, prompt }) + "\n");
          appendFileSync(join(cwds.get(p.sessionId)!, "refund.ts"), `export const round = ${prompt.includes("上一轮评审要求修改") ? 2 : 1};
`);
          await say("已实现退款金额计算。");
          return { stopReason: "end_turn" as const };
        }
        const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
        const client = new Client({ name: "fake-review", version: "1" });
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
        try {
          const tools = (await client.listTools()).tools.map((t) => t.name);
          const asks = check === "业务";
          // The business check also maps the requirement to the code; a review of an item says it read the materials.
          const changePoints = asks ? [{ id: "C1", title: "只退未发货的行", status: "partial", requirement: "退款只按未发货的行计算", locations: [{ file: "refund.ts", start: 1, end: 3 }] }] : undefined;
          const decision = prompt.includes("## 方案：") ? { decision: "D1" } : {};
          await client.callTool({ name: "submit_review", arguments: { verdict: asks ? "changes_requested" : "approved", summary: `${check}评审${prompt.includes("## 所属事项") ? "（读了事项材料）" : ""}`, findings: asks ? [{ severity: "major", file: "refund.ts", line: 1, title: "已发货行不能退", suggestion: "过滤已发货行", ...decision }, { severity: "nit", title: "命名可以更具体" }] : [{ severity: "minor", title: "可以补一条测试" }], change_points: changePoints } });
          await say(`结论：${asks ? "需要修改" : "通过"}
${JSON.stringify({ check, tools })}`);
        } finally { await client.close(); }
        return { stopReason: "end_turn" as const };
      }
      // FAKE_MODE=work-state: the nightly write-up (agents/work-state-job.ts). It rewrites the work state with
      // a 本人补充 of its own (the host keeps the owner's), and writes a card for each person the task lists.
      if (process.env.FAKE_MODE === "work-state") {
        const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
        const client = new Client({ name: "fake-work-state", version: "1" });
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
        try {
          const direct = new Set((await client.listTools()).tools.map((t) => t.name));
          const call = (name: string, args: Record<string, unknown>) => client.callTool(direct.has(name) ? { name, arguments: args } : { name: "omem_call", arguments: { tool: name, args } });
          const text = (r: Awaited<ReturnType<typeof call>>) => ((r.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join("");
          const chat = /src:([A-Za-z0-9_-]+)/.exec(prompt.split("# 事实")[1] ?? "")?.[1];
          const state = await call("write_page", {
            space: "personal", page: "state/work", title: "工作近况", summary: "本人这几周在推进的事", kind: "topic",
            body: `## 摘要\n\n- 退款改造：接口联调中，下一步对账${chat ? `（[群](src:${chat})）` : ""}\n\n## 在推进的事\n\n### 退款改造\n\n- 目标：上线部分退款\n\n## 本人补充\n\n（整理时写的，应被替换）`,
          });
          const cards = [];
          for (const m of prompt.matchAll(/→ (people\/\S+?)（/g)) {
            const ref = /src:[A-Za-z0-9_-]+#L\d+/.exec(prompt.slice(m.index))?.[0];
            const r = await call("write_page", { space: "personal", page: m[1], title: m[1].slice(7), kind: "person", summary: "项目 A 后端，常找本人确认退款字段", body: `## 团队和角色\n\n项目 A 后端${ref ? `（[消息](${ref})）` : ""}` });
            cards.push(r.isError ? text(r) : m[1]);
          }
          await say(`近况已更新 ${JSON.stringify({ state: state.isError ? text(state) : "ok", cards, hasOwner: prompt.includes("## 本人补充（本人手写") })}`);
        } finally { await client.close(); }
        return { stopReason: "end_turn" as const };
      }
      // FAKE_MODE=mention: someone looking for the owner (mentions/mentions.ts). The triage on the general model
      // answers FAKE_TRIAGE (JSON); a handling reads the cited line, replies to the asker when it may
      // (FAKE_REPLY), then writes the reminder — or stays quiet (FAKE_MENTION=quiet), or says nothing (=silent).
      if (process.env.FAKE_MODE === "mention") {
        if (prompt.includes('只输出 JSON：{"action"')) {
          await say(process.env.FAKE_TRIAGE ?? '{"action":"handle","what":"问退款口径","handler":"assistant","urgency":"normal","canProgress":true,"reason":"在问一个能查的问题"}');
          return { stopReason: "end_turn" as const };
        }
        if (process.env.FAKE_PROMPT_FILE) appendFileSync(process.env.FAKE_PROMPT_FILE, JSON.stringify(prompt) + "\n");
        const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
        const client = new Client({ name: "fake-mention", version: "1" });
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
        try {
          const direct = new Set((await client.listTools()).tools.map((t) => t.name));
          const call = (name: string, args: Record<string, unknown>) => client.callTool(direct.has(name) ? { name, arguments: args } : { name: "omem_call", arguments: { tool: name, args } });
          const ref = /src:[A-Za-z0-9_-]+#L\d+/.exec(prompt)?.[0];
          const read = ref ? await call("read_source", { source: ref.slice(4).split("#")[0] }) : null;
          if (process.env.FAKE_MENTION === "quiet") {
            await call("stay_quiet", { reason: "群里已经有人回答了" });
            await say("不用提醒");
            return { stopReason: "end_turn" as const };
          }
          if (process.env.FAKE_MENTION === "silent") return { stopReason: "end_turn" as const };
          const replied = process.env.FAKE_REPLY ? await call("reply_to_asker", { text: process.env.FAKE_REPLY }) : null;
          const said = replied ? ((replied.content as { text?: string }[])[0]?.text ?? "") : "";
          await say(`小王问退款口径：按未发货行算，可以直接回\n\n小王要退款金额的算法，案例页写明只退未发货的行。${read && !read.isError ? "（读了原件）" : ""}${said ? `\n\n回复：${said}` : ""}\n\n[原消息](${ref})`);
        } finally { await client.close(); }
        return { stopReason: "end_turn" as const };
      }
      // FAKE_MODE=aware (test/awareness.test.ts): the task is a script. `@wait <file>` writes <file>.ready and
      // waits for <file> (the test speaks as the owner meanwhile); `@call <tool> <json>` calls an omem tool and
      // logs its result to FAKE_TOOL_LOG. Then it answers FAKE_ANSWER. The check before posting (“# 发出前复核”)
      // is answered with a rewritten conclusion, or with stay_quiet when FAKE_AWARE_QUIET is set.
      if (process.env.FAKE_MODE === "aware") {
        if (process.env.FAKE_PROMPT_FILE) appendFileSync(process.env.FAKE_PROMPT_FILE, JSON.stringify(prompt) + "\n");
        const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
        const client = new Client({ name: "fake-aware", version: "1" });
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
        try {
          const direct = new Set((await client.listTools()).tools.map((t) => t.name));
          const call = async (name: string, args: Record<string, unknown>) => {
            const r = await client.callTool(direct.has(name) ? { name, arguments: args } : { name: "omem_call", arguments: { tool: name, args } });
            const text = (r.content as { text?: string }[]).map((c) => c.text ?? "").join("");
            if (process.env.FAKE_TOOL_LOG) appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify({ name, text, isError: !!r.isError }) + "\n");
            return text;
          };
          if (prompt.includes("# 发出前复核")) {
            if (process.env.FAKE_AWARE_QUIET) {
              await call("stay_quiet", { reason: "本人已经处理了" });
              await say("已结束");
            } else await say("复核后的结论：本人已经补充了，按本人说的办");
            return { stopReason: "end_turn" as const };
          }
          for (const line of prompt.split("\n")) {
            const wait = /^@wait (\S+)$/.exec(line.trim());
            if (wait) {
              writeFileSync(`${wait[1]}.ready`, "1");
              while (!existsSync(wait[1])) await new Promise((r) => setTimeout(r, 50));
              continue;
            }
            const c = /^@call (\S+) (.*)$/.exec(line.trim());
            if (c) await call(c[1], JSON.parse(c[2]));
          }
          await say(process.env.FAKE_ANSWER ?? "结论：要本人看一下");
        } finally { await client.close(); }
        return { stopReason: "end_turn" as const };
      }
      if (echo) {
        await say(JSON.stringify({ session: p.sessionId, resumed: resumed.has(p.sessionId), system: systems.get(p.sessionId) ?? null, prompt }));
        return { stopReason: "end_turn" };
      }
      if (process.env.FAKE_MODE === "background") {
        const n = (turns.get(p.sessionId) ?? 0) + 1;
        turns.set(p.sessionId, n);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
        const client = new Client({ name: "fake", version: "1" });
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
        const result = await client.callTool({ name: "search", arguments: { query: "虚构测试材料" } });
        // An ingest fact without evidence is rejected and records the owning run.
        await client.callTool({ name: "remember", arguments: { kind: "fact", content: "项目 A 每周二执行检查。" } });
        await client.close();
        if (result.isError) throw new Error("MCP search failed");
        await say(JSON.stringify({ session: p.sessionId, turn: n, prompt }));
        return { stopReason: "end_turn" };
      }
      if (fixed !== undefined) {
        // FAKE_QUIET: first say nothing is to be posted (stay_quiet), the way a real agent would, then
        // the fixed text; a refusal is said too, so a test sees it.
        if (process.env.FAKE_QUIET) {
          const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
          const client = new Client({ name: "fake", version: "1" });
          await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
          const direct = (await client.listTools()).tools.some((t) => t.name === "stay_quiet");
          const args = { reason: process.env.FAKE_QUIET };
          const r = await client.callTool(direct ? { name: "stay_quiet", arguments: args } : { name: "omem_call", arguments: { tool: "stay_quiet", args } });
          await client.close();
          if (r.isError) await say(`stay_quiet 不能用：${(r.content as { text?: string }[]).map((c) => c.text ?? "").join("")}\n\n`);
          // FAKE_EMPTY_STREAM=1: a provider that fails the empty final message after stay_quiet.
          if (process.env.FAKE_EMPTY_STREAM === "1") throw RequestError.internalError({ message: "stream disconnected before completion: llm response empty stream", will_retry: false });
        }
        // FAKE_STREAM_CUT=1: the upstream model stream breaks off mid-answer (the backend process lives on).
        if (process.env.FAKE_STREAM_CUT === "1") {
          await say("我先看一下……");
          throw RequestError.internalError({ message: "stream disconnected before completion: upstream connect error", will_retry: false });
        }
        await say(fixed);
        return { stopReason: "end_turn" };
      }
      if (stall === "before") {
        await say("Skill descriptions were shortened to fit the 2% skills context budget. TRAE can still see every skill.");
        await new Promise(() => {});
      }
      if (stall === "after") {
        await say("我先看一下材料。");
        await new Promise(() => {});
      }
      if (queueMs && trae) {
        const status = (state: string, position?: number) => conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "session_info_update", _meta: { trae: { queueStatus: { state, position, message: state === "ready" ? undefined : `排在第 ${position} 位` } } } } as never });
        await status("queued", 3);
        await new Promise((r) => setTimeout(r, queueMs / 2));
        await status("waiting", 1);
        await new Promise((r) => setTimeout(r, queueMs / 2));
        await status("ready");
        await say(`queued-ok ${state.model}`);
        return { stopReason: "end_turn" };
      }
      if (queueMs) {
        await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "queue_begin", position: 3 } as never });
        await new Promise((r) => setTimeout(r, queueMs));
        await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "queue_end" } as never });
        await say("queued-ok");
        return { stopReason: "end_turn" };
      }
      if (threadMode) {
        const n = (turns.get(p.sessionId) ?? 0) + 1;
        turns.set(p.sessionId, n);
        inTurn.add(p.sessionId);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        inTurn.delete(p.sessionId);
        const steered = steeredIn.get(p.sessionId) ?? [];
        steeredIn.delete(p.sessionId);
        const part = prompt.slice(prompt.lastIndexOf("# 本人新消息"));
        const msgs = [...part.matchAll(/本人（[^）]*）：([^\n]*)/g)].map((m) => m[1]);
        const role = /# 角色：([^\n]*)/.exec(prompt)?.[1] ?? "";
        const text = JSON.stringify({ session: p.sessionId, turn: n, resumed: resumed.has(p.sessionId), cold: prompt.includes("# 会话背景"), msgs, role, summary: /## 本会话到目前为止的摘要\n\n([^\n]*)/.exec(prompt)?.[1] ?? null, context: prompt.includes("的上下文，"), memories: [...part.matchAll(/- mem:(\w+)/g)].map((m) => m[1]), woken: prompt.includes("# 唤醒\n"), ...(steered.length ? { steered } : {}), ...(legacy ? state : {}) });
        await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
        return { stopReason: "end_turn" };
      }
      const message = /本人（[^）]*）：([^\n]*)/.exec(prompt.slice(prompt.lastIndexOf("# 本人新消息")))?.[1] ?? /# 任务\n\n([^\n]*)/.exec(prompt)?.[1] ?? "hello";
      const server = sessions.get(p.sessionId)![0] as { command: string; args: string[]; env: { name: string; value: string }[] };
      const client = new Client({ name: "fake", version: "1" });
      await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } as Record<string, string> }));
      const tools = (await client.listTools()).tools.map((t) => t.name);
      await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "mcp__omem__search", kind: "search", status: "in_progress" } });
      const found = (await client.callTool({ name: "search", arguments: { query: message } })) as { content: { text: string }[] };
      await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } });
      await client.callTool({ name: "remember", arguments: { content: `FAKE: ${message}`, kind: "fact" } });
      await client.close();
      const text = `tools=${tools.length}; search=${found.content[0].text.slice(0, 40).replace(/\n/g, " ")}`;
      await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
      return { stopReason: "end_turn" };
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(input) as ReadableStream<Uint8Array>),
);
