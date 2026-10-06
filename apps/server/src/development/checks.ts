import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DevelopmentProject } from "../../../../packages/contracts/src/development.js";
import { stableDigest } from "../storage/digest.js";
import { fingerprint, runCommand, type CommandResult } from "./workspace.js";

/** One execution environment shared by coding, host and review. A restart gets
 * a new environment identity, so old dependency state is never assumed ready. */
export class ProjectChecks {
  private readonly id = randomUUID();
  private generation = 0;
  private readonly pending = new Map<string, Promise<CommandResult>>();
  constructor(
    readonly root: string,
    readonly project: () => DevelopmentProject,
    readonly results: CommandResult[],
    readonly logs: string,
    readonly onResult: () => void,
    readonly signal?: AbortSignal,
  ) {}
  private environment() {
    return `${this.id}:${this.generation}`;
  }
  private latest(name: string, source: string) {
    const command = this.project().commands.find((c) => c.name === name);
    return (
      command &&
      this.results.findLast(
        (r) =>
          r.name === name &&
          r.sourceFingerprint === source &&
          r.commandFingerprint === stableDigest(command) &&
          r.environmentId === this.environment(),
      )
    );
  }
  private matches(result: CommandResult, name: string, source: string) {
    const command = this.project().commands.find((c) => c.name === name);
    return (
      command &&
      result.name === name &&
      result.exitCode === 0 &&
      result.sourceFingerprint === source &&
      result.afterFingerprint === source &&
      result.commandFingerprint === stableDigest(command) &&
      result.environmentId === this.environment() &&
      existsSync(result.log)
    );
  }
  async status() {
    const source = await fingerprint(this.root);
    return {
      commands: this.project().commands,
      results: this.results.map((r) => ({
        ...r,
        reusable:
          this.latest(r.name, source) === r &&
          !!this.matches(r, r.name, source),
      })),
    };
  }
  async run(
    name: string,
    forceReason?: string,
  ): Promise<CommandResult & { reused?: boolean }> {
    const project = this.project(),
      command = project.commands.find((c) => c.name === name);
    if (!command) throw Error("未知检查命令；先从项目文件确定并登记检查方式");
    const source = await fingerprint(this.root);
    if (!forceReason) {
      const saved = this.latest(name, source);
      // A later failed rerun overrides an earlier pass on the same inputs.
      if (saved && this.matches(saved, name, source))
        return { ...saved, reused: true };
    }
    const key = stableDigest([name, command, source, this.environment()]);
    const running = this.pending.get(key);
    if (running) return { ...(await running), reused: true };
    const operation = (async () => {
      const result = await runCommand(
        this.root,
        project,
        name,
        this.logs,
        this.signal,
      );
      if (command.purpose === "setup") this.generation++;
      result.environmentId = this.environment();
      this.results.push(result);
      this.onResult();
      return result;
    })();
    this.pending.set(key, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(key);
    }
  }
}
