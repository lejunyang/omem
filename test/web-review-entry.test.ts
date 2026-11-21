/// <reference path="../web/src/env.d.ts" />
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, expect, it, vi } from "vitest";
import { followMe, type Me } from "../web/src/lib/caps.ts";
import App from "../web/src/App.vue";
import Agents from "../web/src/views/Agents.vue";

// Exercise the page's normal load hooks before rendering it in Node.
vi.mock("vue", async importOriginal => {
  const vue = await importOriginal<typeof import("vue")>();
  return { ...vue, onMounted: vue.onServerPrefetch };
});
const { get, state } = vi.hoisted(() => ({
  get: vi.fn<(url: string) => Promise<unknown>>(),
  state: { spaces: [{ id: "project", name: "项目 A" }], space: "project", me: null, toasts: [] },
}));
vi.mock("../web/src/store.ts", () => ({
  state, kindLabel: {}, loadSpaces: vi.fn(), refreshUnread: vi.fn(), toast: vi.fn(),
}));
vi.mock("../web/src/api.ts", () => ({ get, setLiveEvents: vi.fn() }));
vi.mock("../web/src/components/CommandPalette.vue", () => ({ default: { render: () => null } }));
vi.mock("../web/src/components/CaptureDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("../web/src/components/DialogHost.vue", () => ({ default: { render: () => null } }));
vi.mock("../web/src/components/CitationDrawer.vue", () => ({ default: { render: () => null } }));
vi.mock("../web/src/components/ImagePreview.vue", () => ({ default: { render: () => null } }));

afterEach(() => {
  vi.unstubAllGlobals();
  get.mockReset();
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
