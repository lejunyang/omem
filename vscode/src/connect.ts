import * as vscode from "vscode";
import type { Api } from "./api";
import { fromPasted, type Mode } from "./connection";

const cfg = () => vscode.workspace.getConfiguration("omem");
const G = vscode.ConfigurationTarget.Global;

/**
 * The connection in the status bar: what it points at and whether it answers. A click opens the
 * connect steps.
 */
export class Status implements vscode.Disposable {
  readonly item = vscode.window.createStatusBarItem("omem.connection", vscode.StatusBarAlignment.Left, 50);

  constructor(private readonly api: Api) {
    this.item.name = "omem 连接";
    this.item.command = "omem.connect";
    this.item.show();
  }

  /** Ask omem who we are; the answer (or why not) goes to the status bar and the views. */
  async check() {
    const where = this.api.conn.describe();
    this.item.text = `$(sync~spin) omem`;
    try {
      await this.api.get("/api/me");
      this.item.text = `$(plug) omem`;
      this.item.tooltip = `已连上：${where}\n点击更换连接`;
      this.item.backgroundColor = undefined;
      await vscode.commands.executeCommand("setContext", "omem.connected", true);
      return true;
    } catch (e) {
      this.item.text = `$(debug-disconnect) omem 未连接`;
      this.item.tooltip = `${(e as Error).message}\n点击设置连接`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      await vscode.commands.executeCommand("setContext", "omem.connected", false);
      return false;
    }
  }

  dispose() {
    this.item.dispose();
  }
}

type Choice = vscode.QuickPickItem & { go: () => Promise<boolean | undefined> };

