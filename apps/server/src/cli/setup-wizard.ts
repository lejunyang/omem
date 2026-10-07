import { checkbox, confirm, select } from "@inquirer/prompts";

export type SetupComponent =
  | "documents"
  | "document-models"
  | "embedding"
  | "decisions";
export type DecisionMode = "off" | "auto" | "2b" | "4b" | "9b";
export type ModelSize = "2b" | "4b" | "9b";
type InstallationKey = SetupComponent | `decision-startlux${ModelSize}`;

export type SetupPlan = {
  components: SetupComponent[];
  decisionModels?: ModelSize[];
  enableEmbedding?: true;
  decisionMode?: Exclude<DecisionMode, "off">;
};

export type SetupWizardState = {
  decisionsSupported?: boolean;
  installed?: Partial<Record<InstallationKey, boolean>>;
  embeddingEnabled?: boolean;
  embeddingModel?: string;
  decisionMode?: DecisionMode;
};

type Choice<T extends string> = {
  name: string;
  value: T;
  description?: string;
  checked?: boolean;
  disabled?: string | boolean;
};
type CheckboxOptions<T extends string> = {
  message: string;
  choices: Choice<T>[];
  required?: boolean;
  shortcuts?: { all?: string | null; invert?: string | null };
};
type SelectOptions<T extends string> = {
  message: string;
  choices: Choice<T>[];
  default?: T;
};

export type SetupWizardIO = {
  checkbox<T extends string>(options: CheckboxOptions<T>): Promise<T[]>;
  select<T extends string>(options: SelectOptions<T>): Promise<T>;
  confirm(options: { message: string; default?: boolean }): Promise<boolean>;
  write(message: string): void;
};

const nativeIO: SetupWizardIO = {
  checkbox: (options) => checkbox(options, { output: process.stderr }),
  select: (options) => select(options, { output: process.stderr }),
  confirm: (options) => confirm(options, { output: process.stderr }),
  write: (message) => console.error(message),
};

const componentOrder: SetupComponent[] = [
  "documents",
  "document-models",
  "embedding",
  "decisions",
];
const modelSizes: ModelSize[] = ["2b", "4b", "9b"];
const modelLabels: Record<ModelSize, string> = {
  "2b": "StartLux 2B · 约 4.26 GiB",
  "4b": "StartLux 4B · 约 8.70 GiB",
  "9b": "StartLux 9B · 约 18 GiB；暂定需 28 GiB 可用内存",
};

function installedLabel(state: SetupWizardState, key: InstallationKey) {
  return state.installed?.[key] ? " · 已发现本机资源" : "";
}

