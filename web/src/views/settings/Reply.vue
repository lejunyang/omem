<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get } from "../../api";
import { state } from "../../store";
import { intIn, useSettings } from "./ctx";
import DoubaoSendStatus from "../../components/DoubaoSendStatus.vue";
import HelpText from "../../components/HelpText.vue";
import SetCard from "../../components/SetCard.vue";
import SetRow from "../../components/SetRow.vue";
import Skeleton from "../../components/Skeleton.vue";
import UiCheckbox from "../../components/UiCheckbox.vue";
import UiSegmented from "../../components/UiSegmented.vue";
import UiSelect from "../../components/UiSelect.vue";
import { FIRST_TO_EFFECT, firstLookOptions, type FirstLookOptions, type FirstTo } from "../../lib/first-look";

/**
 * 设置 → 助手 → 代你回复: someone looking for the owner (有人找你), people who are not users asking the bot,
 * commands in the owner's own private chats, adding people to chats, and checking replies before and after they go out.
 */
const { config, load, saveConfig } = useSettings();

// What became of the drafted replies to people who looked for the owner, and what the owner wrote themselves.
type ReplyStats = { samples: number; drafts: number; sent: number; edited: number; dropped: number; ownReplies: number; noReply: number; reasons: Record<string, number>; typicalLength: number };
const replyStats = ref<ReplyStats | null>(null);
const REASON: Record<string, string> = { "no-need": "不用回", verbose: "太啰嗦", "no-conclusion": "没有结论", self: "我自己回" };
const reasonText = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${REASON[k] ?? k} ${n}`).join("、");
onMounted(() => void get<{ replies: ReplyStats | null }>("/api/mentions").then((r) => (replyStats.value = r.replies)).catch(() => {}));

const off = computed(() => config.value?.mentions?.enabled === false);

// 快速通道 (docs/v2/first-look.md): where a first look's first message goes by default, and which AI looks.
const fl = ref<FirstLookOptions | null>(null);
onMounted(() => void firstLookOptions(true).then((o) => (fl.value = o)).catch(() => {}));
const FIRST_TO: { value: FirstTo; label: string }[] = [{ value: "dm", label: "私聊发给我" }, { value: "ephemeral", label: "群里只有我看得到" }, { value: "chat", label: "发到群里" }];
const firstTo = computed<FirstTo>(() => config.value?.firstLook?.to ?? fl.value?.to ?? "dm");
function saveFirstTo(v: FirstTo) {
  void saveConfig({ firstLook: { ...(config.value.firstLook ?? {}), to: v } }, `第一条默认${FIRST_TO.find((x) => x.value === v)?.label}`);
}
/**
 * The AI a first look runs on, worked out the way the server does (src/rules/first-look.ts firstLookAI):
 * the role's own pick in the Agent page, else the 省的 tier at low effort, else the default backend's lowest.
 */
const fastAI = computed(() => {
  const a = config.value?.agents;
  if (!a) return null;
  const role: string | undefined = a.roles?.["first-look"];
  const models: Record<string, { model?: string; effort?: string }> | undefined = a.roleModels?.["first-look"];
  if (role || models) {
    const backend = role || a.default || "";
    const m = (backend && models?.[backend]) || undefined;
    return { what: [backend || "默认后端", m?.model, m?.effort].filter(Boolean).join(" · "), from: "按你在 Agent 页给“先看一眼”指定的" };
  }
  const cheap = a.tiers?.cheap as { profile: string; model?: string; effort?: string } | undefined;
  if (cheap) return { what: [cheap.profile, cheap.model].filter(Boolean).join(" · ") + " · low", from: `跟随“省的”档位，用低 effort（后端没有 low 时用档上写的${cheap.effort ? ` ${cheap.effort}` : ""}，再没有用最低一档）` };
  return { what: `${a.default || "默认后端"} · 最低 effort`, from: "没配“省的”档位：用默认后端的最低 effort" };
});
const skipKeys = [
  { key: "read" as const, label: "已读" },
  { key: "reacted" as const, label: "回了表情" },
  { key: "replied" as const, label: "在那里回复了" },
];
function saveMentions(patch: Record<string, unknown>, note = "已保存") {
  const cur = config.value.mentions ?? { enabled: true, p2p: true, delayMinutes: 3, skipWhen: { read: true, reacted: true, replied: true }, timeoutMinutes: 10, guidance: "", noDecision: "general", perDay: { triage: 80, handle: 1000 }, reply: { lark: { group: "off", p2p: "off", p2pVia: "group", signedVia: "lark-cli" } } };
  void saveConfig({ mentions: { ...cur, ...patch } }, note);
}
/** Answering the asker is per channel (`mentions.reply.<channel>`); Feishu is the one there is. */
function saveMentionReply(patch: Record<string, unknown>) {
  const reply = config.value.mentions?.reply ?? {};
  saveMentions({ reply: { ...reply, lark: { ...(reply.lark ?? { group: "off", p2p: "off", p2pVia: "group", signedVia: "lark-cli" }), ...patch } } });
}
const REPLY_MODES = [{ value: "off", label: "只提醒我" }, { value: "draft", label: "草稿" }, { value: "auto", label: "自动" }];
const replyOn = computed(() => [config.value?.mentions?.reply?.lark?.group, config.value?.mentions?.reply?.lark?.p2p].some((m) => m === "draft" || m === "auto"));
const p2pReply = computed(() => (config.value?.mentions?.reply?.lark?.p2p ?? "off") !== "off");
const showMore = ref(false);

const savingGuestSpaces = ref(false);
const guestSpaceOptions = computed(() => [
  ...state.spaces.map((s) => ({ value: s.id, label: s.name, hint: s.id })),
  ...(config.value?.lark?.guests?.spaces ?? []).filter((id: string) => !state.spaces.some((s) => s.id === id)).map((id: string) => ({ value: id, label: `空间不存在：${id}`, hint: "取消选择可移除" })),
].map((o) => ({ ...o, disabled: savingGuestSpaces.value })));
async function saveGuestSpaces(spaces: string[]) {
  if (savingGuestSpaces.value) return;
  savingGuestSpaces.value = true;
  try {
    await saveGuests({ spaces });
  } finally {
    savingGuestSpaces.value = false;
  }
}
function saveGuests(patch: Record<string, unknown>, note = "已保存访客设置") {
  const cur = config.value.lark.guests ?? { enabled: false, p2p: false, spaces: [], perHour: 20, ownerPresent: "guest", fullAccess: false };
  return saveConfig({ lark: { ...config.value.lark, guests: { ...cur, ...patch } } }, note);
}
const guestsOff = computed(() => !config.value?.lark?.guests?.enabled);

function saveCommands(patch: Record<string, unknown>, note = "已保存私聊指令") {
  const cur = config.value.lark.commands ?? { enabled: false, ai: "/ai", group: "/ai拉群", signature: "（此消息由 AI 代发）", context: 30, signedVia: "lark-cli" };
  void saveConfig({ lark: { ...config.value.lark, commands: { ...cur, ...patch } } }, note);
}
const commandsOff = computed(() => !config.value?.lark?.commands?.enabled);

async function saveReplyHours(raw: string) {
  const n = Number(raw);
  const v = Number.isFinite(n) && raw.trim() !== "" ? Math.max(1, Math.min(72, Math.round(n))) : 6;
  await saveConfig({ replies: { ...config.value.replies, outcome: { ...(config.value.replies?.outcome ?? {}), afterHours: v } } }, `回复发出 ${v} 小时后判断有没有用`);
  void load();
}
async function saveReplyReview(patch: Record<string, unknown>, note: string) {
  const outcome = config.value.replies?.outcome ?? {};
  await saveConfig({ replies: { ...config.value.replies, outcome: { ...outcome, review: { ...(outcome.review ?? {}), ...patch } } } }, note);
  void load();
}
function saveReplyReviewMax(raw: string) {
  const n = Number(raw);
  const v = Number.isFinite(n) && raw.trim() !== "" ? Math.max(1, Math.min(200, Math.round(n))) : 30;
  return saveReplyReview({ max: v }, `每晚最多复查 ${v} 条回复结果`);
}
const outcomeOff = computed(() => config.value?.replies?.outcome?.enabled === false);
</script>

<template>
  <Skeleton v-if="!config" :rows="6" />
  <div v-else class="stack">
    <SetCard id="set-mentions" title="有人找你" :keys="['mentions']">
      <template #help>有人在群里 @ 你或私聊你，过几分钟你还没处理时，先由一次很小的判断看是什么事：不用管、简短提醒你，还是值得先查；值得查的交给主助手以你的身份读上下文、查资料，再提醒你结论和建议的回复。你回复那条提醒就接着聊。它排在所有规则之后：规则在这条消息上触发过或正等着处理，这里就不管。分诊的标准是“有人找你·分诊”角色，在 Agent 页可以改。</template>
      <SetRow label="有人找你时先分诊再提醒">
        <UiCheckbox :model-value="!off" switch aria-label="有人找你时先分诊再提醒" @change="(v) => saveMentions({ enabled: v }, v ? '有人找你时先分诊再提醒' : '已关闭：有人找你时不再分诊')" />
      </SetRow>
      <SetRow label="私聊也算" hint="同事私聊你的消息" :off="off">
        <UiCheckbox :model-value="config.mentions?.p2p !== false" switch :disabled="off" aria-label="私聊也算" @change="(v) => saveMentions({ p2p: v })" />
      </SetRow>
      <SetRow label="等几分钟再开始" hint="0–240，给你自己先看的时间" :off="off">
        <input class="input set-num" type="number" inputmode="numeric" min="0" max="240" aria-label="消息发出后等几分钟再开始" :disabled="off" :value="config.mentions?.delayMinutes ?? 3" @change="saveMentions({ delayMinutes: Math.max(0, Math.min(240, Math.round(Number(($event.target as HTMLInputElement).value)) || 0)) })" />
      </SetRow>
      <SetRow label="你做了这些就算处理过" hint="都不勾时，只要没有规则接手，过了上面的时间就分诊" :off="off">
        <UiCheckbox v-for="k in skipKeys" :key="k.key" size="sm" :model-value="config.mentions?.skipWhen?.[k.key] !== false" :disabled="off" @change="(v) => saveMentions({ skipWhen: { read: true, reacted: true, replied: true, ...(config.mentions?.skipWhen ?? {}), [k.key]: v } }, v ? `${k.label}算已处理` : `${k.label}不再算已处理`)">{{ k.label }}</UiCheckbox>
      </SetRow>
      <SetRow label="分诊说明" hint="写给判断的模型：哪些人、哪些群、哪类事一定要查或不用管" block :off="off">
        <textarea class="textarea" rows="3" aria-label="分诊说明" :disabled="off" :value="config.mentions?.guidance ?? ''" placeholder="例如：项目 A 群里问接口和数据口径的都先查；行政通知、团建不用提醒；小王找我的一律提醒" @change="saveMentions({ guidance: ($event.target as HTMLTextAreaElement).value.trim() })" />
      </SetRow>

      <SetRow label="替你回复对方">
        <template #hint>
          <HelpText>草稿：提醒旁边多一张卡片，你改了再点发送。自动：分诊也认为不用你拍板时直接回，回了什么写在提醒里，每次都记进审计；拿不准时仍是草稿。飞书群里由机器人在对方那条消息的话题里回（机器人不在群里时用你的身份把它拉进来）。草稿连续照发到设定次数后会问你一次要不要改成自动，你点了才改；自动回复被你回了不满意的表情，这一类立刻改回草稿。</HelpText>
        </template>
      </SetRow>
      <SetRow :keys="['mentions.reply']" label="飞书群里" :off="off">
        <UiSegmented size="sm" aria-label="群里回复对方" :model-value="config.mentions?.reply?.lark?.group ?? 'off'" :options="REPLY_MODES" @change="(v: string) => saveMentionReply({ group: v })" />
      </SetRow>
      <SetRow :keys="['mentions.reply']" label="飞书私聊" :off="off">
        <UiSegmented size="sm" aria-label="私聊回复对方" :model-value="config.mentions?.reply?.lark?.p2p ?? 'off'" :options="REPLY_MODES" @change="(v: string) => saveMentionReply({ p2p: v })" />
      </SetRow>
      <SetRow v-if="p2pReply" :keys="['mentions.reply']" label="私聊怎么回" :off="off">
        <UiSegmented size="sm" aria-label="私聊怎么回" :model-value="config.mentions?.reply?.lark?.p2pVia ?? 'group'" :options="[{ value: 'group', label: '拉你、对方和机器人的群' }, { value: 'signed', label: '以你的身份，带署名' }]" @change="(v: string) => saveMentionReply({ p2pVia: v })" />
      </SetRow>
      <template v-if="p2pReply && config.mentions?.reply?.lark?.p2pVia === 'signed'">
        <SetRow :keys="['mentions.reply']" label="以你的身份怎么发" :off="off">
          <template v-if="config.mentions?.reply?.lark?.signedVia === 'doubao'" #hint><HelpText>企业不让 lark-cli 以你的身份发私聊时用这个：每条回复建一个新的豆包会话，只交给它定稿的回复和对方是谁（姓名、邮箱、id），让它原样发出，用完删除会话；发完用 lark-cli 读那个私聊核对。没核对上或没发出都会单独告诉你，不算回复成功。</HelpText></template>
          <UiSegmented size="sm" aria-label="以你的身份怎么发" :model-value="config.mentions?.reply?.lark?.signedVia ?? 'lark-cli'" :options="[{ value: 'lark-cli', label: '用 lark-cli 发' }, { value: 'doubao', label: '经豆包发送' }]" @change="(v: string) => saveMentionReply({ signedVia: v })" />
        </SetRow>
        <div v-if="config.mentions?.reply?.lark?.signedVia === 'doubao'" class="set-pad"><DoubaoSendStatus /></div>
      </template>
      <SetRow v-if="replyOn" :keys="['mentions.reply']" label="连续照发几次草稿后问我要不要改成自动" hint="0 = 不问；群里和私聊分开数" :off="off">
        <input class="input set-num" type="number" inputmode="numeric" min="0" max="100" aria-label="连续照发多少次草稿后问要不要改成自动" :value="config.mentions?.reply?.promoteAfter ?? 10" @change="saveMentions({ reply: { ...(config.mentions?.reply ?? {}), promoteAfter: Math.max(0, Math.min(100, Math.round(Number(($event.target as HTMLInputElement).value)) || 0)) } })" />
      </SetRow>
      <div v-if="replyStats?.samples" class="set-pad small muted">
        <p>近 60 天 {{ replyStats.samples }} 条找你的消息：<template v-if="replyStats.drafts">拟了 {{ replyStats.drafts }} 条回复，照发 {{ replyStats.sent }}、改后发 {{ replyStats.edited }}、没发 {{ replyStats.dropped }}<template v-if="reasonText(replyStats.reasons)">（{{ reasonText(replyStats.reasons) }}）</template>；</template>你自己回了 {{ replyStats.ownReplies }} 条<template v-if="replyStats.typicalLength">，通常 {{ replyStats.typicalLength }} 字左右</template>，没回 {{ replyStats.noReply }} 条。之后的分诊和草稿会参照这些。</p>
      </div>

      <SetRow label="次数和时限" hint="没有决策模型时怎么分诊、每天最多几次、查多久" :off="off">
        <button class="btn ghost sm" :aria-expanded="showMore" @click="showMore = !showMore">{{ showMore ? "收起" : "展开" }}</button>
      </SetRow>
      <template v-if="showMore">
        <SetRow label="没有配置决策模型时" block :off="off">
          <UiSelect
            :model-value="config.mentions?.noDecision ?? 'general'"
            size="sm"
            width="100%"
            aria-label="没有决策模型时怎么分诊"
            :disabled="off"
            :options="[
              { value: 'general', label: '用通用模型分诊（助手的后端，一次不带工具的调用）' },
              { value: 'notify', label: '不分诊，都发简短提醒' },
              { value: 'handle', label: '不分诊，都交给助手先查（最费）' },
            ]"
            @change="(v) => saveMentions({ noDecision: v })"
          />
        </SetRow>
        <SetRow label="每天最多分诊" hint="次；超过就只发简短提醒" :off="off">
          <input class="input set-num" type="number" inputmode="numeric" min="0" max="1000" aria-label="每天最多分诊" :disabled="off" :value="config.mentions?.perDay?.triage ?? 80" @change="saveMentions({ perDay: { ...(config.mentions?.perDay ?? { triage: 80, handle: 1000 }), triage: Math.max(0, Math.min(1000, Math.round(Number(($event.target as HTMLInputElement).value)) || 0)) } })" />
        </SetRow>
        <SetRow label="每天最多交给助手查" hint="次；超过就只发简短提醒" :off="off">
          <input class="input set-num" type="number" inputmode="numeric" min="0" max="10000" aria-label="每天最多交给助手查" :disabled="off" :value="config.mentions?.perDay?.handle ?? 1000" @change="saveMentions({ perDay: { ...(config.mentions?.perDay ?? { triage: 80, handle: 1000 }), handle: Math.max(0, Math.min(500, Math.round(Number(($event.target as HTMLInputElement).value)) || 0)) } })" />
        </SetRow>
        <SetRow label="查背景最多几分钟" hint="1–60；超过就发简短提醒" :off="off">
          <input class="input set-num" type="number" inputmode="numeric" min="1" max="60" aria-label="查背景最多几分钟" :disabled="off" :value="config.mentions?.timeoutMinutes ?? 10" @change="saveMentions({ timeoutMinutes: intIn($event, 1, 60, 10) })" />
        </SetRow>
      </template>
    </SetCard>

    <SetCard id="set-first-look" title="快速通道" :keys="['firstLook']">
      <template #help>规则或关注打开“先快速看一眼”后，消息一来先跑选的预查，再让快模型在 {{ fl?.budgetSec ?? 90 }} 秒内看一眼：答完了、要接着查、要你定。只有要接着查才起深查。这里定第一条消息默认发到哪，每条规则和每个关注可以自己改。</template>
      <SetRow label="第一条消息默认发到哪" block>
        <UiSegmented :model-value="firstTo" size="sm" :options="FIRST_TO" aria-label="第一条消息默认发到哪" @change="(v) => saveFirstTo(v as FirstTo)" />
        <template #hint>{{ FIRST_TO_EFFECT[firstTo] }}</template>
      </SetRow>
      <SetRow label="先看一眼用的 AI" block>
        <div class="fast-ai">
          <code v-if="fastAI">{{ fastAI.what }}</code>
          <span v-else class="muted">看不到 AI 的设置</span>
          <router-link to="/agents?tab=agents&role=first-look" class="small">在 Agent 页换</router-link>
        </div>
        <template v-if="fastAI" #hint>{{ fastAI.from }}。和其他内置角色一样，在 Agent 页的“先看一眼”角色里改后端、模型和思考强度。</template>
      </SetRow>
      <SetRow v-if="fl" label="预查库" :hint="fl.probes.length ? `${fl.probes.length} 个预查：${fl.probes.slice(0, 3).map((p) => p.name).join('、')}${fl.probes.length > 3 ? ' 等' : ''}` : '还没有预查'">
        <router-link to="/rules/probes" class="btn sm">管理预查</router-link>
      </SetRow>
    </SetCard>

    <SetCard id="set-guests" title="访客提问" :keys="['lark.guests']">
      <template #help>没有登记为 omem 用户的同事在群里 @ 机器人，或别的机器人 @ 它时：先由“访客提问把关”角色判断该回答、拒绝还是不理（要它执行命令、查私人信息、问无关或敏感的事一律拒绝），再由“回答访客”角色只读这个群的空间（不读任何个人空间）和下面列出的空间作答。两个角色的模型在 Agent 页设置；把关建议用快的小模型，回答访客建议用不带本机命令行的后端。</template>
      <SetRow label="回答未登记的人和别的机器人">
        <UiCheckbox :model-value="!guestsOff" switch aria-label="回答未登记的人和别的机器人" @change="(v) => saveGuests({ enabled: v }, v ? '已开启访客提问' : '已关闭访客提问')" />
      </SetRow>
      <SetRow label="也回答他们的私聊" hint="私聊只读下面“开放给访客的空间”" :off="guestsOff">
        <UiCheckbox :model-value="!!config.lark.guests?.p2p" switch :disabled="guestsOff" aria-label="也回答未登记的人与机器人的私聊" @change="(v) => saveGuests({ p2p: v })" />
      </SetRow>
      <SetRow label="你也在群里时" block :off="guestsOff">
        <UiSelect
          :model-value="config.lark.guests?.ownerPresent ?? 'guest'"
          size="sm"
          width="100%"
          aria-label="你也在群里时怎么回答访客"
          :disabled="guestsOff"
          :options="[
            { value: 'guest', label: '和别处一样：把关后由“回答访客”受限回答' },
            { value: 'gated', label: '把关后由助理回答（像你自己问的一样，能用全部资料和工具）' },
            { value: 'free', label: '不把关，直接由助理回答' },
          ]"
          @change="(v) => saveGuests({ ownerPresent: v })"
        />
      </SetRow>
      <SetRow label="开放给访客的空间" hint="私聊只读这里选的；群聊还可读群所属的非个人空间" block :off="guestsOff">
        <UiSelect
          :model-value="(config.lark.guests?.spaces ?? []) as string[]"
          multiple
          :options="guestSpaceOptions"
          :disabled="guestsOff"
          aria-label="开放给访客的空间"
          placeholder="未选择空间"
          @change="saveGuestSpaces"
        />
      </SetRow>
      <SetRow label="每人每小时最多提问" hint="1–200" :off="guestsOff">
        <input class="input set-num" type="number" inputmode="numeric" min="1" max="200" aria-label="每人每小时最多提问" :value="config.lark.guests?.perHour ?? 20" @change="saveGuests({ perHour: Math.max(1, Math.min(200, Math.round(Number(($event.target as HTMLInputElement).value) || 20))) })" />
      </SetRow>
      <SetRow label="回答访客时完全访问" :off="guestsOff">
        <template #hint>
          <span v-if="config.lark.guests?.fullAccess" class="warn-text">命令不进沙箱、不经审批：访客的话可能让它在这台机器上执行命令。只在回答访客的后端本来就不带本机命令行、或你信任群里的人时打开</span>
          <template v-else>命令不进沙箱、不经审批</template>
        </template>
        <UiCheckbox :model-value="!!config.lark.guests?.fullAccess" switch :disabled="guestsOff" aria-label="回答访客时完全访问" @change="(v) => saveGuests({ fullAccess: v }, v ? '已对访客打开完全访问' : '已对访客关闭完全访问')" />
      </SetRow>
    </SetCard>

    <SetCard id="set-commands" title="私聊指令" :keys="['lark.commands']">
      <template #help>在你和别人的私聊里输入指令（每分钟用 lark-cli 读一次你发的私聊消息）。只有你亲手发出指令时，omem 才会以你的身份在那个私聊里发一条消息，结尾带上署名。</template>
      <SetRow label="开启私聊指令">
        <UiCheckbox :model-value="!commandsOff" switch aria-label="开启私聊指令" @change="(v) => saveCommands({ enabled: v }, v ? '已开启私聊指令' : '已关闭私聊指令')" />
      </SetRow>
      <SetRow label="代回" hint="读最近的私聊和指令后面的说明，以你的身份回复对方" :off="commandsOff">
        <input class="input sm mono cmd-in" aria-label="代回指令" :value="config.lark.commands?.ai ?? '/ai'" @change="saveCommands({ ai: ($event.target as HTMLInputElement).value.trim() || '/ai' })" />
      </SetRow>
      <SetRow label="拉群" hint="建一个你、对方和机器人的群，机器人在群里接着处理" :off="commandsOff">
        <input class="input sm mono cmd-in" aria-label="拉群指令" :value="config.lark.commands?.group ?? '/ai拉群'" @change="saveCommands({ group: ($event.target as HTMLInputElement).value.trim() || '/ai拉群' })" />
      </SetRow>
      <SetRow label="代回怎么发" :off="commandsOff">
        <template v-if="config.lark.commands?.signedVia === 'doubao'" #hint>每次代回建一个新的豆包会话，只交给它定稿的回复和对方是谁，原样发出后删除；发完读私聊核对</template>
        <UiSegmented size="sm" aria-label="代回怎么发" :model-value="config.lark.commands?.signedVia ?? 'lark-cli'" :options="[{ value: 'lark-cli', label: '用 lark-cli 发' }, { value: 'doubao', label: '经豆包发送' }]" @change="(v: string) => saveCommands({ signedVia: v })" />
      </SetRow>
      <div v-if="config.lark.commands?.signedVia === 'doubao'" class="set-pad"><DoubaoSendStatus /></div>
      <SetRow label="代回消息结尾的署名" :off="commandsOff">
        <input class="input sm sig-in" aria-label="代回消息结尾的署名" :value="config.lark.commands?.signature ?? '（此消息由 AI 代发）'" @change="saveCommands({ signature: ($event.target as HTMLInputElement).value.trim() || '（此消息由 AI 代发）' })" />
      </SetRow>
      <SetRow label="读最近多少条私聊" hint="1–100" :off="commandsOff">
        <input class="input set-num" type="number" inputmode="numeric" min="1" max="100" aria-label="读最近多少条私聊" :value="config.lark.commands?.context ?? 30" @change="saveCommands({ context: Math.max(1, Math.min(100, Math.round(Number(($event.target as HTMLInputElement).value) || 30))) })" />
      </SetRow>
    </SetCard>

    <SetCard id="set-invite" title="拉人进群" :keys="['lark.invite']">
      <template #help>助手可以用你的身份把人或机器人拉进你所在的群。拉人每次都要你批准，卡片上列出每个群和每个人；拉机器人（omem 自己的，或在你的群里见过、认得出名字的）默认直接拉，事后在回复里告诉你。</template>
      <SetRow label="拉机器人进群也要我批准">
        <UiCheckbox :model-value="!!config.lark.invite?.botApproval" switch aria-label="拉机器人进群也要我批准" @change="(v) => saveConfig({ lark: { ...config.lark, invite: { ...(config.lark.invite ?? {}), botApproval: v } } }, v ? '拉机器人进群也要你批准' : '拉机器人进群不用批准')" />
      </SetRow>
    </SetCard>

    <SetCard id="set-reply-check" title="回复发出前的检查" :keys="['replies']">
      <template #help>回复里只有“我核对一下”“收到，我看看”，或只有“可能”“建议进一步确认”这类退路、没有结论和依据时，先不发，退回给 Agent 重写一次：要么给出结果和依据，要么说清缺哪一个信息。只拦这几种明显不是回答的样子，不判断回答对不对；它已经安排了之后回来（定了唤醒、交办了任务）时不拦。每次退回都记在那次运行里。</template>
      <SetRow label="空话和只有退路的回复退回重写一次">
        <UiCheckbox :model-value="config.replies?.check !== false" switch aria-label="空话和只有退路的回复退回重写一次" @change="(v) => saveConfig({ replies: { ...(config.replies ?? {}), check: v } }, v ? '已打开回复检查' : '已关闭回复检查')" />
      </SetRow>
    </SetCard>

    <SetCard id="set-reply-outcome" title="回复发出后看有没有用" :keys="['replies']">
      <template #help>助手的回答发出几小时后，取同一个会话或群里之后大家说的话，请决策模型标一个结果：解决了、被追问、被纠正、别人接手了、看不出；没人接话的不问模型。结果记在那次运行上（运行页能看到依据，标错了你可以改），数据页的“做得怎么样”按它统计。没配决策模型时只记“没人接话”。</template>
      <SetRow label="按之后大家说的话判断回复有没有用">
        <UiCheckbox :model-value="!outcomeOff" switch aria-label="按回复之后大家说的话判断它有没有用" @change="(v: boolean) => saveConfig({ replies: { ...config.replies, outcome: { ...(config.replies?.outcome ?? {}), enabled: v } } }, v ? '回复发出后会看后续' : '不再看回复的后续')" />
      </SetRow>
      <SetRow label="发出几小时后判断" hint="1–72" :off="outcomeOff">
        <input class="input set-num" type="number" inputmode="numeric" min="1" max="72" aria-label="发出几小时后判断" :value="config.replies?.outcome?.afterHours ?? 6" @change="saveReplyHours(($event.target as HTMLInputElement).value)" />
      </SetRow>
      <SetRow label="每晚复查" :off="outcomeOff">
        <template #hint><HelpText>一到三天前的回答，由 outcome-reviewer 带着发出后一整天的消息重看第一遍的标注，同意的记同意，不对的改判；你标的和按表情记的不碰。在 Agent 页给它选一个比决策模型强的模型。</HelpText></template>
        <UiCheckbox :model-value="config.replies?.outcome?.review?.enabled !== false" switch aria-label="每晚复查回复结果" @change="(v: boolean) => saveReplyReview({ enabled: v }, v ? '每晚复查回复结果' : '不再复查回复结果')" />
      </SetRow>
      <SetRow label="每晚最多复查几条" :hint="`1–200，其中随机抽 ${config.replies?.outcome?.review?.sample ?? 5} 条有把握的`" :off="outcomeOff || config.replies?.outcome?.review?.enabled === false">
        <input class="input set-num" type="number" inputmode="numeric" min="1" max="200" aria-label="每晚最多复查几条" :value="config.replies?.outcome?.review?.max ?? 30" @change="saveReplyReviewMax(($event.target as HTMLInputElement).value)" />
      </SetRow>
    </SetCard>
  </div>
</template>

<style scoped>
.fast-ai {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  min-width: 0;
}
.fast-ai code {
  overflow-wrap: anywhere;
  word-break: break-all;
}
.cmd-in {
  width: 140px;
}
.sig-in {
  width: 220px;
  max-width: 100%;
}
.warn-text {
  color: var(--warn);
}
</style>
