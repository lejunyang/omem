<script setup lang="ts">
import { toast } from "../../store";
import { useSettings } from "./ctx";
import FlowSettings from "../../components/FlowSettings.vue";
import ItemSyncSettings from "../../components/ItemSyncSettings.vue";
import SetCard from "../../components/SetCard.vue";
import SetRow from "../../components/SetRow.vue";
import Skeleton from "../../components/Skeleton.vue";
import UiCheckbox from "../../components/UiCheckbox.vue";
import UiSegmented from "../../components/UiSegmented.vue";

/**
 * 设置 → 助手 → 推进工作: how far the assistant goes on without the owner (auto-advance, flows following
 * their chats and gates, commits made by hand, design first, where studies run) and when items close themselves.
 */
const { config, load, saveConfig } = useSettings();

async function saveAutoAdvance(key: "turns" | "codeRounds", raw: string) {
  const [min, max, fallback] = key === "turns" ? [0, 50, 6] : [1, 20, 3];
  const n = Number(raw);
  const v = Number.isFinite(n) && raw.trim() !== "" ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  const cur = config.value.agents.autoAdvance ?? { turns: 6, codeRounds: 3 };
  await saveConfig({ agents: { ...config.value.agents, autoAdvance: { ...cur, [key]: v } } }, key === "turns" ? `多 Agent 自动推进最多 ${v} 次` : `编码交办自动推进到第 ${v} 轮`);
  void load();
}
async function saveFlows(key: "autoAdvance" | "staleDays", raw: string) {
  const [max, fallback] = key === "autoAdvance" ? [20, 3] : [365, 2];
  const n = Number(raw);
  const v = Number.isFinite(n) && raw.trim() !== "" ? Math.max(1, Math.min(max, Math.round(n))) : fallback;
  await saveConfig({ flows: { ...(config.value.flows ?? {}), [key]: v } }, key === "autoAdvance" ? `流程连着自己开始 ${v} 段后先问你` : `停在等你的阶段 ${v} 天后提醒`);
  void load();
}
async function savePreCheck(v: boolean) {
  const cur = config.value.agents.autoAdvance ?? { turns: 6, codeRounds: 3 };
  await saveConfig({ agents: { ...config.value.agents, autoAdvance: { ...cur, preCheck: v } } }, v ? "新交办开始编码前先做检查" : "新交办直接开始编码");
  void load();
}
/** agents.design (docs/v2/coding-plan.md §3): whether delegations write a design first, and who confirms it. */
async function saveDesign(patch: { mode?: string; confirm?: string }) {
  const cur = config.value.agents.design ?? { mode: "auto", confirm: "owner" };
  const next = { ...cur, ...patch };
  await saveConfig({ agents: { ...config.value.agents, design: next } }, patch.mode ? `方案先行：${({ auto: "按编码前检查的判断", always: "每次交办都先写方案", never: "不写方案" } as Record<string, string>)[next.mode]}` : next.confirm === "assistant" ? "没有要你定的问题时由助手确认方案" : "方案都由你确认");
  void load();
}
const itemKinds = [["todo", "待办"], ["decision", "待决定"], ["watch", "关注"], ["waiting", "等待回复"], ["reminder", "提醒过后"]] as const;
async function saveItems(patch: Record<string, unknown>) {
  await saveConfig({ items: { ...config.value.items, ...patch } }, "已保存事项收尾设置");
}
async function saveItemDays(kind: string, raw: string) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > 365) return toast("天数要在 1 到 365 之间", "error");
  await saveItems({ days: { ...config.value.items.days, [kind]: n } });
}
</script>

