import { describe, expect, it } from "vitest";
import { createJsonTreeNode, formatJsonPrimitive, parseJsonView, type JsonValue } from "./json-viewer";

describe("json viewer", () => {
  it("parses object JSON into expandable tree nodes", () => {
    const result = parseJsonView('{"user":{"name":"Alice","roles":["admin","editor"]},"enabled":true}');

    expect(result.ok).toBe(true);
    expect(result.node?.type).toBe("object");
    expect(result.node?.children.map((child) => child.key)).toEqual(["user", "enabled"]);
    expect(result.node?.children[0].children[1].children[0]).toMatchObject({
      key: "0",
      path: "$.user.roles[0]",
      type: "string",
      value: "admin"
    });
  });

  it("parses top-level arrays and keeps item paths stable", () => {
    const result = parseJsonView('[{"id":1},{"id":2}]');

    expect(result.ok).toBe(true);
    expect(result.node).toMatchObject({
      type: "array",
      size: 2
    });
    expect(result.node?.children[1].children[0]).toMatchObject({
      key: "id",
      path: "$[1].id",
      value: 2
    });
  });

  it("parses JSON payload text from request detail format", () => {
    const result = parseJsonView('Request Payload\n{"traceId":"abc","nested":{"ok":true}}');

    expect(result.ok).toBe(true);
    expect(result.node?.children[1].children[0]).toMatchObject({
      key: "ok",
      path: "$.nested.ok",
      value: true
    });
  });

  it("rejects empty or invalid JSON", () => {
    expect(parseJsonView("   ")).toMatchObject({ ok: false, node: null, error: "内容为空。" });
    expect(parseJsonView("{broken").ok).toBe(false);
  });

  it("formats primitive values with JSON semantics", () => {
    expect(formatJsonPrimitive("line\nbreak")).toBe('"line\\nbreak"');
    expect(formatJsonPrimitive(42)).toBe("42");
    expect(formatJsonPrimitive(false)).toBe("false");
    expect(formatJsonPrimitive(null)).toBe("null");
  });

  it("escapes object keys that are not identifier-like", () => {
    const node = createJsonTreeNode({ "x-y": 1 } as JsonValue, "root", "$");

    expect(node.children[0]).toMatchObject({
      key: "x-y",
      path: '$."x-y"'
    });
  });
});
