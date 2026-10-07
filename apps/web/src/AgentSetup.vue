<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { OmButton, OmCheckbox, OmPanel, OmSelect } from "@omem/ui";
import { api } from "./api";
const emit = defineEmits<{ saved: []; notice: [text: string] }>();
const names = {
  assistant: "主助手",
  knowledge: "材料与文章整理",
  learning: "记忆整理",
  coding: "编码",
  review: "代码评审",
};
type Role = keyof typeof names;
const roles = Object.keys(names) as Role[];
type Choice = { candidateId: string; model: string; effort: string };
type Options = { current: string; values: { value: string; name: string }[] };
type Probe = {
  connected: boolean;
  inference: string;
  model: Options;
  effort: Options;
};
type Settings = {
  configured: boolean;
  candidates: { id: string; name: string; installed: boolean }[];
  nativeCli: { codex: boolean; claude: boolean };
  roles: Record<
    Role,
    { id: string; candidateId: string; model: string; effort: string } | null
  >;
  learningEnabled: boolean;
};
const settings = ref<Settings>();
const loading = ref(false),
  saving = ref(false),
  error = ref(""),
  separate = ref(false);
const choices = reactive(
  Object.fromEntries(
    roles.map((r) => [r, { candidateId: "", model: "", effort: "" }]),
  ) as Record<Role, Choice>,
);
const results = reactive({} as Partial<Record<Role, Probe>>),
  busy = reactive({} as Partial<Record<Role, boolean>>),
  errors = reactive({} as Partial<Record<Role, string>>);
