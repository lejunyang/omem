import { expect, it } from "vitest";
import { estimateTokens, generationBudget } from "../src/code/budget.js";
import { assertContextBudget } from "../src/agents.js";

it("counts UTF-8 bytes and charges headroom, with validated host overrides", () => {
  expect(estimateTokens("中文abc")).toMatchObject({ chars: 5, utf8Bytes: 9, estimatedTokens: 3, budgetedTokens: 4 });
  expect(generationBudget({ maxInputTokens: 96000 }, { max_context_tokens: 12000, max_output_tokens: 3000 }).maxInputTokens).toBe(96000);
  expect(() => generationBudget({ maxInputTokens: -1 }, { max_context_tokens: 12000, max_output_tokens: 3000 })).toThrow("Invalid");
});

it("checks the selected model's discovered window including output and reserve", () => {
  const options = [{ id: "model", name: "Model", category: "model", type: "select" as const, currentValue: "small", options: [
    { value: "small", name: "Small", _meta: { trae: { contextWindow: 32000 } } },
    { value: "large", name: "Large", _meta: { trae: { contextWindow: 272000 } } },
  ] }];
  const budget = { estimatedInputTokens: 40000, maxOutputTokens: 8000, contextReserveTokens: 16000 };
  expect(() => assertContextBudget(options, budget)).toThrow("64000 > discovered context window 32000");
  options[0]!.currentValue = "large";
  expect(assertContextBudget(options, budget)).toBe(272000);
  expect(assertContextBudget([], budget)).toBeNull();
});
