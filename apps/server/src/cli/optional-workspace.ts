import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { developmentCheckout, modelWorkspace, packageRoot } from "../paths.js";
import { runSetupCommand } from "./osdk.js";

const resources = [
  "scripts/document-parser/convert.py",
  "scripts/document-parser/pyproject.toml",
  "scripts/document-parser/uv.lock",
  "scripts/startlux/worker.py",
  "scripts/startlux/selection.py",
  "scripts/startlux/pyproject.toml",
  "scripts/startlux/uv.lock",
  "scripts/startlux/upstream.json",
];
export const optionalManifestName = ".omem-managed.json";
export const optionalUpdateDirectory = ".omem-updates";

type ModelDeclaration = Record<string, unknown>;
type Manifest = {
  schemaVersion: 1;
  bundleVersion: string;
  bundleDigest: string;
  models: Record<string, ModelDeclaration>;
  files: Record<string, string>;
};
export type OptionalWorkspaceOptions = {
  cwd?: string;
  assetRoot?: string;
  development?: boolean;
  run?: typeof runSetupCommand;
};
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function sameModel(
  left: ModelDeclaration | undefined,
  right: ModelDeclaration | undefined,
) {
  const normalized = (value: ModelDeclaration | undefined) => {
    if (value === undefined) return value;
    const result = clone(value);
    result.include ??= [];
    result.exclude ??= [];
    if (Object.keys((result.views ?? {}) as object).length === 0)
      delete result.views;
    return result;
  };
  return isDeepStrictEqual(normalized(left), normalized(right));
}

// First npm installs copied this exact declaration set without an ownership
// manifest. It stays frozen so upgraded packages can distinguish defaults from
// private overrides. New releases use the recorded three-way baseline instead.
const legacyModels: Record<string, ModelDeclaration> = {
  "docling-tables": {
    source:
      "hf:docling-project/docling-models@fc0f2d45e2218ea24bce5045f58a389aed16dc23",
    include: ["config.json", "model_artifacts/tableformer/accurate/*"],
    exclude: [],
    kind: "other",
    family: "docling",
    views: {},
  },
  "docling-layout": {
    source:
      "hf:docling-project/docling-layout-heron@8f39ad3c0b4c58e9c2d2c84a38465abf757272d8",
    include: ["*.json", "*.safetensors"],
    exclude: [],
    kind: "other",
    family: "docling",
    views: {},
  },
  "decision-startlux4b": {
    source:
      "hf:startlux-models/StartLux-Decision-4B@9302aedb7f7bd889994336f2ae919dffbf5dbee1",
    include: ["*.safetensors", "*.json", "merges.txt", "LICENSE", "NOTICE"],
    exclude: [],
    variant: "bf16",
    family: "startlux-decision",
    views: {},
  },
  "decision-startlux2b": {
    source:
      "hf:startlux-models/StartLux-Decision-2B@3e2e456409a7fe44be69eee231566f7830872ea2",
    include: ["*.safetensors", "*.json", "merges.txt", "LICENSE", "NOTICE"],
    exclude: [],
    variant: "bf16",
    family: "startlux-decision",
    views: {},
  },
  "memory-zh": {
    source:
      "hf:Xenova/bge-small-zh-v1.5@75c43b069aac4d136ba6bc1122f995fedcfd2781",
    include: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "vocab.txt",
      "onnx/model_quantized.onnx",
    ],
    exclude: [],
    kind: "embedding",
    family: "bge",
    derived_from: "BAAI/bge-small-zh-v1.5",
    views: {},
  },
};

function parseModels(text: string, path: string) {
  try {
    const models = parse(text).models ?? {};
    if (typeof models !== "object" || Array.isArray(models))
      throw Error("models 需要是 TOML 表");
    return clone(models) as Record<string, ModelDeclaration>;
  } catch (error) {
    throw Error(`无法读取模型声明 ${path}：${(error as Error).message}`);
  }
}

