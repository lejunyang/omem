<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import QrcodeVue from "qrcode.vue";
import { OmBadge, OmButton, OmEmpty, OmPanel } from "@omem/ui";
import {
  api,
  type LarkConnection,
  type LarkOnboarding,
  type LarkRequestedConfig,
  type ReusableLarkApp,
} from "./api";

const emit = defineEmits<{ error: [text: string]; notice: [text: string] }>();
const pageError = ref("");
function reportError(text: string) {
  pageError.value = text.includes("LARK_ONBOARDING_NOT_CONFIGURED")
    ? "飞书连接尚未启用。在服务机器运行 omem bot setup，按提示启动或重启服务后再打开这里。"
    : text;
}
const mode = ref<"new" | "update" | "import">("update");
const credentialSource = ref<"botmux" | "manual">("botmux");
const appId = ref("");
const clientSecret = ref("");
const config = ref<LarkRequestedConfig | null>(null);
const connections = ref<LarkConnection[]>([]);
const reusableApps = ref<ReusableLarkApp[]>([]);
const pending = ref<LarkOnboarding[]>([]);
const onboarding = ref<LarkOnboarding | null>(null);
const pairingCode = ref("");
const busy = ref(false);
const loading = ref(true);
let timer: ReturnType<typeof setInterval> | undefined;

const terminal = computed(() =>
  onboarding.value
    ? ["active", "cancelled", "denied", "expired", "failed"].includes(
        onboarding.value.status,
      )
    : true,
);
const statusLabel: Record<string, string> = {
  draft: "准备中",
  awaiting_scan: "等待授权",
  credentials_received: "已收到凭据",
  checking: "正在核验权限",
  awaiting_pair: "等待本人配对",
  active: "已启用",
  failed: "核验失败",
  denied: "已拒绝",
  expired: "授权已过期",
  cancelled: "已取消",
};
const statusTone = (status: string) =>
  status === "active"
    ? "success"
    : ["failed", "denied", "expired", "cancelled"].includes(status)
      ? "danger"
      : "warning";
const needsQr = computed(() =>
  Boolean(
    onboarding.value?.resumable !== false &&
      onboarding.value?.verificationUrl &&
      onboarding.value.status === "awaiting_scan",
  ),
);

function selectedId() {
  return new URLSearchParams(location.hash.split("?")[1] || "").get(
    "onboarding",
  );
}
function selectOnboarding(value: LarkOnboarding) {
  onboarding.value = value;
  history.replaceState(
    history.state,
    "",
    "#/lark?" + new URLSearchParams({ onboarding: value.id }),
  );
}
async function resume(id: string) {
  busy.value = true;
  pageError.value = "";
  pairingCode.value = "";
  try {
    selectOnboarding(
      await api<LarkOnboarding>(
        `/integrations/lark/onboarding/${encodeURIComponent(id)}`,
      ),
    );
  } catch (error) {
    reportError(String(error));
  } finally {
    busy.value = false;
  }
}
function syncLocation() {
  const id = selectedId();
  if (id && id !== onboarding.value?.id) void resume(id);
}

