/// <reference path="../web/src/env.d.ts" />
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { afterEach, expect, it, vi } from "vitest";
import { followMe, type Me } from "../web/src/lib/caps.ts";
import App from "../web/src/App.vue";
import Agents from "../web/src/views/Agents.vue";

// Exercise the page's normal load hooks before rendering it in Node.
vi.mock("vue", async importOriginal => {
  const vue = await importOriginal<typeof import("vue")>();
  return { ...vue, onMounted: vue.onServerPrefetch };
});
const { get, put, state } = vi.hoisted(() => ({
  get: vi.fn<(url: string) => Promise<unknown>>(),
  put: vi.fn<(url: string, body: unknown) => Promise<unknown>>(),
  state: { spaces: [{ id: "project", name: "项目 A" }], space: "project", me: null, toasts: [] },
}));
vi.mock("../web/src/store.ts", () => ({
  state, kindLabel: {}, loadSpaces: vi.fn(), refreshUnread: vi.fn(), toast: vi.fn(),
}));
vi.mock("../web/src/api.ts", () => ({ get, put, setLiveEvents: vi.fn() }));
vi.mock("../web/src/components/CommandPalette.vue", () => ({ default: { render: () => null } }));
vi.mock("../web/src/components/CaptureDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("../web/src/components/DialogHost.vue", () => ({ default: { render: () => null } }));
vi.mock("../web/src/components/CitationDrawer.vue", () => ({ default: { render: () => null } }));
vi.mock("../web/src/components/VirtualList.vue", () => ({default:{render:()=>null}}));
vi.mock("../web/src/components/Markdown.vue", () => ({default:{render:()=>null}}));
vi.mock("../web/src/components/ProfileLearning.vue", () => ({ default: { render: () => "专属记忆" } }));
vi.mock("../web/src/components/ImagePreview.vue", () => ({ default: { render: () => null } }));

afterEach(() => {
  vi.unstubAllGlobals();
  get.mockReset();
  put.mockReset();
  followMe(() => null);
});

it.each([false, true])("opens review settings from the member's sidebar and tier deep link (edit=%s)", async edit => {
  const me: Me = { role: "member", perms: [], spaces: ["project"], caps: ["settings.assistant.view", ...(edit ? ["settings.assistant.edit"] : [])], spaceCaps: {} };
  Object.assign(state, { me });
  followMe(() => me);
  vi.stubGlobal("location", { hash: "" });
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  const responses: Record<string, unknown> = {
    "/api/me": me, "/api/plugins": [],
    "/api/review-settings": { tiers: [{ id: "basic", name: "基础档", checks: [], maxRounds: 1 }], checks: [], recent: {} },
    "/api/review-options": { fields: {}, descriptions: {}, ops: [] },
    "/api/settings?section=assistant": { agents: [] },
  };
  get.mockImplementation(async url => {
    if (!(url in responses)) throw new Error("Unexpected request: " + url);
    return responses[url];
  });
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/ask", component: { render: () => null } }, { path: "/agents", component: Agents },
    { path: "/:rest(.*)", component: { render: () => null } },
  ] });
  const render = async (url: string) => {
    await router.push(url);
    return renderToString(createSSRApp(App).use(router));
  };
  const sidebar = await render("/ask");
  const entry = sidebar.match(/href="([^"]+)"[^>]*>(?:(?!<\/a>).)*评审设置<\/a>/s)?.[1];
  expect(entry).toBe("/agents?tab=review");
  expect(sidebar).not.toContain('href="/agents"');
  expect(await render(entry!)).toContain("基础档");
  const tier = await render(entry + "&tier=basic");
  expect(tier).toContain('aria-label="档位名称"');
  expect(tier.includes(">保存</button>")).toBe(edit);
  expect(tier.includes("<fieldset disabled")).toBe(!edit);
  expect(tier.includes("新建档位</button>")).toBe(edit);
  expect(await render("/agents?tab=skills")).not.toContain("新建技能");
  expect(get.mock.calls.map(([url]) => url).every(url => url in responses)).toBe(true);
  me.caps = [];
  me.perms = ["agents.manage", "code.delegate"];
  get.mockClear();
  expect(await render("/agents?tab=review&tier=basic")).not.toContain('aria-label="档位名称"');
  expect(get).not.toHaveBeenCalledWith("/api/review-settings");
});

