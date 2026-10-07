import { expect, it } from "vitest";
import {
  createSetupPlan,
  type SetupWizardIO,
} from "../src/cli/setup-wizard.js";

type Answer = {
  kind: "checkbox" | "select" | "confirm";
  value: string[] | string | boolean;
};

function scriptedIO(answers: Answer[]) {
  const prompts: {
    kind: Answer["kind"];
    options: Record<string, unknown>;
  }[] = [];
  const output: string[] = [];
  function take(kind: Answer["kind"], options: object) {
    prompts.push({ kind, options: structuredClone(options) });
    const answer = answers.shift();
    expect(answer?.kind).toBe(kind);
    return answer!.value;
  }
  const io: SetupWizardIO = {
    checkbox: async <T extends string>(options: {
      message: string;
      choices: { value: T; name: string }[];
    }) => take("checkbox", options) as T[],
    select: async <T extends string>(options: {
      message: string;
      choices: { value: T; name: string }[];
    }) => take("select", options) as T,
    confirm: async (options) => take("confirm", options) as boolean,
    write: (message) => output.push(message),
  };
  return { io, prompts, output, remaining: answers };
}

it("returns to the selection with the draft intact, allowing preparation without changing settings", async () => {
  const script = scriptedIO([
    { kind: "checkbox", value: ["embedding"] },
    { kind: "confirm", value: true },
    { kind: "select", value: "adjust" },
    { kind: "checkbox", value: ["embedding"] },
    { kind: "confirm", value: false },
    { kind: "select", value: "execute" },
  ]);
  const plan = await createSetupPlan({}, script.io);
  expect(plan).toEqual({ components: ["embedding"] });
  const choices = script.prompts[3]!.options.choices as {
    value: string;
    checked: boolean;
  }[];
  expect(choices.find((choice) => choice.value === "embedding")?.checked).toBe(
    true,
  );
  expect(script.prompts[4]!.options.default).toBe(true);
  expect(script.remaining).toEqual([]);
});

it("adds the parser when the full PDF model bundle is selected", async () => {
  const script = scriptedIO([
    { kind: "checkbox", value: ["document-models"] },
    { kind: "select", value: "execute" },
  ]);
  expect(await createSetupPlan({}, script.io)).toEqual({
    components: ["documents", "document-models"],
  });
  expect(script.output.join("\n")).toContain("已自动加入 Docling");
  expect(script.remaining).toEqual([]);
});

it("lets the documents submenu include PDF resources in the same plan", async () => {
  const script = scriptedIO([
    { kind: "checkbox", value: ["documents"] },
    { kind: "select", value: "pdf" },
    { kind: "select", value: "execute" },
  ]);
  expect(await createSetupPlan({}, script.io)).toEqual({
    components: ["documents", "document-models"],
  });
});

it("makes 9B an explicit model choice with its cost visible in the final plan", async () => {
  const script = scriptedIO([
    { kind: "checkbox", value: ["decisions"] },
    { kind: "checkbox", value: ["9b"] },
    { kind: "select", value: "9b" },
    { kind: "select", value: "execute" },
  ]);
  expect(
    await createSetupPlan({ decisionsSupported: true }, script.io),
  ).toEqual({
    components: ["decisions"],
    decisionModels: ["9b"],
    decisionMode: "9b",
  });
  const modelPrompt = script.prompts[1]!.options;
  const choices = modelPrompt.choices as {
    value: string;
    checked: boolean;
  }[];
  expect(choices.find((choice) => choice.value === "9b")?.checked).toBe(false);
  expect(modelPrompt.shortcuts).toEqual({ all: null, invert: null });
  const modes = script.prompts[2]!.options.choices as { value: string }[];
  expect(modes.map((choice) => choice.value)).toEqual(["9b", "prepare"]);
  expect(script.output.join("\n")).toContain("约 18 GiB");
  expect(script.output.join("\n")).toContain("28 GiB");
});

