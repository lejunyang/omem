import { z } from "zod";

export const capabilityId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const environmentRefs = z
  .record(z.string(), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
  .default({});
const executable = {
  command: z.string().min(1),
  env: environmentRefs,
  timeoutMs: z.number().int().min(1000).max(600000).default(60000),
};
const argument = z.union([
  z.string(),
  z
    .object({
      input: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
      description: z.string().min(1),
      choices: z.array(z.string()).min(1).optional(),
    })
    .strict(),
]);
export const capabilitySchema = z
  .object({
    version: z.literal(1),
    id: capabilityId,
    name: z.string().min(1),
    description: z.string().min(1),
    // References are imported into a versioned private directory at registration.
    skills: z
      .array(
        z.object({ name: capabilityId, directory: z.string().min(1) }).strict(),
      )
      .default([]),
    checks: z
      .array(
        z
          .object({
            ...executable,
            name: z.string().min(1),
            args: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .default([]),
    cli: z
      .array(
        z
          .object({
            ...executable,
            name: capabilityId,
            description: z.string().min(1),
            readOnly: z.literal(true),
            args: z.array(argument).default([]),
          })
          .strict(),
      )
      .default([]),
    mcp: z
      .discriminatedUnion("transport", [
        z
          .object({
            transport: z.literal("stdio"),
            ...executable,
            args: z.array(z.string()).default([]),
            readOnlyTools: z.array(z.string().min(1)).min(1),
          })
          .strict(),
        z
          .object({
            transport: z.literal("http"),
            url: z.url(),
            bearerTokenEnv: z
              .string()
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
              .optional(),
            timeoutMs: z.number().int().min(1000).max(600000).default(60000),
            readOnlyTools: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .superRefine((pack, ctx) => {
    for (const kind of ["skills", "checks", "cli"] as const) {
      const names = pack[kind].map((v) => v.name);
      if (new Set(names).size !== names.length)
        ctx.addIssue({ code: "custom", message: `${kind} 名称重复` });
    }
    if (!pack.skills.length && !pack.cli.length && !pack.mcp)
      ctx.addIssue({
        code: "custom",
        message: "能力包至少包含一种 skill、CLI 或 MCP",
      });
    if (pack.mcp?.transport === "http") {
      const url = new URL(pack.mcp.url);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        ctx.addIssue({
          code: "custom",
          message: "MCP 地址仅支持 HTTP(S)，认证用环境变量引用，不能放入 URL",
        });
    }
  });
export type Capability = z.infer<typeof capabilitySchema>;
export type CapabilityReference = { id: string; revision: string };