it("冷启动后打开角色和档案表单，已选插件后端显示来源和停用原因", async () => {
  const { testApp } = await import("./helpers.ts");
  const { App: Host } = await import("../src/core/app.ts");
  const { saveConfig } = await import("../src/core/config.ts");
  const { saveAgentSpec } = await import("../src/agents/specs.ts");
  const { startServer } = await import("../src/server/http.ts");
  const saved = testApp(), id = "removed:worker";
  saved.config.agents.roles.assistant = id;
  saveConfig(saved.config,saved.home);
  saveAgentSpec(saved,{name:"demo",description:"核对材料",agent:id,prompt:"核对材料"},"user");
  saved.db.close();
  const host = Host.open(saved.home);
  const server = await startServer(host,{port:0,quiet:true});
  const me: Me = {role:"owner",perms:[],spaces:["personal"],caps:[],spaceCaps:{}};
  followMe(() => me);
  Object.assign(state,{me});
  vi.stubGlobal("window",{addEventListener:vi.fn()});
  vi.stubGlobal("location",{hash:""});
  try {
    get.mockImplementation(async url => {
      const res = await server.inject({url});
      if (res.statusCode !== 200) throw Error(url + ": " + res.statusCode);
      return res.json();
    });
    const options = (await server.inject({url:"/api/profile-options"})).json();
    expect(options.backends.map((b:{id:string}) => b.id)).not.toContain(id);
    expect(options.unavailableBackends).toContainEqual(expect.objectContaining({id}));
    for (const query of ["role=assistant","name=demo"]) {
      const router = createRouter({history:createMemoryHistory(),routes:[{path:"/agents",component:Agents}]});
      await router.push("/agents?" + query);
      const html = await renderToString(createSSRApp(Agents).use(router));
      const field = html.match(/aria-label="后端"[^>]*>[\s\S]*?<\/button>/)?.[0];
      // The saved choice stays the selected option, marked as unavailable, with where it came from and why.
      expect(field).toContain(">" + options.unavailableBackends.find((b:{id:string}) => b.id === id).name + "（不可用）</span>");
      expect(html).toContain("现在用不了：这个后端来自已停用或未信任的插件");
      expect(html).toContain("（来自插件 removed）");
    }
  } finally { await server.close(); host.db.close(); }
});

it("旧 agents.manage 成员可保存档案用途，打开内置角色只见摘要", async () => {
  const me = { role: "profiles", perms: ["agents.manage"], spaces: [] };
  Object.assign(state, { me });
  followMe(() => me);
  const summary = { name: "example", description: "原用途", status: "draft", model: "example-model" };
  const detailUrl = "/api/agents/example";
  const role = { name: "reviewer", description: "检查改动" };
  const roleUrl = "/api/roles/reviewer";
  const responses: Record<string, unknown> = {
    "/api/agents": [summary], [detailUrl]: summary, "/api/roles": [role], "/api/skills": [],
    [roleUrl]: { ...role, defaults: { agent: "example-backend", byBackend: { "example-backend": { model: "review-model", effort: "high" } } } },
    "/api/skill-groups": { groups: [] }, "/api/profile-options": {},
  };
  get.mockImplementation(async url => {
    if (!(url in responses)) throw new Error("Unexpected request: " + url);
    return responses[url];
  });
  put.mockImplementation(async (url, body) => {
    expect(url).toBe(detailUrl);
    expect(body).toEqual({ description: "新用途", status: "draft" });
    return Object.assign(summary, body);
  });
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/agents", component: Agents }] });
  await router.push("/agents?name=example");
  const app = createSSRApp({ render: () => h(RouterView) }).use(router);
  // Drive the loaded page's form and save handler in Node, without starting a browser.
  let editor!: { form: { description: string }; saveSpec(): Promise<void> };
  app.mixin({ created() {
    if (this.$.type === Agents) editor = (this.$ as unknown as { setupState: typeof editor }).setupState;
  } });
  const html = await renderToString(app);
  expect(html).toContain("原用途</textarea>");
  expect(html).toContain('aria-label="档案状态"');
  expect(html).toContain("example-model");
  expect(html).not.toMatch(/档案原文|>原文<|工作目录|提示词|专属记忆|MCP 服务/);
  editor.form.description = "新用途";
  await editor.saveSpec();
  expect(put).toHaveBeenCalledTimes(1);
  expect(get.mock.calls.filter(([url]) => url === detailUrl)).toHaveLength(2);
  expect(get.mock.calls.map(([url]) => url).every(url => url in responses)).toBe(true);
  expect(await renderToString(createSSRApp({ render: () => h(RouterView) }).use(router))).toContain("新用途</textarea>");
  await router.push("/agents?tab=agents&role=reviewer");
  const rolePage = await renderToString(createSSRApp({ render: () => h(RouterView) }).use(router));
  expect(get).toHaveBeenCalledWith(roleUrl);
  expect(rolePage).toContain("检查改动</p>");
  expect(rolePage).toContain("默认 AI · example-backend · review-model · high");
  expect(rolePage).not.toMatch(/专属记忆|角色原文|保存默认 AI|自定义|<textarea/);
});