async function loadBase() {
  try {
    const [nextConfig, nextConnections, apps, unfinished] = await Promise.all([
      api<LarkRequestedConfig>("/integrations/lark/default-config"),
      api<LarkConnection[]>("/integrations/lark/status"),
      api<ReusableLarkApp[]>("/integrations/lark/reusable-apps"),
      api<LarkOnboarding[]>("/integrations/lark/onboardings"),
    ]);
    config.value = nextConfig;
    connections.value = nextConnections;
    reusableApps.value = apps;
    pending.value = unfinished;
    if (!appId.value)
      appId.value = apps[0]?.appId || nextConnections[0]?.appId || "";
    if (selectedId()) await resume(selectedId()!);
    else if (unfinished.length === 1) selectOnboarding(unfinished[0]!);
  } catch (error) {
    reportError(String(error));
  } finally {
    loading.value = false;
  }
}
async function refreshOnboarding() {
  if (!onboarding.value) return;
  try {
    onboarding.value = await api<LarkOnboarding>(
      `/integrations/lark/onboarding/${onboarding.value.id}`,
    );
    await loadConnections();
  } catch (error) {
    reportError(String(error));
  }
}
async function loadConnections() {
  try {
    connections.value = await api<LarkConnection[]>(
      "/integrations/lark/status",
    );
    pending.value = await api<LarkOnboarding[]>(
      "/integrations/lark/onboardings",
    );
  } catch (error) {
    reportError(String(error));
  }
}
async function start() {
  if (!config.value) return;
  if (mode.value !== "new" && !/^cli_[a-zA-Z0-9]+$/.test(appId.value)) {
    reportError("请输入有效的飞书 App ID（cli_…）");
    return;
  }
  busy.value = true;
  pageError.value = "";
  pairingCode.value = "";
  try {
    if (mode.value === "import") {
      onboarding.value = await api<LarkOnboarding>(
        "/integrations/lark/existing",
        {
          appId: appId.value,
          source: credentialSource.value,
          ...(credentialSource.value === "manual"
            ? { clientSecret: clientSecret.value }
            : {}),
          config: config.value,
        },
      );
      clientSecret.value = "";
    } else {
      onboarding.value = await api<LarkOnboarding>(
        "/integrations/lark/onboarding",
        {
          mode: mode.value === "new" ? "new" : "existing",
          ...(mode.value === "update" ? { appId: appId.value } : {}),
          config: config.value,
        },
      );
    }
    selectOnboarding(onboarding.value!);
    emit(
      "notice",
      needsQr.value
        ? "授权已开始，可扫码或直接打开链接"
        : "已有应用凭据已接收，正在核验权限",
    );
  } catch (error) {
    reportError(String(error));
  } finally {
    clientSecret.value = "";
    busy.value = false;
  }
}
async function cancel() {
  if (!onboarding.value) return;
  try {
    onboarding.value = await api(
      `/integrations/lark/onboarding/${onboarding.value.id}/cancel`,
      {},
    );
  } catch (error) {
    reportError(String(error));
  }
}
async function issuePairing() {
  if (!onboarding.value) return;
  busy.value = true;
  try {
    const result = await api<{ code: string; expiresAt: string }>(
      `/integrations/lark/onboarding/${onboarding.value.id}/pairing-code`,
      {},
    );
    pairingCode.value = result.code;
    await refreshOnboarding();
  } catch (error) {
    reportError(String(error));
  } finally {
    busy.value = false;
  }
}
async function confirmPairing() {
  const pairing = onboarding.value?.pairing;
  if (!pairing?.candidateOpenId) return;
  busy.value = true;
  try {
    await api("/integrations/lark/bindings/confirm", {
      pairingId: pairing.id,
      expectedOpenId: pairing.candidateOpenId,
    });
    await refreshOnboarding();
    emit("notice", "本人身份与应用已绑定；加入群后会自动开始读取群消息");
  } catch (error) {
    reportError(String(error));
  } finally {
    busy.value = false;
  }
}
function reset() {
  onboarding.value = null;
  pairingCode.value = "";
  clientSecret.value = "";
  history.replaceState(history.state, "", "#/lark");
}
async function restartInterrupted() {
  const knownApp = onboarding.value?.appId || onboarding.value?.requestedAppId;
  await cancel();
  if (onboarding.value?.status !== "cancelled") return;
  reset();
  if (knownApp) {
    appId.value = knownApp;
    mode.value = "update";
  }
}
watch(
  () => [onboarding.value?.status, onboarding.value?.resumable],
  () => {
    if (
      !onboarding.value ||
      terminal.value ||
      onboarding.value.resumable === false
    ) {
      if (timer) clearInterval(timer);
      timer = undefined;
      return;
    }
    if (!timer) timer = setInterval(() => void refreshOnboarding(), 1500);
  },
  { immediate: true },
);
onMounted(() => {
  window.addEventListener("hashchange", syncLocation);
  void loadBase();
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  window.removeEventListener("hashchange", syncLocation);
});
</script>

