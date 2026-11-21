<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get, put } from "../api";
import { toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import { FULL_ACCESS, MODES, defaultLabel, fullAccessNote, grantLinks, sandboxBody, splitDefaults, tilde, type FullAccessMode, type SandboxMode, type SandboxSettings, type SandboxStatus } from "../lib/sandbox";
import { settingsContext } from "../views/settings/ctx";
import Icon from "./Icon.vue";
import MonoLine from "./MonoLine.vue";
import SandboxPaths from "./SandboxPaths.vue";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * 设置 → 安全 → 运行的沙箱 and 完全访问 (src/agents/own-run.ts `sandboxStatus`, own-sandbox.ts `runAccess`,
 * docs/v2/agent-accounts.md “本人的运行进沙箱”): whether the owner's runs on this machine go into a
 * sandbox that lets them read the home directory and write only the listed places, which directories
 * are added or hidden, and the one switch for turning off the backends' own sandbox and approvals.
 * Only the owner; the whole setting is saved at once (`PUT /api/security/sandbox`). A server without it
 * (404) shows nothing.
 */
const KEYS = ["agents.ownSandbox", "agents.fullAccess"];
const status = ref<SandboxStatus | null>(null);
const missing = ref(false);
const error = ref("");
const showState = ref(false);
const ctx = settingsContext();
const backendName = (id: string) => ctx?.profiles.value.find((p) => p.id === id)?.name ?? id;

async function load() {
  error.value = "";
  try {
    status.value = await get<SandboxStatus>("/api/security/sandbox");
  } catch (e) {
    if ((e as { status?: number }).status === 404) missing.value = true;
    else error.value = (e as Error).message;
  }
}
onMounted(load);

/** Sends the whole setting with one part changed; the server's refusal is returned, not shown here. */
async function send(change: Partial<SandboxSettings>): Promise<string | null> {
  if (!status.value) return "还没读到设置";
  try {
    status.value = await put<SandboxStatus>("/api/security/sandbox", sandboxBody(status.value, change));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
async function save(change: Partial<SandboxSettings>, note: string) {
  const refused = await send(change);
  if (refused) toast(`没有保存：${refused}`, "error");
  else toast(note, "ok");
}
const listSaver = (key: "writable" | "hidden") => async (next: string[]) => {
  const refused = await send({ [key]: next });
  if (!refused) toast(key === "writable" ? "可写目录已保存" : "藏起来的目录已保存", "ok");
  return refused;
};

async function setFullAccess(v: FullAccessMode) {
  if (v === "all" && !(await confirmDialog("完全访问全部开？", {
    message: "没进沙箱的运行也会关掉后端自己的沙箱和审批，命令不受任何限制；只读的角色和访客除外。omem 工具的授权和操作规则照常检查。",
    okText: "全部开", danger: true,
  }))) return;
  await save({ fullAccess: v }, `完全访问：${FULL_ACCESS.find((f) => f.value === v)?.label}`);
}

const home = computed(() => status.value?.home || null);
const grants = computed(() => grantLinks(status.value?.fullAccessGrants));
const data = computed(() => status.value?.defaults.hidden[0] ?? null);
const split = computed(() => (status.value ? splitDefaults(status.value) : { common: [], backends: [] }));
const off = computed(() => status.value?.mode === "off");
const note = computed(() => (status.value ? fullAccessNote(status.value) : ""));
</script>

<template>
  <template v-if="!missing">
    <SetCard id="set-sandbox" title="运行的沙箱" :keys="KEYS">
      <template #help>你的运行（也包括访客和借你登录的同事）在这台机器上进沙箱：能读你的主目录，只能写下面这些地方。成员用自己的账号时另有隔离；云端和借别的设备跑的不在这里。</template>
      <template v-if="status" #aside>
        <span class="badge" :class="status.support.ok ? 'ok' : 'warn'" :title="status.support.version ? `bubblewrap ${status.support.version}` : status.support.reason ?? ''">{{ status.support.ok ? "这台能用" : "这台用不了" }}</span>
      </template>
      <Skeleton v-if="!status && !error" :rows="3" />
      <div v-else-if="error" class="set-pad sbx-retry" role="alert"><span class="small">读不到沙箱设置：{{ error }}</span><button class="btn ghost sm" @click="load">重试</button></div>
      <template v-else-if="status">
        <p v-if="!status.support.ok" class="set-pad small warn-text">{{ status.support.reason || "这台机器不能隔离运行" }}。这里选的模式先存着，在这台不生效。</p>
        <SetRow label="进沙箱" :hint="MODES.find((m) => m.value === status!.mode)?.hint">
          <UiSegmented :model-value="status.mode" size="sm" aria-label="本人的运行进不进沙箱" :options="MODES.map((m) => ({ value: m.value, label: m.label, title: m.hint }))" @change="(v) => save({ mode: v as SandboxMode }, `沙箱：${MODES.find((m) => m.value === v)?.label}`)" />
        </SetRow>
        <SetRow label="默认可写" hint="进了沙箱的运行只能写这些地方，别处都只读" block :off="off">
          <ul class="sbx-list" aria-label="默认可写">
            <li v-for="p in split.common" :key="p" class="sbx-line">
              <template v-if="defaultLabel(p, data, home).path">
                <span class="sbx-named">{{ defaultLabel(p, data, home).text }}</span>
                <span class="sbx-aside" :title="p">{{ defaultLabel(p, data, home).path }}</span>
              </template>
              <MonoLine v-else :text="defaultLabel(p, data, home).text" />
            </li>
          </ul>
          <div v-if="split.backends.length" class="sbx-fold">
            <button type="button" class="lnk small" :aria-expanded="showState" aria-controls="sbx-state" @click="showState = !showState">
              <Icon :name="showState ? 'down' : 'right'" :size="13" />各后端的状态目录（{{ split.backends.length }} 个后端）
            </button>
            <div v-if="showState" id="sbx-state" class="sbx-state">
              <div v-for="b in split.backends" :key="b.id" class="sbx-backend">
                <span class="sbx-bname">{{ backendName(b.id) }}</span>
                <MonoLine v-for="p in b.state" :key="p" :text="tilde(p, home)" />
              </div>
            </div>
          </div>
        </SetRow>
        <SetRow label="默认藏起来" hint="沙箱里看到的是空目录；这一轮要用的部分会单独挂回去" block :off="off">
          <ul class="sbx-list" aria-label="默认藏起来">
            <li v-for="p in status.defaults.hidden" :key="p" class="sbx-line">
              <span class="sbx-named">omem 的数据目录</span>
              <span class="sbx-aside mono" :title="p">{{ tilde(p, home) }}</span>
            </li>
          </ul>
        </SetRow>
        <SetRow label="你加的可写目录" hint="命令写清单以外的地方会失败；命令行工具存登录凭据、缓存的目录要加在这里" block :off="off">
          <SandboxPaths :items="status.writable" :home="home" label="你加的可写目录" placeholder="~/build-cache" :save="listSaver('writable')" />
        </SetRow>
        <SetRow label="要藏起来的目录" hint="你主目录里不想让运行读到的，比如 ~/.ssh" block :off="off">
          <SandboxPaths :items="status.hidden" :home="home" label="要藏起来的目录" placeholder="~/private" :save="listSaver('hidden')" />
        </SetRow>
      </template>
    </SetCard>

    <SetCard v-if="status" id="set-full-access" title="完全访问" :keys="KEYS">
      <template #help>完全访问让后端关掉它自己的沙箱和审批，命令直接跑。omem 工具的授权和操作规则不受影响。</template>
      <SetRow label="哪些运行开" :hint="FULL_ACCESS.find((f) => f.value === status!.fullAccess)?.hint">
        <UiSegmented :model-value="status.fullAccess" size="sm" aria-label="完全访问" :options="FULL_ACCESS.map((f) => ({ value: f.value, label: f.label, title: f.hint }))" @change="(v) => setFullAccess(v as FullAccessMode)" />
      </SetRow>
      <p v-if="note" class="set-pad small muted">{{ note }}</p>
      <p v-if="status.warning" class="set-pad small warn-text">{{ status.warning }}</p>
      <SetRow v-if="status.fullAccess === 'per-role' && status.fullAccessGrants" label="单独开着的" block>
        <ul v-if="grants.length" class="sbx-list" aria-label="单独开着完全访问的">
          <li v-for="g in grants" :key="`${g.kind}:${g.id}`" class="sbx-line">
            <span class="sbx-named">{{ g.kind }}</span>
            <RouterLink :to="g.to" class="sbx-aside sbx-grant" :class="{ mono: g.kind === '内置角色' }" :title="g.title">{{ g.name }}</RouterLink>
          </li>
        </ul>
        <span v-else class="small muted">现在没有单独开着完全访问的内置角色、Agent 档案或规则。</span>
      </SetRow>
      <div class="set-link">
        <span>访客的完全访问另在</span>
        <RouterLink to="/settings?card=guests">访客</RouterLink>
        <span>里设。</span>
      </div>
    </SetCard>
  </template>
</template>
