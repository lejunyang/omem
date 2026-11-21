<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
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
 *
 * `user`: someone else's outlets, opened from their row in 设置 → 成员 (the owner, or whoever manages
 * members: `GET /api/notify/outlets?user=`): the same list without its card and without the test (it
 * goes to the person asking). When the owner ticks an approval there, that also opens it for them.
 */
const props = defineProps<{ ownerName?: string; user?: string; userName?: string }>();
const outlets = ref<Outlet[] | null>(null);
const missing = ref(false);
const error = ref("");
const open = ref<string | null>(null);
const owner = computed(() => !state.me || state.me.role === "owner");
const ctx = settingsContext();
const ownerName = computed(() => props.ownerName ?? ctx?.ownerName.value ?? state.me?.ownerName ?? "主人");
const plugins = computed(() => (outlets.value ?? []).filter((o) => !o.builtin));
/** Whose outlets these are, in a sentence: “你” or the member's name. */
const whose = computed(() => (props.user ? props.userName ?? "他" : "你"));
const path = computed(() => (props.user ? `/api/notify/outlets?user=${encodeURIComponent(props.user)}` : "/api/notify/outlets"));

async function load() {
  error.value = "";
  try {
    outlets.value = (await get<{ outlets: Outlet[] }>(path.value)).outlets;
  } catch (e) {
    if ((e as { status?: number }).status === 404 && !props.user) missing.value = true;
    else error.value = (e as Error).message;
  }
}
onMounted(load);
watch(path, () => {
  outlets.value = null;
  void load();
});

async function save(next: Outlet[], note: string) {
  const before = outlets.value;
  outlets.value = next;
  try {
    await put("/api/notify/outlets", props.user ? { userId: props.user, outlets: outletSettings(next) } : { outlets: outletSettings(next) });
    toast(note, "ok");
    // The owner's save also changes what is opened for this person: read it back.
    if (props.user) void load();
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
    message: props.user
      ? `${whose.value}之后在${o.name}上点一下就能批准命令、工具或操作，和在网页里批准一样算数。只在这个渠道可信、而且只有${whose.value}自己能看到它时打开。`
      : `之后在${o.name}上点一下就能批准命令、工具或操作，和在网页里批准一样算数。只在你信任这个渠道、而且只有你自己能看到它时打开。`,
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
  <component :is="user ? 'div' : SetCard" v-if="!missing" v-bind="user ? { class: 'ol-embed' } : { id: 'set-notify-outlets', title: '通知出口' }">
    <template v-if="!user" #help>通知和要你回答的问题除了网页，还能发到哪里。插件加的出口在这里打开，每个人各设各的。</template>
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
            <button v-if="!user" class="btn ghost sm" :disabled="testing === o.id" @click="test(o)">发一条测试</button>
            <UiCheckbox :model-value="!!o.setting" switch :aria-label="user ? `发到${whose}的${o.name}` : `发到${o.name}`" @change="(v) => change(o, { on: v }, v ? (user ? `已替${whose}打开${o.name}` : `已打开${o.name}`) : `已关掉${o.name}`)" />
          </template>
          <button v-if="!o.builtin && (o.supportsAsk || !o.reachable.ok)" type="button" class="btn ghost sm icon ol-more" :aria-expanded="open === o.id" :aria-label="`${o.name}的更多设置`" @click="open = open === o.id ? null : o.id"><Icon name="down" :size="14" /></button>
          <span v-else-if="!o.builtin" class="ol-more-gap" aria-hidden="true" />
        </div>
        <div v-if="open === o.id" class="ol-body small">
          <p v-if="!o.reachable.ok" class="warn-text">{{ o.reachable.hint || `这个出口现在送不到${whose}` }}</p>
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
  </component>
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
/* In a member's row (设置 → 成员): no card around it, the rows flush with the row's own lines. */
.ol-embed .ol {
  padding: 0;
}
.ol-embed .ol:first-child {
  border-top: 0;
}
.ol-embed .set-pad {
  padding-left: 0;
  padding-right: 0;
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
