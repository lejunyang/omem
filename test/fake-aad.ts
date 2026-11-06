// A stand-in for ai-auto-desktop's `aad` in remote operation tests (src/remote): the commands omem
// runs, answering the way the real ones do. Each call is appended to FAKE_AAD_LOG as a JSON line.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const out = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
if (process.env.FAKE_AAD_LOG) appendFileSync(process.env.FAKE_AAD_LOG, JSON.stringify(args) + "\n");
const scratch = () => mkdtempSync(join(tmpdir(), "fake-aad-"));
const after = (flag: string) => args[args.indexOf(flag) + 1];

function workflow(name: string) {
  const path = join(scratch(), `${name}.yaml`);
  writeFileSync(path, `apiVersion: ai-auto-desktop.dev/v1alpha1\nkind: Workflow\nmetadata:\n  name: ${name}\n`);
  return path;
}

/** The viewer and its WebSocket, on loopback with a token, announced as one JSON line. */
function assist() {
  const token = randomBytes(8).toString("hex");
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.searchParams.get("token") !== token) return void (res.writeHead(403), res.end());
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<title>viewer</title>path=${u.pathname}`);
  });
  server.on("upgrade", (req, socket) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/ws" || u.searchParams.get("token") !== token) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const text = Buffer.from(`ready ${args.join(" ")}`);
    const head = text.length < 126 ? [0x81, text.length] : [0x81, 126, text.length >> 8, text.length & 0xff];
    socket.write(Buffer.concat([Buffer.from(head), text]));
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    out({ url: `http://127.0.0.1:${port}/?token=${token}`, websocket: `ws://127.0.0.1:${port}/ws?token=${token}`, token, source: args.includes("--desktop") ? "desktop" : "browser" });
  });
}

/** `aad mcp`: JSON-RPC lines in, tool results out. */
function mcp() {
  let recording = "";
  let profileLock: string | null = null;
  const tools: Record<string, (a: any) => unknown> = {
    browser_profiles: (a) => (a.browser === "edge" ? { browser: "edge", profiles: [{ id: "Default", name: "工作", path: "x" }] } : (() => { throw new Error(`no ${a.browser} user data`); })()),
    browser_open: (a) => {
      if (a.browser === "chrome" && process.env.FAKE_AAD_NO_CHROME) throw new Error("chrome is not installed");
      if (a.copy_profile && !a.close_running) throw new Error("the profile is in use by a running browser");
      if (a.profile_dir) {
        const lock = join(a.profile_dir, ".aad-recording.lock");
        writeFileSync(lock, "", { flag: "wx" });
        profileLock = lock;
      }
      return { browser: a.browser, port: 9333, page_id: "PAGE1", profile_dir: a.profile_dir ?? scratch(), temporary_profile: !a.profile_dir };
    },
    browser_close: async () => {
      if (profileLock) {
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_AAD_CLOSE_MS ?? 0)));
        unlinkSync(profileLock);
        profileLock = null;
      }
      return { closed: true };
    },
    browser_record_start: () => ((recording = scratch()), { recording: true, out: recording }),
    browser_record_stop: () => {
      const step = (id: number, action: Record<string, unknown>, network: unknown[] = []) => JSON.stringify({ id, at_ms: id, page_id: "PAGE1", frame_id: "", kind: "action", action: { url: "https://example.test/admin", ...action }, changes: [], screenshots: [], network });
      writeFileSync(join(recording, "steps.jsonl"), [JSON.stringify({ id: 0, kind: "baseline", action: { title: "后台" } }), step(1, { kind: "input", label: "商户号", value: "B-1001", control: { role: "textbox", name: "商户号" } }), step(2, { kind: "click", label: "开通", control: { role: "button", name: "开通" } }, [{ method: "POST", url: "https://example.test/api/refund/grant", status: 200 }])].join("\n") + "\n");
      mkdirSync(join(recording, "evidence"), { recursive: true });
      writeFileSync(join(recording, "evidence", "network.jsonl"), JSON.stringify({ id: "req-1", step_id: 2, count: 1, request: { method: "POST", url: "https://example.test/api/refund/grant", postData: '{"merchant":"B-1001","token":"[REDACTED]"}' }, response: { status: 200 }, body: '{"ok":true}' }) + "\n");
      mkdirSync(join(recording, "screenshots"), { recursive: true });
      writeFileSync(join(recording, "screenshots", "s1.png"), "png");
      writeFileSync(join(recording, "walkthrough.md"), "# 浏览器操作记录\n\n## 1. 填写「商户号」：B-1001\n\n## 2. 点击「开通」\n");
      return { out: recording, files: ["steps.jsonl", "evidence/network.jsonl"] };
    },
    control_targets: () => ({ resources: [{ resource_id: "browser.cdp:PAGE1", metadata: { page_id: "PAGE1", main_frame: true } }] }),
    control_observe: () => ({ nodes: [{ role: "document", target: { node_id: "doc" } }] }),
    control_act: () => ({ applied: true }),
    run_workflow: (a) => ({ status: "succeeded", name: a.name }),
  };
  createInterface({ input: process.stdin }).on("line", async (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    if (process.env.FAKE_AAD_LOG) appendFileSync(process.env.FAKE_AAD_LOG, JSON.stringify(["mcp", msg.method, msg.params?.name ?? null, msg.params?.arguments ?? null]) + "\n");
    if (msg.method === "initialize") return out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    let payload: unknown;
    let isError = false;
    try {
      payload = await tools[msg.params.name](msg.params.arguments ?? {});
    } catch (e) {
      payload = { code: "BROWSER.START_FAILED", message: (e as Error).message };
      isError = true;
    }
    out({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError } });
  });
}