/** “连接 omem…”: pick how omem is reached, fill only what that way needs, check it answers. */
export async function connect(api: Api, status: Status) {
  const conn = api.conn;
  const set = async (values: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(values)) await cfg().update(k, v, G);
  };
  const choices: Choice[] = [
    {
      label: "$(vm) 这台机器上的 omem",
      description: conn.mode === "local" ? "当前" : undefined,
      detail: vscode.env.remoteName
        ? `omem 在这个窗口连到的机器上（${vscode.env.remoteName}）；插件要装在那边`
        : "omem 在这台电脑上；用 Remote-SSH 连到 omem 那台时也选这个",
      go: async () => {
        // Ask only for what the default does not settle: the port when nothing answers there, a
        // token when omem has one configured.
        let port = cfg().get<number>("port") || 4317;
        let answer = await probe(`http://127.0.0.1:${port}`, await conn.token());
        if (answer === "down") {
          const v = await vscode.window.showInputBox({ title: `端口 ${port} 上没有 omem：它在哪个端口`, value: String(port), prompt: "omem serve 的端口（omem 设置里的 port）", validateInput: (x) => (/^\d{2,5}$/.test(x.trim()) ? null : "填端口号") });
          if (v === undefined) return;
          port = Number(v.trim());
        }
        await set({ connection: "local", port });
        answer = await probe(conn.server, await conn.token());
        if (answer === "token") {
          const token = await vscode.window.showInputBox({ title: "这台机器的 omem 设了访问令牌", prompt: "运行 omem user token 得到", password: true, ignoreFocusOut: true });
          if (!token?.trim()) return;
          await conn.setToken(token.trim());
        }
        return true;
      },
    },
    {
      label: "$(key) 粘贴配对码或链接",
      description: conn.mode === "direct" ? "当前" : undefined,
      detail: "那台机器上 omem link 或 omem peer invite 的输出，地址和令牌一起填好",
      go: async () => {
        const text = await vscode.window.showInputBox({ title: "粘贴配对码或链接", prompt: "omem link 的链接，或 omem peer invite 的配对码", ignoreFocusOut: true, password: true });
        if (!text?.trim()) return;
        const got = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "omem：试连接…" }, () => fromPasted(text));
        await conn.setToken(got.token, got.url);
        await set({ connection: "direct", url: got.url });
        return true;
      },
    },
    {
      label: "$(globe) 填地址和令牌",
      description: conn.mode === "direct" ? "当前" : undefined,
      detail: "如 http://192.168.1.20:4317，令牌是那台机器上 omem user token 的输出",
      go: async () => {
        const url = await vscode.window.showInputBox({ title: "omem 的地址", value: cfg().get<string>("url") || "http://", ignoreFocusOut: true, validateInput: (v) => (/^https?:\/\/[^/]+/.test(v.trim()) ? null : "以 http:// 或 https:// 开头") });
        if (!url) return;
        const clean = url.trim().replace(/\/+$/, "");
        const token = await vscode.window.showInputBox({ title: "访问令牌", prompt: "那台机器上运行 omem user token；不需要令牌的留空", password: true, ignoreFocusOut: true });
        if (token === undefined) return;
        await conn.setToken(token.trim() || null, clean);
        await set({ connection: "direct", url: clean });
        return true;
      },
    },
    {
      label: "$(references) 经本机 omem 转发到配对的设备",
      description: conn.mode === "peer" ? `当前：${conn.peer}` : undefined,
      detail: "本机 omem 用 omem peer add 配好的设备，经中转的也行；不用另填地址和令牌",
      go: async () => {
        const local = `http://127.0.0.1:${cfg().get<number>("port") || 4317}`;
        const token = await conn.token();
        let peers: { id: string; url: string; via: string | null }[];
        try {
          const r = await fetch(`${local}/api/peers`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(4000) });
          if (!r.ok) throw new Error(r.status === 401 ? "本机 omem 要令牌：先用“这台机器上的 omem”连上" : r.statusText);
          peers = ((await r.json()) as { peers: typeof peers }).peers;
        } catch (e) {
          throw new Error(`读不到本机 omem 配对的设备（${local}）：${(e as Error).message}`);
        }
        if (!peers.length) throw new Error("本机 omem 还没有配对的设备：在那台机器上 omem peer invite，本机 omem peer add <配对码>");
        const pick = await vscode.window.showQuickPick(
          peers.map((p) => ({ label: p.id, description: p.via ? `经 ${p.via}` : p.url, picked: p.id === conn.peer })),
          { title: "转发到哪台设备" },
        );
        if (!pick) return;
        await set({ connection: "peer", peer: pick.label });
        return true;
      },
    },
  ];
  const picked = await vscode.window.showQuickPick(choices, { title: "omem 在哪里", placeHolder: `现在：${conn.describe()}`, matchOnDetail: true });
  if (!picked || !(await picked.go())) return;
  if (await status.check()) {
    void vscode.window.showInformationMessage(`omem：已连上 ${conn.describe()}`);
    if ((conn.mode as Mode) !== "local") await askSshHost(conn.uri("/") === null);
  } else {
    const again = await vscode.window.showWarningMessage(`omem：还连不上 ${conn.describe()}。${status.item.tooltip?.toString().split("\n")[0] ?? ""}`, "重新设置");
    if (again) await connect(api, status);
  }
}

async function probe(url: string, token?: string | null): Promise<"ok" | "token" | "down"> {
  try {
    const r = await fetch(`${url}/api/me`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(3000) });
    return r.status === 401 ? "token" : "ok";
  } catch {
    return "down";
  }
}

/**
 * Opening a delegation's folder needs that machine reachable from here: over Remote-SSH, by the
 * Host name in ~/.ssh/config. Asked once after connecting to another machine (skippable).
 */
export async function askSshHost(needed: boolean) {
  const current = (cfg().get<string>("sshHost") || "").trim();
  if (!needed) return current || null;
  const host = await vscode.window.showInputBox({
    title: "omem 那台机器的 SSH 主机名（可留空）",
    prompt: "~/.ssh/config 里的 Host，用 Remote-SSH 打开交办的工作区、跳到评审的代码时用。留空则只在网页和列表里看。",
    value: current,
    ignoreFocusOut: true,
  });
  if (host === undefined) return current || null;
  await cfg().update("sshHost", host.trim(), G);
  return host.trim() || null;
}
