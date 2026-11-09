import { recordMatches, type NetworkRecord } from "./network";

export type StatusFilter = "all" | "2xx" | "3xx" | "4xx" | "5xx" | "failed";
export type TypeFilter =
  | "all"
  | "fetch/xhr"
  | "document"
  | "stylesheet"
  | "script"
  | "image"
  | "media"
  | "font"
  | "websocket"
  | "other";

export const TYPE_FILTERS: Array<{ label: string; value: TypeFilter }> = [
  { label: "全部", value: "all" },
  { label: "Fetch/XHR", value: "fetch/xhr" },
  { label: "文档", value: "document" },
  { label: "CSS", value: "stylesheet" },
  { label: "JS", value: "script" },
  { label: "图片", value: "image" },
  { label: "媒体", value: "media" },
  { label: "字体", value: "font" },
  { label: "WS", value: "websocket" },
  { label: "其他", value: "other" }
];

export const STATUS_FILTERS: Array<{ label: string; value: StatusFilter }> = [
  { label: "全部状态", value: "all" },
  { label: "2xx", value: "2xx" },
  { label: "3xx", value: "3xx" },
  { label: "4xx", value: "4xx" },
  { label: "5xx", value: "5xx" },
  { label: "失败/未知", value: "failed" }
];

const QUERY_FIELDS = [
  "method",
  "status",
  "type",
  "resource",
  "domain",
  "host",
  "url",
  "name",
  "mime",
  "payload",
  "request",
  "response",
  "header",
  "headers",
  "has",
  "duration",
  "time",
  "size"
] as const;

const HAS_VALUES = [
  "payload",
  "request",
  "response",
  "query",
  "form",
  "headers",
  "request-headers",
  "response-headers"
] as const;

export type AdvancedFilterField = (typeof QUERY_FIELDS)[number] | "keyword";
export type AdvancedFilterOperator = "contains" | "equals" | "gt" | "gte" | "lt" | "lte" | "regex" | "not-regex";

interface QueryCondition {
  raw: string;
  negative: boolean;
  field: string;
  operator: QueryOperator;
  value: string;
}

type QueryOperator = ":" | "=" | ">" | ">=" | "<" | "<=" | "~" | "!~";

type QueryExpression =
  | {
      type: "condition";
      condition: QueryCondition;
    }
  | {
      type: "and" | "or";
      children: QueryExpression[];
    };

interface ParsedQuery {
  expression: QueryExpression | null;
  errors: string[];
}

export interface QueryValidationResult {
  valid: boolean;
  errors: string[];
}

export function matchesType(record: NetworkRecord, type: TypeFilter): boolean {
  if (type === "all") {
    return true;
  }

  if (type === "other") {
    return !TYPE_FILTERS.some((filterItem) => {
      if (filterItem.value === "all" || filterItem.value === "other") {
        return false;
      }
      return matchesType(record, filterItem.value);
    });
  }

  return record.resourceType === type || record.resourceType.includes(type);
}

export function matchesStatus(record: NetworkRecord, statusFilter: StatusFilter): boolean {
  if (statusFilter === "all") {
    return true;
  }

  if (statusFilter === "failed") {
    return record.status === null || record.status === 0;
  }

  if (record.status === null) {
    return false;
  }

  const lower = Number(statusFilter[0]) * 100;
  return record.status >= lower && record.status < lower + 100;
}

export function matchesAdvancedQuery(record: NetworkRecord, query: string): boolean {
  const parsedQuery = parseAdvancedQuery(query);
  if (parsedQuery.errors.length) {
    return false;
  }
  if (!parsedQuery.expression) {
    return true;
  }

  return matchesExpression(record, parsedQuery.expression);
}

export function validateAdvancedQuery(query: string): QueryValidationResult {
  const parsedQuery = parseAdvancedQuery(query);
  return {
    valid: parsedQuery.errors.length === 0,
    errors: parsedQuery.errors
  };
}

export function buildAdvancedFilterToken(input: {
  field: AdvancedFilterField;
  value: string;
  negative: boolean;
  operator?: AdvancedFilterOperator;
}): string {
  const value = input.value.trim();
  if (!value) {
    return "";
  }

  const operator = input.operator ?? "contains";
  const token = buildToken(input.field, operator, value);
  return input.negative ? `-${token}` : token;
}

