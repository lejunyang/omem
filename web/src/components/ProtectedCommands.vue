<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get, put } from "../api";
import { toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import { commandSummary, draftOf, parseCommand, type CommandDraft, type ProtectedCommand } from "../lib/protected-commands";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";

/**
 * 设置 → 安全 → 运行的沙箱 → 你登记的命令 (`GET` / `PUT /api/security/protected-commands`): command-line tools
 * the owner adds without a credential plugin. In the sandbox their login directories are hidden and a call runs
 * in the executor with this identity's login. The whole list is saved at once; the server's refusal stays in
 * the form. Reading and saving need the owner's own login (not a local request), and the server says so.
 */
const commands = ref<ProtectedCommand[] | null>(null);
const loadError = ref("");
/** Refused for who is asking (a request from this machine without the owner's login): said plainly, nothing to retry. */
const refused = ref("");
/** The entry being edited (its name), `""` for a new one, `null` when the form is closed. */
const editing = ref<string | null>(null);
const draft = ref<CommandDraft>(draftOf());
const formError = ref("");
const busy = ref(false);

async function load() {
  loadError.value = "";
  try {
    commands.value = (await get<{ commands: ProtectedCommand[] }>("/api/security/protected-commands")).commands;
  } catch (e) {
    if ((e as { status?: number }).status === 403) refused.value = (e as Error).message;
    else loadError.value = (e as Error).message;
  }
}
onMounted(load);

function open(c?: ProtectedCommand) {
  editing.value = c?.name ?? "";
  draft.value = draftOf(c);
  formError.value = "";
}
async function send(next: ProtectedCommand[]): Promise<string | null> {
  busy.value = true;
  try {
    commands.value = (await put<{ commands: ProtectedCommand[] }>("/api/security/protected-commands", { commands: next })).commands;
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function submit() {
  const list = commands.value ?? [];
  const others = list.filter((c) => c.name !== editing.value);
  const r = parseCommand(draft.value, others);
  if ("error" in r) return void (formError.value = r.error);
  const at = list.findIndex((c) => c.name === editing.value);
  const next = at >= 0 ? list.map((c, i) => (i === at ? r.command : c)) : [...list, r.command];
  const refused = await send(next);
  if (refused) return void (formError.value = refused);
  toast(at >= 0 ? `${r.command.name} 已保存` : `已登记 ${r.command.name}`, "ok");
  editing.value = null;
}
async function remove(c: ProtectedCommand) {
  if (!(await confirmDialog(`不再保护 ${c.name}？`, {
    message: "之后新起的运行里，它的登录目录不再遮住，调用也不再经执行器；操作规则里针对它的规则照常生效。",
    okText: "去掉", danger: true,
  }))) return;
  const refused = await send((commands.value ?? []).filter((x) => x.name !== c.name));
  if (refused) toast(`没有去掉：${refused}`, "error");
  else toast(`${c.name} 已去掉`, "ok");
}
</script>

<template>
  <div class="pc">
    <p v-if="refused" class="small muted">{{ refused }}（在本机直接打开的页面不算本人登录）。</p>
    <Skeleton v-else-if="!commands && !loadError" :rows="1" />
    <p v-else-if="loadError" class="sbx-err" role="alert">{{ loadError }} <button type="button" class="lnk small" @click="load">重试</button></p>
    <template v-else-if="commands">
      <ul v-if="commands.length" class="sbx-list" aria-label="你登记的命令">
        <li v-for="c in commands" :key="c.name" class="sbx-line">
          <span class="sbx-named mono">{{ c.name }}</span>
          <span class="sbx-aside" :title="commandSummary(c)">{{ commandSummary(c) }}</span>
          <button type="button" class="btn ghost sm" :disabled="busy" @click="open(c)">改</button>
          <button type="button" class="btn ghost sm icon" :disabled="busy" :aria-label="`不再保护 ${c.name}`" title="去掉" @click="remove(c)"><Icon name="x" :size="13" /></button>
        </li>
      </ul>
      <form v-if="editing !== null" class="pc-form" @submit.prevent="submit">
        <label class="pc-field">
          <span class="small muted">命令名</span>
          <input v-model="draft.name" class="input sm mono" placeholder="sample-cli" spellcheck="false" maxlength="100" aria-label="命令名" @input="formError = ''" />
        </label>
        <label class="pc-field">
          <span class="small muted">登录目录（主目录下，一行一个）</span>
          <textarea v-model="draft.state" class="input sm mono" rows="2" placeholder="~/.config/sample" spellcheck="false" aria-label="登录目录" @input="formError = ''" />
        </label>
        <label class="pc-field">
          <span class="small muted">登录变量（只写名字，逗号隔开）</span>
          <input v-model="draft.loginEnv" class="input sm mono" placeholder="SAMPLE_TOKEN" spellcheck="false" aria-label="登录变量" @input="formError = ''" />
        </label>
        <p v-if="formError" class="sbx-err" role="alert">{{ formError }}</p>
        <div class="pc-actions">
          <button class="btn sm" type="submit" :disabled="busy || !draft.name.trim()">{{ busy ? "保存中…" : "保存" }}</button>
          <button class="btn ghost sm" type="button" :disabled="busy" @click="editing = null">取消</button>
        </div>
      </form>
      <button v-else type="button" class="btn ghost sm pc-add" @click="open()"><Icon name="plus" :size="13" />登记一个命令</button>
    </template>
  </div>
</template>
