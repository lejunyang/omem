<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { connectionLabel, DEFAULT_LOCAL_URL } from "../shared/connections";
import type { OmemPeer } from "../shared/omem-client";
import type { OmemContext } from "./use-omem";

// 管理连接：列表（切换、重新登录、改名、删除）和新建（本机 / 远程地址 / 配对的设备）。
const props = defineProps<{ omem: OmemContext }>();
const emit = defineEmits<{ close: [] }>();

const { connections, activeId, pending } = props.omem;
const kind = ref<"local" | "remote" | "peer">(connections.value.length ? "remote" : "local");
const name = ref("");
const url = ref(DEFAULT_LOCAL_URL);
const via = ref("");
const peers = ref<OmemPeer[]>([]);
const peer = ref("");
const busy = ref(false);
const error = ref("");
const renaming = ref<string | null>(null);
const renameText = ref("");
const confirmRemove = ref<string | null>(null);

const directConnections = computed(() => connections.value.filter((item) => item.kind !== "peer" && item.token));

watch(kind, (value) => {
  error.value = "";
  if (value === "local") url.value = DEFAULT_LOCAL_URL;
  if (value === "remote") url.value = "";
  if (value === "peer" && !via.value) via.value = directConnections.value[0]?.id ?? "";
});

watch(via, async (value) => {
  peers.value = [];
  peer.value = "";
  if (!value || kind.value !== "peer") return;
  try {
    peers.value = await props.omem.listPeers(value);
    peer.value = peers.value[0]?.id ?? "";
  } catch (reason) {
    error.value = `读不到配对的设备：${(reason as Error).message}`;
  }
});

async function add(): Promise<void> {
  error.value = "";
  busy.value = true;
  try {
    if (kind.value === "peer") {
      if (!via.value || !peer.value) throw new Error("先选经过哪条连接、转到哪台设备");
      await props.omem.addPeer(via.value, peer.value, name.value);
    } else {
      await props.omem.addDirect(kind.value, name.value, url.value);
    }
    name.value = "";
    emit("close");
  } catch (reason) {
    error.value = (reason as Error).message;
  } finally {
    busy.value = false;
  }
}

async function relogin(id: string): Promise<void> {
  error.value = "";
  try {
    await props.omem.login(id);
  } catch (reason) {
    error.value = (reason as Error).message;
  }
}

function startRename(id: string, current: string): void {
  renaming.value = id;
  renameText.value = current;
}

async function finishRename(): Promise<void> {
  if (renaming.value) await props.omem.rename(renaming.value, renameText.value);
  renaming.value = null;
}

async function remove(id: string): Promise<void> {
  if (confirmRemove.value !== id) {
    confirmRemove.value = id;
    return;
  }
  confirmRemove.value = null;
  await props.omem.remove(id);
}
</script>

<template>
  <section class="connections" aria-label="omem 连接">
    <header class="connections-header">
      <strong>连接 omem</strong>
      <button class="button button-ghost" type="button" @click="emit('close')">完成</button>
    </header>

    <ul v-if="connections.length" class="connection-list">
      <li v-for="item in connections" :key="item.id" :class="{ 'is-active': item.id === activeId }">
        <button class="connection-pick" type="button" :aria-pressed="item.id === activeId" @click="omem.setActive(item.id)">
          <span class="connection-radio" aria-hidden="true" />
          <span class="connection-text">
            <input
              v-if="renaming === item.id"
              v-model="renameText"
              class="filter-input"
              aria-label="名称"
              @click.stop
              @keydown.enter.prevent="finishRename"
              @blur="finishRename"
            />
            <b v-else>{{ item.name }}</b>
            <small class="muted">{{ connectionLabel(item, connections) }}{{ item.user ? ` · ${item.user.name}` : "" }}</small>
          </span>
        </button>
        <div class="connection-actions">
          <button v-if="item.kind !== 'peer'" class="button button-ghost" type="button" @click="relogin(item.id)">{{ item.token ? "重新登录" : "登录" }}</button>
          <button class="button button-ghost" type="button" @click="startRename(item.id, item.name)">改名</button>
          <button class="button button-ghost" :class="{ 'button-danger': confirmRemove === item.id }" type="button" @click="remove(item.id)">
            {{ confirmRemove === item.id ? "确认删除" : "删除" }}
          </button>
        </div>
      </li>
    </ul>

    <div v-if="pending" class="login-pending" role="status">
      <strong>在打开的页面里点「允许」</strong>
      <span>确认码 <code>{{ pending.code }}</code>，和页面上显示的一致再允许。{{ pending.browserUser ? `浏览器里已登录为 ${pending.browserUser}，点一下即可。` : "浏览器里还没登录这个 omem，先登录再允许。" }}</span>
      <div class="login-pending-actions">
        <a :href="pending.url" target="_blank" rel="noreferrer">重新打开确认页</a>
        <button class="button button-ghost" type="button" @click="omem.cancelLogin()">取消</button>
      </div>
    </div>

    <form class="connection-form" @submit.prevent="add">
      <strong>添加连接</strong>
      <div class="segmented" role="radiogroup" aria-label="连接方式">
        <button type="button" role="radio" :aria-checked="kind === 'local'" :class="{ on: kind === 'local' }" @click="kind = 'local'">本机</button>
        <button type="button" role="radio" :aria-checked="kind === 'remote'" :class="{ on: kind === 'remote' }" @click="kind = 'remote'">远程地址</button>
        <button type="button" role="radio" :aria-checked="kind === 'peer'" :class="{ on: kind === 'peer' }" :disabled="!directConnections.length" :title="directConnections.length ? '' : '先添加并登录一条本机或远程连接'" @click="kind = 'peer'">配对的设备</button>
      </div>
      <p class="muted form-hint">
        {{
          kind === "local"
            ? "这台电脑上运行的 omem。连接时会打开 omem 的确认页，点「允许」后扩展拿到一个只给它用的令牌（账号页可以撤销）。"
            : kind === "remote"
              ? "填 omem 网页的地址（局域网或服务器）。浏览器里已经登录的话，确认页点一下「允许」就行。"
              : "经一条已登录的连接转到它配对的设备（omem peer 那套），不用在那台设备上单独登录。"
        }}
      </p>
      <label v-if="kind !== 'peer'" class="field">
        <span>地址</span>
        <input v-model="url" class="filter-input" :placeholder="kind === 'local' ? DEFAULT_LOCAL_URL : 'https://omem.example.com'" required />
      </label>
      <template v-else>
        <label class="field">
          <span>经过</span>
          <select v-model="via" class="preset-select">
            <option v-for="item in directConnections" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
        </label>
        <label class="field">
          <span>设备</span>
          <select v-model="peer" class="preset-select" :disabled="!peers.length">
            <option v-for="item in peers" :key="item.id" :value="item.id">{{ item.id }}{{ item.via ? `（经 ${item.via}）` : "" }}</option>
          </select>
        </label>
      </template>
      <label class="field">
        <span>名称</span>
        <input v-model="name" class="filter-input" placeholder="可不填" />
      </label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button class="button button-primary" type="submit" :disabled="busy">{{ busy ? "连接中…" : kind === "peer" ? "添加" : "连接并登录" }}</button>
    </form>
  </section>
</template>