<template>
  <Skeleton v-if="!config" :rows="6" />
  <div v-else class="stack">
    <SetCard id="set-auto-advance" title="自动推进">
      <template #help>没等你回复时，助理最多替你往下推几步。到上限后它会汇报进展、问你是否继续；你回一句“继续”，计数重新开始。</template>
      <SetRow label="多 Agent 工作最多自动交办几次" hint="从你上次说话算起，0–50；0 表示每轮都先问你">
        <input class="input set-num" type="number" inputmode="numeric" min="0" max="50" aria-label="多 Agent 工作最多自动交办几次" :value="config.agents.autoAdvance?.turns ?? 6" @change="saveAutoAdvance('turns', ($event.target as HTMLInputElement).value)" />
      </SetRow>
      <SetRow label="编码交办自动改到第几轮" hint="评审要求修改时，1–20">
        <input class="input set-num" type="number" inputmode="numeric" min="1" max="20" aria-label="编码交办自动改到第几轮" :value="config.agents.autoAdvance?.codeRounds ?? 3" @change="saveAutoAdvance('codeRounds', ($event.target as HTMLInputElement).value)" />
      </SetRow>
      <SetRow label="流程连着自己开始几段后先问你" hint="没有人参与时，1–20">
        <input class="input set-num" type="number" inputmode="numeric" min="1" max="20" aria-label="流程连着自己开始几段后先问你" :value="config.flows?.autoAdvance ?? 3" @change="saveFlows('autoAdvance', ($event.target as HTMLInputElement).value)" />
      </SetRow>
      <SetRow label="流程停在等你的阶段，几天后提醒" hint="1–365，之后每次间隔加倍">
        <input class="input set-num" type="number" inputmode="numeric" min="1" max="365" aria-label="停在等你的阶段过几天提醒" :value="config.flows?.staleDays ?? 2" @change="saveFlows('staleDays', ($event.target as HTMLInputElement).value)" />
      </SetRow>
      <SetRow label="编码前检查" hint="新交办开始编码前，先查会碰到什么、以前出过什么问题、改完要回归什么">
        <UiCheckbox :model-value="config.agents.autoAdvance?.preCheck !== false" switch aria-label="编码前检查" @change="savePreCheck" />
      </SetRow>
    </SetCard>

    <FlowSettings :flows="config.flows" :studies="config.studies" @save="(partial, note) => saveConfig(partial, note).then(() => load())" />

    <SetCard id="set-design" title="方案先行">
      <template #help>值得的交办在编码前先写一份方案：几个决定，每个说清改什么、为什么、不选什么，有要你定的就问你。你确认后编码 Agent 照它做，评审也对照它看。写方案的是角色“写方案”，在 Agent 页给它选最强的模型。仓库空间的设置里也可以让某个仓库总是先写；你对助手说“不用方案，直接改”时这次不写。</template>
      <SetRow label="什么时候先写方案">
        <template #hint>{{ (config.agents.design?.mode ?? 'auto') === 'auto' ? "要改现有分工或接口、有两种以上说得通的做法、或要求重构时" : config.agents.design?.mode === 'always' ? "每次交办都先写" : "都不写" }}</template>
        <UiSegmented :model-value="config.agents.design?.mode ?? 'auto'" size="sm" aria-label="什么时候先写方案" :options="[{ value: 'auto', label: '自动' }, { value: 'always', label: '总是' }, { value: 'never', label: '从不' }]" @change="(v) => saveDesign({ mode: v })" />
      </SetRow>
      <SetRow label="谁来确认">
        <UiSegmented :model-value="config.agents.design?.confirm ?? 'owner'" size="sm" aria-label="谁来确认方案" :options="[{ value: 'owner', label: '我确认' }, { value: 'assistant', label: '没有要我定的就由助手确认' }]" @change="(v) => saveDesign({ confirm: v })" />
      </SetRow>
    </SetCard>

    <SetCard v-if="config.items" id="set-item-expiry" title="事项自动收尾">
      <template #help>做完的事不用回来点完成。一件事项在下面的天数里没有新进展（你改动它、或有新的材料记进来），就标为“过期”；截止或提醒时间还没到的不会过期，提醒在时间过后一天过期。过期不算完成，有新进展会自动重新打开。每天的“事项清点”卡片里可以逐条保留或恢复。</template>
      <SetRow label="没有进展的事项按期限自动过期">
        <UiCheckbox :model-value="config.items.expiry" switch aria-label="没有进展的事项按期限自动过期" @change="(v) => saveItems({ expiry: v })" />
      </SetRow>
      <SetRow v-if="config.items.expiry" label="多少天没进展算过期" block>
        <div class="days">
          <label v-for="[k, l] in itemKinds" :key="k" class="day">
            <span class="small muted">{{ l }}</span>
            <span class="day-in"><input class="input set-num" type="number" inputmode="numeric" min="1" max="365" :aria-label="`${l}（天）`" :value="config.items.days[k]" @change="saveItemDays(k, ($event.target as HTMLInputElement).value)" /><span class="small muted">天</span></span>
          </label>
        </div>
      </SetRow>
      <SetRow label="你回过话的交给助理判断是否已办" hint="在来源会话里回过话、回了表情的事项；DONE 表情直接关">
        <UiCheckbox :model-value="config.items.infer" switch aria-label="你回过话的事项交给助理判断是否已办" @change="(v) => saveItems({ infer: v })" />
      </SetRow>
    </SetCard>

    <ItemSyncSettings />
  </div>
</template>

<style scoped>
.days {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
}
.day {
  display: grid;
  gap: 4px;
}
.day-in {
  display: flex;
  align-items: center;
  gap: 4px;
}
.day-in .set-num.input {
  width: 64px;
}
</style>
