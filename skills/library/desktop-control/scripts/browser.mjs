#!/usr/bin/env node
// A Chrome on a long-lived profile, for agents that drive web pages with aad.
//
//   node browser.mjs open <profile> [--url U] [--visible] [--chrome PATH] [--header host=Name:Value]...
//   node browser.mjs shot <profile> --out FILE [--page TEXT] [--full]
//   node browser.mjs close <profile>
//   node browser.mjs list
//
// The profile lives in <OMEM_HOME>/remote/profiles/<profile> (the same place the 远程 page keeps
// its profiles), so cookies and logins stay between runs: log in once per account, not per task.
// A profile already open is reused (a new tab when --url is given). Every launch:
//   - blocks pages from opening other programs (custom-scheme links such as app deep links make
//     Chrome ask "Open xdg-open?", a native dialog that also swallows page input);
//   - adds the --header values to requests for those hosts (a test lane, say), so no routing
//     script is needed;
//   - prints JSON: { profile, port, pid, reused }. Use it as AAD_CDP_PORT.
// Headless unless --visible, in a 1440x900 window (--size WxH): headless Chrome's own 800x600 makes
// a dialog only as tall as that little viewport while the page under it runs on.
//
// `shot` saves what the page shows now: the visible part (with any dialog or drawer as the user sees
// it), not the whole document. --full asks for the whole page, for long pages with no overlay open.
// --page picks the tab whose URL or title contains TEXT (else the last one opened). Prints
// { path, width, height, url }. Only Node built-ins.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const home = process.env.OMEM_HOME || join(homedir(), ".omem");
const root = process.env.OMEM_BROWSER_PROFILES || join(home, "remote", "profiles");
const [cmd, name, ...rest] = process.argv.slice(2);

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const opt = (flag) => {
  const out = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === flag && rest[i + 1] !== undefined) out.push(rest[++i]);
  return out;
};
const has = (flag) => rest.includes(flag);
const dirOf = (n) => {
  if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(n ?? "")) fail("profile name: letters, digits, _ and - (up to 40)");
  return join(root, n);
};

async function alive(dir) {
  const f = join(dir, "DevToolsActivePort");
  if (!existsSync(f)) return null;
  const port = Number(readFileSync(f, "utf8").split("\n")[0]);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? port : null;
  } catch {
    return null;
  }
}

function findChrome() {
  const explicit = opt("--chrome")[0] || process.env.OMEM_CHROME;
  if (explicit) return explicit;
  const c = [
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/microsoft/msedge/msedge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const base of [join(homedir(), ".cache", "puppeteer", "chrome"), join(homedir(), ".cache", "ms-playwright")]) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).sort().reverse()) {
      c.push(join(base, d, "chrome-linux64", "chrome"), join(base, d, "chrome-linux", "chrome"));
    }
  }
  return c.find((p) => existsSync(p)) ?? fail("no Chrome found; pass --chrome PATH");
}

// The page-side guard: a custom-scheme navigation (iframe, link click, window.open, location)
// is dropped and noted in the console instead of reaching the operating system.
const guard = `(() => {
  window.__omemGuard = true;
  const web = /^(https?|about|data|blob|javascript|chrome|devtools|file):/i;
  const external = (u) => { try { const s = String(new URL(String(u), location.href)); return !web.test(s) && /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : null; } catch { return null; } };
  const note = (s) => console.warn("[omem] blocked opening another program:", s.split(/[?#]/)[0]);
  const wrap = (proto, key, test) => { const d = Object.getOwnPropertyDescriptor(proto, key); if (!d || !d.set) return;
    Object.defineProperty(proto, key, { ...d, set(v) { const s = test(v); if (s) return note(s); d.set.call(this, v); } }); };
  wrap(HTMLIFrameElement.prototype, "src", external);
  wrap(HTMLAnchorElement.prototype, "href", () => null);
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (k, v) { if (this instanceof HTMLIFrameElement && String(k).toLowerCase() === "src") { const s = external(v); if (s) return note(s); } return setAttr.call(this, k, v); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { const s = external(this.href); if (s) return note(s); return click.call(this); };
  document.addEventListener("click", (e) => { const a = e.target && e.target.closest && e.target.closest("a[href]"); const s = a && external(a.href); if (s) { e.preventDefault(); note(s); } }, true);
  const open = window.open;
  window.open = function (u, ...a) { const s = external(u); if (s) { note(s); return null; } return open.call(this, u, ...a); };
  for (const k of ["assign", "replace"]) { const f = Location.prototype[k]; Location.prototype[k] = function (u) { const s = external(u); if (s) return note(s); return f.call(this, u); }; }
  if (window.navigation) navigation.addEventListener("navigate", (e) => { const s = external(e.destination.url); if (s && e.cancelable) { e.preventDefault(); note(s); } });
})();`;

