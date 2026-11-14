<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from "vue";
import { del, post, put } from "../api";
import { confirmDialog } from "../lib/dialog";
import { toast } from "../store";
import Skeleton from "./Skeleton.vue";
import VirtualList from "./VirtualList.vue";
import HelpText from "./HelpText.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
export type McpServer = { name: string; kind: "command" | "url"; description: string; command?: string; args: string[]; url?: string; readOnly: boolean; secrets: { name: string; set: boolean }[]; usedBy: string[] };
const props = defineProps<{ servers: McpServer[]; loading?: boolean; error?: string }>();
const emit = defineEmits<{ changed: []; dirty: [on: boolean] }>();
type Secret = { name: string; value: string | null; set: boolean };
const editor = ref<null | { creating: boolean; name: string; kind: "command" | "url"; description: string; command: string; args: string; url: string; readOnly: boolean; secrets: Secret[] }>(null);
const editorEl = ref<HTMLFormElement | null>(null);
let opener: HTMLElement | null = null;
let active = true;
const testSeq = new Map<string, number>();
onBeforeUnmount(() => { active = false; });
const busy = ref(false);
const error = ref("");
const tests = ref<Record<string, { busy?: boolean; error?: string; tools?: { name: string; description?: string }[] }>>({});
async function edit(server?: McpServer) {
  opener = document.activeElement as HTMLElement | null;
  if (server) { testSeq.set(server.name, (testSeq.get(server.name) ?? 0) + 1); delete tests.value[server.name]; }
  editor.value = { creating: !server, name: server?.name ?? "", kind: server?.kind ?? "command", description: server?.description ?? "", command: server?.command ?? "", args: server?.args.join("\n") ?? "", url: server?.url ?? "", readOnly: server?.readOnly ?? false, secrets: server?.secrets.map((s) => ({ name: s.name, value: s.set ? null : "", set: s.set })) ?? [] };
  error.value = "";
  emit("dirty", true);
  await nextTick();
  editorEl.value?.scrollIntoView({ block: "nearest" });
  editorEl.value?.querySelector("input")?.focus();
}
function cancel() { editor.value = null; error.value = ""; emit("dirty", false); void nextTick(() => opener?.isConnected && opener.focus()); }
async function save() {
  const draft = editor.value;
  if (!draft) return;
  const names = draft.secrets.map((s) => s.name.trim());
  if (names.some((s) => !s) || new Set(names).size !== names.length) { error.value = "密钥名称不能为空或重复"; return; }
  busy.value = true; error.value = "";
  try {
    await put(`/api/mcp/${encodeURIComponent(draft.name)}`, { description: draft.description, readOnly: draft.readOnly,
      ...(draft.kind === "command" ? { command: draft.command, args: draft.args.split("\n").filter((s) => s.trim()) } : { url: draft.url }),
      secrets: Object.fromEntries(draft.secrets.map((s) => [s.name.trim(), s.value])) });
    delete tests.value[draft.name];
    cancel(); emit("changed"); toast("MCP 服务已保存", "ok");
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function remove(server: McpServer) {
  if (!(await confirmDialog(`删除 ${server.name}？`, { message: server.usedBy.length ? `仍在使用：${server.usedBy.join("、")}。删除后这些档案和角色不再获得此服务；密钥也会删除。` : "服务和保存的密钥一起删除。", okText: "删除", danger: true }))) return;
  try { await del(`/api/mcp/${encodeURIComponent(server.name)}`); delete tests.value[server.name]; emit("changed"); }
  catch (e) { toast((e as Error).message, "error"); }
}
async function test(server: McpServer) {
  const seq = (testSeq.get(server.name) ?? 0) + 1;
  testSeq.set(server.name, seq);
  const current = () => active && testSeq.get(server.name) === seq;
  const state = { busy: true } as { busy?: boolean; error?: string; tools?: { name: string; description?: string }[] };
  tests.value[server.name] = state;
  try {
    const result = await post<{ ok: boolean; error?: string; tools?: { name: string; description?: string }[] }>(`/api/mcp/${encodeURIComponent(server.name)}/test`);
    if (current()) tests.value[server.name] = result.ok ? { tools: result.tools ?? [] } : { error: result.error };
  } catch (e) { if (current()) tests.value[server.name] = { error: (e as Error).message }; }
}
</script>
<template>
  <div class="stack mcp-services">
    <div class="row wrap"><h2>MCP 服务</h2><span class="spacer" /><button class="btn primary sm" :disabled="!!editor || loading || !!props.error" @click="edit()">添加</button></div>
    <HelpText>MCP 服务在这里配置一次，再到各个档案或内置角色里勾选；环境变量和请求头的值按密钥保存，保存后不再显示；只有你自己的运行会带上这些服务，访客、其他成员的运行和评审项不带。</HelpText>
    <Skeleton v-if="loading" :rows="4" />
    <p v-else-if="props.error" class="error" role="alert">{{ props.error }} <button class="btn ghost sm" @click="emit('changed')">重试</button></p>
    <p v-else-if="!servers.length" class="muted">还没有 MCP 服务，点“添加”配置一个。</p>
    <article v-for="server in servers" :key="server.name" class="card pad stack">
      <div class="row wrap"><strong>{{ server.name }}</strong><span class="badge">{{ server.kind === 'command' ? '命令' : '网址' }}</span><span v-if="server.readOnly" class="badge">只读</span></div>
      <p>{{ server.description }}</p><p class="small muted mono">{{ server.command || server.url }}</p>
      <p class="small muted">用到它的档案和角色：{{ server.usedBy.join('、') || '暂无' }}</p>
      <div class="row wrap"><button class="btn ghost sm" :disabled="!!editor" @click="edit(server)">编辑</button><button class="btn ghost sm" :disabled="tests[server.name]?.busy || !!editor" @click="test(server)">{{ tests[server.name]?.busy ? '检测中…' : '检测' }}</button><button class="btn danger sm" :disabled="!!editor || tests[server.name]?.busy" @click="remove(server)">删除</button></div>
      <p v-if="tests[server.name]?.error" class="error" role="alert">{{ tests[server.name]?.error }}</p>
      <div v-if="tests[server.name]?.tools" class="small"><p>检测通过 · {{ tests[server.name]?.tools?.length }} 个工具</p><VirtualList :items="tests[server.name]?.tools ?? []" :item-key="(tool) => tool.name" :estimate="36"><template #default="{ item: tool }"><p><strong>{{ tool.name }}</strong><span v-if="tool.description"> · {{ tool.description }}</span></p></template></VirtualList></div>
    </article>
    <form v-if="editor" ref="editorEl" class="card pad stack" @submit.prevent="save" @input="emit('dirty', true)">
      <h3>{{ editor.creating ? '添加 MCP 服务' : `编辑 ${editor.name}` }}</h3>
      <label v-if="editor.creating" class="field"><span>名称</span><input v-model="editor.name" class="input" required pattern="[a-z][a-z0-9-]{0,39}" maxlength="40" placeholder="例如 docs-search" /><small class="muted">小写字母开头，可用数字和连字符</small></label>
      <UiSegmented v-model="editor.kind" aria-label="连接方式" :disabled="busy" :options="[{ value: 'command', label: '命令' }, { value: 'url', label: '网址' }]" @change="editor.secrets = []" />
      <template v-if="editor.kind === 'command'"><label class="field"><span>启动命令</span><input v-model="editor.command" class="input mono" required placeholder="例如 npx" /></label><label class="field"><span>参数（一行一个）</span><textarea v-model="editor.args" class="textarea mono" rows="3" /></label></template>
      <label v-else class="field"><span>网址</span><input v-model="editor.url" class="input mono" type="url" required placeholder="https://example.com/mcp" /></label>
      <label class="field"><span>说明</span><textarea v-model="editor.description" class="textarea" rows="2" /></label>
      <div class="field"><strong>{{ editor.kind === 'command' ? '环境变量' : '请求头' }}</strong>
        <div v-for="(secret, i) in editor.secrets" :key="i" class="secret-row">
          <input v-model="secret.name" class="input mono" :readonly="secret.value === null" :aria-label="`密钥名称 ${i + 1}`" placeholder="名称" required />
          <div v-if="secret.value === null" class="row wrap"><span class="muted">已设置</span><button type="button" class="btn ghost sm" @click="secret.value = ''">改</button></div>
          <input v-else v-model="secret.value" class="input" type="password" autocomplete="new-password" :aria-label="`密钥值 ${i + 1}`" placeholder="值（保存后不再显示）" required />
          <button type="button" class="btn ghost sm" :aria-label="`移除密钥 ${i + 1}`" @click="editor.secrets.splice(i, 1)">移除</button>
        </div>
        <button type="button" class="btn ghost sm" @click="editor.secrets.push({ name: '', value: '', set: false })">添加{{ editor.kind === 'command' ? '环境变量' : '请求头' }}</button>
      </div>
      <UiCheckbox v-model="editor.readOnly" aria-label="只读（只查不写；夜间复盘只会用标了只读的）" switch>只读（只查不写；夜间复盘只会用标了只读的）</UiCheckbox>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="row wrap"><button class="btn primary sm" :disabled="busy">{{ busy ? '保存中…' : '保存' }}</button><button type="button" class="btn ghost sm" :disabled="busy" @click="cancel">取消</button></div>
    </form>
  </div>
</template>
<style scoped>
.mcp-services { max-width: 860px; min-width: 0; overflow-wrap: anywhere; padding: 20px; margin: 0 auto; }
.secret-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 8px; align-items: center; }
.mcp-services input, .mcp-services textarea { min-width: 0; width: 100%; }
@media (max-width: 760px) { .secret-row { grid-template-columns: minmax(0, 1fr); } .mcp-services { padding: 12px; } }
</style>
