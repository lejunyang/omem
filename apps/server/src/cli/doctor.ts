import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { parse } from "smol-toml";
import type { Config } from "../config.js";
import {
  assetPath,
  modelWorkspace,
  pythonInVenv,
  developmentCheckout,
} from "../paths.js";
import { inspectOptionalWorkspace } from "./optional-workspace.js";
import { osdkInstallHelp } from "./osdk.js";

export type DependencyState =
  | "discovered"
  | "verified"
  | "missing"
  | "stale"
  | "unsupported"
  | "error";
export interface DependencyCheck {
  id: string;
  component: string;
  state: DependencyState;
  enabled: boolean;
  installed: boolean;
  message: string;
  fix?: string;
  path?: string;
  details?: Record<string, unknown>;
}
export interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}
export type ProbeRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv },
) => Promise<ProbeResult>;
export interface InspectOptionalOptions {
  verifyModels?: boolean;
  cwd?: string;
  assetRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  run?: ProbeRunner;
}

const runProbe: ProbeRunner = (command, args, options) =>
  new Promise((complete) => {
    execFile(
      command,
      args,
      { ...options, maxBuffer: 2_000_000, windowsHide: true },
      (error, stdout, stderr) =>
        complete({
          code: error
            ? typeof error.code === "number"
              ? error.code
              : null
            : 0,
          stdout,
          stderr: stderr || error?.message || "",
          errorCode: error
            ? typeof error.code === "string"
              ? error.code
              : error.killed
                ? "ETIMEDOUT"
                : undefined
            : undefined,
        }),
    );
  });

const failing = new Set<DependencyState>([
  "missing",
  "stale",
  "unsupported",
  "error",
]);
const errorText = (result: ProbeResult) =>
  (result.stderr || result.stdout || result.errorCode || `退出 ${result.code}`)
    .trim()
    .slice(-1200);

function sourceFor(config: string, alias: string) {
  try {
    const table = (
      parse(config).models as Record<string, { source?: unknown }> | undefined
    )?.[alias];
    return typeof table?.source === "string" ? table.source : undefined;
  } catch {
    return undefined;
  }
}
function snapshotIdentity(source: string | undefined) {
  const match = source?.match(/^hf:([^@]+)@([0-9a-f]{40})$/);
  return match ? { repository: match[1], revision: match[2] } : undefined;
}

// The probe imports code and checks installed distribution versions; it never
// loads model weights, parses a document, or starts the resident decision worker.
const pythonProbe = String.raw`
import sys, json, importlib, importlib.metadata as md, pathlib, tomllib, re
project, module = sys.argv[1:3]
root = pathlib.Path(project)
config = tomllib.loads((root / "pyproject.toml").read_text())
lock = tomllib.loads((root / "uv.lock").read_text())
expected = {}
for package in lock["package"]:
    expected.setdefault(package["name"].lower().replace("_", "-"), set()).add(package["version"])
direct, missing, mismatches = {}, [], []
for requirement in config["project"]["dependencies"]:
    match = re.match(r"([A-Za-z0-9_-]+)==([^;\s]+)", requirement)
    if not match: continue
    name, version = match.groups()
    try:
        current = md.version(name)
        direct[name] = current
        if current != version: mismatches.append(name + ": " + current + " != " + version)
    except md.PackageNotFoundError: missing.append(name)
for package in md.distributions():
    name = package.metadata.get("Name", "").lower().replace("_", "-")
    if name in expected and package.version not in expected[name]:
        mismatches.append(name + ": " + package.version + " not in lock")
result = {"python": sys.version.split()[0], "versions": direct, "missing": missing, "mismatches": sorted(set(mismatches))}
try:
    importlib.import_module(module)
    result["imported"] = module
    if module == "docling" and importlib.util.find_spec("docling.document_converter") is None:
        result["importError"] = "docling.document_converter entrypoint missing"
except Exception as error:
    result["importError"] = str(error)
print(json.dumps(result))
`;

