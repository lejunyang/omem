/** Native attachment keys only. URLs in quoted/summary text are references, not attachments. */
export function resourceKeys(content: string, raw?: string | null, messageType?: string) {
  const required = new Set<string>(), covers = new Set<string>();
  const add = (value: unknown, optional = false) => {
    if (typeof value === "string" && /^(img|file)_[\w-]+$/.test(value)) (optional ? covers : required).add(value);
  };
  const text = content.replace(/<(?:video|media)\b[^>]*>/g, tag => {
    add(/\b(?:file_)?key="([^"]+)"/.exec(tag)?.[1]);
    for (const m of tag.matchAll(/\b(?:cover|cover_key|image_key)="([^"]+)"/g)) add(m[1], true);
    return "";
  });
  for (const m of text.matchAll(/(?:\]\(|\[(?:Image|Media|File|Audio|Video): |\bkey=")((?:img|file)_[\w-]+)/g)) add(m[1]);
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    add(o.file_key);
    add(o.image_key, !!o.file_key && (o.tag === "media" || o.tag === "video" || messageType === "media" || messageType === "video"));
    if (o.tag === "img" || o.tag === "image") add(o.img_key);
    for (const value of Object.values(o)) if (typeof value === "object") walk(value);
  };
  for (const candidate of [raw, /^\s*[{[]/.test(content) ? content : null]) if (candidate) {
    try { walk(JSON.parse(candidate)); } catch { /* Rendered text remains usable. */ }
  }
  return { required, optional: new Set([...covers].filter(key => !required.has(key))) };
}
