/** An explicit estimate, not a model-specific tokenizer. UTF-8 bytes / 3 is a
 * practical code/mixed-CJK estimate; 25% headroom is charged to the budget. */
export function estimateTokens(text: string) {
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  const estimatedTokens = Math.ceil(utf8Bytes / 3);
  return { chars: text.length, utf8Bytes, estimatedTokens, budgetedTokens: Math.ceil(estimatedTokens * 1.25), estimator: "utf8-bytes/3 + 25% headroom" };
}

export type GenerationBudget = {
  maxInputTokens: number;
  maxOutputTokens: number;
  contextReserveTokens: number;
};

export function generationBudget(overrides: Partial<GenerationBudget>, defaults: { max_context_tokens: number; max_output_tokens: number }): GenerationBudget {
  const result = {
    maxInputTokens: overrides.maxInputTokens ?? defaults.max_context_tokens,
    maxOutputTokens: overrides.maxOutputTokens ?? defaults.max_output_tokens,
    contextReserveTokens: overrides.contextReserveTokens ?? 16000,
  };
  for (const [name, value] of Object.entries(result))
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new Error(`Invalid ${name}: expected an integer between 1 and 1000000`);
  return result;
}
