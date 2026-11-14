import { expect, it } from "vitest";
import { independence, modelFamily, reviewerFor } from "../src/agents/families.ts";

it("reads the maker from the model's name, else from the backend's id", () => {
  expect(modelFamily({ profile: "codex", model: "gpt-6.1-sol" })).toBe("openai");
  expect(modelFamily({ profile: "traex", model: "GPT-6.1 Sol" })).toBe("openai");
  expect(modelFamily({ profile: "claude", model: "claude-opus-5-5" })).toBe("anthropic");
  expect(modelFamily({ profile: "traex", model: "Doubao-Seed-Evolving" })).toBe("doubao");
  expect(modelFamily({ profile: "traex", model: "deepseek-v4.1-flash" })).toBe("deepseek");
  expect(modelFamily({ profile: "gemini" })).toBe("google");
  // No model named: the backend's own default.
  expect(modelFamily({ profile: "codex" })).toBe("openai");
  expect(modelFamily({ profile: "claude" })).toBe("anthropic");
  // A model nobody recognises is not guessed from the backend it happens to run on.
  expect(modelFamily({ profile: "codex", model: "in-house-7" })).toBeNull();
  expect(modelFamily({ profile: "traex" })).toBeNull();
  expect(modelFamily(null)).toBeNull();
  // "o3" is a model name; "foo3" and "video" are not.
  expect(modelFamily({ model: "o3-mini" })).toBe("openai");
  expect(modelFamily({ model: "foo3" })).toBeNull();
  expect(modelFamily({ model: "video-gen" })).toBeNull();
});

it("calls a review independent only when both makers are known and differ", () => {
  const coder = { profile: "codex", model: "gpt-6-astra" };
  expect(independence(coder, { profile: "codex", model: "gpt-6.1-sol" })).toBe("same");
  expect(independence(coder, { profile: "claude", model: "claude-opus-5-5" })).toBe("other");
  expect(independence(coder, { profile: "traex", model: "in-house-7" })).toBe("unknown");
  expect(independence(null, coder)).toBe("unknown");
});

it("moves a reviewer of the coder's maker to the first other maker on the owner's list", () => {
  const coder = { profile: "codex", model: "gpt-6-astra" };
  const list = [
    { profile: "codex", model: "gpt-6.1-sol" },
    { profile: "traex", model: "in-house-7" },
    { profile: "traex", model: "Doubao-Seed-Evolving", effort: "high" },
    { profile: "claude", model: "claude-opus-5-5" },
  ];
  // Same maker: the first one known to differ (an unrecognised one is not counted as different).
  expect(reviewerFor(coder, { profile: "codex", model: "gpt-6.1-sol" }, list)).toEqual({ pick: list[2], relation: "other" });
  // Already another maker, or not recognisable: its own stays.
  expect(reviewerFor(coder, { profile: "claude", model: "claude-opus-5-5" }, list)).toEqual({ relation: "other" });
  expect(reviewerFor(coder, { profile: "traex", model: "in-house-7" }, list)).toEqual({ relation: "unknown" });
  // Nothing else on offer: its own stays and the review is known not to be independent.
  expect(reviewerFor(coder, { profile: "codex", model: "gpt-6.1-sol" }, list.slice(0, 2))).toEqual({ relation: "same" });
});
