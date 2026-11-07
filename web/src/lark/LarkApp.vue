<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { get, post } from "../api";
import Skeleton from "../components/Skeleton.vue";
import { state } from "../store";

/**
 * Sign in before showing anything. Inside Feishu the JSSDK asks for a one-time code (`requestAccess`,
 * or `requestAuthCode` on clients older than 6.9) that the server turns into a session; outside
 * Feishu, the person is sent to the same page on the main site, where the usual login applies.
 */
type Tt = {
  requestAccess?: (o: { appID: string; scopeList: string[]; success: (r: { code: string }) => void; fail: (e: { errno?: number; errMsg?: string }) => void }) => void;
  requestAuthCode?: (o: { appId: string; success: (r: { code: string }) => void; fail: (e: { errMsg?: string }) => void }) => void;
};
declare global {
  interface Window {
    tt?: Tt;
    h5sdk?: { ready: (fn: () => void) => void; error?: (fn: (e: unknown) => void) => void };
  }
}

const ready = ref(false);
const problem = ref("");
const route = useRoute();
const mainSite = () => `/${location.hash || "#/"}`;

function feishuCode(appId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sdk = window.h5sdk;
    // Feishu's webview says so in its user agent; elsewhere the SDK may load but never become ready.
    if (!sdk || !window.tt || !/Lark|Feishu/i.test(navigator.userAgent)) return reject(new Error("outside"));
    setTimeout(() => reject(new Error("飞书没有回应登录请求，关掉侧边栏再打开试试")), 15_000);
    sdk.error?.((e) => reject(new Error(`飞书 JSSDK 出错：${JSON.stringify(e)}`)));
    sdk.ready(() => {
      const tt = window.tt!;
      const legacy = () =>
        tt.requestAuthCode
          ? tt.requestAuthCode({ appId, success: (r) => resolve(r.code), fail: (e) => reject(new Error(e.errMsg || "飞书没有给登录码")) })
          : reject(new Error("飞书版本太旧，升级后再打开"));
      if (!tt.requestAccess) return legacy();
      tt.requestAccess({
        appID: appId,
        scopeList: [],
        success: (r) => resolve(r.code),
        // 103: the client is too old for requestAccess.
        fail: (e) => (e.errno === 103 ? legacy() : reject(new Error(e.errMsg || "飞书没有给登录码"))),
      });
    });
  });
}

onMounted(async () => {
  try {
    const s = await get<{ user: unknown; larkApp: string | null }>("/api/auth/session");
    if (!s.user) {
      if (!s.larkApp) throw new Error("omem 没有打开飞书网页应用（设置 → 渠道）。");
      let code: string;
      try {
        code = await feishuCode(s.larkApp);
      } catch (e) {
        if ((e as Error).message === "outside") {
          location.replace(mainSite());
          return;
        }
        throw e;
      }
      await post("/api/auth/lark/app", { code });
    }
    ready.value = true;
  } catch (e) {
    problem.value = (e as Error).message;
  }
});
</script>

<template>
  <div class="lark-app">
    <p v-if="problem" class="problem">
      {{ problem }}
      <a :href="mainSite()" target="_blank" rel="noopener">在浏览器里打开</a>
    </p>
    <Skeleton v-else-if="!ready" :rows="4" />
    <RouterView v-else :key="route.fullPath" />
    <div class="toasts" aria-live="polite">
      <div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.lark-app {
  min-height: 100vh;
  background: var(--bg);
}
.problem {
  max-width: 520px;
  margin: 32px auto;
  padding: 0 16px;
  color: var(--danger);
}
.toasts {
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  display: grid;
  gap: 6px;
  z-index: 80;
  width: min(420px, calc(100% - 32px));
}
.toast {
  background: var(--ink);
  color: var(--bg);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}
.toast.error {
  background: var(--danger);
}
</style>
