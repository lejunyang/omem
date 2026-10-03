import { expect, it } from "vitest";
import { profileSchema } from "../../../packages/contracts/src/index.js";
import { assistantProfile } from "../src/config.js";

it("selects the answer profile without changing the writing profile and rejects invalid choices", () => {
  const profiles = ["writer", "fast"].map((id) =>
    profileSchema.parse({
      id,
      name: id,
      command: "traex",
      transport: "acp",
      model: id === "fast" ? "gpt-5.6-luna" : "gpt-5.6-sol",
    }),
  );
  expect(assistantProfile({ profiles, assistant: { profileId: "fast" } })).toBe(
    profiles[1],
  );
  expect(profiles[0]!.model).toBe("gpt-5.6-sol");
  expect(assistantProfile({ profiles })).toBe(profiles[0]);
  expect(() =>
    assistantProfile({ profiles, assistant: { profileId: "missing" } }),
  ).toThrow("not found");
  expect(() =>
    assistantProfile({
      profiles: [
        profileSchema.parse({
          id: "cli",
          name: "CLI",
          command: "codex",
          transport: "codex-cli",
        }),
      ],
      assistant: { profileId: "cli" },
    }),
  ).toThrow("requires ACP");
});