/** Collect a reviewable plan. Installation and configuration are the caller's job. */
export async function createSetupPlan(
  state: SetupWizardState = {},
  io: SetupWizardIO = nativeIO,
): Promise<SetupPlan | null> {
  const decisionsSupported =
    state.decisionsSupported ??
    (process.platform === "darwin" && process.arch === "arm64");
  let selected: SetupComponent[] = [];
  let documentMode: "runtime" | "pdf" = "runtime";
  let selectedModels: ModelSize[] = ["2b"];
  let enableEmbedding = true;
  let selectedDecisionMode:
    | Exclude<DecisionMode, "off">
    | "prepare"
    | undefined;

  io.write(
    "选择需要的能力。空格勾选，方向键移动，回车继续；Ctrl+C 退出。确认计划前不会安装或修改配置。",
  );
  while (true) {
    selected = await io.checkbox<SetupComponent>({
      message: "准备哪些能力？可以一次选择多项",
      choices: [
        {
          value: "documents",
          name: `documents · DOCX / PDF 解析环境${installedLabel(state, "documents")}`,
          description: "使用 Docling；下一步可选择是否一起准备 PDF 模型。",
          checked: selected.includes("documents"),
        },
        {
          value: "document-models",
          name: `document-models · PDF 布局与表格模型${installedLabel(state, "document-models")}`,
          description:
            "完整模型包约 367 MiB；会一起准备 Docling 解析环境。OCR 尚未启用。",
          checked: selected.includes("document-models"),
        },
        {
          value: "embedding",
          name: `embedding · 中文向量检索${installedLabel(state, "embedding")}${state.embeddingEnabled ? " · 当前已启用" : ""}`,
          description:
            "BGE-small-zh-v1.5 约 23 MiB；可准备后启用，也可仅准备资源。",
          checked: selected.includes("embedding"),
        },
        {
          value: "decisions",
          name: `decisions · 本地快速决策${installedLabel(state, "decisions")}${state.decisionMode ? ` · 当前 ${state.decisionMode}` : ""}`,
          description:
            "选择 StartLux 2B / 4B / 9B 与运行方式；不会自动选择 9B。",
          checked: decisionsSupported && selected.includes("decisions"),
          disabled: decisionsSupported
            ? false
            : "MLX 需要 Apple Silicon Mac；当前平台可使用 ACP Agent",
        },
      ],
    });
    if (!decisionsSupported)
      selected = selected.filter((item) => item !== "decisions");

    const components = new Set(selected);
    if (components.has("document-models")) {
      components.add("documents");
      documentMode = "pdf";
      io.write(
        "PDF 模型是完整布局与表格包（约 367 MiB），已自动加入 Docling 解析环境。",
      );
    } else if (components.has("documents")) {
      documentMode = await io.select({
        message: "文档解析要准备到哪一步？",
        default: documentMode,
        choices: [
          {
            value: "runtime",
            name: "Docling 解析环境 · 用于 DOCX，不下载 PDF 模型",
          },
          {
            value: "pdf",
            name: "Docling + PDF 布局与表格模型 · 模型约 367 MiB",
            description: "保留 PDF 页码、布局与表格；当前 OCR 未启用。",
          },
        ],
      });
      if (documentMode === "pdf") components.add("document-models");
    }

    const plan: SetupPlan = {
      components: componentOrder.filter((item) => components.has(item)),
    };
    if (components.has("embedding")) {
      const switchModel =
        state.embeddingEnabled &&
        state.embeddingModel &&
        state.embeddingModel !== "memory-zh"
          ? `（当前使用 ${state.embeddingModel}，本次启用将切换为 memory-zh）`
          : state.embeddingEnabled
            ? "（当前已启用）"
            : "";
      enableEmbedding = await io.confirm({
        message: `准备完成后启用 BGE 中文向量检索（memory-zh）？${switchModel} 选否则只准备资源，保留现有设置`,
        default: enableEmbedding,
      });
      if (enableEmbedding) plan.enableEmbedding = true;
    }
    if (components.has("decisions")) {
      selectedModels = await io.checkbox<ModelSize>({
        message: "准备哪些 StartLux 模型？9B 尚未推理验收，请按机器余量选择",
        required: true,
        shortcuts: { all: null, invert: null },
        choices: modelSizes.map((size) => ({
          value: size,
          name: `${modelLabels[size]}${installedLabel(state, `decision-startlux${size}`)}`,
          checked: selectedModels.includes(size),
          description:
            size === "9b"
              ? "9B 必须显式选择；28 GiB 是尚未实测校准的内存准入预算，自动模式不会使用它。"
              : size === "4b"
                ? "暂定需 14 GiB 可用内存；可配合 2B 自动按负载选择。"
                : "暂定需 8 GiB 可用内存；首次使用可先选择此模型。",
        })),
      });
      const availableModels = modelSizes.filter(
        (size) =>
          selectedModels.includes(size) ||
          state.installed?.[`decision-startlux${size}`],
      );
      const modes: Choice<Exclude<DecisionMode, "off"> | "prepare">[] = [];
      if (availableModels.includes("2b") || availableModels.includes("4b"))
        modes.push({
          value: "auto",
          name: "启用 auto · 根据机器余量在已准备的 2B / 4B 中选择",
          description: "自动模式不使用 9B；不能保证一定比 ACP Agent 更快。",
        });
      modes.push(
        ...availableModels.map((size) => ({
          value: size,
          name: `启用 ${size.toUpperCase()} · 固定使用此模型`,
          description:
            size === "9b"
              ? "启动时仍需符合内存准入预算；9B 未通过本仓库实际推理验收。"
              : undefined,
        })),
        {
          value: "prepare",
          name: "仅准备资源 · 保留当前决策设置",
        },
      );
      const preferredMode =
        selectedDecisionMode ??
        (state.decisionMode && state.decisionMode !== "off"
          ? state.decisionMode
          : selectedModels.length > 1
            ? "auto"
            : selectedModels[0]);
      selectedDecisionMode = await io.select({
        message: "准备完成后如何使用快速决策？",
        choices: modes,
        default: modes.some((choice) => choice.value === preferredMode)
          ? preferredMode
          : "prepare",
      });
      plan.decisionModels = [...selectedModels];
      if (selectedDecisionMode !== "prepare")
        plan.decisionMode = selectedDecisionMode;
    }

    io.write(formatSetupPlan(plan, state));
    const action = await io.select<"execute" | "adjust" | "cancel">({
      message: plan.components.length
        ? "按这个计划执行？"
        : "不准备可选能力，要先设置基础功能吗？",
      default: "execute",
      choices: [
        {
          value: "execute",
          name: plan.components.length
            ? "执行 · 下载、校验并保存所选设置"
            : "只用基础功能 · 初始化个人配置，不安装可选能力",
        },
        { value: "adjust", name: "返回调整 · 保留刚才的选择" },
        { value: "cancel", name: "退出 · 不安装、不修改配置" },
      ],
    });
    if (action === "cancel") return null;
    if (action === "execute") return plan;
    selected = plan.components;
  }
}

export function formatSetupPlan(plan: SetupPlan, state: SetupWizardState = {}) {
  const lines = ["\n本次设置计划："];
  if (!plan.components.length)
    lines.push("  基础功能：仅初始化配置；已有配置保留。");
  if (plan.components.includes("documents"))
    lines.push("  documents：准备 Docling 解析环境。");
  if (plan.components.includes("document-models"))
    lines.push("  document-models：准备完整 PDF 布局与表格模型，约 367 MiB。");
  if (plan.components.includes("embedding"))
    lines.push(
      `  embedding：准备中文 BGE 模型 memory-zh，约 23 MiB；${plan.enableEmbedding ? "启用 BGE 中文向量检索（memory-zh）" : `仅准备，保留当前${state.embeddingEnabled ? "已启用" : "设置"}`}。`,
    );
  if (
    plan.enableEmbedding &&
    state.embeddingEnabled &&
    state.embeddingModel &&
    state.embeddingModel !== "memory-zh"
  )
    lines.push(`  向量模型将从 ${state.embeddingModel} 切换为 memory-zh。`);
  if (plan.components.includes("decisions")) {
    const sizes = plan.decisionModels ?? [];
    lines.push(
      `  decisions：准备 ${sizes.map((size) => modelLabels[size]).join("；")}。`,
      `  决策设置：${plan.decisionMode ? `保存为 ${plan.decisionMode}` : `仅准备，保留当前 ${state.decisionMode ?? "设置"}`}。`,
    );
  }
  lines.push(
    plan.components.length
      ? "  已有缓存会复用；未选择的模型不会下载。能力设置在所选资源全部准备成功后保存。"
      : "  不下载模型、不安装可选运行环境。",
  );
  return lines.join("\n");
}