export function getAdvancedFilterOperatorOptions(
  field: AdvancedFilterField
): Array<{ label: string; value: AdvancedFilterOperator }> {
  if (field === "keyword") {
    return [
      { label: "包含", value: "contains" },
      { label: "正则匹配", value: "regex" },
      { label: "正则不匹配", value: "not-regex" }
    ];
  }
  if (["status", "duration", "time", "size"].includes(field)) {
    return [
      { label: "包含", value: "contains" },
      { label: "等于", value: "equals" },
      { label: "大于", value: "gt" },
      { label: "大于等于", value: "gte" },
      { label: "小于", value: "lt" },
      { label: "小于等于", value: "lte" }
    ];
  }
  if (["type", "resource", "has"].includes(field)) {
    return [
      { label: "包含", value: "contains" },
      { label: "等于", value: "equals" }
    ];
  }
  return [
    { label: "包含", value: "contains" },
    { label: "等于", value: "equals" },
    { label: "正则匹配", value: "regex" },
    { label: "正则不匹配", value: "not-regex" }
  ];
}

export function appendAdvancedFilterToken(
  query: string,
  token: string,
  mode: "and" | "or"
): string {
  const currentQuery = query.trim();
  if (!token) {
    return currentQuery;
  }
  if (!currentQuery) {
    return token;
  }
  if (mode === "or") {
    return `(${currentQuery}) OR (${token})`;
  }
  return `${currentQuery} ${token}`;
}

function parseAdvancedQuery(query: string): ParsedQuery {
  const lexed = lexQuery(query);
  const errors = [...lexed.errors];
  const parser = createExpressionParser(lexed.tokens, errors);
  const expression = parser.parseExpression();
  if (parser.hasRemainingTokens()) {
    errors.push(`无法解析的筛选条件 ${parser.peek() ?? ""}。`);
  }

  return {
    expression,
    errors
  };
}

function createExpressionParser(tokens: string[], errors: string[]) {
  let index = 0;

  const peek = (): string | undefined => tokens[index];
  const consume = (): string | undefined => tokens[index++];
  const isOrToken = (token: string | undefined): boolean => token?.toUpperCase() === "OR" || token === "|";
  const isExpressionEnd = (token: string | undefined): boolean => token === undefined || token === ")";

  const parseExpression = (): QueryExpression | null => parseOr();

  const parseOr = (): QueryExpression | null => {
    const children: QueryExpression[] = [];
    if (isOrToken(peek())) {
      errors.push("OR 前需要一个条件或分组。");
      consume();
    }
    const first = parseAnd();
    if (first) {
      children.push(first);
    }

    while (isOrToken(peek())) {
      consume();
      const right = parseAnd();
      if (!right) {
        errors.push("OR 后需要一个条件或分组。");
        break;
      }
      children.push(right);
    }

    if (!children.length) {
      return null;
    }
    return children.length === 1 ? children[0] : { type: "or", children };
  };

  const parseAnd = (): QueryExpression | null => {
    const children: QueryExpression[] = [];
    while (!isExpressionEnd(peek()) && !isOrToken(peek())) {
      const primary = parsePrimary();
      if (!primary) {
        break;
      }
      children.push(primary);
    }

    if (!children.length) {
      return null;
    }
    return children.length === 1 ? children[0] : { type: "and", children };
  };

  const parsePrimary = (): QueryExpression | null => {
    const token = peek();
    if (token === undefined) {
      return null;
    }

    if (token === "(") {
      consume();
      const nested = parseExpression();
      if (peek() !== ")") {
        errors.push("存在未闭合的左括号。");
      } else {
        consume();
      }
      if (!nested) {
        errors.push("分组中至少需要一个条件。");
      }
      return nested;
    }

    if (token === ")") {
      errors.push("存在未匹配的右括号。");
      consume();
      return null;
    }

    if (isOrToken(token)) {
      errors.push("OR 前需要一个条件或分组。");
      consume();
      return null;
    }

    const condition = parseCondition(consume() ?? "");
    errors.push(...validateCondition(condition));
    return {
      type: "condition",
      condition
    };
  };

  return {
    parseExpression,
    hasRemainingTokens: () => index < tokens.length,
    peek
  };
}

