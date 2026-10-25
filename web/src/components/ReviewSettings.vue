<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from "vue-router";
import { get, put } from "../api";
import Icon from "./Icon.vue";
import RuleConditions, { type Condition } from "./RuleConditions.vue";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { confirmDialog } from "../lib/dialog";
import { toast } from "../store";

/**
 * Agent page → 评审 (docs/v2/review.md): review tiers in matching order and the review checks.
 * A tier picks the checks for a change; a check is a built-in review role or an agent spec.
 * Everything is saved together (config.review).
 */
type Blocks = "blocker" | "major" | "minor";
type Tier = { id: string; name: string; when: Condition | null; guide: string; checks: string[]; maxRounds: number; lead: boolean; confirmPlan: boolean };
type Check = { name: string; label: string; blocks: Blocks; when: Condition | null; guide: string; builtin: boolean; about: string; missing: boolean; ai: { profile: string; model?: string; effort?: string } | null };
type Settings = { tiers: Tier[]; rereviewAllEvery: number; checks: Check[]; specs: { name: string; description: string }[]; recent: Record<string, number> };

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const saving = ref(false);
const dirty = ref(false);
const saved = ref<Settings | null>(null);
const tiers = ref<Tier[]>([]);
const checks = ref<Check[]>([]);
const rereviewAllEvery = ref(2);
const options = ref<{ fields: Record<string, string>; descriptions: Record<string, string>; ops: string[] }>({ fields: {}, descriptions: {}, ops: [] });
const NUMERIC = ["change.lines", "change.codeLines", "change.files", "change.repos"];
const fieldOps = Object.fromEntries(NUMERIC.map((f) => [f, ["gte", "lte", "equals"]]));

const tierId = computed(() => (typeof route.query.tier === "string" ? route.query.tier : null));
const checkName = computed(() => (typeof route.query.check === "string" ? route.query.check : null));
const adding = computed(() => route.query.add === "1");
const tier = computed(() => tiers.value.find((t) => t.id === tierId.value) ?? null);
const tierIndex = computed(() => tiers.value.findIndex((t) => t.id === tierId.value));
const check = computed(() => checks.value.find((c) => c.name === checkName.value) ?? null);
const labelOf = (name: string) => checks.value.find((c) => c.name === name)?.label ?? name;
const aiText = (c: Check) => (c.ai ? [c.ai.profile, c.ai.model, c.ai.effort].filter(Boolean).join(" · ") : "没有可用的后端");

function reset(s: Settings) {
  saved.value = s;
  tiers.value = JSON.parse(JSON.stringify(s.tiers));
  checks.value = JSON.parse(JSON.stringify(s.checks));
  rereviewAllEvery.value = s.rereviewAllEvery ?? 2;
  dirty.value = false;
}
async function load() {
  try {
    const [s, o] = await Promise.all([get<Settings>("/api/review-settings"), get<typeof options.value>("/api/review-options")]);
    options.value = o;
    reset(s);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    loading.value = false;
  }
}
onMounted(load);
const touch = () => (dirty.value = true);
const leave = async () => !dirty.value || (await confirmDialog("评审设置还没保存，放弃修改吗？", { okText: "放弃修改", danger: true }));
onBeforeRouteLeave(leave);
onBeforeRouteUpdate(async (to) => (to.query.tab === "review" ? true : leave()));
async function go(query: Record<string, string>) {
  await router.replace({ query: { tab: "review", ...query } });
}

