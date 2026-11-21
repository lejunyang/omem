<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get, post } from "../api";
import { toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import { actionLabel, cleanScope, matchText, scopeText, type PackRule, type RulePack, type Scope, type SelectOption } from "../lib/operation-rules";
import Icon from "./Icon.vue";
import OperationScope from "./OperationScope.vue";
import SetCard from "./SetCard.vue";
import Skeleton from "./Skeleton.vue";

/**
 * 设置 → 安全 → 规则包 (src/agents/rule-packs.ts): ready-made rules a plugin or skill brings. Listed
 * only; they apply once the owner enables one with a scope. A newer version shows what changes and is
 * swapped in only when the owner confirms that exact difference (the `confirmation` goes back as is).
 */
const props = defineProps<{ backends: SelectOption<string>[]; blocked: boolean }>();
const emit = defineEmits<{ changed: [] }>();

const packs = ref<RulePack[] | null>(null);
const error = ref("");
const open = ref<string | null>(null);
const scopes = ref<Record<string, Scope>>({});
const busy = ref<string | null>(null);

async function load() {
  error.value = "";
  try {
    packs.value = (await get<{ packs: RulePack[] }>("/api/security/rule-packs")).packs;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);

const nameOf = (p: RulePack) => p.name || p.source.name;
const sourceOf = (p: RulePack) => `${p.source.type === "plugin" ? "插件" : "技能"} ${p.source.name}`;
const changes = (p: RulePack) => (p.diff ? p.diff.added.length + p.diff.removed.length + p.diff.changed.length + (p.diff.order ? 1 : 0) : 0);
const hasUpdate = (p: RulePack) => p.enabled && !!p.confirmation && (p.installedVersion !== p.version || changes(p) > 0);
function status(p: RulePack): { text: string; cls: string } {
  if (!p.confirmation) return { text: p.enabled ? `已启用 · ${p.error ?? "读不到包"}` : `读不到 · ${p.error ?? ""}`, cls: "bad" };
  if (hasUpdate(p)) return { text: p.installedVersion !== p.version ? `有更新 · ${p.installedVersion} → ${p.version}` : "有更新", cls: "update" };
  if (p.enabled) return { text: `已启用 · ${scopeText(p.scope, props.backends).short}`, cls: "on" };
  return { text: "没启用", cls: "" };
}
function toggle(p: RulePack) {
  if (open.value === p.id) return void (open.value = null);
  open.value = p.id;
  scopes.value[p.id] = JSON.parse(JSON.stringify(p.scope ?? {}));
}

const ruleLine = (r: PackRule) => r.title || matchText(r.match);
/** What changed in one rule, in a few words. */
function changedText(c: { before: PackRule; after: PackRule }) {
  const parts: string[] = [];
  if (c.before.action !== c.after.action) parts.push(`处理 ${actionLabel(c.before.action)} → ${actionLabel(c.after.action)}`);
  if (JSON.stringify(c.before.match) !== JSON.stringify(c.after.match)) parts.push(`匹配 ${matchText(c.before.match)} → ${matchText(c.after.match)}`);
  if (JSON.stringify(c.before.approval ?? null) !== JSON.stringify(c.after.approval ?? null)) parts.push("批准的设置");
  if ((c.before.title ?? "") !== (c.after.title ?? "")) parts.push("说明");
  return parts.join("；") || "细节";
}

function guard() {
  if (!props.blocked) return true;
  toast("上面的操作规则还有没保存的改动：先保存或放弃，再改规则包", "error");
  return false;
}
async function enable(p: RulePack) {
  if (!guard() || !p.confirmation) return;
  busy.value = p.id;
  try {
    await post(`/api/security/rule-packs/${encodeURIComponent(p.id)}/enable`, { scope: cleanScope(scopes.value[p.id]) ?? {}, confirmation: p.confirmation });
    toast(hasUpdate(p) ? `已换成「${nameOf(p)}」${p.version}` : p.enabled ? "已改范围" : `已启用「${nameOf(p)}」`, "ok");
    open.value = null;
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = null;
    await load();
  }
}
async function disable(p: RulePack) {
  if (!guard()) return;
  if (!(await confirmDialog(`停用「${nameOf(p)}」？`, { message: "它的规则会从上面的清单里去掉。之后可以再启用。", okText: "停用", danger: true }))) return;
  busy.value = p.id;
  try {
    await post(`/api/security/rule-packs/${encodeURIComponent(p.id)}/disable`, {});
    toast(`已停用「${nameOf(p)}」`, "ok");
    open.value = null;
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = null;
    await load();
  }
}
</script>

<template>
  <SetCard id="set-rule-packs" title="规则包">
    <template #help>插件或技能可以带一组现成的规则（比如某个命令行工具的写操作清单）。这里只列出来，你选好范围启用后才生效；包更新了先看差异，确认后才换。安装插件或技能本身不会放行任何操作。</template>

    <p v-if="error" class="set-link" role="alert"><span class="grow">读不到规则包：{{ error }}</span><button class="btn sm" @click="load">重试</button></p>
    <div v-else-if="!packs" class="set-pad"><Skeleton variant="list" :rows="2" /></div>
    <p v-else-if="!packs.length" class="set-link muted">规则包随插件或技能提供，这里列出能启用的；现在还没有。</p>

    <div v-for="p in packs ?? []" :key="p.id" class="pk" :class="{ open: open === p.id }">
      <button type="button" class="pk-row" :aria-expanded="open === p.id" @click="toggle(p)">
        <span class="pk-main">
          <span class="pk-name ellipsis">{{ nameOf(p) }}</span>
          <span class="pk-meta ellipsis">{{ sourceOf(p) }} · {{ p.ruleCount }} 条{{ p.version ? ` · 版本 ${p.version}` : "" }}</span>
        </span>
        <span class="pk-status" :class="status(p).cls" :title="status(p).text">{{ status(p).text }}</span>
        <Icon name="right" :size="14" class="chev" />
      </button>

      <div v-if="open === p.id" class="pk-body">
        <template v-if="hasUpdate(p) && p.diff">
          <div class="field">
            <span>新版改了什么</span>
            <ul class="pk-diff">
              <li v-for="r in p.diff.added" :key="`a-${r.id}`"><span class="tag add">新增</span><span class="ellipsis" :title="matchText(r.match)">{{ ruleLine(r) }} · {{ actionLabel(r.action) }}</span></li>
              <li v-for="r in p.diff.removed" :key="`r-${r.id}`"><span class="tag del">去掉</span><span class="ellipsis" :title="matchText(r.match)">{{ ruleLine(r) }}</span></li>
              <li v-for="c in p.diff.changed" :key="`c-${c.after.id}`"><span class="tag">改了</span><span class="ellipsis" :title="changedText(c)">{{ ruleLine(c.after) }}：{{ changedText(c) }}</span></li>
              <li v-if="p.diff.order"><span class="tag">顺序</span><span>包内规则的先后变了</span></li>
              <li v-if="!changes(p)"><span class="tag">版本</span><span>规则没变，只是版本号从 {{ p.installedVersion }} 变成 {{ p.version }}</span></li>
            </ul>
          </div>
        </template>
        <template v-else-if="!p.enabled && p.diff">
          <div class="field">
            <span>包里的规则</span>
            <ul class="pk-diff">
              <li v-for="r in p.diff.added" :key="r.id"><span class="ellipsis" :title="matchText(r.match)">{{ ruleLine(r) }} · {{ actionLabel(r.action) }}</span></li>
            </ul>
          </div>
        </template>
        <p v-if="!p.confirmation" class="small muted">{{ p.error }}：{{ p.enabled ? "已启用的规则照旧生效，可以停用。" : "修好包文件后才能启用。" }}</p>

        <div v-if="p.confirmation" class="field">
          <span>对谁生效</span>
          <OperationScope v-model="scopes[p.id]" :backends="backends" />
          <span class="hint">都不选就是所有人</span>
        </div>
        <div class="pk-foot">
          <button v-if="p.enabled" class="btn ghost sm danger" :disabled="busy === p.id" @click="disable(p)">停用</button>
          <span class="grow" />
          <button v-if="p.confirmation" class="btn primary sm" :disabled="busy === p.id" @click="enable(p)">{{ hasUpdate(p) ? "换成新版" : p.enabled ? "改范围" : "启用" }}</button>
        </div>
      </div>
    </div>
  </SetCard>
</template>

<style scoped>
.grow {
  flex: 1;
  min-width: 0;
}
.pk {
  border-top: 1px solid var(--line);
  min-width: 0;
}
.pk-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 20px 10px 18px;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  color: var(--ink);
  cursor: pointer;
  min-width: 0;
}
.pk-main {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.pk-name {
  font-size: 14px;
}
.pk-meta {
  font-size: 12px;
  color: var(--muted);
}
.pk-status {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--muted);
}
.pk-status.on {
  color: var(--ok);
}
.pk-status.update {
  color: var(--warn);
}
.pk-status.bad {
  color: var(--danger);
}
.chev {
  color: var(--muted);
  transition: transform 0.15s ease;
}
.pk.open .chev {
  transform: rotate(90deg);
}
.pk-body {
  display: grid;
  gap: 16px;
  padding: 4px 18px 16px;
  min-width: 0;
}
.pk-body > p {
  margin: 0;
}
.pk-diff {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
  color: var(--ink-2);
  min-width: 0;
}
.pk-diff li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.tag {
  flex: none;
  width: 3em;
  font-size: 12px;
  color: var(--muted);
}
.tag.add {
  color: var(--ok);
}
.tag.del {
  color: var(--danger);
}
.pk-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
@media (max-width: 640px) {
  .pk-row {
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 10px 14px;
  }
  .pk-status {
    grid-row: 2;
    grid-column: 1;
    max-width: none;
  }
  .chev {
    grid-row: 1 / span 2;
    grid-column: 2;
  }
  .pk-body {
    padding-left: 14px;
    padding-right: 14px;
  }
}
</style>
