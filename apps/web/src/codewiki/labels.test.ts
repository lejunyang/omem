import { describe, it, expect } from "vitest";
import {
  fileLabel,
  filePathLabel,
  symbolLabel,
  edgeReason,
  edgeDisabled,
} from "./modules";

describe("human label resolution (DTO-first, never leaks id)", () => {
  it("fileLabel prefers DTO displayTitle, then basename, never fileId", () => {
    expect(fileLabel({ displayTitle: "runtime.ts", path: "apps/server/src/assistant/runtime.ts" })).toBe("runtime.ts");
    expect(fileLabel({ path: "apps/server/src/assistant/runtime.ts" })).toBe("runtime.ts");
    expect(fileLabel({ path: "" })).toBe("未命名文件");
  });

  it("filePathLabel prefers displayPath", () => {
    expect(filePathLabel({ displayPath: "assistant/runtime.ts", path: "apps/server/src/assistant/runtime.ts" })).toBe("assistant/runtime.ts");
    expect(filePathLabel({ path: "apps/server/src/assistant/runtime.ts" })).toBe("apps/server/src/assistant/runtime.ts");
  });

  it("symbolLabel prefers DTO displayTitle, then name, never symbolId", () => {
    expect(symbolLabel({ displayTitle: "AssistantRuntime.governCreateTask", name: "governCreateTask" })).toBe("AssistantRuntime.governCreateTask");
    expect(symbolLabel({ name: "governCreateTask" })).toBe("governCreateTask");
    expect(symbolLabel({})).toBe("未命名符号");
  });

  it("edgeReason uses DTO reason, maps missing/stale, null when actionable", () => {
    expect(edgeReason({ actionable: false, reason: "unresolved target" })).toBe("unresolved target");
    expect(edgeReason({ actionable: true, reason: null })).toBeNull();
    // legacy rows (no DTO fields) still map status
    expect(edgeReason({ actionable: undefined, status: "missing" })).toBe("仓库内未解析");
    expect(edgeReason({ actionable: undefined, status: "stale" })).toBe("已过期");
    expect(edgeReason({ actionable: undefined, status: "confirmed" })).toBeNull();
  });

  it("edgeDisabled: DTO actionable=false disables; missing legacy disables", () => {
    expect(edgeDisabled({ actionable: false, status: "confirmed" })).toBe(true);
    expect(edgeDisabled({ actionable: true, status: "missing" })).toBe(false);
    expect(edgeDisabled({ actionable: undefined, status: "missing" })).toBe(true);
    expect(edgeDisabled({ actionable: undefined, status: "confirmed" })).toBe(false);
  });
});