async function inspectPython(
  component: "documents" | "decisions",
  enabled: boolean,
  cwd: string,
  bundle: string,
  platform: NodeJS.Platform,
  run: ProbeRunner,
): Promise<DependencyCheck> {
  const runtime = join(
    cwd,
    ".osdk/runtime",
    component === "documents" ? "docling" : "decision",
  );
  const path = pythonInVenv(runtime, platform);
  const installed = existsSync(join(runtime, "venv"));
  const base = {
    id: `${component}.python`,
    component,
    enabled,
    installed,
    path,
    fix: `omem setup ${component}`,
  };
  if (!existsSync(path))
    return {
      ...base,
      state: "missing",
      message: "尚未准备可选 Python 运行环境。",
    };
  const result = await run(
    path,
    [
      "-B",
      "-c",
      pythonProbe,
      join(
        bundle,
        "scripts",
        component === "documents" ? "document-parser" : "startlux",
      ),
      component === "documents" ? "docling" : "startlux_decision.mlx_model",
    ],
    {
      cwd,
      timeout: 30_000,
      env: {
        ...process.env,
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        ...(component === "decisions"
          ? { PYTHONPATH: join(runtime, "upstream") }
          : {}),
      },
    },
  );
  if (result.code !== 0)
    return {
      ...base,
      state: "error",
      message: "Python 依赖探测失败；尚未证明可运行。",
      details: { error: errorText(result), exitCode: result.code },
    };
  try {
    const details = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
      python: string;
      versions: Record<string, string>;
      missing: string[];
      mismatches: string[];
      importError?: string;
      imported?: string;
    };
    if (!details.python?.startsWith("3.12.") || details.mismatches?.length)
      return {
        ...base,
        state: "stale",
        message: "已安装 Python 或依赖版本与随包锁文件不一致。",
        details,
      };
    if (details.missing?.length || details.importError || !details.imported)
      return {
        ...base,
        state: "error",
        message: "环境目录已存在，但模块或依赖尚不能导入。",
        details,
      };
    return {
      ...base,
      state: "verified",
      message:
        component === "documents"
          ? "Docling 核心模块导入、解析入口发现及本地依赖锁定版本检查通过；未验证完整解析流程。"
          : "模块导入及本地已安装依赖的锁定版本检查通过；未执行推理。",
      details,
    };
  } catch {
    return {
      ...base,
      state: "error",
      message: "Python 探测没有返回有效结果。",
      details: { error: errorText(result) },
    };
  }
}