const generations: Partial<Record<Role, number>> = {};
const displayed = computed(() =>
  separate.value ? roles : (["assistant"] as Role[]),
);
const ready = computed(() =>
  displayed.value.every((r) => results[r]?.connected && !busy[r] && !errors[r]),
);
async function detect() {
  loading.value = true;
  error.value = "";
  try {
    settings.value = await api<Settings>("/agents/settings");
    const first = settings.value.candidates.find((c) => c.installed)?.id ?? "";
    for (const role of roles) {
      const p = settings.value.roles[role];
      generations[role] = (generations[role] ?? 0) + 1;
      choices[role] = {
        candidateId: p?.candidateId ?? first,
        model: p?.model ?? "",
        effort: p?.effort ?? "",
      };
      results[role] = undefined;
    }
    separate.value = roles.some(
      (r) =>
        r !== "assistant" &&
        JSON.stringify(choices[r]) !== JSON.stringify(choices.assistant),
    );
    // Profile IDs may differ while all choices use the same command. Preserve
    // explicit per-role configuration; do not overwrite it on page entry.
    if (choices.assistant.candidateId)
      await inspect("assistant", false, false, true);
    if (separate.value)
      for (const role of roles.slice(1))
        if (choices[role].candidateId) void inspect(role, false, false, true);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
async function inspect(
  role: Role,
  changedAgent = false,
  test = false,
  discoverModels = false,
) {
  const generation = (generations[role] ?? 0) + 1;
  generations[role] = generation;
  if (changedAgent) {
    choices[role].model = "";
    choices[role].effort = "";
  }
  busy[role] = true;
  errors[role] = "";
  results[role] = undefined;
  const choice = { ...choices[role] };
  try {
    // Model changes are negotiated before reading effort choices. A stale
    // effort is not sent with the new model; the user sees its actual options.
    const result = await api<Probe>("/agents/probe", {
      ...choice,
      model: discoverModels ? "" : choice.model,
      effort: test ? choice.effort : "",
      test,
    });
    if (generations[role] !== generation) return;
    if (
      discoverModels &&
      choice.model &&
      result.model.values.some((v) => v.value === choice.model)
    ) {
      await inspect(role);
      return;
    }
    if (
      discoverModels &&
      choice.model &&
      !result.model.values.some((v) => v.value === choice.model)
    )
      choices[role].model = "";
    if (!choices[role].model) choices[role].model = result.model.current;
    if (!result.effort.values.some((v) => v.value === choices[role].effort))
      choices[role].effort = result.effort.current;
    results[role] = result;
  } catch (e) {
    if (generations[role] === generation)
      errors[role] = e instanceof Error ? e.message : String(e);
  } finally {
    if (generations[role] === generation) busy[role] = false;
  }
}
function effortChanged(role: Role) {
  if (results[role]) results[role]!.inference = "untested";
}
function changeSeparate() {
  if (separate.value)
    for (const role of roles.slice(1)) {
      choices[role] = { ...choices.assistant };
      results[role] = results.assistant
        ? JSON.parse(JSON.stringify(results.assistant))
        : undefined;
    }
}
async function save() {
  saving.value = true;
  error.value = "";
  try {
    const value = Object.fromEntries(
      roles.map((r) => [r, { ...choices[separate.value ? r : "assistant"] }]),
    );
    await api("/agents/settings", { roles: value }, "PUT");
    emit(
      "notice",
      "已保存 Agent 设置，新任务开始使用；已排队的编码任务保留原配置。",
    );
    emit("saved");
    await detect();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
onMounted(detect);
</script>

<template>
  <div class="agent-setup">
    <div class="detection-toolbar">
      <p>
        选择运行 omem 的电脑上已安装、已登录的 Agent。可用模型和思考强度从实际
        ACP 会话读取，切换模型后会重新读取。
      </p>
      <OmButton :loading="loading" @click="detect">重新检测本机 Agent</OmButton>
    </div>
    <p v-if="loading" role="status">正在检测并读取 Agent 能力…</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="settings">
      <div class="agent-inventory">
        <h3>本机检测结果</h3>
        <dl>
          <div
            v-for="candidate in settings.candidates.filter(
              (c) => !c.id.startsWith('omem-'),
            )"
            :key="candidate.id"
          >
            <dt>{{ candidate.name }}</dt>
            <dd>
              {{
                candidate.installed
                  ? "命令可用，连接后核验能力"
                  : "服务环境未找到命令"
              }}
            </dd>
          </div>
        </dl>
        <p
          v-if="
            settings.nativeCli.codex &&
            !settings.candidates.some((c) => /codex/i.test(c.id) && c.installed)
          "
          class="muted"
        >
          检测到 Codex CLI；还需要 codex-acp 适配器才能连接 ACP。
        </p>
        <p
          v-if="
            settings.nativeCli.claude &&
            !settings.candidates.some(
              (c) => /claude/i.test(c.id) && c.installed,
            )
          "
          class="muted"
        >
          检测到 Claude Code CLI；还需要 claude-agent-acp 适配器才能连接 ACP。
        </p>
      </div>
      <div class="separate">
        <OmCheckbox v-model="separate" @change="changeSeparate"
          >为不同工作分别设置 Agent、模型与思考强度</OmCheckbox
        >
      </div>
      <p v-if="!separate" class="muted">
        以下选择用于主助手、材料与文章整理、记忆整理、编码和代码评审。评审仍使用独立会话。
      </p>
      <div class="agent-role-list">
        <OmPanel v-for="role in displayed" :key="role" :title="names[role]">
          <div class="agent-role-form">
            <label
              >{{ names[role] }} Agent<OmSelect
                v-model="choices[role].candidateId"
                :aria-label="`${names[role]} Agent`"
                :disabled="saving"
                @change="inspect(role, true)"
              >
                <option disabled value="">请选择已安装的 Agent</option>
                <option
                  v-for="c in settings.candidates"
                  :key="c.id"
                  :value="c.id"
                  :disabled="!c.installed"
                >
                  {{ c.name }}{{ c.installed ? "" : "（未找到命令）" }}
                </option>
              </OmSelect></label
            >
            <div class="agent-model-grid">
              <label
                >{{ names[role] }}模型<OmSelect
                  v-model="choices[role].model"
                  :aria-label="`${names[role]}模型`"
                  :disabled="busy[role] || saving || !results[role]"
                  @change="inspect(role)"
                >
                  <option value="">使用 Agent 默认模型</option>
                  <option
                    v-for="v in results[role]?.model.values ?? []"
                    :key="v.value"
                    :value="v.value"
                  >
                    {{ v.name }}
                  </option>
                </OmSelect></label
              >
              <label
                >{{ names[role] }}思考强度<OmSelect
                  v-model="choices[role].effort"
                  :aria-label="`${names[role]}思考强度`"
                  :disabled="
                    busy[role] || saving || !results[role]?.effort.values.length
                  "
                  @change="effortChanged(role)"
                >
                  <option value="">使用 Agent 默认强度</option>
                  <option
                    v-for="v in results[role]?.effort.values ?? []"
                    :key="v.value"
                    :value="v.value"
                  >
                    {{ v.name }}
                  </option>
                </OmSelect></label
              >
            </div>
            <p v-if="busy[role]" role="status">
              正在连接 Agent，读取模型对应的思考强度…
            </p>
            <p v-else-if="errors[role]" class="error" role="alert">
              {{ errors[role] }}
            </p>
            <p v-else-if="results[role]" role="status">
              ACP 已连接 ·
              {{
                results[role]?.inference === "passed"
                  ? "所选模型实际调用通过"
                  : "模型实际调用尚未检查"
              }}
            </p>
            <p
              v-if="results[role] && !results[role]?.effort.values.length"
              class="muted"
            >
              此模型未提供可选择的思考强度，使用 Agent 默认行为。
            </p>
            <div class="actions">
              <OmButton
                :loading="busy[role]"
                :disabled="!choices[role].candidateId || saving"
                @click="inspect(role)"
                >读取能力</OmButton
              ><OmButton
                :disabled="!results[role] || busy[role] || saving"
                @click="inspect(role, false, true)"
                >检查所选模型调用</OmButton
              >
            </div>
            <small
              >调用检查仅发送一句连接测试，不传入个人材料；会使用模型额度。能力列表本身不能证明账号已获模型调用权限。</small
            >
          </div>
        </OmPanel>
      </div>
      <p class="muted">
        {{
          settings.learningEnabled
            ? "记忆后台整理当前已启用。"
            : "记忆后台整理当前未启用。"
        }}保存模型设置不会改变消息采集、学习或机器人绑定开关。高级配置中的单独阅读模型仍按原配置使用。
      </p>
      <div class="actions">
        <OmButton
          variant="primary"
          :loading="saving"
          :disabled="!ready || loading"
          @click="save"
          >保存并用于新任务</OmButton
        >
      </div>
    </template>
  </div>
</template>

<style scoped>
.agent-setup {
  display: grid;
  gap: 16px;
  max-width: 920px;
}
.agent-setup p {
  margin: 0;
}
.detection-toolbar {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 16px 24px;
}
.detection-toolbar p {
  flex: 1 1 400px;
  max-width: 64ch;
}
.detection-toolbar button {
  flex-shrink: 0;
}
.agent-role-list {
  display: grid;
  gap: 24px;
  min-width: 0;
}
.agent-setup .agent-role-form {
  display: grid;
  gap: 16px;
}
.agent-role-form label {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.agent-model-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}
.agent-setup .separate {
  padding-top: 8px;
}
.agent-inventory {
  display: grid;
  gap: 8px;
  padding: 16px;
  background: var(--om-soft);
  border-radius: 8px;
  overflow-wrap: anywhere;
}
.agent-inventory h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}
.agent-inventory dl {
  display: grid;
  gap: 8px;
  margin: 0;
}
.agent-inventory dl > div {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(0, 3fr);
  gap: 16px;
}
.agent-inventory dt,
.agent-inventory dd {
  margin: 0;
}
.agent-inventory dd {
  color: var(--om-secondary);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0;
}
.agent-setup small {
  color: var(--om-secondary);
  line-height: 1.8;
}
.agent-setup .error {
  color: var(--om-danger);
}
@media (max-width: 700px) {
  .agent-model-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .agent-inventory dl > div {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
}
</style>