<template>
  <p v-if="pageError" role="status" class="lark-page-error">{{ pageError }}</p>
  <section class="page lark-page">
    <span class="eyebrow">在飞书交办、接收提醒和确认事项</span>
    <h1>飞书机器人</h1>
    <p class="muted">
      新建或更新应用需要平台授权；也可安全复用 botmux 已有应用。App Secret
      只提交给服务端加密保存，不会出现在状态响应、日志或页面结果中。
    </p>

    <p v-if="loading" role="status">正在读取已有连接和未完成的接入…</p>
    <OmPanel
      v-if="!loading && !onboarding && pending.length"
      title="继续未完成的接入"
    >
      <div v-for="item in pending" :key="item.id" class="pending-row">
        <div>
          <b>{{ item.appId || item.requestedAppId || "新应用授权" }}</b
          ><small
            >{{ statusLabel[item.status] || item.status }} ·
            {{ new Date(item.updatedAt).toLocaleString("zh-CN") }}</small
          >
        </div>
        <OmButton :loading="busy" @click="resume(item.id)">继续接入</OmButton>
      </div>
    </OmPanel>
    <OmPanel v-if="!loading && !onboarding && config" title="选择接入方式">
      <div class="tabs" role="tablist" aria-label="飞书应用接入方式">
        <OmButton
          :variant="mode === 'new' ? 'primary' : 'ghost'"
          @click="mode = 'new'"
          >创建新应用</OmButton
        >
        <OmButton
          :variant="mode === 'update' ? 'primary' : 'ghost'"
          @click="mode = 'update'"
          >授权已有应用</OmButton
        >
        <OmButton
          :variant="mode === 'import' ? 'primary' : 'ghost'"
          @click="mode = 'import'"
          >直接导入凭据</OmButton
        >
      </div>
      <form class="form" @submit.prevent="start">
        <label v-if="mode !== 'new'">
          App ID
          <input
            v-model="appId"
            required
            placeholder="cli_…"
            list="reusable-lark-apps"
          />
          <datalist id="reusable-lark-apps">
            <option
              v-for="app in reusableApps"
              :key="app.appId"
              :value="app.appId"
            >
              {{ app.name }}
            </option>
          </datalist>
        </label>
        <template v-if="mode === 'import'">
          <div class="tabs" role="group" aria-label="凭据来源">
            <OmButton
              :variant="credentialSource === 'botmux' ? 'primary' : 'ghost'"
              @click="credentialSource = 'botmux'"
              >从 botmux 复用</OmButton
            >
            <OmButton
              :variant="credentialSource === 'manual' ? 'primary' : 'ghost'"
              @click="credentialSource = 'manual'"
              >手工输入</OmButton
            >
          </div>
          <label v-if="credentialSource === 'manual'">
            App Secret
            <input
              v-model="clientSecret"
              type="password"
              required
              autocomplete="new-password"
            />
            <small>仅本次请求使用；提交后立即从表单内存清除。</small>
          </label>
          <p v-else class="muted">
            只列出本机 botmux 配置中的 App ID 与名称；secret 不会返回浏览器。
          </p>
        </template>
        <div v-if="config" class="capability-summary">
          <div>
            <b>{{ config.addons.scopes.tenant.length }}</b
            ><small>应用权限</small>
          </div>
          <div>
            <b>{{ config.addons.scopes.user.length }}</b
            ><small>用户权限</small>
          </div>
          <div>
            <b>{{
              config.addons.events.items.tenant.length +
              config.addons.events.items.user.length
            }}</b
            ><small>事件订阅</small>
          </div>
          <div>
            <b>{{ config.addons.callbacks.items.length }}</b
            ><small>回调</small>
          </div>
        </div>
        <p class="muted">
          预留消息、文档、云盘、知识库、表格、日历、任务与会议能力；不申请批量消息、群成员管理、文档权限转移或日历
          ACL 删除。
        </p>
        <OmButton type="submit" variant="primary" :loading="busy">
          {{
            mode === "new"
              ? "生成创建授权"
              : mode === "update"
                ? "生成更新授权"
                : "导入并核验"
          }}
        </OmButton>
      </form>
    </OmPanel>

    <OmPanel v-if="onboarding" title="接入状态">
      <div class="row">
        <OmBadge :tone="statusTone(onboarding.status)">{{
          statusLabel[onboarding.status] || onboarding.status
        }}</OmBadge>
        <code>{{
          onboarding.appId || onboarding.requestedAppId || "等待平台返回 App ID"
        }}</code>
      </div>
      <div
        v-if="onboarding.resumable === false"
        class="failure-state"
        role="status"
      >
        <h3>这次授权需要重新配置</h3>
        <p>{{ onboarding.resumeHint }}</p>
        <OmButton @click="restartInterrupted">重新配置</OmButton>
      </div>
      <div v-else-if="needsQr" class="authorization-grid">
        <div class="qr-box">
          <QrcodeVue
            :value="onboarding.verificationUrl!"
            :size="220"
            level="M"
          />
          <small>二维码与授权链接进入同一次授权</small>
        </div>
        <div>
          <h3>
            {{
              onboarding.mode === "new"
                ? "创建并授权应用"
                : "确认已有应用的权限更新"
            }}
          </h3>
          <p>
            手机扫码，或在当前设备打开完整链接。两种方式进入同一次授权，不会重复创建。
          </p>
          <a
            class="authorization-link"
            :href="onboarding.verificationUrl!"
            target="_blank"
            rel="noopener noreferrer"
            >打开飞书授权页面</a
          >
          <small v-if="onboarding.qrExpiresAt"
            >链接有效至
            {{
              new Date(onboarding.qrExpiresAt).toLocaleString("zh-CN")
            }}</small
          >
        </div>
      </div>
      <div
        v-else-if="
          ['credentials_received', 'checking'].includes(onboarding.status)
        "
        class="checking-state"
        role="status"
      >
        <span aria-hidden="true">◌</span>
        <div>
          <b>正在核验实际权限与事件</b>
          <p>完成权限与消息接收能力核验后，才能进入本人配对。</p>
        </div>
      </div>
      <div
        v-else-if="onboarding.status === 'awaiting_pair'"
        class="pairing-state"
      >
        <h3>最后一步：确认本人身份</h3>
        <p>
          生成一次性配对码，私聊这个应用发送配对码。网页读回同一应用的发送者后再确认绑定。
        </p>
        <p v-if="onboarding.pairing?.expired" class="muted">
          配对码已过期，重新生成后再发送。
        </p>
        <p
          v-else-if="
            !pairingCode &&
            onboarding.pairing &&
            !onboarding.pairing.candidateOpenId
          "
          class="muted"
        >
          配对码不保存明文。若没有保留原来的码，可重新生成；同一接入会继续保留。
        </p>
        <OmButton
          v-if="
            (!pairingCode && !onboarding.pairing?.candidateOpenId) ||
            onboarding.pairing?.expired ||
            onboarding.pairing?.consumed
          "
          :loading="busy"
          @click="issuePairing"
          >{{ onboarding.pairing ? "重新生成配对码" : "生成配对码" }}</OmButton
        >
        <div
          v-if="
            pairingCode &&
            !onboarding.pairing?.expired &&
            !onboarding.pairing?.consumed
          "
          class="pairing-code"
          aria-label="配对码"
        >
          {{ pairingCode }}
        </div>
        <template
          v-if="
            onboarding.pairing?.candidateOpenId &&
            !onboarding.pairing.expired &&
            !onboarding.pairing.consumed
          "
        >
          <p>已经收到配对私聊。请确认这条消息由你本人发出，再启用连接。</p>
          <p class="candidate">
            已收到 {{ onboarding.pairing.candidateChatType }} 消息，候选
            本人身份：<code>{{ onboarding.pairing.candidateOpenId }}</code>
          </p>
          <OmButton variant="primary" :loading="busy" @click="confirmPairing"
            >确认这是我并启用</OmButton
          >
        </template>
        <p v-else-if="pairingCode" class="muted">
          等待同一应用收到这条私聊消息…
        </p>
      </div>
      <div v-else-if="onboarding.status === 'active'" class="success-state">
        <h3>机器人连接已启用</h3>
        <p>
          通知和待决定事项将发送给已绑定的本人。机器人加入群聊后会自动读取该群消息；移出群后自动停用采集。
        </p>
      </div>
      <div v-else-if="terminal" class="failure-state" role="alert">
        <h3>{{ statusLabel[onboarding.status] || "接入没有完成" }}</h3>
        <p>
          {{
            onboarding.errorMessage ||
            onboarding.errorCode ||
            "可重新发起，不会自动删除平台上可能已创建的应用。"
          }}
        </p>
        <p v-if="onboarding.missingCapabilities.length">
          缺少：{{ onboarding.missingCapabilities.join("、") }}
        </p>
      </div>
      <template #actions>
        <OmButton v-if="!terminal" @click="refreshOnboarding"
          >刷新状态</OmButton
        >
        <OmButton v-if="!terminal" @click="cancel">取消本次接入</OmButton>
        <OmButton v-if="terminal" @click="reset">{{
          onboarding.status === "active" ? "接入另一个应用" : "重新配置"
        }}</OmButton>
      </template>
    </OmPanel>

    <h2 class="stack">已有连接</h2>
    <OmPanel
      v-for="connection in connections"
      :key="connection.id"
      class="connection-row"
    >
      <div>
        <b>{{ connection.appId }}</b>
        <small
          >{{ connection.tenantBrand || "租户未知" }} · v{{
            connection.activeVersion || "—"
          }}</small
        >
      </div>
      <OmBadge :tone="statusTone(connection.state)">{{
        statusLabel[connection.state] || connection.state
      }}</OmBadge>
      <p v-if="connection.ownerOpenId">本人身份：{{ connection.ownerOpenId }}</p>
    </OmPanel>
    <OmEmpty
      v-if="!connections.length"
      title="尚无飞书连接"
      description="完成授权、权限核验和本人配对后，可在这里查看连接。"
    />
  </section>