interface ModelSpec {
  alias: string;
  declarationAlias?: string;
  component: string;
  enabled: boolean;
  fix: string;
  requiredFiles: string[];
  consumerPath?: string;
}
interface Snapshot {
  repository: string;
  revision: string;
  snapshot_path: string;
  files: { path: string; size: number; sha256: string }[];
}
async function inspectModel(
  spec: ModelSpec,
  localConfig: string,
  expectedConfig: string,
  osdkAvailable: boolean,
  options: Required<
    Pick<InspectOptionalOptions, "cwd" | "verifyModels" | "run">
  >,
): Promise<DependencyCheck> {
  const base = {
    id: `model.${spec.alias}`,
    component: spec.component,
    enabled: spec.enabled,
    installed: !!spec.consumerPath && existsSync(spec.consumerPath),
    fix: spec.fix,
  };
  const expectedSource = sourceFor(
    expectedConfig,
    spec.declarationAlias ?? spec.alias,
  );
  const localSource = sourceFor(localConfig, spec.alias);
  if (!osdkAvailable)
    return {
      ...base,
      state: "missing",
      message: "未找到 osdk，无法只读检查本地模型。",
      fix: "安装 osdk 后再运行 omem doctor；https://github.com/lejunyang/one-sdk#install",
    };
  if (!localSource)
    return {
      ...base,
      state: "missing",
      message: "当前可选环境尚未声明此模型；其他环境的缓存不会当作已安装能力。",
    };
  const result = await options.run(
    "osdk",
    ["model", "show", spec.alias, "--json", "--offline"],
    { cwd: options.cwd, timeout: 10_000 },
  );
  if (result.code !== 0)
    return {
      ...base,
      state:
        result.errorCode ||
        !/No such file|not found|不存在/i.test(errorText(result))
          ? "error"
          : "missing",
      message: "未发现可用的本地模型快照。",
      details: { error: errorText(result), declared: !!localSource },
    };
  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(result.stdout).model;
    if (
      !snapshot?.snapshot_path ||
      !Array.isArray(snapshot.files) ||
      !snapshot.files.length
    )
      throw Error("模型元数据缺少快照路径或文件清单");
  } catch (error) {
    return {
      ...base,
      installed: true,
      state: "error",
      message: "模型元数据无效。",
      details: { error: String(error) },
    };
  }
  const identity = snapshotIdentity(expectedSource);
  const found = { ...base, installed: true, path: snapshot.snapshot_path };
  if (
    !identity ||
    snapshot.repository !== identity.repository ||
    snapshot.revision !== identity.revision ||
    localSource !== expectedSource
  )
    return {
      ...found,
      state: "stale",
      message: "模型快照或当前声明与此版本 omem 要求不一致。",
      details: {
        expectedSource,
        declaredSource: localSource ?? null,
        repository: snapshot.repository,
        revision: snapshot.revision,
      },
    };
  const missing = spec.requiredFiles.filter(
    (name) => !snapshot.files.some((file) => file.path === name),
  );
  if (
    spec.component === "decisions" &&
    !snapshot.files.some((file) => file.path.endsWith(".safetensors"))
  )
    missing.push("模型权重 *.safetensors");
  for (const file of snapshot.files) {
    const path = resolve(snapshot.snapshot_path, file.path);
    const rel = relative(resolve(snapshot.snapshot_path), path);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      missing.push(file.path);
      continue;
    }
    try {
      const info = await stat(path);
      if (
        !info.isFile() ||
        info.size !== file.size ||
        !/^[0-9a-f]{64}$/.test(file.sha256)
      )
        missing.push(file.path);
    } catch {
      missing.push(file.path);
    }
  }
  if (spec.component === "decisions") {
    try {
      const index = JSON.parse(
        await readFile(
          join(snapshot.snapshot_path, "model.safetensors.index.json"),
          "utf8",
        ),
      ) as { weight_map?: Record<string, unknown> };
      if (!index.weight_map || !Object.keys(index.weight_map).length)
        missing.push("模型分片索引");
      else
        for (const file of new Set(Object.values(index.weight_map)))
          if (
            typeof file !== "string" ||
            !snapshot.files.some((entry) => entry.path === file)
          )
            missing.push(`分片 ${String(file)}`);
    } catch {
      missing.push("model.safetensors.index.json");
    }
  }
  if (missing.length)
    return {
      ...found,
      state: "error",
      message: "模型快照的文件缺失、大小异常或摘要记录不完整。",
      details: { files: [...new Set(missing)] },
    };
  if (spec.consumerPath) {
    try {
      if (
        (await realpath(spec.consumerPath)) !==
        (await realpath(snapshot.snapshot_path))
      )
        throw Error("解析器链接未指向当前快照");
    } catch (error) {
      return {
        ...found,
        state: "error",
        message: "PDF 解析模型已下载，但解析器使用的本地链接缺失或过期。",
        details: { consumerPath: spec.consumerPath, error: String(error) },
      };
    }
  }
  const details = {
    repository: snapshot.repository,
    revision: snapshot.revision,
    fileCount: snapshot.files.length,
    bytes: snapshot.files.reduce((sum, file) => sum + file.size, 0),
    inferenceTested: false,
  };
  if (!options.verifyModels)
    return {
      ...found,
      state: "discovered",
      message: "声明、快照清单和文件大小已检查；尚未校验权重内容或执行推理。",
      details,
    };
  const verified = await options.run(
    "osdk",
    ["model", "verify", spec.alias, "--json", "--offline"],
    { cwd: options.cwd, timeout: 180_000 },
  );
  let status;
  try {
    status = JSON.parse(verified.stdout).status;
  } catch {
    /* Report command diagnostics below. */
  }
  return verified.code === 0 && status === "verified"
    ? {
        ...found,
        state: "verified",
        message: "osdk 已完整校验本地模型文件内容；未加载权重或执行推理。",
        details,
      }
    : {
        ...found,
        state: "error",
        message: "模型文件内容校验失败。",
        details: {
          ...details,
          error: errorText(verified),
          exitCode: verified.code,
        },
      };
}