function parseCondition(rawToken: string): QueryCondition {
  const isNegative = rawToken.startsWith("-") && rawToken.length > 1;
  const token = isNegative ? rawToken.slice(1) : rawToken;
  if (token.startsWith("!~") || token.startsWith("~")) {
    const operator = token.startsWith("!~") ? "!~" : "~";
    return {
      raw: rawToken,
      negative: isNegative,
      field: "url",
      operator,
      value: stripQuotes(token.slice(operator.length).trim())
    };
  }

  const separatorIndex = token.indexOf(":");
  if (separatorIndex <= 0) {
    const comparison = parseComparisonToken(token);
    if (comparison) {
      return {
        raw: rawToken,
        negative: isNegative,
        field: comparison.field,
        operator: comparison.operator,
        value: stripQuotes(comparison.value)
      };
    }

    return {
      raw: rawToken,
      negative: isNegative,
      field: "url",
      operator: ":",
      value: stripQuotes(token)
    };
  }

  return {
    raw: rawToken,
    negative: isNegative,
    field: token.slice(0, separatorIndex).trim().toLowerCase(),
    operator: ":",
    value: stripQuotes(token.slice(separatorIndex + 1).trim())
  };
}

function parseComparisonToken(token: string):
  | {
      field: string;
      operator: QueryOperator;
      value: string;
    }
  | null {
  const match = token.match(/^([a-zA-Z-]+)(!~|~|>=|<=|>|<|=)(.+)$/);
  if (!match) {
    return null;
  }
  return {
    field: match[1].toLowerCase(),
    operator: match[2] as QueryOperator,
    value: match[3].trim()
  };
}

function validateCondition(condition: QueryCondition): string[] {
  const errors: string[] = [];
  if (!condition.value) {
    errors.push(`条件 ${condition.raw} 缺少值。`);
  }

  if (condition.field === "keyword") {
    if (["~", "!~"].includes(condition.operator)) {
      const error = validateRegexLiteral(condition.value);
      if (error) {
        errors.push(`${condition.raw} 正则表达式无效：${error}`);
      }
    }
    return errors;
  }

  if (!QUERY_FIELDS.includes(condition.field as (typeof QUERY_FIELDS)[number])) {
    errors.push(`不支持的字段 ${condition.field}。`);
    return errors;
  }

  if (condition.field === "status" && !isValidStatusValue(condition.value)) {
    errors.push("status 仅支持 2xx/3xx/4xx/5xx、failed 或具体状态码。");
  }
  if (["~", "!~"].includes(condition.operator) && !isRegexField(condition.field)) {
    errors.push(`${condition.field} 不支持正则运算符 ${condition.operator}。`);
  }
  if (
    [">", ">=", "<", "<="].includes(condition.operator) &&
    !["status", "duration", "time", "size"].includes(condition.field)
  ) {
    errors.push(`${condition.field} 不支持比较运算符 ${condition.operator}。`);
  }
  if (
    [">", ">=", "<", "<="].includes(condition.operator) &&
    !isValidComparableValue(condition.field, condition.value)
  ) {
    errors.push(`${condition.field} 比较表达式的值无效。`);
  }
  if (["~", "!~"].includes(condition.operator)) {
    const error = validateRegexLiteral(condition.value);
    if (error) {
      errors.push(`${condition.raw} 正则表达式无效：${error}`);
    }
  }
  if ((condition.field === "type" || condition.field === "resource") && !isValidTypeValue(condition.value)) {
    errors.push("type 仅支持 all、fetch/xhr、document、stylesheet、script、image、media、font、websocket、other。");
  }
  if (condition.field === "has" && !HAS_VALUES.includes(condition.value as (typeof HAS_VALUES)[number])) {
    errors.push("has 仅支持 payload、response、query、form、headers、request-headers、response-headers。");
  }

  return errors;
}

function matchesExpression(record: NetworkRecord, expression: QueryExpression): boolean {
  if (expression.type === "condition") {
    const matched = matchesQueryCondition(record, expression.condition);
    return expression.condition.negative ? !matched : matched;
  }

  if (expression.type === "and") {
    return expression.children.every((child) => matchesExpression(record, child));
  }

  return expression.children.some((child) => matchesExpression(record, child));
}

