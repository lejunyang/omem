<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get, post } from "../../api";
import { toast } from "../../store";
import { useSettings } from "./ctx";
import FederationSettings from "../../components/FederationSettings.vue";
import MonoLine from "../../components/MonoLine.vue";
import PeerSettings from "../../components/PeerSettings.vue";
import SetCard from "../../components/SetCard.vue";
import SetRow from "../../components/SetRow.vue";

/** 设置 → 渠道与协作 → 设备: this omem's web address, paired devices, sharing with other omem servers, desktop and browser control. */
const { config, saveConfig } = useSettings();

// Desktop and browser control (ai-auto-desktop's aad): optional, installed through osdk.
type Desktop = { installed: boolean; version: string | null; via: "path" | "osdk" | null; spec: string };
const desktop = ref<Desktop | null>(null);
const desktopBusy = ref(false);
onMounted(() => void get<Desktop>("/api/desktop").then((d) => (desktop.value = d)).catch(() => {}));
async function installDesktop() {
  desktopBusy.value = true;
  try {
    desktop.value = await post<Desktop>("/api/desktop/install", {});
    toast(`已安装 aad ${desktop.value.version ?? ""}`);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    desktopBusy.value = false;
  }
}
</script>

<template>
  <div class="stack">
    <SetCard v-if="config" id="set-web-url" title="这台 omem 的网页地址">
      <template #help>从飞书、手机或其他设备打开 omem 用的地址；登录回调、邀请链接和分享链接也用它。填了以后，通知卡片里的“打开链接”和插件页的链接在飞书里能直接打开，回答里引用的代码、工作文件、记忆和 Wiki 变成只读分享链接；从其他设备打开还需要令牌（<span class="mono">omem link</span>）。</template>
      <SetRow label="网页地址" block>
        <input class="input mono" aria-label="网页地址" :value="config.webUrl ?? ''" placeholder="如 http://192.0.2.10:4317，或反向代理的地址" @change="saveConfig({ webUrl: ($event.target as HTMLInputElement).value.trim() }, '已保存网页地址')" />
      </SetRow>
    </SetCard>
    <PeerSettings />
    <FederationSettings />
    <SetCard v-if="desktop" id="set-desktop" title="桌面与浏览器控制">
      <template #aside>
        <span v-if="desktop.installed" class="badge ok">已安装{{ desktop.version ? ` ${desktop.version}` : "" }}</span>
        <span v-else class="badge">未安装</span>
      </template>
      <template #help>
        ai-auto-desktop（<span class="mono">aad</span>）让带命令行的 Agent 看和操作本机的桌面程序与浏览器：先读出界面结构，再对读到的元素动手。用法在内置技能 <span class="mono">desktop-control</span>：默认只看，动手前先问你，不输入密码。装好后导航里会出现“远程”：在网页上操作这台机器的浏览器页面或桌面，并把做一遍的过程录成技能。
        <template v-if="desktop.installed && desktop.via === 'osdk'">在 osdk 安装目录里，omem 启动 Agent 时会把它加进 PATH。</template>
      </template>
      <SetRow label="经 osdk 安装" hint="终端里 omem setup desktop 同样可用，并带环境检查">
        <MonoLine class="spec" :text="desktop.spec" />
        <button class="btn ghost sm" :disabled="desktopBusy" @click="installDesktop">{{ desktopBusy ? "安装中…" : desktop.installed ? "更新到最新" : "安装" }}</button>
      </SetRow>
    </SetCard>
  </div>
</template>

<style scoped>
.spec {
  max-width: 220px;
}
</style>
