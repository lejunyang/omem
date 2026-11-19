import { expect, it } from "vitest";
import { httpsOf } from "../scripts/git-url.ts";

it("turns an SSH origin into its https address for the upgrade's fallback", () => {
  expect(httpsOf("git@github.com:example/app.git")).toBe("https://github.com/example/app.git");
  expect(httpsOf("ssh://git@example.com:2222/team/app.git")).toBe("https://example.com/team/app.git");
  expect(httpsOf("https://github.com/example/app.git")).toBeNull();
  expect(httpsOf("/srv/repos/app")).toBeNull();
});
