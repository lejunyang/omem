import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { operationRuleSchema, operationRulesSchema, type OperationRule } from "../core/config.ts";
import { HttpError } from "../core/util.ts";
import { listPlugins } from "../plugins/registry.ts";
import { commandGateDir } from "./command-gate.ts";
import { currentRules, digest, saveOperationRules } from "./operation-policy.ts";
import { listSkills } from "./specs.ts";

const packRule = operationRuleSchema.pick({ id: true, title: true, match: true, action: true, approval: true }).strict();
const manifestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(100),
  rules: z.array(packRule).min(1).max(200).refine(rs => new Set(rs.map(r => r.id)).size === rs.length, "包内规则 id 重复"),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
type PackRule = z.infer<typeof packRule>;

// The public pack id identifies the publisher directory. Two publishers can use the same display name.
function installedPackId(rule: OperationRule) {
  return rule.pack && /^pack:((?:plugin|skill):[^:]+):[a-f0-9]{64}$/.exec(rule.id)?.[1];
}

function installedDefinition(rule: OperationRule): PackRule {
  return { id: rule.pack!.ruleId, title: rule.title, match: rule.match, action: rule.action, approval: rule.approval };
}

function compare(before: PackRule[], after: PackRule[]) {
  const old = new Map(before.map(r => [r.id, r]));
  const next = new Map(after.map(r => [r.id, r]));
  const oldOrder = before.map(r => r.id);
  const newOrder = after.map(r => r.id);
  return {
    added: after.filter(r => !old.has(r.id)),
    removed: before.filter(r => !next.has(r.id)),
    changed: after.filter(r => old.has(r.id) && digest(old.get(r.id)) !== digest(r)).map(r => ({ before: old.get(r.id)!, after: r })),
    order: digest(oldOrder) === digest(newOrder) ? null : { before: oldOrder, after: newOrder },
  };
}

function packCatalog(app: App) {
  const sources = [
    ...listPlugins().map(p => ({ type: "plugin", name: p.manifest.id, dir: p.dir })),
    ...listSkills(app, { includeDrafts: true }).map(s => ({ type: "skill", name: s.name, dir: s.dir })),
  ];
  const catalog = new Map<string, { manifest?: Manifest; error?: string; installed: OperationRule[] }>();
  for (const source of sources) {
    const file = join(source.dir, "operation-rules.yaml");
    const id = source.type + ":" + source.name;
    try {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("规则包须为不超过 2 MB 的普通文件");
      const manifest = manifestSchema.parse(YAML.parse(readFileSync(file, "utf8")));
      catalog.set(id, { manifest, installed: [] });
    } catch (e) {
      catalog.set(id, { error: (e as Error).message, installed: [] });
    }
  }
  // Keep an installed snapshot manageable if its source is removed or its new YAML is invalid.
  for (const rule of currentRules(app)) {
    const id = installedPackId(rule);
    if (!id) continue;
    if (!catalog.has(id)) catalog.set(id, { error: "来源已移除", installed: [] });
    catalog.get(id)!.installed.push(rule);
  }
  return catalog;
}

const confirmation = (id: string, manifest: Manifest, installed: OperationRule[]) => digest([id, manifest, installed]);

export function listRulePacks(app: App) {
  return [...packCatalog(app)].map(([id, { manifest, installed, error }]) => {
    const first = installed[0];
    const [type, name] = id.split(":");
    return {
      id, source: { type, name }, name: manifest?.name ?? first?.pack?.name, version: manifest?.version ?? null,
      ruleCount: manifest?.rules.length ?? 0, enabled: installed.length > 0, installedVersion: first?.pack?.version ?? null,
      scope: first?.scope, error, diff: manifest && compare(installed.map(installedDefinition), manifest.rules),
      confirmation: manifest && confirmation(id, manifest, installed),
    };
  });
}

export function enableRulePack(app: App, id: string, scope: NonNullable<OperationRule["scope"]>, confirmed: string) {
  const entry = packCatalog(app).get(id);
  if (!entry) throw new HttpError(404, "没有这个规则包");
  const { manifest, installed } = entry;
  if (!manifest) throw new HttpError(400, entry.error!);
  if (confirmed !== confirmation(id, manifest, installed)) throw new HttpError(409, "规则包已变化，请重新查看差异再确认");
  const replacements = manifest.rules.map(r => ({
    ...r, id: `pack:${id}:${digest(r.id)}`, enabled: true, revision: 1, scope,
    pack: { name: manifest.name, version: manifest.version, ruleId: r.id },
  }));
  const rules = currentRules(app);
  // Keep unrelated rules at their priority relative to surviving pack rules. New entries go
  // beside the next surviving rule, or after the last one when the manifest appends them.
  const oldIds = new Set(installed.map(r => r.id));
  const positions = new Map(replacements.map((r, i) => [r.id, i]));
  const anchors = installed.filter(r => positions.has(r.id));
  const ends = anchors.map(r => positions.get(r.id)! + 1).sort((a, b) => a - b);
  // A complete replacement stays at the old pack's position too.
  if (!anchors.length && installed.length) anchors.push(installed[0]);
  const groups = new Map<string, OperationRule[]>();
  let cursor = 0;
  anchors.forEach((r, i) => {
    const end = i === anchors.length - 1 ? replacements.length : ends[i];
    groups.set(r.id, replacements.slice(cursor, end));
    cursor = end;
  });
  const next = rules.flatMap(r => oldIds.has(r.id) ? groups.get(r.id) ?? [] : [r]);
  if (!installed.length) next.push(...replacements);
  const valid = operationRulesSchema.safeParse(next);
  if (!valid.success) throw new HttpError(400, valid.error.message);
  saveOperationRules(app, next);
  commandGateDir(app);
}

export function disableRulePack(app: App, id: string) {
  if (!packCatalog(app).has(id)) throw new HttpError(404, "没有这个规则包");
  saveOperationRules(app, currentRules(app).filter(rule => installedPackId(rule) !== id));
  commandGateDir(app);
}
