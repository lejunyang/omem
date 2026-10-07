import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { select } from "@inquirer/prompts";
import { modelWorkspace, optionalRuntime, pythonInVenv } from "../paths.js";
import {
  readSetupConfigurationSnapshot,
  applySetupConfiguration,
} from "./setup-config.js";
import { setupOptional } from "./setup.js";
import { createSetupPlan, type SetupWizardState } from "./setup-wizard.js";

const exec = promisify(execFile);

/** Discovery is offline and light: it does not import Python or inspect weight bytes. */
export async function discoverSetupResources(): Promise<
  SetupWizardState["installed"]
> {
  const installed: NonNullable<SetupWizardState["installed"]> = {
    documents: existsSync(pythonInVenv(optionalRuntime("docling"))),
    decisions: existsSync(pythonInVenv(optionalRuntime("decision"))),
  };
  const cwd = modelWorkspace();
  if (!existsSync(cwd)) return installed;
  const aliases = [
    "memory-zh",
    "docling-layout",
    "docling-tables",
    "decision-startlux2b",
    "decision-startlux4b",
    "decision-startlux9b",
  ] as const;
  const found = await Promise.all(
    aliases.map(async (alias) => {
      try {
        const { stdout } = await exec(
          "osdk",
          ["model", "show", alias, "--json", "--offline"],
          {
            cwd,
            timeout: 5000,
            windowsHide: true,
            maxBuffer: 1_000_000,
          },
        );
        const { model } = JSON.parse(stdout);
        return [
          alias,
          !!model?.snapshot_path && existsSync(model.snapshot_path),
        ] as const;
      } catch {
        return [alias, false] as const;
      }
    }),
  );
  const resources = new Map(found);
  installed.embedding = resources.get("memory-zh");
  installed["document-models"] =
    !!resources.get("docling-layout") && !!resources.get("docling-tables");
  for (const alias of [
    "decision-startlux2b",
    "decision-startlux4b",
    "decision-startlux9b",
  ] as const)
    installed[alias] = resources.get(alias);
  return installed;
}

export async function setupInteractive() {
  const snapshot = await readSetupConfigurationSnapshot();
  console.error(
    `个人库：${snapshot.config.dataDir}\n配置：${snapshot.path}\n正在读取本机已有资源…`,
  );
  const plan = await createSetupPlan({
    installed: await discoverSetupResources(),
    embeddingEnabled: snapshot.config.retrieval?.enabled ?? false,
    embeddingModel: snapshot.config.retrieval?.osdkModel,
    decisionMode: snapshot.config.decisions?.mode ?? "auto",
  });
  if (!plan) {
    console.error("已退出，未安装或修改配置。");
    return { status: "cancelled", configurationChanged: false };
  }
  const prepared: Awaited<ReturnType<typeof setupOptional>>[] = [];
  for (const [index, component] of plan.components.entries()) {
    console.error(
      `\n[${index + 1}/${plan.components.length}] 准备 ${component}`,
    );
    try {
      prepared.push(
        await setupOptional(component, {
          manualGuidance: false,
          ...(component === "decisions" ? { models: plan.decisionModels } : {}),
        }),
      );
    } catch (error) {
      throw Error(
        `设置在 ${component} 阶段停止；${prepared.length ? `此前已准备 ${prepared.map((item) => item.component).join("、")}。` : ""}本次尚未保存功能配置。已完成的资源保留，重新运行 omem setup 可复用缓存。\n${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  const configuration = await applySetupConfiguration(
    snapshot,
    {
      embedding: plan.enableEmbedding,
      embeddingModel: plan.enableEmbedding ? "memory-zh" : undefined,
      decisions: plan.decisionMode,
    },
    { createIfMissing: true },
  );
  console.error(
    `\n资源准备完成。${configuration.changed ? "已保存所选设置" : "已保留现有设置"}：${configuration.path}`,
  );
  const action = await select<"restart" | "later">(
    {
      message: "现在让本机服务读取设置？",
      default: "later",
      choices: [
        {
          value: "restart",
          name: "启动或重启服务 · 使用本次配置和个人库",
          description:
            "使用包内 PM2；不会安装开机启动项。已有其他管理器的服务请按原方式重启。",
        },
        {
          value: "later",
          name: "稍后启动 · 设置已经保存",
          description: "现有服务需重启才能读取新开关。",
        },
      ],
    },
    { output: process.stderr },
  );
  let service;
  if (action === "restart") {
    const { manageService, formatServiceStatus } = await import(
      "../service-manager.js"
    );
    service = await manageService("restart");
    console.error(formatServiceStatus(service));
    if (service.state !== "online" || !service.health.healthy)
      process.exitCode = 1;
  }
  console.error(
    "设置完成。可在网页「能力与连接」选择 Agent；飞书登录、机器人绑定和消息采集需另行设置。",
  );
  return {
    status: "prepared",
    plan,
    prepared,
    config: configuration.path,
    configurationChanged: configuration.changed,
    ...(service ? { service } : {}),
  };
}
