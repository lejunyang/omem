import { ref, watch } from "vue";

/**
 * Opening a coding run's folder in a desktop editor (docs/v2/ide.md). Which editor and the SSH
 * alias of each omem machine belong to the viewer's computer, so they are remembered here.
 */
export type Editor = "vscode" | "vscode-insiders" | "cursor";
export const editorOptions: { value: Editor; label: string }[] = [
  { value: "vscode", label: "VS Code" },
  { value: "vscode-insiders", label: "VS Code Insiders" },
  { value: "cursor", label: "Cursor" },
];

/** `scheme://file/<path>` on this machine, `scheme://vscode-remote/ssh-remote+<alias>/<path>` over SSH. */
export function ideUrl(editor: Editor, path: string, ssh?: string) {
  const p = path.replace(/\\/g, "/");
  const abs = encodeURI(p.startsWith("/") ? p : `/${p}`).replace(/[?#]/g, encodeURIComponent);
  return ssh ? `${editor}://vscode-remote/ssh-remote+${encodeURIComponent(ssh)}${abs}` : `${editor}://file${abs}`;
}

function stored<T>(key: string, fallback: T) {
  const v = ref<T>((() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  })());
  watch(v, (x) => {
    try {
      localStorage.setItem(key, JSON.stringify(x));
    } catch {
      /* private mode */
    }
  }, { deep: true });
  return v;
}

export const editor = stored<Editor>("omem.ide.editor", "vscode");
/** omem machine (its hostname) → the Host this computer's ~/.ssh/config reaches it by. */
export const sshAliases = stored<Record<string, string>>("omem.ide.ssh", {});
