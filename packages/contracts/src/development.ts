import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
export const requirementStateSchema = z
  .object({
    objective: z.string().min(1),
    nonGoals: z.array(z.string()),
    criteria: z
      .array(
        z
          .object({
            id,
            description: z.string().min(1),
            status: z.enum([
              "missing",
              "implemented",
              "verified",
              "released",
              "uncertain",
            ]),
            evidence: z
              .array(z.string())
              .describe("Keys of original-material citations in this document"),
          })
          .strict(),
      )
      .min(1),
    actions: z.array(
      z
        .object({
          id,
          title: z.string().min(1),
          detail: z.string(),
          owner: z.string().nullable(),
          waitingOn: z.string().nullable(),
          dueAt: z.iso.datetime({ offset: true }).nullable(),
          dueExpression: z.string().nullable(),
          status: z.enum(["open", "waiting", "done", "cancelled"]),
          certainty: z.enum(["confirmed", "proposed", "uncertain"]),
          evidence: z.array(z.string()).min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type RequirementState = z.infer<typeof requirementStateSchema>;

export const projectCommandSchema = z
  .object({
    name: id,
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().default("."),
    purpose: z.enum(["setup", "test", "build", "browser", "design"]),
    required: z.boolean().default(true),
    timeoutMs: z.number().int().positive().default(600000),
  })
  .strict();
const configurationSourceSchema = z
  .object({ path: z.string().min(1), hash: z.string().min(1) })
  .strict();
export const projectChecksSchema = z
  .object({
    commands: z.array(projectCommandSchema).min(1),
    sources: z.array(configurationSourceSchema).min(1),
    summary: z.string().min(1),
    gaps: z.array(z.string()),
  })
  .strict();
export const projectConfigurationSchema = z
  .object({
    expectedVersion: z
      .string()
      .min(1)
      .describe("Current configurationVersion returned by project_inspect."),
    instructions: z
      .string()
      .describe(
        "Project-specific implementation and acceptance instructions, preserving existing owner constraints.",
      ),
    ruleFiles: z
      .array(z.string())
      .describe(
        "Additional repository-relative instructions; AGENTS.md and CLAUDE.md are already read automatically.",
      ),
    commands: z
      .array(projectCommandSchema)
      .describe(
        "Full replacement command list. Derive executable/args/cwd from actual project docs and manifests. No publish, push, remote writes or global installation.",
      ),
    sources: z
      .array(configurationSourceSchema)
      .min(1)
      .describe(
        "Actual paths and hashes returned by project_read or project_inspect; include applicable rules and the command definitions.",
      ),
    summary: z
      .string()
      .min(1)
      .describe(
        "Briefly explain the chosen setup and checks in user language.",
      ),
    gaps: z
      .array(z.string())
      .describe(
        "Missing environment, credentials or acceptance steps. Saving configuration does not mean commands succeeded.",
      ),
  })
  .strict();
export type ProjectConfiguration = z.infer<typeof projectConfigurationSchema>;

export const developmentProjectSchema = z
  .object({
    name: z.string().min(1),
    repository: z.string().min(1),
    origin: z
      .object({
        url: z.string(),
        ref: z.string(),
        commit: z.string(),
        preparedAt: z.string(),
      })
      .strict()
      .optional(),
    instructions: z.string().default(""),
    ruleFiles: z.array(z.string()).default([]),
    capabilities: z.array(z.string()).optional(),
    configuration: z
      .object({
        at: z.string(),
        summary: z.string(),
        sources: z.array(configurationSourceSchema),
        gaps: z.array(z.string()),
      })
      .strict()
      .optional(),
    commands: z.array(projectCommandSchema).default([]),
  })
  .strict();
export type DevelopmentProject = z.infer<typeof developmentProjectSchema>;

export const implementationResultSchema = z
  .object({
    schema_version: z.literal(1),
    summary: z.string().min(1),
    criteria: z.array(
      z
        .object({
          id,
          status: z.enum(["implemented", "blocked"]),
          note: z.string(),
        })
        .strict(),
    ),
    blockers: z.array(z.string()),
  })
  .strict();
export const implementationReviewSchema = z
  .object({
    schema_version: z.literal(1),
    verdict: z.enum(["accepted", "changes_requested", "blocked"]),
    summary: z.string().min(1),
    criteria: z.array(
      z
        .object({
          id,
          status: z.enum(["passed", "failed", "not_run"]),
          detail: z.string().min(1),
        })
        .strict(),
    ),
    findings: z.array(
      z
        .object({
          priority: z.enum(["high", "medium", "low"]),
          path: z.string(),
          line: z.number().int().positive().nullable(),
          issue: z.string().min(1),
          change: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type ImplementationReview = z.infer<typeof implementationReviewSchema>;
