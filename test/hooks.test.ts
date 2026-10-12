import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSpace } from "../src/core/spaces.ts";
import { captureClaudeHook, captureCodexNotify } from "../src/hooks.ts";
import { readSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

it("captures Claude Code transcripts and Codex turns into the matching space", () => {
  const app = testApp();
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  createSpace(app, { id: "app", name: "app", rootPath: repo });
  const transcript = join(repo, "t.jsonl");
  writeFileSync(
    transcript,
    [
      { type: "user", message: { role: "user", content: "把登录改成短信验证码" }, timestamp: "2026-10-12T01:00:00Z" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "已修改 auth.ts" }, { type: "tool_use", name: "Edit" }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  );
  const r = captureClaudeHook(app, { session_id: "abc", transcript_path: transcript, cwd: join(repo, "src") })!;
  const s = readSource(app, r.id);
  expect(s.source.spaceId).toBe("app");
  expect(s.text).toContain("把登录改成短信验证码");
  expect(s.text).toContain("已修改 auth.ts");
  expect(s.text).not.toContain("tool_result");
  const c1 = captureCodexNotify(app, { type: "agent-turn-complete", cwd: "/elsewhere", "thread-id": "t1", "input-messages": ["修复 bug"], "last-assistant-message": "完成" })!;
  captureCodexNotify(app, { type: "agent-turn-complete", cwd: "/elsewhere", "thread-id": "t1", "input-messages": ["再加测试"], "last-assistant-message": "已加" });
  const c = readSource(app, c1.id);
  expect(c.source.spaceId).toBe("personal");
  expect(c.text).toMatch(/修复 bug[\s\S]*再加测试/);
});
