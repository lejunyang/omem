<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { del, get } from "../api";
import { fmtTime, toast } from "../store";
import { confirmDialog } from "../lib/dialog";
import { settingsKey } from "../lib/caps";
import { STATE_LABEL, expiryText, lentTo, overviewLines, stateTone, type CredentialOverview } from "../lib/credentials";
import { settingsContext } from "../views/settings/ctx";
import SetCard from "./SetCard.vue";
import Skeleton from "./Skeleton.vue";

/**
 * 设置 → 成员 → 成员的凭据 (`GET /api/credentials/all`, docs/v2/credentials.md): who logged in to which
 * credential, until when, and who may borrow it — one line per person and kind, the ones expired or about
 * to be first; logging a member out of one (`DELETE /api/credentials/:user/:kind`). The owner's only (the
 * interface answers nobody else); nothing shows when no plugin registered a credential.
 */
const props = defineProps<{ /** Display names by user id (the member list above). */ names?: Record<string, string> }>();
const data = ref<CredentialOverview | null>(null);
const failed = ref("");
const gone = ref(false);
const query = ref("");
const may = computed(() => settingsKey("credentials").edit);
async function load() {
  if (!may.value) return;
  failed.value = "";
  try {
    data.value = await get<CredentialOverview>("/api/credentials/all");
  } catch (e) {
    // A server without credentials (older than the first phase) has no such interface: nothing to show.
    if ((e as { status?: number }).status === 404) gone.value = true;
    else failed.value = (e as Error).message;
  }
}
onMounted(load);

const ctx = settingsContext();
const lending = computed(() => ctx?.config.value?.credentials?.lending as string | undefined);
const nameOf = (id: string) => props.names?.[id] ?? data.value?.people.find((p) => p.userId === id)?.name ?? id;
const several = computed(() => (data.value?.kinds.length ?? 0) > 1);
const lines = computed(() => (data.value ? overviewLines(data.value, query.value) : []));
const people = computed(() => data.value?.people.length ?? 0);
const fullTime = (ms?: number) => (ms === undefined ? "" : fmtTime(new Date(ms).toISOString()));

async function logOut(userId: string, person: string, kind: string, name: string) {
  if (!(await confirmDialog(`让 ${person} 退出 ${name}`, { message: `${person} 在这台机器上的 ${name} 登录和它供给的后端、命令行一起退出，登录文件删除；借他这份登录的同事也用不了了。他之后可以在自己的账号页重新登录。`, okText: "退出", danger: true }))) return;
  try {
    await del(`/api/credentials/${encodeURIComponent(userId)}/${encodeURIComponent(kind)}`);
    toast(`${person} 已退出 ${name}`, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
  await load();
}
</script>

<template>
  <SetCard v-if="may && !gone && (failed || !data || data.kinds.length)" id="set-credential-holds" title="成员的凭据" :keys="['credentials']">
    <template #help>各人在账号页登录的凭据：到哪天、借给了谁。快到期和过期的排在前面，替他退出会把这份登录供给的后端和命令行一起退出。</template>
    <template #aside><span v-if="data" class="muted small">{{ people }} 人</span></template>
    <div v-if="failed" class="set-pad small" role="alert">读不到：{{ failed }} <button class="btn ghost sm" @click="load">重试</button></div>
    <Skeleton v-else-if="!data" variant="list" :rows="3" />
    <template v-else>
      <div v-if="lending === 'off' || people > 8" class="set-pad hd">
        <input v-if="people > 8" v-model="query" class="input sm" type="search" placeholder="按名字找" aria-label="按名字找成员的凭据" />
        <span v-if="lending === 'off'" class="small muted">出借现在关着（安全 → 凭据的出借），“谁能借”暂不生效。</span>
      </div>
      <p v-if="!data.people.length" class="set-pad small muted">还没有人登录凭据。成员在自己的账号页登录后会出现在这里。</p>
      <p v-else-if="!lines.length" class="set-pad small muted">没有名字里带“{{ query.trim() }}”的人。</p>
      <ul v-else class="holds" aria-label="成员的凭据">
        <li v-for="l in lines" :key="l.key" class="hold" :class="{ first: l.first, several }">
          <span class="h-who ellipsis" :title="l.person.name">{{ l.first ? l.person.name : "" }}</span>
          <span v-if="several" class="h-kind ellipsis" :title="l.c.describe">{{ l.c.name }}</span>
          <span class="h-state" :class="stateTone(l.c.state)"><span class="dot" aria-hidden="true" />{{ STATE_LABEL[l.c.state] }}</span>
          <span class="h-when ellipsis" :title="fullTime(l.c.expiresAt)">{{ expiryText(l.c) || (l.c.machine ? "这台机器的登录" : "") }}</span>
          <span class="h-lend ellipsis" :title="lentTo(l.c.sharing, nameOf)">{{ lentTo(l.c.sharing, nameOf) }}</span>
          <span class="h-ops">
            <button v-if="!l.c.machine && l.c.state !== 'none'" class="btn ghost sm danger" :aria-label="`让 ${l.person.name} 退出 ${l.c.name}`" @click="logOut(l.person.userId, l.person.name, l.c.kind, l.c.name)">替他退出</button>
          </span>
        </li>
      </ul>
      <p v-if="data.people.length * data.kinds.length >= data.limit" class="set-pad small muted">只列了前 {{ data.limit }} 份。</p>
    </template>
  </SetCard>
</template>

<style scoped>
.hd {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.hd .input {
  flex: 0 1 220px;
  min-width: 0;
}
.holds {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--line);
}
/* One line per person and kind; a person's first line carries the name and the rule above it. */
.hold {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) 76px minmax(0, 0.9fr) minmax(0, 1.2fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 4px 18px;
  min-width: 0;
  font-size: 13px;
}
.hold.several {
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1fr) 76px minmax(0, 0.9fr) minmax(0, 1.2fr) auto;
}
.hold.first:not(:first-child) {
  border-top: 1px solid var(--line);
}
.h-who {
  font-size: 14px;
  color: var(--ink);
}
.h-kind {
  color: var(--ink-2);
}
.h-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-2);
  white-space: nowrap;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--line-strong);
  flex: none;
}
.h-state.ok .dot { background: var(--ok); }
.h-state.warn { color: var(--warn); }
.h-state.warn .dot { background: var(--warn); }
.h-state.danger { color: var(--danger); }
.h-state.danger .dot { background: var(--danger); }
.h-state.accent { color: var(--accent); }
.h-state.accent .dot { background: var(--accent); }
.h-when {
  font-size: 12px;
  color: var(--muted);
}
.h-lend {
  color: var(--ink-2);
}
.h-ops {
  display: flex;
  justify-content: flex-end;
  min-width: 76px;
}
/* Narrow: the name on a line of its own, then kind, state and end, then who may borrow it and the button. */
@media (max-width: 640px) {
  .hold,
  .hold.several {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    padding: 8px 14px;
  }
  .h-who {
    flex: 1 1 100%;
  }
  .h-who:empty {
    display: none;
  }
  .h-lend {
    flex: 1 1 140px;
    min-width: 0;
  }
  .h-ops {
    min-width: 0;
    margin-left: auto;
  }
}
</style>
