<script setup lang="ts">
import { computed, ref } from "vue";
import { get, post } from "../../api";
import { state, toast } from "../../store";
import { useSettings } from "./ctx";
import AssistantsSettings from "../../components/AssistantsSettings.vue";
import HelpText from "../../components/HelpText.vue";
import MonoLine from "../../components/MonoLine.vue";
import PluginChannels from "../../components/PluginChannels.vue";
import SetCard from "../../components/SetCard.vue";
import SetRow from "../../components/SetRow.vue";
import Skeleton from "../../components/Skeleton.vue";
import UiCheckbox from "../../components/UiCheckbox.vue";
import UiSelect from "../../components/UiSelect.vue";

/** 设置 → 渠道与协作 → 渠道: the Feishu bot and its permissions, assistants, plugin channels, Telegram and QQ / WeChat. */
const { config, saveConfig } = useSettings();

/** The host Feishu has to trust for the web app (H5 可信域名). */
const webHost = computed(() => {
  try {
    return new URL(config.value?.webUrl ?? "").host;
  } catch {
    return "";
  }
});
const webBase = computed(() => String(config.value?.webUrl ?? "").replace(/\/+$/, ""));

// The bot apps' permissions and event subscriptions (src/channels/lark-bot-check.ts).
type BotEvent = { name: string; label: string; optional?: boolean };
type BotCheck = {
  ref: string;
  appId: string;
  name?: string;
  error?: string;
  scopes: { missing: string[]; unknown: boolean; link: string | null };
  members?: { missing: string[]; features: string[]; link: string | null };
  docs?: { missing: string[]; link: string | null };
  events: { subscribed: string[] | null; missing: BotEvent[]; unpublished: string[]; mode: string | null; link: string };
  callbacks: { subscribed: string[] | null; missing: { name: string; label: string }[] };
  reactionsQuiet: { days: number; botMessages: number; reactions: number; everReceived: boolean; quiet: boolean };
};
const botCheck = ref<BotCheck[] | null>(null);
const botChecking = ref(false);
const scanLinks = ref<Record<string, string>>({});
async function checkBots() {
  botChecking.value = true;
  try {
    botCheck.value = (await get<{ bots: BotCheck[] }>("/api/lark/bot-check")).bots;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    botChecking.value = false;
  }
}
async function scanBot(ref_: string) {
  try {
    const r = await post<{ url?: string; error?: string }>(`/api/lark/bot-check/${ref_}/scan`, {});
    if (r.url) {
      // The link is shown only when the browser blocked the new tab.
      const opened = window.open(r.url, "_blank");
      if (opened) {
        opened.opener = null;
        toast("在打开的页面里用飞书扫码确认，确认后会收到通知", "ok");
      } else scanLinks.value = { ...scanLinks.value, [ref_]: r.url };
    } else toast(r.error ?? "没有拿到扫码链接", "error");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const required = (b: BotCheck) => b.events.missing.filter((e) => !e.optional);
const optional = (b: BotCheck) => b.events.missing.filter((e) => e.optional);
</script>

<template>
  <Skeleton v-if="!config" :rows="6" />
  <div v-else class="stack">
    <SetCard id="set-lark-bot" title="飞书机器人">
      <template #help>飞书机器人是日常指挥入口：私聊可以提问、交代事项、交办任务；机器人所在的群聊会被保存为聊天原件并交给助理整理。通知也会发到私聊。在终端运行 <span class="mono">omem setup</span> → 渠道 → 飞书机器人：扫码创建新机器人，或绑定 lark-cli 里已有的应用；权限、长连接事件和卡片回调一并申请，不用复制 App Secret。密钥只存在本机 <span class="mono">secrets/lark.json</span>（环境变量 {{ config.lark.appSecretEnv }} 可覆盖）。</template>
      <template #aside>
        <span v-if="config.lark.appId" class="badge" :class="{ ok: config.lark.ownerOpenId }" :title="config.lark.appId">{{ config.lark.ownerOpenId ? "已绑定 · 本人已确认" : "已绑定 · 待确认本人" }}</span>
        <span v-else class="badge">未绑定</span>
      </template>
      <SetRow label="启用飞书机器人">
        <UiCheckbox :model-value="config.lark.enabled" switch aria-label="启用飞书机器人" @change="(v) => saveConfig({ lark: { ...config.lark, enabled: v } })" />
      </SetRow>
      <SetRow v-if="config.lark.appId" label="应用">
        <MonoLine class="app-id" :text="config.lark.appId" copy />
      </SetRow>
      <SetRow label="本人 open_id" hint="setup 扫码通常自动填；不知道可先私聊机器人一句，再运行 omem setup">
        <input class="input sm mono id-in" aria-label="本人 open_id" :value="config.lark.ownerOpenId ?? ''" @change="saveConfig({ lark: { ...config.lark, ownerOpenId: ($event.target as HTMLInputElement).value } })" />
      </SetRow>
      <SetRow label="默认空间">
        <UiSelect :model-value="config.lark.defaultSpace" size="sm" width="200px" aria-label="默认空间" :options="state.spaces.map((s) => ({ value: s.id, label: s.name }))" @change="(v) => saveConfig({ lark: { ...config.lark, defaultSpace: v } })" />
      </SetRow>
      <SetRow label="飞书网页应用" :off="!config.webUrl || !config.lark.appId">
        <template #hint>
          <template v-if="!config.webUrl || !config.lark.appId">表单和交互页在飞书侧边栏里打开；先在设备页填网页地址{{ config.lark.appId ? "" : "并接入飞书机器人" }}</template>
          <HelpText v-else>表单和交互页在飞书侧边栏里打开，不用再登录。打开前在飞书开发者后台给主机器人的应用：添加“网页应用”能力，桌面端和移动端主页都填 <span class="mono">{{ webBase }}/lark/</span>；安全设置的重定向 URL 加上 <span class="mono">{{ webBase }}/lark/</span>（免登接口要求调用它的页面地址在这个列表里，只加 H5 可信域名不够），H5 可信域名加上 <span class="mono">{{ webHost }}</span>；然后发布版本。手机和电脑都要能访问这个地址。</HelpText>
        </template>
        <UiCheckbox :model-value="!!config.lark.webApp" switch :disabled="!config.webUrl || !config.lark.appId" aria-label="飞书网页应用" @change="(v) => saveConfig({ lark: { ...config.lark, webApp: v } }, v ? '已打开飞书网页应用' : '已关闭飞书网页应用')" />
      </SetRow>
    </SetCard>

    <SetCard v-if="config.lark.appId" id="set-lark-check" title="机器人权限与事件">
      <template #help>omem 用到的应用权限（机器人的、成员连接飞书的）、事件订阅和卡片回调。缺什么都点“扫码更新”，在飞书里确认后一次补齐；之后在开发者后台发布新版本才生效，再点“检查”看结果。在后台手动加的权限同样要发布新版本才算开通。</template>
      <template #aside><button class="btn sm" :disabled="botChecking" @click="checkBots">{{ botChecking ? "检查中…" : "检查" }}</button></template>
      <div v-for="b in botCheck ?? []" :key="b.ref" class="set-pad bot">
        <div class="row wrap">
          <strong>{{ b.name ?? b.ref }}</strong><span class="muted small mono">{{ b.appId }}</span><span class="spacer" />
          <button class="btn sm" @click="scanBot(b.ref)">扫码更新</button>
        </div>
        <p v-if="b.error" class="small warn-text">{{ b.error }}</p>
        <dl class="checks small">
          <dt>权限</dt>
          <dd>
            <template v-if="b.scopes.unknown">读不到已开通的权限</template>
            <template v-else-if="b.scopes.missing.length">缺 {{ b.scopes.missing.length }} 项<div class="muted mono break">{{ b.scopes.missing.join("、") }}</div></template>
            <span v-else class="badge accent">齐全</span>
          </dd>
          <template v-if="b.members">
            <dt>成员连接飞书</dt>
            <dd>
              <template v-if="b.members.missing.length">{{ b.members.features.join("、") }}还缺 {{ b.members.missing.length }} 项用户身份的权限<div class="muted mono break">{{ b.members.missing.join("、") }}</div></template>
              <span v-else class="badge accent">齐全</span>
            </dd>
          </template>
          <template v-if="b.docs">
            <dt>文档变化规则</dt>
            <dd>
              <template v-if="b.docs.missing.length">订阅文档、表格的变化还缺 {{ b.docs.missing.length }} 项权限<div class="muted mono break">{{ b.docs.missing.join("、") }}</div></template>
              <span v-else class="badge accent">齐全</span>
            </dd>
          </template>
          <dt>事件</dt>
          <dd>
            <template v-if="b.events.subscribed === null">
              飞书没有告诉 omem 订阅了哪些；扫码更新会一并订阅 omem 用到的事件<template v-if="b.reactionsQuiet.quiet">；最近 {{ b.reactionsQuiet.days }} 天机器人发了 {{ b.reactionsQuiet.botMessages }} 条消息，一个表情事件都没收到，多半没订阅表情事件</template><template v-else-if="!b.reactionsQuiet.everReceived">；还没收到过表情事件</template>。
            </template>
            <template v-else-if="required(b).length">缺 {{ required(b).map((e) => e.label).join("、") }}<div class="muted mono break">{{ required(b).map((e) => e.name).join("、") }}</div></template>
            <span v-else class="badge accent">已订阅</span>
            <span v-if="b.events.subscribed !== null && optional(b).length" class="muted">（可选，未订阅：{{ optional(b).map((e) => e.label).join("、") }}）</span>
            <div v-if="b.events.unpublished.length" class="warn-text">已订阅但线上版本还没有：{{ b.events.unpublished.join("、") }}，发布新版本后生效</div>
          </dd>
          <template v-if="b.callbacks.missing.length">
            <dt>卡片回调</dt>
            <dd class="warn-text">未订阅：{{ b.callbacks.missing.map((c) => `${c.label}（${c.name}）`).join("、") }}</dd>
          </template>
        </dl>
        <a v-if="scanLinks[b.ref]" class="small" :href="scanLinks[b.ref]" target="_blank" rel="noopener">浏览器拦下了扫码页面，点这里打开（确认后会收到通知）</a>
      </div>
    </SetCard>

    <AssistantsSettings />

    <SetCard title="机器人在群里">
      <SetRow label="机器人之间连续转交最多" hint="之后等有人发话">
        <UiSelect :model-value="String(config.lark.botRelay ?? 4)" size="sm" width="96px" aria-label="机器人之间连续转交上限" :options="['0', '1', '2', '4', '6', '10'].map((v) => ({ value: v, label: `${v} 次` }))" @change="(v) => saveConfig({ lark: { ...config.lark, botRelay: Number(v) } }, `机器人之间连续转交最多 ${v} 次`)" />
      </SetRow>
      <SetRow label="盯着的群，每批消息先筛一遍">
        <template #hint><HelpText>助手盯着的群每攒一批消息交给它看一次。打开后每批先由决策模型判断有没有助手能介入的事：只是闲聊、“稍等”“收到”、进度播报的就不交给助手，省下一次完整运行；@ 你或 @ 机器人的消息不筛，判断出错时照常交给助手。单个群可以让助手按你的话单独开关。</HelpText></template>
        <UiCheckbox :model-value="config.lark.watchPrefilter !== false" switch aria-label="盯着的群每批消息先由决策模型筛一遍" @change="(v) => saveConfig({ lark: { ...config.lark, watchPrefilter: v } }, v ? '盯群的每批消息先由决策模型筛一遍' : '盯群的每批消息都交给助手看')" />
      </SetRow>
    </SetCard>

    <PluginChannels />

    <SetCard id="set-telegram" title="Telegram 机器人">
      <template #help>用 @BotFather 创建机器人，把 token 放在环境变量 <span class="mono">{{ config.telegram.tokenEnv }}</span>。首次给机器人发消息会回复你的 chat id。</template>
      <SetRow label="启用">
        <UiCheckbox :model-value="config.telegram.enabled" switch aria-label="启用 Telegram 机器人" @change="(v) => saveConfig({ telegram: { ...config.telegram, enabled: v } })" />
      </SetRow>
      <SetRow label="本人 chat id" :off="!config.telegram.enabled">
        <input class="input sm mono id-in" aria-label="本人 chat id" :value="config.telegram.ownerChatId ?? ''" @change="saveConfig({ telegram: { ...config.telegram, ownerChatId: ($event.target as HTMLInputElement).value || undefined } })" />
      </SetRow>
    </SetCard>

    <SetCard id="set-onebot" title="QQ / 微信机器人">
      <template #help>连接 NapCat、LLOneBot、Lagrange 等 OneBot v11 实现（正向 WebSocket）。私聊里只有本人能指挥助理；群消息保存为聊天原件并交给助理整理。</template>
      <SetRow label="启用">
        <UiCheckbox :model-value="config.onebot.enabled" switch aria-label="启用 QQ / 微信机器人" @change="(v) => saveConfig({ onebot: { ...config.onebot, enabled: v } })" />
      </SetRow>
      <SetRow label="WebSocket 地址" :off="!config.onebot.enabled">
        <input class="input sm mono id-in" aria-label="WebSocket 地址" :value="config.onebot.url ?? ''" placeholder="ws://127.0.0.1:3001" @change="saveConfig({ onebot: { ...config.onebot, url: ($event.target as HTMLInputElement).value || undefined } })" />
      </SetRow>
      <SetRow label="显示名" :off="!config.onebot.enabled">
        <input class="input sm id-in" aria-label="显示名" :value="config.onebot.name" @change="saveConfig({ onebot: { ...config.onebot, name: ($event.target as HTMLInputElement).value } })" />
      </SetRow>
      <SetRow label="本人账号" hint="QQ 号或微信 id" :off="!config.onebot.enabled">
        <input class="input sm mono id-in" aria-label="本人账号（QQ 号 / 微信 id）" :value="config.onebot.ownerUserId ?? ''" @change="saveConfig({ onebot: { ...config.onebot, ownerUserId: ($event.target as HTMLInputElement).value || undefined } })" />
      </SetRow>
    </SetCard>
  </div>
</template>

<style scoped>
.id-in {
  width: 260px;
  max-width: 100%;
}
.app-id {
  max-width: 260px;
}
.bot {
  gap: 8px;
}
.checks {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0;
}
.checks dt {
  color: var(--muted);
}
.checks dd {
  margin: 0;
  min-width: 0;
}
.break {
  overflow-wrap: anywhere;
}
.warn-text {
  color: var(--warn);
  margin: 0;
}
@media (max-width: 640px) {
  .checks {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
  .checks dd {
    margin-bottom: 6px;
  }
}
</style>
