export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonTreeNodeType = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonTreeNode {
  key: string;
  path: string;
  type: JsonTreeNodeType;
  value: JsonValue;
  children: JsonTreeNode[];
  size: number;
}

export interface JsonParseResult {
  ok: boolean;
  node: JsonTreeNode | null;
  error: string;
}

// 详情面板只接收字符串内容，这里集中处理 JSON.parse，避免 Vue 组件在每次渲染时重复解析和吞异常。
export function parseJsonView(text: string): JsonParseResult {
  const source = normalizeJsonSource(text);
  if (!source) {
    return { ok: false, node: null, error: "内容为空。" };
  }

  try {
    return { ok: true, node: createJsonTreeNode(JSON.parse(source) as JsonValue, "root", "$"), error: "" };
  } catch (error) {
    return {
      ok: false,
      node: null,
      error: error instanceof Error ? error.message : "JSON 解析失败。"
    };
  }
}

// Payload 详情会带上 “Request Payload” 标题；解析时剥离这层展示文案，避免真实 JSON 请求体无法进入树视图。
function normalizeJsonSource(text: string): string {
  const source = text.trim();
  const marker = "Request Payload\n";
  const markerIndex = source.lastIndexOf(marker);
  return markerIndex >= 0 ? source.slice(markerIndex + marker.length).trim() : source;
}

// 将 JSON 值转成递归树节点；path 使用 JSONPath 风格，便于测试和未来定位字段。
export function createJsonTreeNode(value: JsonValue, key: string, path: string): JsonTreeNode {
  if (Array.isArray(value)) {
    return {
      key,
      path,
      type: "array",
      value,
      children: value.map((item, index) => createJsonTreeNode(item, String(index), `${path}[${index}]`)),
      size: value.length
    };
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return {
      key,
      path,
      type: "object",
      value,
      children: entries.map(([childKey, childValue]) =>
        createJsonTreeNode(childValue, childKey, `${path}.${escapePathKey(childKey)}`)
      ),
      size: entries.length
    };
  }

  return {
    key,
    path,
    type: primitiveNodeType(value),
    value,
    children: [],
    size: 0
  };
}

// 基础类型展示使用 JSON.stringify，确保字符串转义、null 和布尔值与 JSON 原文语义一致。
export function formatJsonPrimitive(value: JsonValue): string {
  if (Array.isArray(value) || (value && typeof value === "object")) {
    return "";
  }
  return JSON.stringify(value);
}

function escapePathKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function primitiveNodeType(value: JsonPrimitive): Exclude<JsonTreeNodeType, "object" | "array"> {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  return "string";
}