async function inspectDecisionCode(
  cwd: string,
  bundle: string,
  enabled: boolean,
): Promise<DependencyCheck> {
  const path = join(cwd, ".osdk/runtime/decision/upstream/startlux_decision");
  const base = {
    id: "decisions.code",
    component: "decisions",
    enabled,
    installed: existsSync(path),
    path,
    fix: "omem setup decisions",
  };
  if (!base.installed)
    return {
      ...base,
      state: "missing",
      message: "尚未准备锁定的 StartLux 运行代码。",
    };
  try {
    const manifest = JSON.parse(
      await readFile(join(bundle, "scripts/startlux/upstream.json"), "utf8"),
    ) as { files: Record<string, string>; commit: string };
    const mismatches: string[] = [];
    for (const [name, hash] of Object.entries(manifest.files)) {
      try {
        const actual = createHash("sha256")
          .update(await readFile(join(path, name)))
          .digest("hex");
        if (actual !== hash) mismatches.push(name);
      } catch {
        mismatches.push(name);
      }
    }
    return mismatches.length
      ? {
          ...base,
          state: "stale",
          message: "StartLux 运行代码缺失或与随包锁定版本不一致。",
          details: { files: mismatches },
        }
      : {
          ...base,
          state: "verified",
          message: "StartLux 运行代码摘要检查通过。",
          details: { commit: manifest.commit },
        };
  } catch (error) {
    return {
      ...base,
      state: "error",
      message: "无法检查 StartLux 运行代码。",
      details: { error: String(error) },
    };
  }
}

/** Read-only optional-capability inspection. Missing unused extras do not make
 * the base installation unhealthy. Installed-but-broken extras are actionable. */
