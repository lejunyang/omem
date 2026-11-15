<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { del, get, post, put } from "../api";
import { confirmDialog } from "../lib/dialog";
import { toast } from "../store";
import Skeleton from "./Skeleton.vue";
import VirtualList from "./VirtualList.vue";

type Lesson = { id: string; text: string; pattern: string | null; paths: string | null; state: "proposed" | "on" | "off"; hits: number; evidence: { run: string; title: string; finding?: number; note?: string }[] };
const props = defineProps<{ space: string }>();
const lessons = ref<Lesson[]>([]);
const loading = ref(true);
const error = ref("");
const busy = ref(false);
const editing = ref<string | null>(null);
const draft = ref({ text: "", pattern: "", paths: "" });
const stateLabel = { proposed: "待启用", on: "已启用", off: "已关闭" };
let request = 0;
let alive = true;
onBeforeUnmount(() => { alive = false; request++; });
const url = (space: string) => `/api/spaces/${encodeURIComponent(space)}/lessons`;
async function load(space: string) {
  const seq = ++request;
  loading.value = true; error.value = ""; lessons.value = []; editing.value = null;
  try { const data = await get<Lesson[]>(url(space)); if (seq === request && alive && space === props.space) lessons.value = data; }
  catch (e) { if (seq === request) error.value = (e as Error).message; }
  finally { if (seq === request) loading.value = false; }
}
watch(() => props.space, load, { immediate: true });
function edit(lesson?: Lesson) {
  editing.value = lesson?.id ?? "new";
  draft.value = { text: lesson?.text ?? "", pattern: lesson?.pattern ?? "", paths: lesson?.paths ?? "" };
}
async function mutate(action: (space: string) => Promise<unknown>) {
  if (busy.value) return;
  const space = props.space;
  busy.value = true;
  try { await action(space); if (alive && space === props.space) { await load(space); toast("已保存"); } }
  catch (e) { if (alive && space === props.space) toast((e as Error).message); }
  finally { busy.value = false; }
}
function save() {
  const id = editing.value;
  const original = lessons.value.find(l => l.id === id);
  const body = { ...draft.value, pattern: draft.value.pattern || null, paths: draft.value.paths || null };
  void mutate(space => id === "new" ? post(url(space), body) : put(`${url(space)}/${id}`, { ...body, state: original?.state ?? "on" }));
}
function toggle(lesson: Lesson) { void mutate(space => put(`${url(space)}/${lesson.id}`, { ...lesson, state: lesson.state === "on" ? "off" : "on" })); }
async function remove(lesson: Lesson) {
  const space = props.space;
  if (await confirmDialog("删除这条约定？", { message: lesson.text, danger: true }) && alive && space === props.space) void mutate(s => del(`${url(s)}/${lesson.id}`));
}
</script>

<template>
  <section class="stack repo-lessons">
    <div class="row wrap"><strong>学到的约定</strong><button type="button" class="btn sm" :disabled="busy || loading" @click="edit()">手动添加</button></div>
    <p class="hint">同类问题在两次交办里出现后默认启用。有模式的只检查每轮新增的行；所有启用的约定都会交给编码和评审。手动添加立即启用。</p>
    <Skeleton v-if="loading" :rows="3" />
    <p v-else-if="error" role="alert">{{ error }} <button type="button" class="btn sm" @click="load(space)">重试</button></p>
    <template v-else>
      <p v-if="!lessons.length" class="muted small">还没有学到的约定。可以手动添加，或在后续评审中积累。</p>
      <VirtualList :items="lessons" :item-key="l => l.id" :estimate="180">
        <template #default="{ item: l }">
          <article class="lesson stack">
            <p>{{ l.text }}</p>
            <div class="row wrap small"><span class="badge">{{ stateLabel[l.state] }}</span><span class="muted">命中 {{ l.hits }} 次</span></div>
            <p v-if="l.pattern" class="mono small">模式：{{ l.pattern }}</p>
            <p v-if="l.paths" class="mono small">路径：{{ l.paths }}</p>
            <div class="row wrap small"><span class="muted">来自：</span><span v-if="!l.evidence.length">本人添加 / 尚无交办证据</span><router-link v-for="e in l.evidence" :key="e.run" :to="`/runs/${e.run}`" :title="e.note">{{ e.title }}{{ e.finding ? ` · #${e.finding}` : '' }}</router-link></div>
            <div class="row wrap"><button type="button" class="btn sm" :disabled="busy" @click="toggle(l)">{{ l.state === 'on' ? '关闭' : '启用' }}</button><button type="button" class="btn ghost sm" :disabled="busy" @click="edit(l)">编辑</button><button type="button" class="btn danger sm" :disabled="busy" @click="remove(l)">删除</button></div>
          </article>
        </template>
      </VirtualList>
    </template>
    <form v-if="editing" class="stack lesson-form" @submit.prevent="save">
      <strong>{{ editing === 'new' ? '添加约定' : '编辑约定' }}</strong>
      <label class="field"><span>一句话约定（10–200 字）</span><textarea v-model="draft.text" class="textarea" rows="2" minlength="10" maxlength="200" required /></label>
      <label class="field"><span>模式（可选，正则源码，不带标志）</span><input v-model="draft.pattern" class="input mono" maxlength="200" /></label>
      <label class="field"><span>适用路径（可选，逗号分隔 glob）</span><input v-model="draft.paths" class="input mono" maxlength="500" placeholder="src/**/*.ts" /></label>
      <div class="row wrap"><button type="submit" class="btn primary sm" :disabled="busy || draft.text.trim().length < 10">保存</button><button type="button" class="btn ghost sm" :disabled="busy" @click="editing = null">取消</button></div>
    </form>
  </section>
</template>

<style scoped>
.repo-lessons, .lesson, .lesson-form { min-width: 0; }
.lesson { padding: 12px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.lesson p { margin: 0; }
.lesson a { max-width: 100%; overflow-wrap: anywhere; }
.lesson-form { padding-top: 12px; }
</style>
