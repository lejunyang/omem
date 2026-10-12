<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { del, get, onServerEvent, post, type Memory } from "../api";
import Icon from "../components/Icon.vue";
import { fmtTime, memoryKindLabel, openCitation, state, statusLabel, toast } from "../store";

const memories = ref<Memory[]>([]);
const q = ref("");
const kind = ref("");
const status = ref("active");
const scope = ref<"space" | "all">("all");
const adding = ref(false);
const form = ref({ kind: "fact", subject: "", content: "" });
const editing = ref<string | null>(null);
const editText = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;

async function load() {
  const p = new URLSearchParams({ status: status.value });
  if (q.value.trim()) p.set("q", q.value.trim());
  if (kind.value) p.set("kind", kind.value);
  if (scope.value === "space") p.set("space", state.space);
  memories.value = await get<Memory[]>(`/api/memories?${p}`);
}
onMounted(load);
watch([kind, status, scope], load);
watch(q, () => {
  clearTimeout(timer);
  timer = setTimeout(load, 250);
});
const off = onServerEvent((e) => {
  if (e.type === "changed" && e.entity === "memory") void load();
});
onBeforeUnmount(() => off());

const groups = computed(() => {
  const map = new Map<string, Memory[]>();
  for (const m of memories.value) {
    const key = m.subject || "（未分类）";
    map.set(key, [...(map.get(key) ?? []), m]);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
});

async function add() {
  if (!form.value.content.trim()) return;
  await post("/api/memories", { ...form.value, space: state.space });
  form.value = { kind: "fact", subject: "", content: "" };
  adding.value = false;
  toast("已记住", "ok");
}
function startEdit(m: Memory) {
  editing.value = m.id;
  editText.value = m.content;
}
async function supersede(m: Memory) {
  if (editText.value.trim() === m.content) return void (editing.value = null);
  await post(`/api/memories/${m.id}/supersede`, { content: editText.value, reason: "本人更正" });
  editing.value = null;
  toast("已更正，旧版本保留在演变记录中", "ok");
}
async function retract(m: Memory) {
  const reason = prompt("撤回原因（可选）", "不再准确");
  if (reason === null) return;
  await del(`/api/memories/${m.id}?reason=${encodeURIComponent(reason)}`);
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>记忆</h1>
        <p>助理记住的事实、约定、偏好和经验。更正时旧版本不会消失，可以追溯“之前是什么、什么时候改的”。</p>
      </div>
      <span class="spacer" />
      <button class="btn primary" @click="adding = !adding"><Icon name="plus" :size="15" />添加</button>
    </div>

    <form v-if="adding" class="card pad add" @submit.prevent="add">
      <div class="row wrap">
        <select v-model="form.kind" class="select" style="width: 110px">
          <option v-for="(l, k) in memoryKindLabel" :key="k" :value="k">{{ l }}</option>
        </select>
        <input v-model="form.subject" class="input" style="flex: 1; min-width: 160px" placeholder="主题，如“项目A 预算”“张三”" />
      </div>
      <textarea v-model="form.content" class="textarea" rows="2" placeholder="一句话写全：主语、对象、时间、数字" />
      <div class="row"><span class="muted small">保存到「{{ state.spaces.find((s) => s.id === state.space)?.name }}」</span><span class="spacer" /><button class="btn" type="button" @click="adding = false">取消</button><button class="btn primary">保存</button></div>
    </form>

    <div class="filters row wrap">
      <div class="search row"><Icon name="search" :size="15" /><input v-model="q" placeholder="搜索记忆" /></div>
      <select v-model="kind" class="select"><option value="">全部类型</option><option v-for="(l, k) in memoryKindLabel" :key="k" :value="k">{{ l }}</option></select>
      <select v-model="status" class="select"><option value="active">当前有效</option><option value="all">包括历史</option><option value="superseded">已被更正</option><option value="retracted">已撤回</option></select>
      <select v-model="scope" class="select"><option value="all">所有空间</option><option value="space">当前空间</option></select>
    </div>

    <div v-if="!memories.length" class="empty">
      <Icon name="brain" :size="34" />
      <h3>还没有记忆</h3>
      <p>在问答里告诉助理一件事（“记住：…”），或保存聊天和文档让助理整理，长期有用的内容会出现在这里。</p>
    </div>

    <section v-for="[subject, ms] in groups" :key="subject" class="group">
      <h2 class="subject">{{ subject }}</h2>
      <div v-for="m in ms" :key="m.id" class="mem" :class="m.status">
        <div class="row head small">
          <span class="badge" :class="{ accent: m.kind === 'agreement' || m.kind === 'decision' }">{{ memoryKindLabel[m.kind] ?? m.kind }}</span>
          <span v-if="m.status !== 'active'" class="badge warn">{{ statusLabel[m.status] }}</span>
          <span v-if="m.supersedes" class="badge">有更早版本</span>
          <span class="muted">{{ fmtTime(m.validFrom, false) }}{{ m.validTo ? ` → ${fmtTime(m.validTo, false)}` : " 起" }}</span>
          <span v-if="m.spaceId !== 'personal'" class="muted">· {{ m.spaceId }}</span>
          <span class="spacer" />
          <div class="actions row">
            <button v-if="m.supersedes || m.supersededBy" class="btn ghost sm" @click="openCitation({ kind: 'memory', id: m.id }, true)"><Icon name="history" :size="14" />演变</button>
            <button v-if="m.sourceRefs.length" class="btn ghost sm" @click="openCitation({ kind: 'memory', id: m.id }, true)"><Icon name="quote" :size="14" />依据</button>
            <button v-if="m.status === 'active'" class="btn ghost sm" @click="startEdit(m)"><Icon name="edit" :size="14" />更正</button>
            <button v-if="m.status === 'active'" class="btn ghost sm icon" title="撤回" @click="retract(m)"><Icon name="trash" :size="14" /></button>
          </div>
        </div>
        <div v-if="editing === m.id" class="edit">
          <textarea v-model="editText" class="textarea" rows="2" />
          <div class="row"><span class="muted small">保存后旧内容标记为“已被更正”。</span><span class="spacer" /><button class="btn sm" @click="editing = null">取消</button><button class="btn primary sm" @click="supersede(m)">保存更正</button></div>
        </div>
        <p v-else class="content">{{ m.content }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.add {
  display: grid;
  gap: 10px;
  margin-bottom: 18px;
}
.filters {
  margin-bottom: 20px;
  gap: 8px;
}
.filters .select {
  width: auto;
}
.search {
  flex: 1;
  min-width: 200px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 0 10px;
  background: var(--panel);
  color: var(--muted);
}
.search input {
  flex: 1;
  border: 0;
  outline: 0;
  background: none;
  padding: 7px 0;
  color: var(--ink);
}
.group {
  margin-bottom: 26px;
}
.subject {
  font-size: 15px;
  font-weight: 650;
  margin-bottom: 8px;
}
.mem {
  border-top: 1px solid var(--line);
  padding: 10px 0;
}
.head {
  gap: 6px;
}
.actions {
  opacity: 0.6;
  gap: 0;
}
.mem:hover .actions {
  opacity: 1;
}
.content {
  margin: 6px 0 0;
  font-size: 15px;
  line-height: 1.7;
}
.mem.superseded .content,
.mem.retracted .content {
  color: var(--muted);
  text-decoration: line-through;
}
.edit {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}
</style>
