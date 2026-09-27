import { randomUUID } from "node:crypto";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { z } from "zod";
import {
  questionSchema,
  type RunEvent,
} from "../../../packages/contracts/src/index.js";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import { acp, cli } from "./agents.js";
type Run = {
  id: string;
  state: "running" | "done" | "error" | "cancelled";
  events: RunEvent[];
  controller: AbortController;
  answerId?: string;
  promise?: Promise<void>;
};
export class Runs {
  private runs = new Map<string, Run>();
  constructor(
    private store: Store,
    private config: Config,
  ) {}
  get(id: string) {
    const r = this.runs.get(id);
    return r
      ? { id: r.id, state: r.state, events: r.events, answerId: r.answerId }
      : null;
  }
  cancel(id: string) {
    this.runs.get(id)?.controller.abort();
  }
  async close() {
    for (const r of this.runs.values())
      if (r.state === "running") r.controller.abort();
    await Promise.allSettled([...this.runs.values()].map((r) => r.promise));
  }
  start(input: z.infer<typeof questionSchema>) {
    if (
      [...this.runs.values()].filter((r) => r.state === "running").length >= 2
    )
      throw Error("Two runs are already active");
    if (this.runs.size >= 100) {
      for (const [id, r] of this.runs) {
        if (r.state !== "running") {
          this.runs.delete(id);
          break;
        }
      }
    }
    const base = this.config.profiles.find((p) => p.id === input.profileId);
    if (!base) throw Error("Profile not found");
    const profile = {
      ...base,
      model: input.model || base.model,
      effort: input.effort || base.effort,
    };
    const refs = [...new Set([input.focusId, ...input.contextIds])];
    const evidences = refs.map((id) => {
      const e = this.store.evidence(id);
      if (!e) throw Error("Evidence not found");
      return e;
    });
    if (
      input.selection &&
      !evidences[0]!.fragment.text.includes(input.selection)
    )
      throw Error("Selection does not match fixed evidence");
    const evidenceText = evidences
      .map((e) =>
        JSON.stringify({
          evidenceId: e.fragment.id,
          title: e.revision.title,
          version: e.revision.version,
          current: e.revision.current,
          text: e.fragment.text,
        }),
      )
      .join("\n");
    if (
      evidenceText.length + (input.selection?.length || 0) >
      profile.maxContextChars
    )
      throw Error("Context budget exceeded; select fewer evidence fragments");
    const text = `${profile.instructions}\n引用只能使用下面列出的 evidenceId。结论不足时说明不足。\n<materials>${evidenceText}</materials>\n选区：${JSON.stringify(input.selection || "")}\n问题：${input.question}`;
    const blocks: ContentBlock[] = [{ type: "text", text }];
    let imageBytes = 0;
    // Pictures belong to the fixed source revision; cap the whole payload, not just each image.
    const seen = new Set<string>();
    for (const e of evidences)
      for (const p of e.revision.parts) {
        if (p.type !== "image" || seen.has(p.assetId)) continue;
        seen.add(p.assetId);
        const bytes = this.store.asset(p.assetId);
        if (!bytes) throw Error("Image missing");
        imageBytes += bytes.length;
        if (imageBytes > 10_000_000)
          throw Error("Image context budget exceeded");
        blocks.push({
          type: "image",
          mimeType: p.mimeType,
          data: bytes.toString("base64"),
        });
      }
    if (profile.transport !== "acp" && blocks.length > 1)
      throw Error(
        "Image context currently requires an ACP profile; no silent text-only fallback",
      );
    const run: Run = {
      id: randomUUID(),
      state: "running",
      events: [],
      controller: new AbortController(),
    };
    this.runs.set(run.id, run);
    let answer = "";
    let eventChars = 0;
    const emit = (type: "status" | "text" | "permission", text: string) => {
      if (run.controller.signal.aborted) return;
      eventChars += text.length;
      if (eventChars > 250000) {
        run.controller.abort();
        throw Error("Answer output budget exceeded");
      }
      run.events.push({ seq: run.events.length, type, text });
      if (type === "text") answer += text;
      if (type === "permission")
        this.store.tx(() =>
          this.store.record(
            "attention",
            "Agent 需要额外权限",
            null,
            null,
            text,
          ),
        );
    };
    run.promise = (async () => {
      try {
        if (profile.transport === "acp")
          await acp(
            profile,
            this.config.agentCwd,
            blocks,
            emit,
            run.controller.signal,
          );
        else
          await cli(
            profile,
            this.config.agentCwd,
            text,
            emit,
            run.controller.signal,
          );
        if (run.controller.signal.aborted) throw Error("CANCELLED");
        if (!answer.trim()) throw Error("Agent returned no answer");
        const saved = this.store.capture({
          source: "agent",
          externalId: "answer:" + run.id,
          title: input.question.slice(0, 100),
          parts: [{ type: "text", text: answer }],
          context: { runId: run.id, event: "answer" },
          provenance: {
            collectorId: "omem-agent-answer",
            actorId: profile.id,
            actorType: "bot",
            actorVerifiedBy: "omem-runner",
            sourceUri: null,
            eventId: run.id,
            eventAt: new Date().toISOString(),
            timezone: null,
            quoted: false,
            forwarded: false,
            producerKind: "derived",
          },
        });
        run.answerId = saved.revision.id;
        for (const f of saved.revision.fragments)
          for (const ref of refs) this.store.link(f.id, ref);
        run.state = "done";
        run.events.push({
          seq: run.events.length,
          type: "done",
          text: "回答已保存；所提供的材料引用不等于已验证结论支持度。",
        });
      } catch (e) {
        run.state = run.controller.signal.aborted ? "cancelled" : "error";
        run.events.push({
          seq: run.events.length,
          type: "error",
          text: e instanceof Error ? e.message : "Agent failed",
        });
      }
    })();
    return { id: run.id, state: run.state };
  }
}
