import { afterEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  requireOsdk: vi.fn(),
  run: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("../src/cli/osdk.js", () => ({
  requireOsdk: mock.requireOsdk,
  runSetupCommand: mock.run,
}));
vi.mock("../src/cli/optional-workspace.js", () => ({
  prepareOptionalWorkspace: mock.prepare,
}));
import { setupOptional } from "../src/cli/setup.js";

afterEach(() => vi.restoreAllMocks());
function ready() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mock.requireOsdk.mockReset().mockResolvedValue("osdk 0.0.5");
  mock.run.mockReset().mockResolvedValue(undefined);
  mock.prepare.mockReset().mockResolvedValue({
    cwd: "/personal/optional",
    preserved: [],
  });
}

it("checks osdk before changing the optional workspace", async () => {
  ready();
  mock.requireOsdk.mockRejectedValue(Error("找不到 osdk 命令。请先安装 osdk"));
  await expect(setupOptional("embedding")).rejects.toThrow("请先安装 osdk");
  expect(mock.prepare).not.toHaveBeenCalled();
  expect(mock.run).not.toHaveBeenCalled();
});

it("reports a failed download and keeps the retry path rather than reporting success", async () => {
  ready();
  mock.run.mockRejectedValueOnce(Error("osdk 退出码为 1。"));
  await expect(setupOptional("embedding")).rejects.toThrow("下载缓存保留");
  expect(mock.run.mock.calls).toEqual([
    ["osdk", ["model", "sync", "memory-zh"], "/personal/optional"],
  ]);
});

it("verifies the model after synchronization and uses the prepared personal workspace", async () => {
  ready();
  await setupOptional("embedding");
  expect(mock.run.mock.calls).toEqual([
    ["osdk", ["model", "sync", "memory-zh"], "/personal/optional"],
    ["osdk", ["model", "verify", "memory-zh"], "/personal/optional"],
  ]);
});