async function load(options: OptionalWorkspaceOptions) {
  const cwd = options.cwd ?? modelWorkspace();
  const assetRoot = options.assetRoot ?? packageRoot;
  const development = options.development ?? developmentCheckout;
  const template = await readFile(
    join(assetRoot, "config/models.toml"),
    "utf8",
  );
  const models = parseModels(template, join(assetRoot, "config/models.toml"));
  const { version: bundleVersion } = JSON.parse(
    await readFile(join(assetRoot, "package.json"), "utf8"),
  );
  const files: Record<string, string> = {};
  for (const path of resources)
    files[path] = hash(await readFile(join(assetRoot, path)));
  const bundleDigest = hash(JSON.stringify({ models, files }));
  const configFile = join(cwd, "osdk.toml");
  const currentText = existsSync(configFile)
    ? await readFile(configFile, "utf8")
    : undefined;
  const currentModels =
    currentText === undefined ? {} : parseModels(currentText, configFile);
  let previous: Manifest | undefined;
  const manifestFile = join(cwd, optionalManifestName);
  if (existsSync(manifestFile)) {
    try {
      const candidate = JSON.parse(await readFile(manifestFile, "utf8"));
      if (
        candidate.schemaVersion !== 1 ||
        !candidate.models ||
        !candidate.files ||
        typeof candidate.models !== "object" ||
        typeof candidate.files !== "object" ||
        Array.isArray(candidate.models) ||
        Array.isArray(candidate.files)
      )
        throw Error("无法识别受管清单版本");
      previous = candidate;
    } catch (error) {
      throw Error(
        `无法读取安装清单 ${manifestFile}：${(error as Error).message}。请保留原文件并检查内容，不会自动覆盖。`,
      );
    }
  }
  const pendingUpdates: string[] = [];
  const preserved: string[] = [];
  const modelUpdates: string[] = [];
  const fileUpdates: string[] = [];
  for (const [name, declaration] of Object.entries(models)) {
    const current = currentModels[name];
    if (sameModel(current, declaration)) continue;
    const baseline = previous?.models[name] ?? legacyModels[name];
    if (
      currentText === undefined ||
      (current === undefined && baseline === undefined) ||
      sameModel(current, baseline)
    ) {
      modelUpdates.push(name);
      pendingUpdates.push(`models.${name}`);
    } else preserved.push(`models.${name}`);
  }
  for (const [path, digest] of Object.entries(files)) {
    const local = join(cwd, path);
    const current = existsSync(local) ? hash(await readFile(local)) : undefined;
    if (current === digest) continue;
    if (current === undefined || current === previous?.files[path]) {
      fileUpdates.push(path);
      pendingUpdates.push(path);
    } else preserved.push(path);
  }
  return {
    cwd,
    assetRoot,
    development,
    template,
    currentText,
    models,
    files,
    modelUpdates,
    fileUpdates,
    previous,
    bundleVersion: String(bundleVersion),
    bundleDigest,
    pendingUpdates,
    preserved,
    state: development
      ? ("development" as const)
      : currentText === undefined
        ? ("missing" as const)
        : previous === undefined
          ? ("legacy" as const)
          : previous.bundleDigest !== bundleDigest || pendingUpdates.length > 0
            ? ("update-available" as const)
            : ("current" as const),
  };
}

/** Read-only, including unprepared installations; never runs osdk or downloads. */
export async function inspectOptionalWorkspace(
  options: OptionalWorkspaceOptions = {},
) {
  const data = await load(options);
  return {
    cwd: data.cwd,
    state: data.state,
    bundleVersion: data.bundleVersion,
    installedVersion: data.previous?.bundleVersion,
    pendingUpdates: data.pendingUpdates,
    preserved: data.preserved,
    updateDirectory: join(data.cwd, optionalUpdateDirectory),
  };
}

function modelUseArgs(name: string, declaration: ModelDeclaration) {
  const args = ["model", "use", name, String(declaration.source)];
  for (const field of ["include", "exclude"])
    for (const value of (declaration[field] ?? []) as string[])
      args.push(`--${field}`, value);
  for (const field of ["endpoint", "variant", "kind", "family", "derived_from"])
    if (declaration[field] !== undefined)
      args.push(`--${field.replaceAll("_", "-")}`, String(declaration[field]));
  // A new bundled declaration with unsupported view/when semantics must fail
  // visibly instead of flattening it through a partial handwritten TOML editor.
  if (
    declaration.when !== undefined ||
    Object.keys((declaration.views ?? {}) as object).length > 0
  )
    throw Error(`models.${name} 的新声明需要更新安装器，原配置未修改。`);
  return args;
}

export async function prepareOptionalWorkspace(
  options: OptionalWorkspaceOptions = {},
) {
  const data = await load(options);
  if (data.development) return inspectOptionalWorkspace(options);
  await mkdir(data.cwd, { recursive: true, mode: 0o700 });
  const configFile = join(data.cwd, "osdk.toml");
  if (data.currentText === undefined)
    await writeFile(configFile, data.template, { mode: 0o600, flag: "wx" });
  else if (data.modelUpdates.length > 0) {
    // osdk edits TOML with its own round-trip parser. Stage changes so failed
    // commands cannot discard the working declaration or its private comments.
    const staging = await mkdtemp(join(data.cwd, ".omem-setup-"));
    try {
      const stagedConfig = join(staging, "osdk.toml");
      await writeFile(stagedConfig, data.currentText, { mode: 0o600 });
      for (const name of data.modelUpdates)
        await (options.run ?? runSetupCommand)(
          "osdk",
          modelUseArgs(name, data.models[name]!),
          staging,
        );
      if ((await readFile(configFile, "utf8")) !== data.currentText)
        throw Error("模型声明在准备期间被修改，请重跑 setup；此次未覆盖。");
      await rename(stagedConfig, configFile);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  for (const path of data.fileUpdates) {
    const target = join(data.cwd, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(data.assetRoot, path), target);
  }
  if (data.preserved.length > 0) {
    const candidate = join(data.cwd, optionalUpdateDirectory);
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    await writeFile(join(candidate, "osdk.toml"), data.template, {
      mode: 0o600,
    });
    for (const path of data.preserved.filter((path) =>
      path.startsWith("scripts/"),
    )) {
      const target = join(candidate, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(data.assetRoot, path), target);
    }
  }
  const manifest: Manifest = {
    schemaVersion: 1,
    bundleVersion: data.bundleVersion,
    bundleDigest: data.bundleDigest,
    models: data.models,
    files: data.files,
  };
  const target = join(data.cwd, optionalManifestName);
  await writeFile(`${target}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(`${target}.tmp`, target);
  return inspectOptionalWorkspace(options);
}
