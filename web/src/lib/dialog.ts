import { reactive } from "vue";

/**
 * In-page replacements for window.confirm / window.prompt, rendered by DialogHost.
 * Resolve when closed: confirm → boolean, prompt → text (or field values), null when cancelled.
 */
export type DialogRequest = {
  id: number;
  kind: "confirm" | "prompt";
  title: string;
  message?: string;
  okText: string;
  danger?: boolean;
  text?: string;
  placeholder?: string;
  fields?: { id: string; label: string; value: string; required?: boolean; maxLength?: number }[];
  resolve: (v: boolean | string | Record<string, string> | null) => void;
};

export const dialogs = reactive<{ stack: DialogRequest[] }>({ stack: [] });
let n = 0;

export function confirmDialog(title: string, opts: { message?: string; okText?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => dialogs.stack.push({ id: ++n, kind: "confirm", title, message: opts.message, okText: opts.okText ?? "确定", danger: opts.danger, resolve: (v) => resolve(v === true) }));
}

type PromptOptions = { message?: string; value?: string; placeholder?: string; okText?: string; danger?: boolean };
type PromptFields = { fields: NonNullable<DialogRequest["fields"]> };
export function promptDialog(title: string, opts: PromptOptions & PromptFields): Promise<Record<string, string> | null>;
export function promptDialog(title: string, opts?: PromptOptions): Promise<string | null>;
export function promptDialog(title: string, opts: PromptOptions & Partial<PromptFields> = {}): Promise<string | Record<string, string> | null> {
  return new Promise((resolve) =>
    dialogs.stack.push({ id: ++n, kind: "prompt", title, message: opts.message, text: opts.value ?? "", placeholder: opts.placeholder, fields: opts.fields?.map((f) => ({ ...f })), okText: opts.okText ?? "确定", danger: opts.danger, resolve: (v) => resolve(typeof v === "string" || (v && typeof v === "object") ? v : null) }),
  );
}

export function closeDialog(id: number, value: boolean | string | Record<string, string> | null) {
  const i = dialogs.stack.findIndex((d) => d.id === id);
  if (i < 0) return;
  const [d] = dialogs.stack.splice(i, 1);
  d.resolve(value);
}