switch (args[0]) {
  case "--version":
    console.log("aad 0.0.5");
    break;
  case "apps":
    // As `aad apps` prints it: the windows the accessibility tree lists, under `apps`.
    out({ count: 1, apps: [{ resource_id: "desktop.fake:notepad", provider: "desktop.fake", name: "记事本", metadata: { process_name: "notepad.exe", process_id: 7, window_id: "hwnd:1", title: "记事本" } }] });
    break;
  case "assist":
    if (args.includes("--probe-video")) out({ ffmpeg: { path: "ffmpeg", version: "7.1" }, encoders: { h264: "libx264" }, tried: [{ encoder: "libx264", hardware: false, ok: true, ms: 80 }] });
    else if (args.includes("--list-screens")) out({ monitors: [{ monitor: 0, name: "D1", primary: true, width: 800, height: 600 }], windows: [{ window: "0x1", title: "记事本", process_id: 7, minimized: false }, { window: "0x2", title: "隐藏", minimized: true }] });
    else assist();
    break;
  case "mcp":
    mcp();
    break;
  case "browser-record":
    out({ count: 2, steps: [{ id: "rec1", app: { provider: "browser.cdp", url: "https://example.test/admin" }, locator: { role: "textbox", name: "商户号" }, action: { type: "fill", value: "B-1001" } }, { id: "rec2", app: { provider: "browser.cdp", url: "https://example.test/admin" }, locator: { role: "button", name: "开通" }, action: { type: "click" } }], skipped: [], saved: { workflow_path: workflow(after("--save")) } });
    break;
  case "record": {
    // Until standard input closes, as `--until-stdin-closes` does.
    process.stdin.resume();
    process.stdin.on("end", () => out({ status: "ok", data: { stopped_by: "stdin_closed", count: 1, steps: [{ id: "rec1", app: { process: "notepad.exe" }, locator: { role: "button", name: "保存" }, action: { type: "click" } }], skipped: [{ reason: "无法识别操作的元素", summary: "click" }], saved: { workflow_path: workflow(after("--save")) } } }));
    break;
  }
  case "run":
    out({ status: "ok", data: { status: "succeeded", steps: 1 } });
    break;
  default:
    console.error(`fake aad: unknown command ${args[0]}`);
    process.exit(2);
}
