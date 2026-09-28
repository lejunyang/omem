// Runtime-only dynamic imports resolved by the consuming app (apps/web). The
// concrete deps (marked / dompurify / highlight.js) live in apps/web's
// package.json; packages/ui stays dependency-free and loads them lazily.
declare module "highlight.js/lib/core" {
  const hl: {
    highlight(code: string, opts: { language: string; ignoreIllegals?: boolean }): { value: string };
    registerLanguage(name: string, lang: unknown): void;
    getLanguage(name: string): unknown;
  };
  export default hl;
}
declare module "highlight.js/lib/languages/*" {
  const lang: unknown;
  export default lang;
}
declare module "marked" {
  export const marked: {
    (src: string): string;
    setOptions(opts: Record<string, unknown>): void;
  };
}
declare module "dompurify" {
  const DOMPurify: {
    sanitize(html: string, opts?: Record<string, unknown>): string;
  };
  export default DOMPurify;
}
