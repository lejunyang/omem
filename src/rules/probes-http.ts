import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { deleteProbe, listProbes, probeInputSchema, requireProbe, saveProbe, tryProbe, PROBE_TIMEOUT_MAX } from "./probes.ts";

/**
 * The web side of 预查库 and 快速通道 (docs/v2/first-look.md, “HTTP 接口”). Whoever reads rules sees the
 * probes' names and what they find (to pick them in a rule or a 关注); the code, saving, deleting and
 * trial runs are the owner's (src/auth/routes.ts, and checked again here).
 */
function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, `参数错误：${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

/** A sample event to try a probe on: the message text (what the regex is tried on) and anything else of the event. */
const sampleSchema = z.object({
  text: z.string().max(20_000).default(""),
  event: z.record(z.string(), z.unknown()).optional(),
});

function sampleEvent(s: z.infer<typeof sampleSchema>) {
  const event = { kind: "message", via: "test", ...(s.event ?? {}) } as Record<string, unknown>;
  const message = (event.message as Record<string, unknown> | undefined) ?? {};
  const text = s.text || String(message.text ?? "");
  return { event: { ...event, message: { id: "om_sample", ...message, text } }, texts: [text] };
}

export function registerProbeRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  const owner = (req: FastifyRequest) => {
    if (who(req) !== OWNER) throw new HttpError(403, "预查的代码、保存、删除和试跑只有本人可以");
  };

  server.get("/api/probes", async () =>
    listProbes(app).map(({ code, ...p }) => ({ ...p, lines: code.split(/\r?\n/).length })),
  );

  server.get("/api/probes/:name", async (req) => {
    owner(req);
    return requireProbe(app, (req.params as { name: string }).name);
  });

  server.put("/api/probes/:name", async (req) => {
    owner(req);
    const name = (req.params as { name: string }).name;
    const b = parse(probeInputSchema.omit({ name: true }).partial({ timeoutSec: true, direct: true }), req.body);
    return saveProbe(app, { ...b, name }, who(req));
  });

  server.delete("/api/probes/:name", async (req) => {
    owner(req);
    deleteProbe(app, (req.params as { name: string }).name, who(req));
    return { ok: true };
  });

  // A saved probe on a sample event.
  server.post("/api/probes/:name/try", async (req) => {
    owner(req);
    const p = requireProbe(app, (req.params as { name: string }).name);
    const { event, texts } = sampleEvent(parse(sampleSchema, req.body));
    return tryProbe(app, p, event, texts);
  });

  // One not saved yet (the editor's 试跑): the same body as saving, plus the sample.
  server.post("/api/probes/try", async (req) => {
    owner(req);
    const b = parse(probeInputSchema.extend({ sample: sampleSchema.default({ text: "" }) }), req.body);
    const { sample, ...p } = b;
    const { event, texts } = sampleEvent(sample);
    return tryProbe(app, p, event, texts);
  });

  // What the rules page and the 关注 settings offer for 快速通道.
  server.get("/api/first-look/options", async () => ({
    to: app.config.firstLook.to,
    destinations: [
      { value: "chat", label: "发到群里", note: "只在直接回复（规则的回复方式是直接回复，或关注是直接回复）时真的发到群里，否则改成只有你看得到的卡片" },
      { value: "dm", label: "私聊发给我" },
      { value: "ephemeral", label: "群里只有我看得到", note: "私聊、你不在群里或发不出时改私聊" },
    ],
    probes: listProbes(app).map((p) => ({ name: p.name, description: p.description, match: p.match ?? null, direct: p.direct })),
    budgetSec: 90,
    rulePerDay: (await import("./first-look.ts")).RULE_FIRST_LOOKS_PER_DAY,
    probeTimeoutMax: PROBE_TIMEOUT_MAX,
  }));
}
