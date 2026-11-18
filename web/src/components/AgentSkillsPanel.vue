<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get, post, put } from "../api";
import { confirmDialog } from "../lib/dialog";
import { toast } from "../store";
import UiCheckbox from "./UiCheckbox.vue";
import Skeleton from "./Skeleton.vue";

/**
 * Agent 自带的技能（src/agents/agent-skills.ts）：Codex、Claude Code 等 Agent 的技能目录里别的工具装进去的
 * 技能由 omem 接管，目录里只留 omem 说明和每个分组的总入口。
 */
type Dir = { path: string; agents: string[]; write: boolean; exists: boolean; skills: number };
type Sweep = { at: string; adopted: string[]; updated: string[]; conflicts: string[]; removed: number; backup?: string; dryRun: boolean; entries?: { dir: string; written: string[]; removed: string[] }[] };
type Status = { takeOver: boolean; autoOrganize: boolean; pending: number; everyMinutes: number; dirs: Dir[]; last: Sweep | null; backups: string[] };

const emit = defineEmits<{ changed: [] }>();
const status = ref<Status | null>(null);
const busy = ref(false);
const preview = ref<Sweep | null>(null);

async function load() {
  status.value = (await get<{ takeOver: Status }>("/api/skill-groups")).takeOver;
}
onMounted(() => void load().catch((e) => toast((e as Error).message)));

const waiting = computed(() => status.value?.dirs.reduce((n, d) => n + d.skills, 0) ?? 0);
const stamp = (s: string) => new Date(s).toLocaleString();

async function setOn(on: boolean) {
  if (on && !(await confirmDialog("接管 Agent 自带的技能？", { message: `这些目录里的 ${waiting.value} 个技能会移进 omem 的库（原件备份，可还原），目录里只留 omem 说明和每个分组的总入口；之后新装进来的每 ${status.value?.everyMinutes ?? 10} 分钟收一次。不经 omem 直接用 Claude Code、Codex 时也只看到这些。`, okText: "接管" }))) return;
  busy.value = true;
  try {
    status.value = await put<Status>("/api/agent-skills/settings", { takeOver: on });
    toast(on ? "已接管" : "已关闭，目录里的总入口保留");
    emit("changed");
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = false;
  }
}

async function setAuto(on: boolean) {
  busy.value = true;
  try {
    status.value = await put<Status>("/api/agent-skills/settings", { autoOrganize: on });
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = false;
  }
}

async function organizeNow() {
  busy.value = true;
  try {
    await post("/api/agent-skills/organize", {});
    toast("已交给后台整理，完成后会通知你");
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = false;
  }
}

async function dryRun() {
  busy.value = true;
  try {
    preview.value = await post<Sweep>("/api/agent-skills/sweep", { dryRun: true });
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = false;
  }
}

async function sweep() {
  busy.value = true;
  try {
    const r = await post<Sweep>("/api/agent-skills/sweep", {});
    toast(`新收 ${r.adopted.length} 个，更新 ${r.updated.length} 个`);
    preview.value = null;
    await load();
    emit("changed");
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = false;
  }
}

async function restore() {
  const latest = status.value?.backups[0];
  if (!latest || !(await confirmDialog("撤销最近一次收取？", { message: `把 ${stamp(latest.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z"))} 移走的原件放回各 Agent 目录，去掉 omem 写的入口，并关闭接管。技能仍留在 omem 的库里。`, okText: "还原", danger: true }))) return;
  busy.value = true;
  try {
    const r = await post<{ restored: string[]; kept: string[] }>("/api/agent-skills/restore", {});
    toast(`放回 ${r.restored.length} 项${r.kept.length ? `，${r.kept.length} 项原处已有东西没动` : ""}`);
    await load();
    emit("changed");
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="agent-skills">
    <h3>Agent 自带的技能</h3>
    <p class="muted small">别的工具往 Codex、Claude Code 等 Agent 的技能目录里装了很多技能时，每个 Agent 都背着全部说明，命令行会截断，模型看不清每个是做什么的。接管后它们移进 omem 的库、按分组管理，目录里只留 omem 说明和每个分组一个总入口，Agent 先读总入口再按用途找到具体技能。</p>
    <Skeleton v-if="!status" variant="lines" :rows="4" />
    <template v-else>
      <UiCheckbox :model-value="status.takeOver" switch :disabled="busy" @change="setOn">接管（每 {{ status.everyMinutes }} 分钟收一次新装进来的）</UiCheckbox>
      <UiCheckbox :model-value="status.autoOrganize" switch :disabled="busy" @change="setAuto">自动整理分组</UiCheckbox>
      <p class="muted small">新收进来的技能、上游更新后说明变了的技能，以及你自己的技能里没分组的攒到一定数量时，交给后台的技能整理角色放进合适的分组和用途，必要时新建分组、补写说明，做完发一条通知。你手动移动过的技能、改过的分组说明，它不会再动。<template v-if="status.pending"> 现在有 {{ status.pending }} 个技能等着整理。</template></p>
      <ul class="dirs small">
        <li v-for="d in status.dirs" :key="d.path">
          <code>{{ d.path }}</code>
          <span class="muted"> · {{ d.agents.join("、") || "额外目录" }}<template v-if="d.write"> · 写入总入口</template><template v-if="!d.exists"> · 不存在</template><template v-else-if="d.skills"> · {{ d.skills }} 个未接管</template></span>
        </li>
      </ul>
      <p v-if="status.last" class="muted small">上次收取 {{ stamp(status.last.at) }}：新收 {{ status.last.adopted.length }}，更新 {{ status.last.updated.length }}<template v-if="status.last.conflicts.length">，库里已有同名的 {{ status.last.conflicts.length }} 个保留库里的</template></p>
      <div class="row wrap">
        <button class="btn sm" :disabled="busy" @click="dryRun">看看会收哪些</button>
        <button class="btn sm" :disabled="busy || !waiting" @click="sweep">现在收一次</button>
        <button class="btn sm" :disabled="busy || !status.pending" @click="organizeNow">现在整理</button>
        <button v-if="status.backups.length" class="btn ghost sm danger" :disabled="busy" @click="restore">撤销最近一次</button>
      </div>
      <div v-if="preview" class="preview small">
        <p>会新收 {{ preview.adopted.length }} 个、更新 {{ preview.updated.length }} 个，从目录移走 {{ preview.removed }} 项<template v-if="preview.conflicts.length">；库里已有同名的保留库里的：{{ preview.conflicts.join("、") }}</template>。</p>
        <p v-for="e in preview.entries ?? []" :key="e.dir" class="muted"><code>{{ e.dir }}</code> 会留下：{{ e.written.join("、") }}</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.agent-skills { text-align: left; max-width: 640px; margin: 24px auto 0; display: grid; gap: 10px; }
.agent-skills h3 { margin: 0; }
.agent-skills p { max-width: none; margin: 0; text-align: left; }
.dirs { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
.dirs code, .preview code { overflow-wrap: anywhere; }
.preview { border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; }
.preview p { margin: 4px 0; }
</style>
