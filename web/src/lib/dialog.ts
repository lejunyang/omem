import { reactive } from "vue";

/**
 * In-page replacements for window.confirm / window.prompt, rendered by DialogHost.
 * Both resolve when the dialog closes: confirm → boolean, prompt → text or null (cancelled).
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
  resolve: (v: boolean | string | null) => void;
};

export const dialogs = reactive<{ stack: DialogRequest[] }>({ stack: [] });
let n = 0;

export function confirmDialog(title: string, opts: { message?: string; okText?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => dialogs.stack.push({ id: ++n, kind: "confirm", title, message: opts.message, okText: opts.okText ?? "确定", danger: opts.danger, resolve: (v) => resolve(v === true) }));
}

export function promptDialog(title: string, opts: { message?: string; value?: string; placeholder?: string; okText?: string; danger?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) =>
    dialogs.stack.push({ id: ++n, kind: "prompt", title, message: opts.message, text: opts.value ?? "", placeholder: opts.placeholder, okText: opts.okText ?? "确定", danger: opts.danger, resolve: (v) => resolve(typeof v === "string" ? v : null) }),
  );
}

export function closeDialog(id: number, value: boolean | string | null) {
  const i = dialogs.stack.findIndex((d) => d.id === id);
  if (i < 0) return;
  const [d] = dialogs.stack.splice(i, 1);
  d.resolve(value);
}
