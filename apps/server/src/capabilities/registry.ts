import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  capabilityId,
  capabilitySchema,
  type Capability,
  type CapabilityReference,
} from "../../../../packages/contracts/src/capabilities.js";
import { codePath, saveJson } from "../development/workspace.js";
import { stableDigest } from "../storage/digest.js";

export type RegisteredCapability = {
  definition: Capability;
  revision: string;
  directory: string;
};
export class CapabilityRegistry {
  readonly root: string;
  constructor(dataDir: string) {
    this.root = join(resolve(dataDir), "capabilities");
  }
  private path(id: string) {
    return join(this.root, capabilityId.parse(id));
  }
  register(input: unknown, base = process.cwd()) {
    const definition = capabilitySchema.parse(input),
      files: Record<string, Buffer> = {};
    for (const skill of definition.skills) {
      const root = realpathSync(resolve(base, skill.directory));
      if (!existsSync(join(root, "SKILL.md")))
        throw Error(`${skill.name} 缺少 SKILL.md`);
      const visit = (relative: string) => {
        for (const entry of readdirSync(join(root, relative), {
          withFileTypes: true,
        })) {
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          const path = join(relative, entry.name);
          if (entry.isSymbolicLink())
            throw Error(`技能不能包含符号链接：${path}`);
          if (entry.isDirectory()) visit(path);
          else if (entry.isFile())
            files[join("skills", skill.name, path)] = readFileSync(
              join(root, path),
            );
        }
      };
      visit("");
      skill.directory = join("skills", skill.name);
    }
    const revision = stableDigest({
      definition,
      files: Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([p, b]) => [p, stableDigest(b)]),
    });
    const directory = join(this.path(definition.id), "versions", revision);
    if (!existsSync(join(directory, "manifest.json"))) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const [path, bytes] of Object.entries(files)) {
        mkdirSync(dirname(join(directory, path)), {
          recursive: true,
          mode: 0o700,
        });
        writeFileSync(join(directory, path), bytes, { mode: 0o600 });
      }
      saveJson(join(directory, "manifest.json"), definition);
    }
    saveJson(join(this.path(definition.id), "current.json"), {
      revision,
      enabled: true,
    });
    return this.describe(this.read(definition.id));
  }
  read(id: string, revision?: string): RegisteredCapability {
    const root = this.path(id);
    if (!existsSync(join(root, "current.json")))
      throw Error(`能力未登记：${id}`);
    const current = JSON.parse(
      readFileSync(join(root, "current.json"), "utf8"),
    );
    if (!current.enabled) throw Error(`能力已停用：${id}`);
    revision ??= current.revision;
    if (!/^[a-f0-9]{64}$/.test(revision!)) throw Error("能力版本无效");
    const directory = join(root, "versions", revision!);
    return {
      definition: capabilitySchema.parse(
        JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")),
      ),
      revision: revision!,
      directory,
    };
  }
  describe(pack: RegisteredCapability) {
    const d = pack.definition;
    return {
      id: d.id,
      revision: pack.revision,
      name: d.name,
      description: d.description,
      skills: d.skills.map((s) => ({ name: s.name, entry: "SKILL.md" })),
      cli: d.cli.map((c) => ({
        name: c.name,
        description: c.description,
        arguments: c.args.filter((a) => typeof a !== "string"),
      })),
      mcpTools: d.mcp?.readOnlyTools ?? [],
      checks: d.checks.map((c) => c.name),
      access: "read_only",
      availability: "not_checked",
    };
  }
  list() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).flatMap((id) => {
      if (!capabilityId.safeParse(id).success) return [];
      const currentFile = join(this.path(id), "current.json");
      if (!existsSync(currentFile)) return [];
      try {
        if (!JSON.parse(readFileSync(currentFile, "utf8")).enabled) return [];
        return [this.describe(this.read(id))];
      } catch (error) {
        throw Error(`能力 ${id} 的本地配置读取失败：${String(error)}`);
      }
    });
  }
  references(ids: string[]): CapabilityReference[] {
    return [...new Set(ids)].map((id) => ({
      id,
      revision: this.read(id).revision,
    }));
  }
  disable(id: string) {
    const path = join(this.path(id), "current.json");
    const current = JSON.parse(readFileSync(path, "utf8"));
    saveJson(path, { ...current, enabled: false });
    return { id, enabled: false, historyRetained: true };
  }
  readSkill(pack: RegisteredCapability, name: string, path: string) {
    const skill = pack.definition.skills.find((s) => s.name === name);
    if (!skill) throw Error("技能不在本能力包中");
    return readFileSync(
      codePath(join(pack.directory, skill.directory), path),
      "utf8",
    );
  }
}