function matchesQueryCondition(record: NetworkRecord, condition: QueryCondition): boolean {
  if (condition.field === "keyword") {
    if (condition.operator === ":" || condition.operator === "=") {
      return recordMatches(record, condition.value);
    }
    return matchesTextQuery(formatSearchableRecord(record), condition.operator, condition.value);
  }

  const field = condition.field;
  const value = condition.value;
  if (!value) {
    return false;
  }

  switch (field) {
    case "method":
      return matchesTextQuery(record.method, condition.operator, value);
    case "status":
      if (condition.operator !== ":") {
        return matchesNumberQuery(record.status, condition.operator, value, "status");
      }
      return matchesStatusQuery(record, value);
    case "duration":
    case "time":
      return matchesNumberQuery(record.duration, condition.operator, value, "duration");
    case "size":
      return matchesNumberQuery(record.size, condition.operator, value, "size");
    case "type":
    case "resource":
      if (condition.operator === "=") {
        return record.resourceType.toLowerCase() === value.toLowerCase();
      }
      return matchesResourceQuery(record, value);
    case "domain":
    case "host":
      return matchesTextQuery(hostname(record.url), condition.operator, value);
    case "url":
      return matchesTextQuery(record.url, condition.operator, value);
    case "name":
      return matchesTextQuery(record.name, condition.operator, value);
    case "mime":
      return matchesTextQuery(record.mimeType, condition.operator, value);
    case "payload":
    case "request":
      return matchesTextQuery(record.requestBody, condition.operator, value);
    case "response":
      return matchesTextQuery(record.responseBody, condition.operator, value);
    case "header":
    case "headers":
      return matchesTextQuery(formatHeaders(record), condition.operator, value);
    case "has":
      if (condition.operator === "=") {
        return matchesHasQuery(record, value);
      }
      return matchesHasQuery(record, value);
    default:
      return false;
  }
}

function matchesStatusQuery(record: NetworkRecord, value: string): boolean {
  if (value.toLowerCase() === "failed") {
    return matchesStatus(record, "failed");
  }
  if (/^[2-5]xx$/i.test(value)) {
    return matchesStatus(record, value.toLowerCase() as StatusFilter);
  }

  return record.status?.toString() === value;
}

function matchesNumberQuery(
  source: number | null,
  operator: QueryOperator,
  rawValue: string,
  field: "duration" | "size" | "status"
): boolean {
  if (source === null) {
    return false;
  }

  const target = field === "size" ? parseSizeValue(rawValue) : Number(rawValue);
  if (!Number.isFinite(target)) {
    return false;
  }

  switch (operator) {
    case ">":
      return source > target;
    case ">=":
      return source >= target;
    case "<":
      return source < target;
    case "<=":
      return source <= target;
    case "=":
    case ":":
      return source === target;
    default:
      return false;
  }
}

function matchesResourceQuery(record: NetworkRecord, value: string): boolean {
  const normalizedValue = value.toLowerCase();
  if (TYPE_FILTERS.some((filterItem) => filterItem.value === normalizedValue)) {
    return matchesType(record, normalizedValue as TypeFilter);
  }

  return includesIgnoreCase(record.resourceType, normalizedValue);
}

function matchesHasQuery(record: NetworkRecord, value: string): boolean {
  switch (value.toLowerCase()) {
    case "payload":
    case "request":
      return Boolean(record.requestBody);
    case "response":
      return Boolean(record.responseBody);
    case "query":
      return record.queryParams.length > 0;
    case "form":
      return record.postParams.length > 0;
    case "headers":
      return record.requestHeaders.length > 0 || record.responseHeaders.length > 0;
    case "request-headers":
      return record.requestHeaders.length > 0;
    case "response-headers":
      return record.responseHeaders.length > 0;
    default:
      return false;
  }
}

