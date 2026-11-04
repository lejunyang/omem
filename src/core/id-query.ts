/** Accept a bare id, an internal route, or a copied answer footer. */
export function normalizeLookupId(raw: string) {
  const copied = /^id\s+(\S+?)(?:\s+·.*)?$/i.exec(raw.trim());
  return (copied?.[1] ?? raw.trim()).replace(/^(运行|run)\s*/i, "").replace(/^#?\/?(runs|items|ask)\//, "").replace(/^(src|mem|msg):/, "").replace(/#L\d+(-L?\d+)?$/, "");
}

/** Try an indexed lookup for id-like input without requiring a label or known id prefix. */
export function idQuery(raw: string): string | null {
  const id = normalizeLookupId(raw);
  return /^\S{6,200}$/.test(id) && /[a-z]/i.test(id) && /\d/.test(id) ? id : null;
}