function writeExtension(dir, headers) {
  const ext = join(dir, ".omem-extension");
  rmSync(ext, { recursive: true, force: true });
  mkdirSync(ext, { recursive: true });
  const rules = headers.map((h, i) => {
    const m = /^([^=]+)=([^:]+):(.*)$/.exec(h);
    if (!m) fail(`--header ${h}: expected host=Name:Value`);
    return {
      id: i + 1,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: m[2].trim(), operation: "set", value: m[3].trim() }] },
      condition: { requestDomains: [m[1].trim()] },
    };
  });
  writeFileSync(join(ext, "guard.js"), guard);
  writeFileSync(join(ext, "rules.json"), JSON.stringify(rules));
  writeFileSync(
    join(ext, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "omem page guard",
      version: "1.0",
      permissions: ["declarativeNetRequest"],
      host_permissions: ["<all_urls>"],
      declarative_net_request: { rule_resources: [{ id: "headers", enabled: true, path: "rules.json" }] },
      content_scripts: [{ matches: ["<all_urls>"], js: ["guard.js"], run_at: "document_start", all_frames: true, world: "MAIN" }],
    }),
  );
  return ext;
}

function windowSize() {
  const want = opt("--size")[0] ?? "1440x900";
  const m = /^(\d{3,4})[x,](\d{3,4})$/.exec(want);
  if (!m) fail(`--size ${want}: expected WIDTHxHEIGHT, such as 1440x900`);
  return `${m[1]},${m[2]}`;
}

/** One CDP session on a page target: send(method, params) → result. */
async function session(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("cannot connect to the page")); });
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.no(new Error(m.error.message));
    else w.ok(m.result);
  };
  return {
    send: (method, params = {}) => new Promise((ok, no) => { const id = ++n; waiting.set(id, { ok, no }); ws.send(JSON.stringify({ id, method, params })); }),
    close: () => ws.close(),
  };
}

async function shot() {
  const port = await alive(dirOf(name));
  if (!port) fail(`profile ${name} is not open; open it first`);
  const out = opt("--out")[0];
  if (!out) fail("shot needs --out FILE");
  const want = opt("--page")[0];
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page");
  const page = want ? pages.find((t) => t.url.includes(want) || t.title.includes(want)) : pages[0];
  if (!page) fail(want ? `no tab with "${want}" in its URL or title` : "no open tab");
  const s = await session(page.webSocketDebuggerUrl);
  try {
    const m = await s.send("Page.getLayoutMetrics");
    const view = m.cssVisualViewport ?? m.visualViewport;
    const full = has("--full");
    const size = full ? m.cssContentSize ?? m.contentSize : { width: view.clientWidth, height: view.clientHeight };
    const r = await s.send("Page.captureScreenshot", { format: "png", ...(full ? { captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } } : {}) });
    if (process.env.OMEM_BROWSER_EXECUTOR) {
      console.log(JSON.stringify({ png: r.data, width: Math.round(size.width), height: Math.round(size.height), url: page.url, full }));
      return;
    }
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, "base64"));
    console.log(JSON.stringify({ path, width: Math.round(size.width), height: Math.round(size.height), url: page.url, full }));
  } finally {
    s.close();
  }
}