async function save() {
  saving.value = true;
  try {
    const body = {
      tiers: tiers.value,
      rereviewAllEvery: rereviewAllEvery.value,
      checks: Object.fromEntries(checks.value.map((c) => [c.name, { label: c.label, blocks: c.blocks, when: c.when, guide: c.guide ?? "" }])),
    };
    await put("/api/review-settings", body);
    dirty.value = false;
    toast("评审设置已保存", "ok");
    reset(await get<Settings>("/api/review-settings"));
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}

// ---- tiers -----------------------------------------------------------------------------
function newTier() {
  let n = tiers.value.length + 1;
  while (tiers.value.some((t) => t.id === `tier-${n}`)) n++;
  const t: Tier = { id: `tier-${n}`, name: "新档位", when: { field: "change.lines", op: "gte", value: "200" } as Condition, guide: "", checks: ["reviewer"], maxRounds: 3, lead: true, confirmPlan: false };
  // New tiers go above the catch-all, which must stay last.
  tiers.value.splice(Math.max(0, tiers.value.length - 1), 0, t);
  touch();
  void go({ tier: t.id });
}
function moveUp() {
  const i = tierIndex.value;
  if (i <= 0 || i >= tiers.value.length - 1) return;
  [tiers.value[i - 1], tiers.value[i]] = [tiers.value[i], tiers.value[i - 1]];
  touch();
}
async function removeTier() {
  const t = tier.value;
  if (!t || tiers.value.length <= 1) return;
  if (!(await confirmDialog(`删除档位「${t.name}」？`, { message: "保存后生效；之后的改动按剩下的档位匹配。", okText: "删除", danger: true }))) return;
  tiers.value = tiers.value.filter((x) => x.id !== t.id);
  // The last tier is the catch-all.
  tiers.value[tiers.value.length - 1].when = null;
  tiers.value[tiers.value.length - 1].guide = "";
  touch();
  void go({});
}
function toggleCheck(t: Tier, name: string) {
  t.checks = t.checks.includes(name) ? t.checks.filter((c) => c !== name) : [...t.checks, name];
  touch();
}
const isLast = computed(() => tierIndex.value === tiers.value.length - 1);
const roundsPerTier = (t: Tier) => [t.checks.length > 1 ? `${t.checks.length} 项评审` : `只做${labelOf(t.checks[0] ?? "reviewer")}评审`, t.lead ? "负责人协调" : "", `最多 ${t.maxRounds} 轮`, t.confirmPlan ? "先给你看计划" : ""].filter(Boolean).join(" · ");

// ---- checks ----------------------------------------------------------------------------
const pick = ref<string | null>(null);
const newLabel = ref("");
async function addCheck() {
  const spec = saved.value?.specs.find((s) => s.name === pick.value);
  if (!spec || !newLabel.value.trim()) return toast("选一个档案并写一个简称", "error");
  checks.value.push({ name: spec.name, label: newLabel.value.trim(), blocks: "major", when: null, guide: "", builtin: false, about: spec.description, missing: false, ai: null });
  touch();
  pick.value = null;
  newLabel.value = "";
  await go({ check: spec.name });
}
function inTier(t: Tier, name: string) {
  return t.checks.includes(name);
}
function setInTier(t: Tier, name: string, on: boolean) {
  if (on === inTier(t, name)) return;
  if (!on && t.checks.length === 1) return toast(`「${t.name}」至少要有一项评审`, "error");
  toggleCheck(t, name);
}
async function removeCheck() {
  const c = check.value;
  if (!c || c.builtin) return;
  const used = tiers.value.filter((t) => t.checks.includes(c.name));
  if (used.some((t) => t.checks.length === 1)) return toast(`「${used.find((t) => t.checks.length === 1)!.name}」只剩这一项评审，先给它换一项`, "error");
  if (!(await confirmDialog(`不再把 ${c.name} 用作评审项？`, { message: "档案本身保留，只从各档位里移除。保存后生效。", okText: "移除", danger: true }))) return;
  for (const t of used) t.checks = t.checks.filter((x) => x !== c.name);
  checks.value = checks.value.filter((x) => x.name !== c.name);
  touch();
  void go({});
}
const profileLink = (c: Check) => (c.builtin ? { query: { tab: "agents", role: c.name } } : { query: { tab: "agents", name: c.name } });
const blockOptions = [{ value: "blocker", label: "阻断" }, { value: "major", label: "严重及以上" }, { value: "minor", label: "一般及以上" }];
const specOptions = computed(() => (saved.value?.specs ?? []).filter((s) => !checks.value.some((c) => c.name === s.name)).map((s) => ({ value: s.name as string | null, label: s.name, hint: s.description })));
</script>

<template>
  <div class="review">
    <aside class="list-col">
      <slot name="tabs" />
      <div class="items">
        <Skeleton v-if="loading" :rows="6" />
        <template v-else>
          <div class="group row"><span>档位</span><span class="spacer" /><span title="从上往下，第一个条件满足的档位生效">按顺序匹配</span></div>
          <button v-for="t in tiers" :key="t.id" class="li" :class="{ on: t.id === tierId }" @click="go({ tier: t.id })">
            <span class="grow"><strong>{{ t.name }}</strong><span class="muted small sub">{{ roundsPerTier(t) }}{{ t.when || t.guide ? "" : " · 其他情况都用它" }}{{ t.guide ? " · AI 判断" : "" }}</span></span>
          </button>
          <button class="li add" @click="newTier"><Icon name="plus" :size="14" />新建档位</button>

          <div class="group">评审项</div>
          <button v-for="c in checks" :key="c.name" class="li" :class="{ on: c.name === checkName }" @click="go({ check: c.name })">
            <span class="grow">
              <span class="row"><strong>{{ c.label }}</strong><span class="badge" :class="{ accent: !c.builtin, warn: c.missing }">{{ c.missing ? "档案不可用" : c.builtin ? "内置" : "专项" }}</span></span>
              <span class="muted small sub mono ellipsis">{{ c.name }} · {{ aiText(c) }}</span>
            </span>
          </button>
          <button class="li add" :class="{ on: adding }" @click="go({ add: '1' })"><Icon name="plus" :size="14" />加专项评审</button>
        </template>
      </div>
      <div v-if="dirty" class="savebar row">
        <span class="small">有未保存的修改</span><span class="spacer" />
        <button class="btn ghost sm" :disabled="saving" @click="saved && reset(saved)">撤销</button>
        <button class="btn primary sm" :disabled="saving" @click="save">保存</button>
      </div>
    </aside>

    <main class="detail">
      <div v-if="tier" class="page">
        <header class="row dh">
          <input v-model="tier.name" class="input title" maxlength="20" aria-label="档位名称" @input="touch" />
          <button v-if="tierIndex > 0 && !isLast" class="btn sm" :title="`先于「${tiers[tierIndex - 1].name}」匹配`" @click="moveUp">↑ 上移</button>
          <button class="btn sm primary" :disabled="saving || !dirty" @click="save">保存</button>
          <button v-if="tiers.length > 1" class="btn ghost sm icon danger" title="删除档位" aria-label="删除档位" @click="removeTier"><Icon name="trash" :size="14" /></button>
        </header>

        <section class="block">
          <div class="block-head"><h3>什么时候用</h3><span class="muted small">改动指标由 omem 在编码完成后算好</span></div>
          <p v-if="isLast" class="muted small">这是兜底档：上面的档位都没匹配上时用它，不设条件。要按条件分档，在它上面新建档位。</p>
          <template v-else>
            <RuleConditions v-model="tier.when" :fields="options.fields" :ops="options.ops" :descriptions="options.descriptions" :bool-fields="['change.checksPassed']" :field-ops="fieldOps" @update:model-value="touch" />
            <label class="field"><span>也可以用一句话说明（由 AI 判断）</span>
              <textarea v-model="tier.guide" class="input" rows="2" maxlength="2000" placeholder="例如：改到计费、对账、权限这类出错代价大的逻辑" @input="touch" /></label>
            <small class="muted">满足上面的条件就用这一档；条件不满足时，再请模型对照这句话看改动，符合就升到这一档。只写说明、不设条件也可以。</small>
          </template>
          <small class="muted">最近 30 次编码交办里有 {{ saved?.recent[tier.id] ?? 0 }} 次落在这一档。交办时说“用完整评审”会直接用指定的档位；同一次交办的后续轮次不会降档。</small>
        </section>

        <section class="block">
          <div class="block-head"><h3>做哪些评审</h3><span class="muted small">每项各开一个会话独立评审，可以用不同的模型</span></div>
          <div class="checks">
            <button v-for="c in checks" :key="c.name" class="check-card" :class="{ on: tier.checks.includes(c.name) }" :aria-pressed="tier.checks.includes(c.name)" @click="setInTier(tier, c.name, !tier.checks.includes(c.name))">
              <span class="row"><strong class="grow">{{ c.label }}</strong><span v-if="!c.builtin" class="badge accent">专项</span><span class="tick" aria-hidden="true"><Icon v-if="tier.checks.includes(c.name)" name="check" :size="11" /></span></span>
              <span class="small muted">{{ c.about || c.name }}</span>
            </button>
          </div>
        </section>

        <section class="block">
          <div class="block-head"><h3>怎么推进</h3></div>
          <div class="row opt"><span class="grow">由评审负责人协调<span class="muted small sub">合并重复的问题、逐条接受或驳回、写修改单，下一轮只复审受影响的评审项；修改不收敛、同一问题僵持或需求有分歧时停下来问你</span></span>
            <UiCheckbox v-model="tier.lead" switch aria-label="由评审负责人协调" @change="touch" /></div>
          <div class="row opt"><span class="grow">开始评审前先给我看计划<span class="muted small sub">编码完成后把档位、评审项和理由发给你，确认或换档后再评审</span></span>
            <UiCheckbox v-model="tier.confirmPlan" switch aria-label="开始评审前先给我看计划" @change="touch" /></div>
          <label class="row opt"><span class="grow">评审要求修改时，最多自动再改几轮<span class="muted small sub">到上限后停下来等你决定</span></span>
            <input v-model.number="tier.maxRounds" class="input num" type="number" min="1" max="10" inputmode="numeric" aria-label="最多轮数" @input="touch" /></label>
          <label v-if="tier.lead" class="row opt"><span class="grow">每隔几轮全部评审项重审一次<span class="muted small sub">防止只复审一部分时漏掉新问题；所有档位共用</span></span>
            <input v-model.number="rereviewAllEvery" class="input num" type="number" min="1" max="10" inputmode="numeric" aria-label="全部重审的间隔" @input="touch" /></label>
          <small class="muted">每轮 {{ tier.checks.length }} 个评审运行{{ tier.lead ? " + 1 个负责人运行" : "" }}。</small>
        </section>
      </div>

      <div v-else-if="check" class="page">
        <header class="row dh">
          <h2>{{ check.label }}</h2>
          <span class="badge" :class="{ accent: !check.builtin }">{{ check.builtin ? "内置" : "专项" }}</span>
          <span class="muted small mono">{{ check.name }}</span>
          <span class="spacer" />
          <router-link class="btn sm" :to="profileLink(check)">编辑提示词和默认 AI<Icon name="right" :size="13" /></router-link>
          <button class="btn sm primary" :disabled="saving || !dirty" @click="save">保存</button>
        </header>
        <p v-if="check.about" class="muted about">{{ check.about }}</p>
        <p v-if="check.missing" class="err small">档案不存在或还是草稿，评审时会跳过这一项。</p>

        <section class="block">
          <div class="block-head"><h3>简称</h3><span class="muted small">显示在评审结论和进度卡片上</span></div>
          <input v-model="check.label" class="input short" maxlength="12" aria-label="简称" @input="touch" />
        </section>

        <section class="block">
          <div class="block-head"><h3>用在哪些档位</h3></div>
          <div class="row wrap">
            <UiCheckbox v-for="t in tiers" :key="t.id" :model-value="inTier(t, check.name)" @change="(v) => setInTier(t, check!.name, v)">{{ t.name }}</UiCheckbox>
          </div>
        </section>

        <section class="block">
          <div class="block-head"><h3>额外在什么时候加上</h3><span class="muted small">不管落在哪个档位，满足就加进这次评审</span></div>
          <RuleConditions v-model="check.when" :fields="options.fields" :ops="options.ops" :descriptions="options.descriptions" :bool-fields="['change.checksPassed']" :field-ops="fieldOps" @update:model-value="touch" />
          <label class="field"><span>也可以用一句话说明（由 AI 判断）</span>
            <textarea v-model="check.guide" class="input" rows="2" maxlength="2000" placeholder="例如：改了数据库查询、循环里有网络或磁盘读写" @input="touch" /></label>
          <small class="muted">条件写不出来的情况写在这里：编码完成后请模型对照改动判断，符合就加上这项评审。</small>
        </section>

        <section class="block">
          <div class="block-head"><h3>什么级别的问题要求再改一轮</h3></div>
          <UiSegmented v-model="check.blocks" size="sm" :options="blockOptions" aria-label="阻塞级别" @change="touch" />
          <small class="muted">低于这一级的问题列在结论里，不要求编码 Agent 再改。</small>
        </section>

        <section class="block">
          <div class="block-head"><h3>默认 AI</h3><span class="muted small">在档案页修改</span></div>
          <div class="row wrap small"><span class="badge mono">{{ aiText(check) }}</span><span class="muted">评审时只能用只读工具，不能写文件、发消息或交办，不论档案平时怎么设</span></div>
        </section>

        <div v-if="!check.builtin" class="row"><button class="btn ghost sm danger" @click="removeCheck">不再用作评审项</button></div>
      </div>

      <div v-else-if="adding" class="page">
        <header class="row dh"><h2>加专项评审</h2></header>
        <p class="muted about">专项评审就是一个 Agent 档案：在档案里写清它只看什么（比如鉴权和越权、性能、数据迁移），这里把它挂成评审项，再选它用在哪些档位、什么改动时额外加上。</p>
        <section class="block">
          <div class="block-head"><h3>用哪个档案</h3></div>
          <div class="row wrap">
            <UiSelect v-model="pick" width="260px" :options="specOptions" placeholder="选择 Agent 档案" aria-label="档案" />
            <input v-model="newLabel" class="input short" maxlength="12" placeholder="简称，如：安全" aria-label="简称" />
            <button class="btn primary sm" :disabled="!pick || !newLabel.trim()" @click="addCheck">加上</button>
          </div>
          <small class="muted">没有合适的档案？<router-link :to="{ query: { tab: 'agents', new: '1' } }">新建 Agent 档案</router-link>，写好提示词后回到这里。</small>
        </section>
      </div>

      <div v-else-if="!loading" class="empty">
        <Icon name="check" :size="34" />
        <h3>评审</h3>
        <p>交办编码完成后，按改动大小选一个档位，档位决定做哪几项评审。每项评审各开一个会话独立进行，要求修改的问题汇总后交给编码 Agent 再改一轮。</p>
        <div class="row wrap center"><button class="btn" @click="go({ tier: tiers[0]?.id ?? '' })">看看档位</button><button class="btn ghost" @click="go({ add: '1' })">加专项评审</button></div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.review { display: flex; height: 100%; }
.list-col { width: 300px; flex: none; border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.items { overflow-y: auto; padding: 6px; flex: 1; }
.group { font-size: 11px; color: var(--muted); padding: 10px 10px 4px; letter-spacing: 0.04em; }
.li { display: flex; width: 100%; text-align: left; border: 0; background: none; padding: 8px 10px; border-radius: 8px; cursor: pointer; color: var(--ink); min-width: 0; gap: 8px; align-items: center; font: inherit; }
.li:hover { background: var(--hover); }
.li.on { background: var(--accent-soft); }
.li.add { color: var(--ink-2); font-size: 13px; }
.grow { flex: 1; min-width: 0; }
.sub { display: block; }
.savebar { padding: 10px 12px; border-top: 1px solid var(--line); background: var(--panel); }
.detail { flex: 1; min-width: 0; overflow-y: auto; }
.page { max-width: 880px; padding: 16px 24px 48px; display: grid; gap: 14px; margin: 0; }
.dh { gap: 10px; flex-wrap: wrap; }
.dh h2 { font-size: 18px; font-weight: 650; }
.title { flex: 1; min-width: 140px; font-size: 16px; font-weight: 600; }
.about { margin: 0; }
.err { color: var(--danger); margin: 0; }
.block { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; display: grid; gap: 10px; min-width: 0; }
.block-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.block-head h3 { margin: 0; font-size: 14px; }
.block > p { margin: 0; }
.block :deep(.ui-seg) { justify-self: start; }
.checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.check-card { border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; display: grid; gap: 2px; cursor: pointer; background: var(--panel); text-align: left; font: inherit; color: var(--ink); }
.check-card:hover { border-color: var(--line-strong); }
.check-card.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.tick { width: 15px; height: 15px; border-radius: 4px; border: 1.5px solid var(--line-strong); display: inline-flex; align-items: center; justify-content: center; color: var(--accent-ink); flex: none; }
.check-card.on .tick { background: var(--accent); border-color: var(--accent); }
.opt { gap: 12px; }
.num { width: 72px; }
.short { max-width: 200px; }
.empty { max-width: 620px; margin: 50px auto; text-align: center; color: var(--ink-2); padding: 0 16px; display: grid; gap: 10px; justify-items: center; }
.center { justify-content: center; }
@media (max-width: 760px) {
  .review { flex-direction: column; }
  .list-col { width: 100%; max-height: 40vh; border-right: 0; border-bottom: 1px solid var(--line); }
  .page { padding: 12px 16px 32px; }
}
</style>
