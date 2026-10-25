<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get, post, put } from "../api";
import Icon from "./Icon.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { state, toast } from "../store";

/**
 * Backlog digestion of one space: jobs that go through stored material in batches — triage
 * (levels from titles and heads) and digest (read in full, into pages, notes and memories).
 */
type Job = { id: string; spaceId: string; mode: "triage" | "digest"; status: string; total: number; left: number; inflight: number; runId: string | null; label: string; body: { agent?: string; goal?: string; parallel?: number; batch?: number } };

const props = defineProps<{ space: string }>();
const emit = defineEmits<{ close: [] }>();

const jobs = ref<Job[]>([]);
const loading = ref(true);
async function load() {
  loading.value = true;
  try {
    jobs.value = (await get<Job[]>("/api/digest-jobs?all=1")).filter((j) => j.spaceId === props.space);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const modeOptions = [
  { value: "triage" as const, label: "分级", title: "按标题和开头给每份定关注程度，快" },
  { value: "digest" as const, label: "精读整理", title: "读全文，提炼成知识页、案例页、标注和记忆；跳过仅检索和忽略的" },
];
const kindOptions = [{ value: "", label: "全部类型" }, { value: "doc", label: "文档" }, { value: "chat", label: "聊天" }, { value: "meeting", label: "妙记" }, { value: "web", label: "网页" }];
const form = ref({ mode: "triage" as "triage" | "digest", title: "", goal: "", agent: "", kind: "", titleContains: "", wikiPath: "", parallel: 2, batch: "" });
const agents = ref<{ value: string; label: string }[]>([{ value: "", label: "不指定" }]);
onMounted(async () => {
  try {
    const specs = await get<{ name: string; description?: string }[]>("/api/agents");
    agents.value = [{ value: "", label: "不指定" }, ...specs.map((s) => ({ value: s.name, label: s.name }))];
  } catch {
    // agents are optional here
  }
});
const filter = computed(() => ({ kind: form.value.kind || undefined, title_contains: form.value.titleContains.trim() || undefined, wiki_path_contains: form.value.wikiPath.trim() || undefined }));
const matched = ref<number | null>(null);
async function preview() {
  try {
    matched.value = (await post<{ matched: number }>("/api/sources/attention", { filter: { ...filter.value, space: props.space }, level: null, dryRun: true })).matched;
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function start() {
  const f = form.value;
  try {
    const batch = Number(f.batch);
    await post("/api/digest-jobs", { mode: f.mode, space: props.space, title: f.title.trim() || undefined, goal: f.goal.trim(), agent: f.agent || undefined, filter: filter.value, parallel: clampParallel(f.parallel), batch: f.batch !== "" && batch >= 1 ? Math.min(300, Math.round(batch)) : undefined });
    toast("已开始，后台一批一批地做", "ok");
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function control(j: Job, action: "pause" | "resume" | "stop") {
  try {
    await post(`/api/digest-jobs/${j.id}/${action}`);
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const clampParallel = (n: number) => Math.max(1, Math.min(16, Math.round(Number(n) || 1)));
async function setParallel(j: Job, raw: string) {
  try {
    await put(`/api/digest-jobs/${j.id}`, { parallel: clampParallel(Number(raw)) });
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const STATUS: Record<string, string> = { active: "进行中", paused: "已暂停", stopped: "已停止", done: "已完成" };
const spaceName = computed(() => state.spaces.find((s) => s.id === props.space)?.name ?? props.space);
</script>

<template>
  <Teleport to="body">
  <div class="modal-overlay" @mousedown.self="emit('close')">
    <div class="modal stack digest">
      <div class="row"><strong>整理存量材料 · {{ spaceName }}</strong><span class="spacer" /><button class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" /></button></div>
      <p class="muted small">已经入库、还没人整理过的材料（回溯的群、整批导入的知识库）在后台一批一批地处理。先“分级”过一遍，再对重点和一般的“精读整理”。同时跑的几批会分到角色配置过的不同模型上，各模型的并行上限在设置 → Agent。</p>

      <div v-if="loading" class="muted small">读取中…</div>
      <ul v-else-if="jobs.length" class="jobs">
        <li v-for="j in jobs" :key="j.id">
          <div class="grow">
            <div class="ellipsis">{{ j.mode === "triage" ? "分级" : "精读整理" }} · {{ j.label }}</div>
            <div class="muted small">{{ STATUS[j.status] ?? j.status }} · {{ j.total - j.left }} / {{ j.total }}<template v-if="j.inflight"> · {{ j.inflight }} 批进行中</template><template v-if="j.body.agent"> · 经验写给 {{ j.body.agent }}</template><template v-if="j.runId"> · <router-link :to="`/runs/${j.runId}`">当前批次</router-link></template></div>
          </div>
          <label v-if="j.status === 'active' || j.status === 'paused'" class="pace small muted">同时<input class="input sm num" type="number" inputmode="numeric" min="1" max="16" :value="j.body.parallel ?? 1" aria-label="同时跑几批" @change="setParallel(j, ($event.target as HTMLInputElement).value)" />批</label>
          <button v-if="j.status === 'active'" class="btn ghost sm" @click="control(j, 'pause')">暂停</button>
          <button v-if="j.status === 'paused' || j.status === 'stopped'" class="btn ghost sm" @click="control(j, 'resume')">继续</button>
          <button v-if="j.status === 'active' || j.status === 'paused'" class="btn ghost sm danger" @click="control(j, 'stop')">停止</button>
        </li>
      </ul>

      <div class="section-title">新的整理</div>
      <UiSegmented v-model="form.mode" size="sm" aria-label="整理方式" :options="modeOptions" />
      <div class="grid">
        <label class="field"><span>标题包含</span><input v-model="form.titleContains" class="input sm" placeholder="如“值班”“Oncall”" @change="matched = null" /></label>
        <label class="field"><span>知识库或目录包含</span><input v-model="form.wikiPath" class="input sm" placeholder="如“技术方案”" @change="matched = null" /></label>
        <div class="field"><span>类型</span><UiSelect v-model="form.kind" size="sm" :options="kindOptions" aria-label="类型" @change="matched = null" /></div>
        <label class="field"><span>同时跑几批</span><input v-model.number="form.parallel" class="input sm" type="number" inputmode="numeric" min="1" max="16" /></label>
        <label class="field"><span>每批最多几份</span><input v-model="form.batch" class="input sm" type="number" inputmode="numeric" min="1" max="300" :placeholder="form.mode === 'triage' ? '默认 150' : '默认 40，约 15 万字'" /></label>
        <div v-if="form.mode === 'digest'" class="field"><span>经验写给哪个 Agent</span><UiSelect v-model="form.agent" size="sm" :options="agents" aria-label="经验写给哪个 Agent" /></div>
      </div>
      <label class="field"><span>这批是什么（可选）</span><input v-model="form.title" class="input sm" placeholder="如“值班群回溯”" /></label>
      <label class="field"><span>想得到什么</span><textarea v-model="form.goal" class="textarea" rows="3" placeholder="如：整理成值班排查手册，每类问题怎么判断、找谁、怎么处理；闲聊和机器人通知不用管" /></label>
      <div class="row wrap gap">
        <button class="btn ghost sm" @click="preview">看看圈中多少份</button>
        <span v-if="matched !== null" class="muted small">{{ matched }} 份</span>
        <span class="spacer" />
        <button class="btn primary sm" @click="start">开始</button>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 12, 16, 0.35);
  z-index: 55;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 8vh 0 16px;
  overflow-y: auto;
}
.modal {
  background: var(--panel);
  border-radius: 14px;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  padding: 18px;
}
.digest {
  width: min(640px, calc(100vw - 32px));
}
.jobs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.jobs li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.grow {
  flex: 1;
  min-width: 0;
}
.pace {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.num {
  width: 56px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
}
.gap {
  gap: 8px;
}
</style>
