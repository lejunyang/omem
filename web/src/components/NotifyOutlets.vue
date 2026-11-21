<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get, post, put } from "../api";
import { relTime, state, toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import { ASK_KINDS, URGENCY_OPTIONS, kindAllowed, ordinaryKind, outletMeta, outletSettings, withOutlet, type Outlet, type Urgency } from "../lib/outlets";
import { settingsContext } from "../views/settings/ctx";
import Icon from "./Icon.vue";
import SetCard from "./SetCard.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";

/**
 * 通知出口 (src/plugins/notifier.ts, docs/v2/plugins.md “加一个通知出口”): one row per outlet, this person's
 * own setting. The built-in web and Feishu only say whether they reach you; an outlet a plugin added can be
 * turned on, given the least urgency it gets, tried with a test, and (when it can carry questions) told
 * which kinds of question go there. Shown under 设置 → 通知与打扰 and on the account page.
 * A server without outlets (404) shows nothing.
 */
const props = defineProps<{ ownerName?: string }>();
const outlets = ref<Outlet[] | null>(null);
const missing = ref(false);
const error = ref("");
const open = ref<string | null>(null);
const owner = computed(() => !state.me || state.me.role === "owner");
const ctx = settingsContext();
const ownerName = computed(() => props.ownerName ?? ctx?.ownerName.value ?? "主人");
const plugins = computed(() => (outlets.value ?? []).filter((o) => !o.builtin));

async function load() {
  error.value = "";
  try {
    outlets.value = (await get<{ outlets: Outlet[] }>("/api/notify/outlets")).outlets;
  } catch (e) {
    if ((e as { status?: number }).status === 404) missing.value = true;
    else error.value = (e as Error).message;
  }
}
onMounted(load);

async function save(next: Outlet[], note: string) {
  const before = outlets.value;
  outlets.value = next;
  try {
    await put("/api/notify/outlets", { outlets: outletSettings(next) });
    toast(note, "ok");
  } catch (e) {
    outlets.value = before;
    const status = (e as { status?: number }).status;
    toast(status === 403 ? `没有保存：这类提问要${ownerName.value}为这个出口打开` : (e as Error).message, "error");
  }
}
const change = (o: Outlet, c: Parameters<typeof withOutlet>[2], note: string) => save(withOutlet(outlets.value!, o.id, c), note);

async function toggleKind(o: Outlet, kind: string, on: boolean) {
  const label = ASK_KINDS.find((k) => k.kind === kind)?.label ?? kind;
  if (on && !ordinaryKind(kind) && !(await confirmDialog(`让审批发到${o.name}？`, {
    message: `之后在${o.name}上点一下就能批准命令、工具或操作，和在网页里批准一样算数。只在你信任这个渠道、而且只有你自己能看到它时打开。`,
    okText: "发到这里",
  }))) return;
  const kinds = o.setting?.askKinds ?? [];
  await change(o, { askKinds: on ? [...new Set([...kinds, kind])] : kinds.filter((k) => k !== kind) }, on ? `${label}会发到${o.name}` : `${label}不再发到${o.name}`);
}

const testing = ref<string | null>(null);
async function test(o: Outlet) {
  testing.value = o.id;
  try {
    await post(`/api/notify/outlets/${encodeURIComponent(o.id)}/test`);
    toast(`已发一条测试到${o.name}`, "ok");
  } catch (e) {
    toast(`${o.name}没发出去：${(e as Error).message}`, "error");
  } finally {
    testing.value = null;
    void load();
  }
}
</script>

<template>
  <SetCard v-if="!missing" id="set-notify-outlets" title="通知出口">
    <template #help>通知和要你回答的问题除了网页，还能发到哪里。插件加的出口在这里打开，每个人各设各的。</template>
    <Skeleton v-if="!outlets && !error" variant="list" :rows="2" />
    <div v-else-if="error" class="set-pad row" role="alert"><span class="grow small">读不到通知出口：{{ error }}</span><button class="btn ghost sm" @click="load">重试</button></div>
    <div v-else class="ol-list">
      <div v-for="o in outlets" :key="o.id" class="ol" :class="{ open: open === o.id }">
        <div class="ol-row">
          <div class="ol-name">
            <span class="ol-title">{{ o.name }}</span>
            <span class="ol-meta">{{ outletMeta(o, relTime) }}</span>
            <span v-if="o.lastError" class="ol-err" :title="o.lastError">{{ o.lastError }}</span>
          </div>
          <span class="ol-state" :class="o.reachable.ok ? 'ok' : 'warn'" :title="o.reachable.hint ?? ''">{{ o.reachable.ok ? "能送达" : "送不到" }}</span>
          <template v-if="!o.builtin">
            <UiSelect v-if="o.setting" :model-value="o.setting.minUrgency" size="sm" width="132px" :aria-label="`${o.name}最低紧急程度`" :options="URGENCY_OPTIONS" @change="(v) => change(o, { minUrgency: v as Urgency }, `${o.name}：${URGENCY_OPTIONS.find((u) => u.value === v)?.label}`)" />
            <button class="btn ghost sm" :disabled="testing === o.id" @click="test(o)">发一条测试</button>
            <UiCheckbox :model-value="!!o.setting" switch :aria-label="`发到${o.name}`" @change="(v) => change(o, { on: v }, v ? `已打开${o.name}` : `已关掉${o.name}`)" />
          </template>
          <button v-if="!o.builtin && (o.supportsAsk || !o.reachable.ok)" type="button" class="btn ghost sm icon ol-more" :aria-expanded="open === o.id" :aria-label="`${o.name}的更多设置`" @click="open = open === o.id ? null : o.id"><Icon name="down" :size="14" /></button>
          <span v-else-if="!o.builtin" class="ol-more-gap" aria-hidden="true" />
        </div>
        <div v-if="open === o.id" class="ol-body small">
          <p v-if="!o.reachable.ok" class="warn-text">{{ o.reachable.hint || "这个出口现在送不到你" }}</p>
          <template v-if="o.supportsAsk">
            <div class="ol-k muted">哪些问题发到这里</div>
            <div class="ol-kinds">
              <span v-for="k in ASK_KINDS" :key="k.kind" class="ol-kind" :title="k.hint">
                <UiCheckbox
                  size="sm"
                  :model-value="!!o.setting?.askKinds.includes(k.kind)"
                  :disabled="!o.setting || !kindAllowed(o, k.kind, owner)"
                  @change="(v) => toggleKind(o, k.kind, v)"
                >{{ k.label }}</UiCheckbox>
                <span v-if="o.setting && !kindAllowed(o, k.kind, owner)" class="muted">要{{ ownerName }}为这个出口打开</span>
              </span>
            </div>
            <p v-if="!o.setting" class="muted">先打开这个出口。</p>
          </template>
        </div>
      </div>
      <p v-if="!plugins.length" class="set-pad small muted">还没有插件加通知出口：上面是内置的两处。</p>
    </div>
  </SetCard>
</template>

<style scoped>
.ol-list {
  display: grid;
}
.ol {
  border-top: 1px solid var(--line);
  padding: 0 18px;
  min-width: 0;
}
.ol-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  min-width: 0;
}
.ol-name {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 2px;
}
.ol-title {
  font-size: 14px;
}
.ol-meta {
  font-size: 12px;
  color: var(--muted);
}
.ol-err {
  font-size: 12px;
  color: var(--danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ol-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--ink-2);
  white-space: nowrap;
}
.ol-state::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
}
.ol-state.warn::before {
  background: var(--warn);
}
.ol-more-gap {
  width: 30px;
  flex: none;
}
.ol.open .ol-more :deep(svg) {
  transform: rotate(180deg);
}
.ol-body {
  display: grid;
  gap: 8px;
  padding: 0 0 12px;
}
.ol-kinds {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
}
.ol-kind {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.grow {
  flex: 1;
  min-width: 0;
}
@media (max-width: 760px) {
  .ol-row {
    flex-wrap: wrap;
  }
  .ol-name {
    flex-basis: 100%;
  }
}
</style>
