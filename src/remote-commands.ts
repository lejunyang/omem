import type { Command } from "commander";
import { cliLogin, normalizeUrl, openBrowser, readClient, remoteApi, resolveRemote, writeClient, type ClientInfo } from "./remote-client.ts";

/**
 * The commands for using a remote omem that both CLIs have: the full app (src/cli-main.ts) and the
 * light client (packages/cli, `@omem-ai/cli`). Only Node built-ins and remote-client.ts here: the light
 * client bundles this file and must not pull in the server.
 */

/** What `omem tool` / `omem mcp` tell a remote omem about this client (src/remote-client.ts). */
export function clientInfo(o: { space?: string; spaces?: string; readOnly?: boolean; session?: string; agent?: string; model?: string; effort?: string }, defaultSession: string): ClientInfo {
  return {
    session: o.session || process.env.OMEM_SESSION || process.env.OMEM_PEER_SESSION || defaultSession,
    agent: o.agent || process.env.OMEM_AGENT || process.env.OMEM_PEER_AGENT || undefined,
    model: o.model || process.env.OMEM_MODEL || process.env.OMEM_PEER_MODEL || undefined,
    effort: o.effort || process.env.OMEM_EFFORT || process.env.OMEM_PEER_EFFORT || undefined,
    space: o.space,
    spaces: o.spaces,
    readOnly: o.readOnly,
  };
}

export const today = () => new Date().toLocaleDateString("sv");

/** `omem remote …`, `omem login`, `omem open`. */
export function addRemoteCommands(program: Command) {
  const remoteCmd = program.command("remote").description("远程 omem 的地址（本机记一份，不配对）：omem tool / omem mcp 用 --remote <名字> 或默认地址连过去");
  remoteCmd
    .command("add <name> <url>")
    .description("记一个远程地址；--auth-cmd 给一条输出凭据（如 JWT）的命令，或之后用 omem login 换令牌")
    .option("--auth-cmd <command>", "取凭据的命令：标准输出就是凭据，过期或被拒时重新执行")
    .option("--token <token>", "直接用这个 API 令牌（om_ 开头）")
    .option("--default", "设为默认：omem tool / omem mcp 不带地址时就连它")
    .action((name: string, url: string, o: { authCmd?: string; token?: string; default?: boolean }) => {
      const c = readClient();
      const prev = c.remotes[name];
      c.remotes[name] = { url: normalizeUrl(url), ...(o.authCmd ? { authCmd: o.authCmd } : prev?.authCmd && !o.token ? { authCmd: prev.authCmd } : {}), ...(o.token ? { token: o.token } : prev?.token && !o.authCmd ? { token: prev.token } : {}) };
      if (o.default || !c.default) c.default = name;
      writeClient(c);
      console.log(`已记下 ${name} → ${c.remotes[name].url}${c.default === name ? "（默认）" : ""}${c.remotes[name].authCmd || c.remotes[name].token ? "" : `
  还没有凭据：omem login --remote ${name}，或 omem remote add ${name} ${url} --auth-cmd "<命令>"`}`);
    });
  remoteCmd
    .command("list")
    .description("记下的远程地址")
    .action(() => {
      const c = readClient();
      const names = Object.keys(c.remotes);
      if (!names.length) return console.log("还没有。omem remote add <名字> <地址>");
      for (const n of names) {
        const e = c.remotes[n];
        console.log(`${n === c.default ? "*" : "-"} ${n}  ${e.url}  ${e.authCmd ? `命令：${e.authCmd}` : e.token ? "API 令牌" : "没有凭据"}`);
      }
    });
  remoteCmd
    .command("default <name>")
    .description("设为默认远程地址；写 none 取消默认（不带地址时用本机的库）")
    .action((name: string) => {
      const c = readClient();
      if (name !== "none" && !c.remotes[name]) throw new Error(`没有 ${name}`);
      c.default = name === "none" ? undefined : name;
      writeClient(c);
      console.log(name === "none" ? "已取消默认" : `默认：${name}`);
    });
  remoteCmd
    .command("rm <name>")
    .description("删掉一个远程地址（存的令牌一起删；服务器上的令牌到账号页撤销）")
    .action((name: string) => {
      const c = readClient();
      if (!c.remotes[name]) throw new Error(`没有 ${name}`);
      delete c.remotes[name];
      if (c.default === name) c.default = undefined;
      writeClient(c);
      console.log(`已删除 ${name}`);
    });

  program
    .command("login [url]")
    .description("在浏览器里确认后，拿一个以你的身份使用远程 omem 的令牌，记进 omem remote（omem tool / omem mcp 之后就能连过去）")
    .option("--remote <name>", "记成哪个名字（默认按地址的主机名；已记下的名字就换掉它的凭据）")
    .option("--no-browser", "不自动打开浏览器，只打印地址")
    .option("--default", "设为默认远程地址")
    .action(async (url: string | undefined, o: { remote?: string; browser?: boolean; default?: boolean }) => {
      const c = readClient();
      const saved = o.remote ? c.remotes[o.remote] : undefined;
      const target = url ? normalizeUrl(url) : saved ? normalizeUrl(saved.url) : c.default && c.remotes[c.default] ? normalizeUrl(c.remotes[c.default].url) : null;
      if (!target) throw new Error("要给地址：omem login https://omem.example.com");
      const name = o.remote ?? Object.entries(c.remotes).find(([, e]) => normalizeUrl(e.url) === target)?.[0] ?? (new URL(target).hostname.split(".")[0] || "remote");
      const r = await cliLogin(target, (line) => console.log(line), { browser: o.browser });
      const fresh = readClient();
      fresh.remotes[name] = { url: target, token: r.token };
      if (o.default || !fresh.default) fresh.default = name;
      writeClient(fresh);
      console.log(`已登录为 ${r.user.name}（${r.user.id}），记成 ${name}${fresh.default === name ? "（默认）" : ""}。
  试试：omem tool --remote ${name} list_spaces；给 Agent 用：claude mcp add omem -- omem mcp --remote ${name}`);
    });

  program
    .command("open [page]")
    .description("在浏览器里打开远程 omem 并以命令行的身份登录（一次性链接）；page 如 /wiki、/account")
    .option("--url <地址>", "远程地址（也可用 OMEM_URL）")
    .option("--remote <name>", "omem remote add 存下的远程地址")
    .option("--print", "只打印链接，不打开浏览器")
    .action(async (page: string | undefined, o: { url?: string; remote?: string; print?: boolean }) => {
      const target = resolveRemote(o);
      if (!target) throw new Error("没有远程地址：--url、--remote，或 omem remote add 一个默认的。本机直接打开 http://127.0.0.1:4317");
      const r = await remoteApi(target).json<{ url: string }>("/api/auth/open", { body: { path: page ? (page.startsWith("/") ? page : `/${page}`) : undefined }, timeoutMs: 30_000 });
      console.log(`${r.url}
  （5 分钟内有效，只能用一次）`);
      if (!o.print) await openBrowser(r.url);
    });

}
