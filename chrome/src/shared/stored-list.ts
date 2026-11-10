export function normalizeStoredList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value)
    .filter(([key]) => isArrayIndexKey(key))
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, item]) => item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isArrayIndexKey(value: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return false;
  }
  return String(Number(value)) === value;
}
