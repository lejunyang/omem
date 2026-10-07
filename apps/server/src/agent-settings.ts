import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  profileSchema,
  type AgentProfile,
} from "../../../packages/contracts/src/index.js";
import { acp, withAgentWorkspace } from "./agents.js";
import {
  assistantProfile,
  developmentProfiles,
  knowledgeProfile,
  parseConfig,
  type Config,
} from "./config.js";

export const agentRoles = [
  "assistant",
  "knowledge",
  "learning",
  "coding",
  "review",
] as const;
const selection = z
  .object({
    candidateId: z.string().min(1),
    model: z.string().optional(),
    effort: z.string().optional(),
  })
  .strict();
export const agentProbeSchema = selection.extend({
  test: z.boolean().default(false),
});
export const agentSetupSchema = z
  .object({
    roles: z
      .object({
        assistant: selection,
        knowledge: selection,
        learning: selection,
        coding: selection,
        review: selection,
      })
      .strict(),
  })
  .strict();
type Selection = z.infer<typeof selection>;

function executable(command: string) {
  const names =
    process.platform === "win32"
      ? [
          command,
          ...String(process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
            .split(";")
            .map((ext) => command + ext.toLowerCase()),
        ]
      : [command];
  for (const directory of isAbsolute(command)
    ? [""]
    : String(process.env.PATH ?? "").split(delimiter))
    for (const name of names) {
      const path = directory ? join(directory, name) : name;
      try {
        accessSync(
          path,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return path;
      } catch {
        /* another PATH entry */
      }
    }
  return null;
}
export function optionList(
  options: SessionConfigOption[],
  kind: "model" | "effort",
) {
  const o = options.find(
    (o) =>
      o.id === (kind === "model" ? "model" : "reasoning_effort") ||
      o.category === (kind === "model" ? "model" : "thought_level"),
  );
  if (!o || o.type !== "select")
    return { current: "", values: [] as { value: string; name: string }[] };
  return {
    current: o.currentValue,
    values: o.options
      .flatMap((v) => ("options" in v ? v.options : [v]))
      .map((v) => ({ value: v.value, name: v.name })),
  };
}
/** Candidate commands come from local configuration or this fixed adapter list,
 * never from the browser. Discovery neither installs tools nor changes login. */
export class AgentSettings {
  private probes = new Map<string, Promise<Awaited<ReturnType<typeof acp>>>>();
  private saving = false;
  constructor(
    readonly config: Config,
    readonly file = config.configFile ?? join(config.dataDir, "config.json"),
  ) {}
  candidates() {
    const configured = this.config.profiles.filter(
      (p) =>
        p.transport === "acp" && !agentRoles.some((r) => p.id === `omem-${r}`),
    );
    const defaults = [
      {
        id: "detected-traex",
        name: "Traex",
        command: "traex",
        acpProvider: "traex",
        args: ["-c", 'sandbox_mode="read-only"', "acp", "serve"],
      },
      {
        id: "detected-codex",
        name: "Codex · ACP",
        command: "codex-acp",
        acpProvider: "codex",
        args: [],
      },
      {
        id: "detected-claude",
        name: "Claude Code · ACP",
        command: "claude-agent-acp",
        acpProvider: "claude",
        args: [],
      },
    ].filter((d) => !configured.some((p) => p.command === d.command));
    return [
      ...configured,
      ...defaults.map((p) =>
        profileSchema.parse({ ...p, transport: "acp", idleTimeoutMs: 480000 }),
      ),
    ];
  }
  status() {
    const coding = developmentProfiles(this.config),
      assistant = assistantProfile(this.config);
    const publicProfile = (p?: AgentProfile | null) =>
      p
        ? {
            id: p.id,
            candidateId:
              this.candidates().find(
                (c) =>
                  c.command === p.command &&
                  JSON.stringify(c.args) === JSON.stringify(p.args),
              )?.id ?? p.id,
            name: p.name,
            model: p.model ?? "",
            effort: p.effort ?? "",
          }
        : null;
    return {
      configured: !!this.config.agentsConfiguredAt,
      configuredAt: this.config.agentsConfiguredAt ?? null,
      candidates: this.candidates().map(
        ({ id, name, command, acpProvider, model, effort }) => ({
          id,
          name,
          provider: acpProvider ?? command,
          installed: !!executable(command),
          model,
          effort,
        }),
      ),
      nativeCli: {
        codex: !!executable("codex"),
        claude: !!executable("claude"),
      },
      roles: {
        assistant: publicProfile(assistant),
        knowledge: publicProfile(knowledgeProfile(this.config)),
        learning: publicProfile(
          this.config.profiles.find(
            (p) => p.id === this.config.learning?.profileId,
          ),
        ),
        coding: publicProfile(coding?.coding),
        review: publicProfile(coding?.review),
      },
      learningEnabled: !!this.config.learning?.enabled,
    };
  }
  private candidate(id: string) {
    const p = this.candidates().find((p) => p.id === id);
    if (!p) throw Error("请重新检测并选择已登记的 Agent");
    if (!executable(p.command))
      throw Error(
        `找不到 ${p.command}；请在服务机器安装并登录，或检查服务的 PATH`,
      );
    return p;
  }
  async probe(value: z.infer<typeof agentProbeSchema>) {
    const base = this.candidate(value.candidateId);
    const profile = {
      ...base,
      model: value.model || undefined,
      effort: value.effort || undefined,
      idleTimeoutMs: value.test ? 60000 : 30000,
      maxDurationMs: value.test ? 90000 : 30000,
    };
    const key = JSON.stringify([profile, value.test]);
    let pending = this.probes.get(key);
    if (!pending) {
      pending = (async () => {
        await mkdir(join(this.config.dataDir, "agent-probes"), {
          recursive: true,
          mode: 0o700,
        });
        const workspace = await mkdtemp(
          join(this.config.dataDir, "agent-probes", "probe-"),
        );
        try {
          return await acp(
            withAgentWorkspace(profile, workspace),
            workspace,
            value.test
              ? [
                  {
                    type: "text",
                    text: "这是模型连接检查。只回复 OK，不读取文件，不调用工具，不执行其他操作。",
                  },
                ]
              : null,
            () => {},
            new AbortController().signal,
          );
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      })();
      this.probes.set(key, pending);
    }
    try {
      const result = await pending;
      return {
        connected: true,
        inference: value.test ? "passed" : "untested",
        agent: result.agentInfo,
        model: optionList(result.configOptions, "model"),
        effort: optionList(result.configOptions, "effort"),
        timings: result.timings,
      };
    } finally {
      if (this.probes.get(key) === pending) this.probes.delete(key);
    }
  }
  async save(input: z.infer<typeof agentSetupSchema>) {
    if (this.saving) throw Error("设置正在保存，请稍候");
    this.saving = true;
    try {
      const original = existsSync(this.file)
        ? readFileSync(this.file, "utf8")
        : null;
      const { dataDir, agentCwd, token, host, port, configFile, ...base } =
        this.config;
      const raw = original === null ? base : JSON.parse(original);
      const selected = new Map<string, Promise<unknown>>();
      const profiles = agentRoles.map((role) => {
        const s = input.roles[role],
          p = this.candidate(s.candidateId);
        const key = JSON.stringify(s);
        if (!selected.has(key))
          selected.set(key, this.probe({ ...s, test: false }));
        return profileSchema.parse({
          ...p,
          id: `omem-${role}`,
          name: {
            assistant: "主助手",
            knowledge: "材料与文章整理",
            learning: "记忆整理",
            coding: "编码",
            review: "代码评审",
          }[role],
          model: s.model || undefined,
          effort: s.effort || undefined,
        });
      });
      await Promise.all(selected.values());
      const byRole = Object.fromEntries(
        agentRoles.map((r, i) => [r, profiles[i]!]),
      ) as Record<(typeof agentRoles)[number], AgentProfile>;
      const next = {
        ...raw,
        agentsConfiguredAt: new Date().toISOString(),
        profiles: [
          ...raw.profiles.filter(
            (p: AgentProfile) => !profiles.some((n) => n.id === p.id),
          ),
          ...profiles,
        ],
        assistant: { ...raw.assistant, profileId: byRole.assistant.id },
        knowledge: { profileId: byRole.knowledge.id },
        learning: { ...raw.learning, profileId: byRole.learning.id },
        development: {
          codingProfileId: byRole.coding.id,
          reviewProfileId: byRole.review.id,
        },
      };
      const parsed = parseConfig(next);
      if (
        (existsSync(this.file) ? readFileSync(this.file, "utf8") : null) !==
        original
      )
        throw Error("配置被其他操作更新，请重新加载后保存");
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
      Object.assign(this.config, parsed);
      return this.status();
    } finally {
      this.saving = false;
    }
  }
}