</template>

<style scoped>
.capability-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.capability-summary div {
  padding: 14px;
  background: var(--om-soft);
  display: flex;
  flex-direction: column;
  border-radius: 6px;
}
.capability-summary b {
  font-size: 22px;
}
.authorization-grid {
  display: grid;
  grid-template-columns: 250px 1fr;
  gap: 28px;
  align-items: center;
  margin-top: 20px;
}
.qr-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  padding: 14px;
  border: 1px solid var(--om-line);
  background: white;
}
.authorization-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  margin: 8px 0 16px;
  padding: 0 16px;
  background: #222;
  color: white;
  border-radius: 6px;
  text-decoration: none;
}
.authorization-grid small {
  display: block;
  overflow-wrap: anywhere;
}
.checking-state,
.pairing-state,
.success-state,
.failure-state {
  padding: 20px;
  margin-top: 18px;
  background: var(--om-soft);
  border-radius: 6px;
}
.checking-state {
  display: flex;
  gap: 16px;
}
.checking-state > span {
  font-size: 28px;
}
.checking-state p,
.success-state p,
.failure-state p {
  margin-bottom: 0;
}
.pairing-code {
  margin: 14px 0;
  padding: 16px;
  background: #222;
  color: white;
  font: 16px/1.5 monospace;
  letter-spacing: 1px;
  overflow-wrap: anywhere;
  user-select: all;
}
.candidate code,
.connection-row code {
  overflow-wrap: anywhere;
}
.connection-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  margin-top: 12px;
}
.connection-row > div {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.connection-row p {
  grid-column: 1 / -1;
  margin: 0;
  overflow-wrap: anywhere;
}
.pending-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid var(--om-line);
}
.pending-row > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.pairing-state > .om-button {
  margin: 8px 0;
}
@media (max-width: 700px) {
  .capability-summary {
    grid-template-columns: 1fr 1fr;
  }
  .authorization-grid {
    grid-template-columns: 1fr;
  }
  .qr-box canvas {
    max-width: 100%;
    height: auto !important;
  }
}
</style>

<style scoped>
.lark-page-error {
  margin: 24px;
  padding: 16px;
  background: var(--om-soft);
  color: var(--om-secondary);
  line-height: 1.8;
}
</style>