it("keeps a 2B and 9B combination without silently adding 4B", async () => {
  const script = scriptedIO([
    { kind: "checkbox", value: ["decisions"] },
    { kind: "checkbox", value: ["2b", "9b"] },
    { kind: "select", value: "auto" },
    { kind: "select", value: "execute" },
  ]);
  const plan = await createSetupPlan({ decisionsSupported: true }, script.io);
  expect(plan?.decisionModels).toEqual(["2b", "9b"]);
  expect(plan?.decisionMode).toBe("auto");
  expect(script.output.join("\n")).not.toContain("StartLux 4B");
});

it("only prepares resources when requested, preserving existing enabled choices", async () => {
  const script = scriptedIO([
    { kind: "checkbox", value: ["embedding", "decisions"] },
    { kind: "confirm", value: false },
    { kind: "checkbox", value: ["2b"] },
    { kind: "select", value: "prepare" },
    { kind: "select", value: "execute" },
  ]);
  const plan = await createSetupPlan(
    {
      decisionsSupported: true,
      embeddingEnabled: true,
      decisionMode: "4b",
      installed: { "decision-startlux4b": true },
    },
    script.io,
  );
  expect(plan?.enableEmbedding).toBeUndefined();
  expect(plan?.decisionMode).toBeUndefined();
  expect(script.output.join("\n")).toContain("保留当前已启用");
  expect(script.output.join("\n")).toContain("保留当前 4b");
});

it("shows the model switch before explicitly enabling BGE over an existing model", async () => {
  const script = scriptedIO([
    { kind: "checkbox", value: ["embedding"] },
    { kind: "confirm", value: true },
    { kind: "select", value: "execute" },
  ]);
  const plan = await createSetupPlan(
    { embeddingEnabled: true, embeddingModel: "custom-model" },
    script.io,
  );
  expect(plan?.enableEmbedding).toBe(true);
  expect(script.prompts[1]!.options.message).toContain(
    "当前使用 custom-model，本次启用将切换为 memory-zh",
  );
  expect(script.output.join("\n")).toContain(
    "从 custom-model 切换为 memory-zh",
  );
});

it("keeps unsupported local decisions visible but disabled", async () => {
  const script = scriptedIO([
    { kind: "checkbox", value: [] },
    { kind: "select", value: "cancel" },
  ]);
  expect(
    await createSetupPlan({ decisionsSupported: false }, script.io),
  ).toBeNull();
  const choices = script.prompts[0]!.options.choices as {
    value: string;
    checked: boolean;
    disabled?: string;
  }[];
  const decisions = choices.find((choice) => choice.value === "decisions")!;
  expect(decisions.disabled).toContain("Apple Silicon");
  expect(choices.every((choice) => !choice.checked)).toBe(true);
});

it("returns no executable plan on cancellation after making selections", async () => {
  const script = scriptedIO([
    { kind: "checkbox", value: ["documents", "embedding"] },
    { kind: "select", value: "runtime" },
    { kind: "confirm", value: true },
    { kind: "select", value: "cancel" },
  ]);
  expect(await createSetupPlan({}, script.io)).toBeNull();
  expect(script.remaining).toEqual([]);
});

it("allows basic setup without selecting or installing optional capabilities", async () => {
  const script = scriptedIO([
    { kind: "checkbox", value: [] },
    { kind: "select", value: "execute" },
  ]);
  expect(await createSetupPlan({}, script.io)).toEqual({ components: [] });
  const choices = script.prompts[1]!.options.choices as {
    value: string;
    name: string;
    disabled?: boolean;
  }[];
  const execute = choices.find((choice) => choice.value === "execute")!;
  expect(execute.disabled).not.toBe(true);
  expect(execute.name).toContain("只用基础功能");
  expect(script.output.join("\n")).toContain("仅初始化配置；已有配置保留");
  expect(script.remaining).toEqual([]);
});