async function announce(port, details, tab, navigate) {
  const opened = { profile: name, port, ...details };
  if (process.env.OMEM_BROWSER_PROFILES) {
    const page = tab ?? (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page");
    if (!page?.id) fail("browser has no page to register");
    const r = await fetch(new URL("/api/remote/agent-browser", process.env.OMEM_URL), {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json", authorization: "Bearer " + process.env.OMEM_TOKEN },
      body: JSON.stringify({ profile: name, pageId: page.id }),
    });
    if (!r.ok) fail(`browser opened, remote registration failed (${r.status}): ${await r.text()}`);
    opened.sessionId = (await r.json()).id;
  }
  if (navigate) {
    const s = await session(tab.webSocketDebuggerUrl);
    try { await s.send("Page.navigate", { url: navigate }); } finally { s.close(); }
  }
  console.log(JSON.stringify(opened));
}

async function open() {
  const dir = dirOf(name);
  mkdirSync(dir, { recursive: true });
  const url = opt("--url")[0];
  // Attach aad assist (which owns the request gate) on a blank page before the first navigation.
  const deferred = process.env.OMEM_BROWSER_EXECUTOR && url;
  const target = deferred ? "about:blank" : url;
  const running = await alive(dir);
  if (running) {
    const page = url ? await (await fetch(`http://127.0.0.1:${running}/json/new?${encodeURIComponent(target)}`, { method: "PUT" })).json() : null;
    await announce(running, { reused: true }, page, deferred);
    return;
  }
  rmSync(join(dir, "DevToolsActivePort"), { force: true });
  const ext = writeExtension(dir, opt("--header"));
  const args = [
    `--user-data-dir=${dir}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--enable-automation",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    `--load-extension=${ext}`,
    `--disable-extensions-except=${ext}`,
    // Newer Chrome ignores --load-extension without this; company intranet assets trip
    // Local Network Access checks in a test profile.
    "--disable-features=DisableLoadExtensionCommandLineSwitch,LocalNetworkAccessChecks",
    `--window-size=${windowSize()}`,
    // In a run omem started for someone other than its owner: everything goes through omem's guard,
    // loopback included, so the page cannot reach services on this machine.
    ...(process.env.OMEM_BROWSER_PROXY ? [`--proxy-server=${process.env.OMEM_BROWSER_PROXY}`, "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] : []),
    ...(has("--visible") ? [] : ["--headless=new"]),
    "about:blank",
  ];
  const child = spawn(findChrome(), args, { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 100; i++) {
    const port = await alive(dir);
    if (port) {
      // The page guard installs with the profile: open the page once it is there, not as the
      // start page of a new profile (that load can beat it).
      let page;
      if (url) {
        await new Promise((r) => setTimeout(r, 1500));
        page = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(target)}`, { method: "PUT" })).json();
      }
      await announce(port, { pid: child.pid, reused: false }, page, deferred);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  fail("Chrome did not start (profile in use by a Chrome without a debugging port?)");
}

async function close() {
  const port = await alive(dirOf(name));
  if (!port) return console.log(JSON.stringify({ profile: name, closed: false }));
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  await new Promise((resolve) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    ws.onmessage = ws.onclose = ws.onerror = () => resolve();
    setTimeout(resolve, 3000);
  });
  console.log(JSON.stringify({ profile: name, closed: true }));
}

async function list() {
  const out = [];
  if (existsSync(root)) for (const n of readdirSync(root)) if (!n.startsWith("@")) out.push({ profile: n, port: await alive(join(root, n)) });
  console.log(JSON.stringify(out));
}

if (process.env.OMEM_COMMAND_GATE?.endsWith("/bin/sandbox/bin/guarded") && !process.env.OMEM_BROWSER_EXECUTOR) {
  const shot = cmd === "shot";
  const r = spawnSync("aad", ["omem-browser", ...process.argv.slice(2)], { stdio: ["inherit", shot ? "pipe" : "inherit", "inherit"], maxBuffer: 64 << 20 });
  if (r.error) fail(r.error.message);
  if (r.status !== 0) process.exit(r.status ?? 1);
  if (shot) {
    const { png, ...details } = JSON.parse(r.stdout);
    const path = resolve(opt("--out")[0]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(png, "base64"));
    console.log(JSON.stringify({ path, ...details }));
  }
} else if (cmd === "open") await open();
else if (cmd === "register") {
  const pageId = opt("--page-id")[0];
  const port = await alive(dirOf(name));
  if (!process.env.OMEM_BROWSER_PROFILES || !port || !pageId) fail("register needs a managed profile and --page-id");
  await announce(port, { reused: true }, { id: pageId });
}
else if (cmd === "shot") await shot();
else if (cmd === "close") await close();
else if (cmd === "list") await list();
else fail("usage: browser.mjs open <profile> [--url U] [--visible] [--size WxH] [--chrome PATH] [--header host=Name:Value]... | shot <profile> --out FILE [--page TEXT] [--full] | close <profile> | list");