function lexQuery(query: string): {
  tokens: string[];
  errors: string[];
} {
  const tokens: string[] = [];
  const errors: string[] = [];
  let index = 0;

  while (index < query.length) {
    const char = query[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "(" || char === ")") {
      tokens.push(char);
      index += 1;
      continue;
    }

    let token = "";
    while (index < query.length && !/\s/.test(query[index]) && query[index] !== "(" && query[index] !== ")") {
      if (query[index] === '"') {
        const quoteStart = index;
        token += query[index];
        index += 1;
        while (index < query.length && query[index] !== '"') {
          token += query[index];
          index += 1;
        }
        if (index >= query.length) {
          errors.push(`从第 ${quoteStart + 1} 个字符开始的引号未闭合。`);
          break;
        }
        token += query[index];
        index += 1;
        continue;
      }

      token += query[index];
      index += 1;
    }

    if (token) {
      tokens.push(token);
    }
  }

  return { tokens, errors };
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function includesIgnoreCase(source: string, target: string): boolean {
  return source.toLowerCase().includes(target.toLowerCase());
}

function equalsIgnoreCase(source: string, target: string): boolean {
  return source.toLowerCase() === target.toLowerCase();
}

function matchesTextQuery(source: string, operator: QueryOperator, value: string): boolean {
  if (operator === "=") {
    return equalsIgnoreCase(source, value);
  }
  if (operator === "~" || operator === "!~") {
    const matched = matchesRegexLiteral(source, value);
    return operator === "~" ? matched : !matched;
  }
  return includesIgnoreCase(source, value);
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function formatHeaders(record: NetworkRecord): string {
  return [...record.requestHeaders, ...record.responseHeaders]
    .map((header) => `${header.name}: ${header.value}`)
    .join("\n");
}

function formatSearchableRecord(record: NetworkRecord): string {
  return [
    record.name,
    record.url,
    record.method,
    record.status?.toString() ?? "",
    record.resourceType,
    record.mimeType,
    record.requestBody,
    record.responseBody,
    formatHeaders(record)
  ].join("\n");
}

function quoteIfNeeded(value: string): string {
  if (/[\s()]/.test(value)) {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return value;
}

function isValidStatusValue(value: string): boolean {
  return /^[2-5]xx$/i.test(value) || /^[1-5]\d\d$/.test(value) || value.toLowerCase() === "failed";
}

function isValidTypeValue(value: string): boolean {
  return TYPE_FILTERS.some((item) => item.value === value.toLowerCase());
}

function isValidComparableValue(field: string, value: string): boolean {
  if (field === "size") {
    return Number.isFinite(parseSizeValue(value));
  }
  return Number.isFinite(Number(value));
}

function buildToken(field: AdvancedFilterField, operator: AdvancedFilterOperator, value: string): string {
  if (field === "keyword") {
    if (operator === "regex") {
      return `keyword~${toRegexLiteral(value)}`;
    }
    if (operator === "not-regex") {
      return `keyword!~${toRegexLiteral(value)}`;
    }
    return `keyword:${quoteIfNeeded(value)}`;
  }
  if (operator === "equals") {
    return `${field}=${quoteIfNeeded(value)}`;
  }
  if (operator === "gt") {
    return `${field}>${quoteIfNeeded(value)}`;
  }
  if (operator === "gte") {
    return `${field}>=${quoteIfNeeded(value)}`;
  }
  if (operator === "lt") {
    return `${field}<${quoteIfNeeded(value)}`;
  }
  if (operator === "lte") {
    return `${field}<=${quoteIfNeeded(value)}`;
  }
  if (operator === "regex") {
    return `${field}~${toRegexLiteral(value)}`;
  }
  if (operator === "not-regex") {
    return `${field}!~${toRegexLiteral(value)}`;
  }
  return `${field}:${quoteIfNeeded(value)}`;
}

function isRegexField(field: string): boolean {
  return [
    "keyword",
    "method",
    "type",
    "resource",
    "domain",
    "host",
    "url",
    "name",
    "mime",
    "payload",
    "request",
    "response",
    "header",
    "headers"
  ].includes(field);
}

function toRegexLiteral(value: string): string {
  const trimmed = value.trim();
  return /^\/.*\/i?$/.test(trimmed) ? trimmed : `/${trimmed.replaceAll("/", "\\/")}/`;
}

function validateRegexLiteral(value: string): string {
  try {
    createRegexFromLiteral(value);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function matchesRegexLiteral(source: string, value: string): boolean {
  try {
    return createRegexFromLiteral(value).test(source);
  } catch {
    return false;
  }
}

function createRegexFromLiteral(value: string): RegExp {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return new RegExp(trimmed, "i");
  }
  const end = trimmed.lastIndexOf("/");
  if (end <= 0) {
    throw new Error("缺少结束斜杠");
  }
  const pattern = trimmed.slice(1, end);
  const flags = trimmed.slice(end + 1);
  const safeFlags = [...new Set(flags.replace(/[^i]/g, "").split(""))].join("");
  return new RegExp(pattern, safeFlags);
}

function parseSizeValue(value: string): number {
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(b|kb|mb)?$/);
  if (!match) {
    return Number.NaN;
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "b";
  if (unit === "mb") {
    return amount * 1024 * 1024;
  }
  if (unit === "kb") {
    return amount * 1024;
  }
  return amount;
}
