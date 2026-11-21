<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get } from "../api";
import { fmtTime } from "../store";
import Icon from "./Icon.vue";
import SetCard from "./SetCard.vue";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * 设置 → 安全 → 记录 (src/auth/audit-view.ts): what the operation rules stopped, asked about or let
 * through and who approved; what went out in the owner's name; changes to people and logins. The
 * server words each row; a row opens to what was recorded as is (the owner only).
 */
type Group = "ops" | "identity" | "access" | "other";
type Row = {
  id: number; at: string; action: string; group: Group; actor: string; text: string; target: string;
  result: string | null; tone: "ok" | "warn" | "danger" | null; runId: string | null; rule: string | null; detail: Record<string, unknown>;
};
const FILTERS: { value: Group | "all"; label: string }[] = [
  { value: "all", label: "全部" }, { value: "ops", label: "拦下与批准" }, { value: "identity", label: "以你的身份" }, { value: "access", label: "成员与登录" }, { value: "other", label: "其他" },
];
const group = ref<Group | "all">("all");
const rows = ref<Row[] | null>(null);
const more = ref(false), loading = ref(false), error = ref("");
const open = ref<number | null>(null);
let seq = 0;

async function load(reset: boolean) {
  const n = ++seq;
  loading.value = true;
  if (reset) open.value = null;
  try {
    const before = !reset && rows.value?.length ? rows.value[rows.value.length - 1].id : null;
    const q = new URLSearchParams({ limit: "30", ...(group.value !== "all" ? { group: group.value } : {}), ...(before ? { before: String(before) } : {}) });
    const r = await get<{ rows: Row[]; more: boolean }>(`/api/security/audit?${q}`);
    if (n !== seq) return;
    rows.value = reset ? r.rows : [...(rows.value ?? []), ...r.rows];
    more.value = r.more;
    error.value = "";
  } catch (e) {
    if (n !== seq) return;
    rows.value ??= [];
    error.value = (e as Error).message;
  } finally {
    if (n === seq) loading.value = false;
  }
}
onMounted(() => load(true));

const hasDetail = (r: Row) => Object.keys(r.detail).length > 0;
/** One recorded value on one line. */
function shown(v: unknown) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}
</script>

<template>
  <SetCard id="set-trail" title="记录">
    <template #aside><UiSegmented v-model="group" size="sm" aria-label="看哪一类" :options="FILTERS" class="au-filter" @change="load(true)" /></template>
    <template #help>规则拦下、问过或放行了什么，谁批准的；以你的身份发出了什么；成员、登录和分享的变动。最新的在前，只增不改。点一行看当时记下的原样内容。</template>

    <p v-if="error" class="set-link" role="alert"><span class="grow">读不到记录：{{ error }}</span><button class="btn sm" @click="load(true)">重试</button></p>
    <div v-else-if="!rows" class="set-pad"><Skeleton variant="list" :rows="4" /></div>
    <p v-else-if="!rows.length" class="set-link muted">{{ group === "all" ? "还没有记录。" : "这一类还没有记录。" }}</p>

    <div v-for="r in rows ?? []" :key="r.id" class="au" :class="{ open: open === r.id }">
      <component :is="hasDetail(r) ? 'button' : 'div'" :type="hasDetail(r) ? 'button' : undefined" class="au-row" :aria-expanded="hasDetail(r) ? open === r.id : undefined" @click="hasDetail(r) && (open = open === r.id ? null : r.id)">
        <i class="au-dot" :class="r.tone ?? 'none'" aria-hidden="true" />
        <span class="au-main">
          <span class="au-line"><span class="au-text">{{ r.text }}</span><span v-if="r.target" class="au-target ellipsis" :class="{ mono: r.group === 'ops' }" :title="r.target">{{ r.target }}</span></span>
          <span v-if="r.result || r.rule" class="au-sub ellipsis" :title="r.result ?? undefined"><template v-if="r.rule">规则“{{ r.rule }}”</template><template v-if="r.rule && r.result"> · </template>{{ r.result }}</span>
        </span>
        <span class="au-meta">{{ r.actor }} · {{ fmtTime(r.at) }}</span>
      </component>
      <div v-if="open === r.id" class="au-body">
        <dl class="au-detail">
          <template v-for="(v, k) in r.detail" :key="k"><template v-if="v !== null && v !== ''"><dt>{{ k }}</dt><dd>{{ shown(v) }}</dd></template></template>
        </dl>
        <router-link v-if="r.runId" class="small" :to="`/runs/${r.runId}`">看这次运行<Icon name="right" :size="12" /></router-link>
      </div>
    </div>
    <p v-if="more" class="set-link au-more"><button class="btn ghost sm" :disabled="loading" @click="load(false)">{{ loading ? "正在读…" : "更早的" }}</button></p>
  </SetCard>
</template>

<style scoped>
.grow { flex: 1; min-width: 0; }
.au { border-top: 1px solid var(--line); min-width: 0; }
.au-row {
  display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: baseline; gap: 4px 12px;
  width: 100%; padding: 9px 20px 9px 18px; border: 0; background: none; font: inherit; text-align: left; color: var(--ink); min-width: 0;
}
button.au-row { cursor: pointer; }
button.au-row:hover { background: var(--hover, var(--sunken)); }
.au-dot { width: 7px; height: 7px; border-radius: 50%; align-self: start; margin-top: 8px; background: var(--line-strong); }
.au-dot.ok { background: var(--ok); }
.au-dot.warn { background: var(--warn); }
.au-dot.danger { background: var(--danger); }
.au-main { display: grid; gap: 1px; min-width: 0; }
.au-line { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.au-text { flex: none; font-size: 14px; }
.au-target { min-width: 0; font-size: 13px; color: var(--ink-2); }
.au-target.mono { font-family: var(--mono); font-size: 12.5px; }
.au-sub { font-size: 12.5px; color: var(--muted); }
.au-meta { font-size: 12px; color: var(--muted); white-space: nowrap; }
.au-body { display: grid; gap: 8px; padding: 2px 20px 12px 38px; min-width: 0; }
.au-detail { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 14px; margin: 0; font-size: 12.5px; }
.au-detail dt { color: var(--muted); font-family: var(--mono); font-size: 12px; }
.au-detail dd { margin: 0; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.au-more { justify-content: center; }
@media (max-width: 640px) {
  .au-row { grid-template-columns: 8px minmax(0, 1fr); padding: 9px 14px; }
  .au-meta { grid-column: 2; }
  .au-line { flex-wrap: wrap; gap: 0 10px; }
  .au-body { padding: 2px 14px 12px 34px; }
  .au-filter { max-width: 100%; overflow-x: auto; }
}
</style>