export async function inspectOptionalDependencies(
  config: Pick<Config, "retrieval" | "decisions">,
  options: InspectOptionalOptions = {},
) {
  const cwd = options.cwd ?? modelWorkspace();
  const bundle = options.assetRoot ?? assetPath();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const run = options.run ?? runProbe;
  const verifyModels = options.verifyModels ?? false;
  const decisionMode = config.decisions?.mode ?? "auto";
  const decisionsEnabled = !!config.decisions && decisionMode !== "off";
  const embeddingEnabled = config.retrieval?.enabled ?? false;
  const checks: DependencyCheck[] = [];
  const version = await run("osdk", ["--version"], {
    cwd: existsSync(cwd) ? cwd : bundle,
    timeout: 10_000,
  });
  const osdkAvailable = version.code === 0;
  checks.push({
    id: "osdk",
    component: "osdk",
    state: osdkAvailable
      ? "discovered"
      : version.errorCode === "ENOENT"
        ? "missing"
        : "error",
    enabled: embeddingEnabled || decisionsEnabled,
    installed: version.code === 0 || version.errorCode !== "ENOENT",
    message: osdkAvailable
      ? "已找到 osdk；不会自动下载依赖或模型。"
      : "无法运行 osdk，可选依赖尚不能准备或检查。",
    ...(!osdkAvailable ? { fix: osdkInstallHelp } : {}),
    details: osdkAvailable
      ? { version: version.stdout.trim() }
      : { error: errorText(version) },
  });
  let workspaceStatus:
    | Awaited<ReturnType<typeof inspectOptionalWorkspace>>
    | undefined;
  try {
    workspaceStatus = await inspectOptionalWorkspace({
      cwd,
      assetRoot: bundle,
      development: options.cwd ? false : developmentCheckout,
    });
    checks.push({
      id: "optional.workspace",
      component: "workspace",
      state: workspaceStatus.state === "missing" ? "missing" : "discovered",
      enabled: false,
      installed: workspaceStatus.state !== "missing",
      path: cwd,
      message:
        workspaceStatus.state === "missing"
          ? "尚未建立可选运行环境；首次 setup 会准备。"
          : workspaceStatus.state === "legacy" ||
              workspaceStatus.state === "update-available"
            ? "可选环境可更新；原有定制声明与脚本会保留。"
            : workspaceStatus.preserved.length
              ? "已读取可选环境；保留的定制项需要自行比较更新候选。"
              : "已读取可选环境的版本与资源状态。",
      ...(workspaceStatus.pendingUpdates.length ||
      workspaceStatus.preserved.length
        ? {
            fix: "运行所需的 omem setup 子命令；定制项与 .omem-updates/ 比较后自行合并。",
          }
        : {}),
      details: { ...workspaceStatus },
    });
  } catch (error) {
    checks.push({
      id: "optional.workspace",
      component: "workspace",
      state: "error",
      enabled: embeddingEnabled || decisionsEnabled,
      installed: existsSync(join(cwd, "osdk.toml")),
      path: cwd,
      message: "可选环境的声明或受管清单无法读取；不会自动覆盖。",
      details: { error: String(error) },
      fix: "保留个人 osdk.toml 与 .omem-managed.json，按错误检查后再运行 omem setup。",
    });
  }
  let localConfig = "",
    expectedConfig = "";
  try {
    expectedConfig = await readFile(join(bundle, "config/models.toml"), "utf8");
  } catch {
    /* Assets are also checked by the CLI. */
  }
  try {
    localConfig = await readFile(join(cwd, "osdk.toml"), "utf8");
  } catch {
    /* First-time npm installation has no optional workspace yet. */
  }
  checks.push(
    await inspectPython("documents", false, cwd, bundle, platform, run),
  );
  const supportsDecisions = platform === "darwin" && arch === "arm64";
  if (supportsDecisions) {
    checks.push(
      await inspectPython(
        "decisions",
        decisionsEnabled,
        cwd,
        bundle,
        platform,
        run,
      ),
    );
    checks.push(await inspectDecisionCode(cwd, bundle, decisionsEnabled));
  } else {
    checks.push({
      id: "decisions.platform",
      component: "decisions",
      state: "unsupported",
      enabled: decisionsEnabled,
      installed: false,
      message: "当前 StartLux 原生运行层需要 Apple Silicon Mac。",
      fix: '保留 decisions.mode="off"，常规问答与整理仍可使用已配置的 ACP Agent。',
      details: { platform, arch },
    });
  }
  const doclingModels = join(cwd, ".osdk/runtime/docling/models");
  const specs: ModelSpec[] = [
    {
      alias: "docling-layout",
      component: "document-models",
      enabled: false,
      fix: "omem setup document-models",
      requiredFiles: [
        "config.json",
        "model.safetensors",
        "preprocessor_config.json",
      ],
      consumerPath: join(
        doclingModels,
        "docling-project--docling-layout-heron",
      ),
    },
    {
      alias: "docling-tables",
      component: "document-models",
      enabled: false,
      fix: "omem setup document-models",
      requiredFiles: [
        "config.json",
        "model_artifacts/tableformer/accurate/tm_config.json",
        "model_artifacts/tableformer/accurate/tableformer_accurate.safetensors",
      ],
      consumerPath: join(doclingModels, "docling-project--docling-models"),
    },
    {
      alias: config.retrieval?.osdkModel ?? "memory-zh",
      declarationAlias: "memory-zh",
      component: "embedding",
      enabled: embeddingEnabled,
      fix: "omem setup embedding",
      requiredFiles: [
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "vocab.txt",
        "onnx/model_quantized.onnx",
      ],
    },
    ...["2b", "4b", "9b"].map((size) => ({
      alias: `decision-startlux${size}`,
      component: "decisions",
      enabled: decisionsEnabled && decisionMode === size,
      fix: `omem setup decisions --model ${size}`,
      requiredFiles: [
        "config.json",
        "decision_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "model.safetensors.index.json",
      ],
    })),
  ];
  for (const spec of specs)
    checks.push(
      await inspectModel(spec, localConfig, expectedConfig, osdkAvailable, {
        cwd: existsSync(cwd) ? cwd : bundle,
        verifyModels,
        run,
      }),
    );
  if (
    decisionsEnabled &&
    decisionMode === "auto" &&
    supportsDecisions &&
    !checks.some(
      (check) =>
        ["model.decision-startlux2b", "model.decision-startlux4b"].includes(
          check.id,
        ) && !failing.has(check.state),
    )
  )
    checks.push({
      id: "decisions.selection",
      component: "decisions",
      state: "missing",
      enabled: true,
      installed: false,
      message: "自动选择至少需要一份可用的 2B 或 4B 本地快照。",
      fix: "omem setup decisions --model 2b",
    });
  const healthy = !checks.some(
    (check) => failing.has(check.state) && (check.enabled || check.installed),
  );
  return {
    workspace: cwd,
    workspaceStatus,
    verifyModels,
    decisionMode,
    decisionsConfigured: !!config.decisions,
    healthy,
    checks,
    note: "检测不会下载、解析文档、启动服务或加载模型推理。“已发现”只代表低成本本地检查；“校验通过”说明所列检查通过，实际运行和效果仍需分别验证。",
  };
}

