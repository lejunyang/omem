import { assetPath, modelWorkspace } from "../paths.js";
import { prepareOptionalWorkspace } from "./optional-workspace.js";
import { requireOsdk, runSetupCommand } from "./osdk.js";

export type DecisionModelChoice = "2b" | "4b" | "9b" | "both" | "all";
export type DecisionModelSize = "2b" | "4b" | "9b";
export type SetupOptionalOptions = {
  model?: DecisionModelChoice;
  models?: readonly DecisionModelSize[];
  /** Interactive setup saves its own plan and supplies the next step. */
  manualGuidance?: boolean;
};
export function decisionModelAliases(
  choice: DecisionModelChoice | readonly DecisionModelSize[] = "2b",
) {
  if (typeof choice !== "string") {
    if (
      !choice.length ||
      choice.some((size) => !["2b", "4b", "9b"].includes(size))
    )
      throw Error("请至少选择一个有效决策模型：2b、4b、9b。");
    return [...new Set(choice)].map((size) => `decision-startlux${size}`);
  }
  if (!["2b", "4b", "9b", "both", "all"].includes(choice))
    throw Error(
      "决策模型可选：2b、4b、9b、both（2b 和 4b）、all（三个模型）。",
    );
  return (
    choice === "all"
      ? ["2b", "4b", "9b"]
      : choice === "both"
        ? ["2b", "4b"]
        : [choice]
  ).map((size) => `decision-startlux${size}`);
}

export async function setupOptional(
  component: string,
  options: SetupOptionalOptions = {},
) {
  if (
    !["documents", "document-models", "decisions", "embedding"].includes(
      component,
    )
  )
    throw Error("可选能力：documents、document-models、decisions、embedding");
  if (
    (options.model !== undefined || options.models !== undefined) &&
    component !== "decisions"
  )
    throw Error("--model 仅用于 omem setup decisions。");
  if (options.model !== undefined && options.models !== undefined)
    throw Error("决策模型不能同时使用单项与多项选择。");
  const aliases =
    component === "decisions"
      ? decisionModelAliases(options.models ?? options.model)
      : [];
  if (component === "decisions") {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw Error(
        "当前 StartLux 运行层使用 MLX，需要 Apple Silicon Mac；其他平台可直接使用 ACP Agent。",
      );
  }
  console.error("正在检查 osdk…");
  const version = await requireOsdk();
  console.error(`${version}；准备位置：${modelWorkspace()}`);
  try {
    console.error("正在检查随包声明与解析脚本…");
    const prepared = await prepareOptionalWorkspace();
    if (prepared.preserved.length > 0)
      console.error(
        `已保留用户定制：${prepared.preserved.join("、")}。新包候选在 ${prepared.updateDirectory}；请按需合并，再重跑 setup。`,
      );
    const run = (command: string, args: string[]) =>
      runSetupCommand(command, args, prepared.cwd);
    if (component === "documents") {
      console.error("正在准备 Python、uv 和 Docling；此步骤不会下载 PDF 模型…");
      await run(process.execPath, [
        assetPath("dist/scripts/document-prepare.js"),
      ]);
      if (options.manualGuidance !== false)
        console.error(
          "Docling 已准备；PDF 布局与表格模型可用 omem setup document-models 单独准备。",
        );
    } else if (component === "document-models") {
      console.error("正在下载并校验 PDF 布局与表格模型；已经验证的缓存会复用…");
      await run(process.execPath, [
        assetPath("dist/scripts/document-models.js"),
      ]);
    } else if (component === "decisions") {
      console.error("正在准备 Python、uv 和 StartLux 的 MLX 运行环境…");
      await run(process.execPath, [
        assetPath("dist/scripts/startlux-prepare.js"),
      ]);
      for (const alias of aliases) {
        console.error(`正在下载并校验 ${alias}；已经验证的缓存会复用…`);
        await run("osdk", ["model", "sync", alias]);
        await run("osdk", ["model", "verify", alias]);
      }
      const mode =
        aliases.length === 1
          ? aliases[0]!.replace("decision-startlux", "")
          : "auto";
      if (options.manualGuidance !== false)
        console.error(
          `已准备所选 StartLux；配置 decisions.mode 为 "${mode}" 后重启服务。未选择的权重不会下载。`,
        );
    } else {
      console.error("正在下载并校验中文向量模型 memory-zh…");
      await run("osdk", ["model", "sync", "memory-zh"]);
      await run("osdk", ["model", "verify", "memory-zh"]);
      if (options.manualGuidance !== false)
        console.error(
          "已准备中文向量模型；配置 retrieval.enabled 为 true 后重启服务。",
        );
    }
    if (options.manualGuidance !== false)
      console.error(
        "准备完成。可运行 omem doctor --local 检查依赖；能力开关不会自动修改。",
      );
    return {
      status: "prepared",
      component,
      workspace: prepared.cwd,
      models: aliases,
      preserved: prepared.preserved,
      configurationChanged: false,
    };
  } catch (error) {
    throw Error(
      `准备 ${component} 未完成：${(error as Error).message}\n已完成的运行环境和下载缓存保留，可修复网络或权限后重跑相同命令。可用 omem doctor 查看缺少的部分。`,
      { cause: error },
    );
  }
}
