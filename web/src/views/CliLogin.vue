<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { get, post } from "../api";
import Skeleton from "../components/Skeleton.vue";

/**
 * `omem login <地址>` asks here (docs/v2/remote-clients.md §4.2): the person, logged in as usual,
 * sees which computer asks and the code the terminal shows, and allows or refuses. Shown without the
 * app frame, like the login page; not logged in yet, the API sends the browser to log in and back.
 */
type Info = { client: string; code: string; approved: boolean; expiresAt: string; user: { id: string; name: string }; may: boolean };

const route = useRoute();
const code = computed(() => (typeof route.query.code === "string" ? route.query.code : ""));
const info = ref<Info | null>(null);
const failed = ref("");
const done = ref<"" | "allowed" | "denied">("");
const busy = ref(false);

onMounted(async () => {
  if (!code.value) return void (failed.value = "地址里没有确认码：在命令行里重新 omem login");
  try {
    info.value = await get<Info>(`/api/auth/cli/info?code=${encodeURIComponent(code.value)}`);
    if (info.value.approved) done.value = "allowed";
  } catch (e) {
    if (!(e as { login?: boolean }).login) failed.value = (e as Error).message;
  }
});

async function answer(allow: boolean) {
  busy.value = true;
  try {
    await post(`/api/auth/cli/${allow ? "approve" : "deny"}`, { code: code.value });
    done.value = allow ? "allowed" : "denied";
  } catch (e) {
    failed.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="cli-login">
    <div class="card pad box stack">
      <div class="row brand">
        <span class="logo" aria-hidden="true"><svg viewBox="0 0 32 32" width="26" height="26"><rect width="32" height="32" rx="8" fill="currentColor" /><circle cx="16" cy="16" r="7" fill="none" stroke="var(--bg)" stroke-width="3" /></svg></span>
        <strong>omem</strong>
      </div>
      <div v-if="failed" class="err small">{{ failed }}</div>
      <Skeleton v-else-if="!info" variant="text" :rows="3" />
      <template v-else-if="done === 'allowed'">
        <h2>已允许</h2>
        <p class="muted">回到终端，{{ info.client }} 上的 omem 命令行会自动拿到令牌。之后可以在 账号 → 命令行与 MCP 里撤销。</p>
      </template>
      <template v-else-if="done === 'denied'">
        <h2>已拒绝</h2>
        <p class="muted">这个确认码作废了。如果不是你发起的，不用做别的。</p>
      </template>
      <template v-else>
        <h2>允许命令行使用 omem？</h2>
        <p class="muted">
          <strong class="ink">{{ info.client }}</strong> 上的 omem 命令行请求以 <strong class="ink">{{ info.user.name }}</strong> 的身份使用 omem：检索、阅读你能看的空间，按你的权限写记忆和页面。
        </p>
        <div class="code mono">{{ info.code }}</div>
        <p class="muted small">先确认上面的确认码和终端里显示的一样；不是你刚才在终端里执行的 omem login，就点“拒绝”。</p>
        <p v-if="!info.may" class="warn-text small">你的角色不能在自己的电脑上用 omem 工具，请联系 omem 的主人。</p>
        <div class="row wrap">
          <button class="btn primary" :disabled="busy || !info.may" @click="answer(true)">允许</button>
          <button class="btn ghost" :disabled="busy" @click="answer(false)">拒绝</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cli-login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background: var(--bg);
}
.box {
  width: min(420px, 100%);
  gap: 14px;
}
.brand {
  gap: 10px;
  font-size: 18px;
}
.logo {
  display: flex;
  color: var(--ink);
}
h2 {
  margin: 0;
  font-family: var(--serif);
  font-weight: 600;
}
p {
  margin: 0;
}
.ink {
  color: var(--ink);
}
.code {
  font-size: 26px;
  letter-spacing: 0.12em;
  text-align: center;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius, 8px);
}
.err {
  color: var(--danger);
  overflow-wrap: anywhere;
}
</style>