export function formatOptionalReport(
  report: Awaited<ReturnType<typeof inspectOptionalDependencies>>,
) {
  const states: Record<DependencyState, string> = {
    discovered: "已发现",
    verified: "校验通过",
    missing: "未准备",
    stale: "版本不一致",
    unsupported: "此平台不支持",
    error: "需要修复",
  };
  const labels: Record<string, string> = {
    osdk: "依赖管理工具 osdk",
    "optional.workspace": "可选环境与升级",
    "documents.python": "Docling 文档解析器",
    "decisions.python": "StartLux Python 环境",
    "decisions.code": "StartLux 运行代码",
    "decisions.platform": "StartLux 平台支持",
    "decisions.selection": "StartLux 自动选模",
    "model.docling-layout": "PDF 布局模型",
    "model.docling-tables": "PDF 表格模型",
    "model.memory-zh": "BGE 中文向量模型",
    "model.decision-startlux2b": "StartLux 2B 模型",
    "model.decision-startlux4b": "StartLux 4B 模型",
    "model.decision-startlux9b": "StartLux 9B 模型",
  };
  const lines = [
    `可选能力：${report.healthy ? "未发现阻断本机安装的问题" : "有已启用或已安装能力需要修复"}`,
    `运行环境：${report.workspace}`,
    `决策模式：${report.decisionMode}${report.decisionsConfigured ? "（已配置）" : "（未配置，可选尝试）"}`,
    ...report.checks.map((check) =>
      [
        `${labels[check.id] ?? check.id.replace(/^model\./, "模型 ")}：${states[check.state]}${check.enabled ? " · 已启用" : " · 按需可选"}。${check.message}`,
        ...(check.fix &&
        (failing.has(check.state) || check.id === "optional.workspace")
          ? [`  ${failing.has(check.state) ? "修复" : "更新"}：${check.fix}`]
          : []),
      ].join("\n"),
    ),
    report.note,
  ];
  if (!report.verifyModels)
    lines.push(
      "完整检查模型文件：omem doctor --local --verify-models（仅本地读取，耗时取决于权重大小）。",
    );
  return lines.join("\n");
}
