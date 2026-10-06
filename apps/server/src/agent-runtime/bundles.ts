import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  roleManifestSchema,
  type AgentProfile,
  type RoleManifest,
} from "../../../../packages/contracts/src/index.js";
import { stableDigest } from "../storage/digest.js";
import { assetPath } from "../paths.js";

export type LoadedSkill = RoleManifest["skill_bundles"][number] & {
  directory: string;
  content: string;
};

export type RoleBundle = {
  directory: string;
  manifest: RoleManifest;
  prompt: string;
  outputSchema: Record<string, unknown>;
  skills: LoadedSkill[];
  bundleHash: string;
};

const inside = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

function safeFile(root: string, path: string) {
  const candidate = resolve(root, path);
  if (!inside(resolve(root), candidate) || !existsSync(candidate))
    throw Error(`ROLE_ASSET_PATH_INVALID: ${path}`);
  const actual = realpathSync(candidate);
  if (
    !inside(realpathSync(root), actual) ||
    lstatSync(candidate).isSymbolicLink()
  )
    throw Error(`ROLE_ASSET_SYMLINK_REJECTED: ${path}`);
  return actual;
}

function files(directory: string, root = directory): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Installer metadata and ignore rules are not runtime assets. npm omits
    // or renames them, so they cannot participate in a portable skill digest.
    if ([".osdk-manifest.json", ".gitignore", ".npmignore"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw Error(`ROLE_ASSET_SYMLINK_REJECTED: ${relative(root, path)}`);
    if (entry.isDirectory()) result.push(...files(path, root));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort((left, right) =>
    relative(root, left).localeCompare(relative(root, right)),
  );
}

export function directoryDigest(directory: string) {
  const hash = createHash("sha256");
  for (const path of files(directory)) {
    // Normalize the relative path to forward slashes so the digest does not
    // depend on the platform path separator (Windows uses "\\", POSIX "/").
    const normalizedPath = relative(directory, path).split(sep).join("/");
    hash.update(normalizedPath);
    hash.update("\0");
    // Normalize file bytes to LF so a CRLF checkout on Windows produces the
    // same digest as an LF checkout on Linux/macOS. Skill bundles are text
    // assets (SKILL.md, *.yaml, *.json); the original manifest digests were
    // computed against LF-normalized content.
    const raw = readFileSync(path).toString("binary").replace(/\r\n/g, "\n");
    hash.update(Buffer.from(raw, "binary"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function copyVerifiedDirectory(source: string, destination: string) {
  for (const path of files(source)) {
    const target = join(destination, relative(source, path));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (existsSync(target)) {
      if (!readFileSync(target).equals(readFileSync(path)))
        throw Error(`ROLE_WORKSPACE_CONTENT_CONFLICT: ${target}`);
      continue;
    }
    copyFileSync(path, target);
  }
}

export class RoleBundleRegistry {
  constructor(
    readonly root = assetPath("packages/agent-runtime/roles"),
    readonly projectSkills = assetPath(".agents/skills"),
  ) {}

  load(roleId: string, version = "1"): RoleBundle {
    if (!/^[a-z0-9-]+$/.test(roleId) || !/^[a-zA-Z0-9._-]+$/.test(version))
      throw Error("ROLE_ID_OR_VERSION_INVALID");
    const directory = resolve(this.root, roleId, version);
    if (!inside(resolve(this.root), directory))
      throw Error("ROLE_PATH_INVALID");
    const manifestPath = safeFile(directory, "manifest.json");
    const manifest = roleManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    if (manifest.role_id !== roleId || manifest.role_version !== version)
      throw Error("ROLE_MANIFEST_ID_MISMATCH");
    const promptParts = manifest.prompt_templates.map((path) =>
      readFileSync(safeFile(directory, path), "utf8"),
    );
    const outputSchema = JSON.parse(
      readFileSync(safeFile(directory, "output.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      String(outputSchema.$id || "")
        .split("/")
        .at(-1) !== manifest.output_schema
    )
      throw Error("ROLE_OUTPUT_SCHEMA_MISMATCH");
    const names = new Set<string>();
    const skills = manifest.skill_bundles.map((entry) => {
      if (names.has(entry.canonical_name)) throw Error("ROLE_SKILL_DUPLICATE");
      names.add(entry.canonical_name);
      const skillRoot =
        entry.source === "project"
          ? resolve(this.projectSkills)
          : resolve(directory, "skills");
      const skillDirectory = resolve(skillRoot, entry.canonical_name);
      if (!inside(skillRoot, skillDirectory) || !existsSync(skillDirectory))
        throw Error(`ROLE_SKILL_MISSING: ${entry.canonical_name}`);
      safeFile(skillRoot, entry.canonical_name);
      const skillFile = safeFile(skillDirectory, "SKILL.md");
      const content = readFileSync(skillFile, "utf8");
      const frontmatterName = content
        .match(/^---\s*\nname:\s*([^\n]+)\n/m)?.[1]
        ?.trim();
      if (frontmatterName !== entry.canonical_name)
        throw Error(`ROLE_SKILL_NAME_MISMATCH: ${entry.canonical_name}`);
      if (directoryDigest(skillDirectory) !== entry.artifact_digest)
        throw Error(`ROLE_SKILL_DIGEST_MISMATCH: ${entry.canonical_name}`);
      return { ...entry, directory: skillDirectory, content };
    });
    const prompt = promptParts.join("\n\n");
    return {
      directory,
      manifest,
      prompt,
      outputSchema,
      skills,
      bundleHash: stableDigest({
        manifest,
        prompt,
        outputSchema,
        skills: skills.map(({ canonical_name, artifact_digest, content }) => ({
          canonical_name,
          artifact_digest,
          content,
        })),
      }),
    };
  }

  prepareWorkspace(
    bundle: RoleBundle,
    base: string,
    profile: AgentProfile,
    runId: string,
  ) {
    const workspace = resolve(base, "roles", bundle.bundleHash, runId);
    if (!inside(resolve(base), workspace))
      throw Error("ROLE_WORKSPACE_INVALID");
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const nativeSkills = bundle.skills.filter(
      (skill) => skill.load_mode === "native",
    );
    if (nativeSkills.length && profile.transport !== "acp")
      throw Error("NATIVE_SKILL_DISCOVERY_UNSUPPORTED_FOR_CLI");
    const skillRoot = join(workspace, ".trae", "skills");
    for (const skill of nativeSkills)
      copyVerifiedDirectory(
        skill.directory,
        join(skillRoot, basename(skill.directory)),
      );
    return workspace;
  }
}
