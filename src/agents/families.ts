/**
 * Which maker a model comes from, and whether a review was done by a different one than the code.
 *
 * A model reviewing its own maker's code shares its habits: what it wrote without noticing, it reads
 * without noticing. So a review counts as independent only when coder and reviewer are known to come
 * from different makers (docs/v2/review.md). The maker is read from the model's name; a backend
 * whose model is not named (its default) goes by the backend's id. Names nobody recognises are
 * `null`: such a review is neither called independent nor the same.
 */
const MAKERS: [string, RegExp][] = [
  ["anthropic", /claude|opus|sonnet|haiku|fable|mythos/i],
  ["openai", /(^|[^a-z])(gpt|chatgpt|codex|o[1-9])([^a-z]|$)/i],
  ["google", /gemini|gemma/i],
  ["deepseek", /deepseek/i],
  ["doubao", /doubao|skylark/i],
  ["qwen", /qwen|tongyi|qwq/i],
  ["zhipu", /(^|[^a-z])glm|zhipu/i],
  ["moonshot", /kimi|moonshot/i],
  ["xai", /grok/i],
  ["meta", /llama/i],
  ["mistral", /mistral|mixtral|codestral/i],
  ["minimax", /minimax|abab/i],
];

export type AI = { profile?: string | null; model?: string | null; effort?: string | null };

export function modelFamily(ai: AI | null | undefined): string | null {
  for (const name of [ai?.model, ai?.profile]) {
    if (!name) continue;
    const hit = MAKERS.find(([, re]) => re.test(name));
    if (hit) return hit[0];
    // A named model nobody recognises says nothing about the backend's default either.
    if (name === ai?.model) return null;
  }
  return null;
}

/** `other`: known to be different makers; `same`: known to be the same; `unknown`: one of them is not recognised. */
export type Independence = "other" | "same" | "unknown";

export function independence(coder: AI | null | undefined, reviewer: AI | null | undefined): Independence {
  const a = modelFamily(coder);
  const b = modelFamily(reviewer);
  return !a || !b ? "unknown" : a === b ? "same" : "other";
}

/**
 * The AI a review check should run on so that it is not the coder's maker: its own when that already
 * differs (or cannot be told), else the first of `others` (the owner's list, in the owner's order)
 * that is known to differ. `pick` is absent when its own stays — because it is fine, or because
 * nothing else is on offer (`relation` then says `same`).
 */
export function reviewerFor<T extends AI>(coder: AI | null | undefined, own: AI | null | undefined, others: T[]): { pick?: T; relation: Independence } {
  const relation = independence(coder, own);
  if (relation !== "same") return { relation };
  const pick = others.find((o) => independence(coder, o) === "other");
  return pick ? { pick, relation: "other" } : { relation: "same" };
}
