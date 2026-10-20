/** A line diff for short texts (prompts, role files): equal / added / removed lines in order. */
export type DiffLine = { op: "=" | "+" | "-"; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  // Longest common subsequence table, from the end.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ op: "=", text: a[i] }), i++, j++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}

/** Only the changed lines with a little context around them; long equal runs fold to "…". */
export function compactDiff(lines: DiffLine[], context = 2): (DiffLine | { op: "…"; text: string })[] {
  const keep = lines.map((l, i) => l.op !== "=" || lines.slice(Math.max(0, i - context), i + context + 1).some((x) => x.op !== "="));
  const out: (DiffLine | { op: "…"; text: string })[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.at(-1)?.op !== "…") out.push({ op: "…", text: "" });
  });
  return out;
}
