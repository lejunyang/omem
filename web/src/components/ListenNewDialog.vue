<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { post } from "../api";
import { toast } from "../store";
import { lines, REPLY_OPTIONS, type ListenKnobs, type ListenView } from "../lib/listen";
import Icon from "./Icon.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * A new 关注 (POST /api/listen): which groups, its name, what the owner wants from it, whether it
 * replies, and — when it does — the brief (what to handle, what to leave, what a reply must have).
 */
const props = defineProps<{ groups: { value: string; label: string; hint?: string }[]; preset?: string[] }>();
const emit = defineEmits<{ close: []; created: [view: ListenView] }>();

const form = reactive({ chats: [...(props.preset ?? [])] as string[], name: "", note: "", reply: "draft" as ListenKnobs["reply"], handle: "", skip: "", valid: "" });
const needsBrief = computed(() => form.reply !== "none");
const tooMany = computed(() => lines(form.handle).length > 12 || lines(form.skip).length > 12);
const ready = computed(() => form.chats.length > 0 && (!needsBrief.value || lines(form.handle).length > 0) && !tooMany.value);
const missing = computed(() => (!form.chats.length ? "先选至少一个群" : needsBrief.value && !lines(form.handle).length ? "要在群里回复，先写要处理哪些消息（或选“只看不回”）" : tooMany.value ? "每栏最多 12 条" : ""));
const busy = ref(false);

async function submit() {
  if (!ready.value || busy.value) return;
  busy.value = true;
  const handle = lines(form.handle), skip = lines(form.skip), valid = form.valid.trim();
  try {
    const v = await post<ListenView>("/api/listen", {
      chats: form.chats,
      ...(form.name.trim() ? { name: form.name.trim() } : {}),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
      ...(handle.length || skip.length || valid ? { brief: { handle, skip, valid } } : {}),
      knobs: { reply: form.reply },
    });
    toast(`开始关注：${v.name}`, "ok");
    emit("created", v);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}

const box = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") (e.preventDefault(), emit("close"));
}
onMounted(async () => {
  returnFocus = document.activeElement as HTMLElement | null;
  await nextTick();
  box.value?.querySelector<HTMLElement>(props.preset?.length ? "input" : "button.ui-select")?.focus();
});
onBeforeUnmount(() => returnFocus?.focus?.());
</script>

<template>
  <Teleport to="body">
    <div class="ln-scrim" @mousedown.self="emit('close')" @keydown="onKey">
      <form ref="box" class="ln-dialog" role="dialog" aria-modal="true" aria-labelledby="ln-title" @submit.prevent="submit">
        <div class="row">
          <h3 id="ln-title" class="spacer">新建关注</h3>
          <button type="button" class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="15" /></button>
        </div>
        <p class="muted small lead">选几个群让助手替你看着：它把这些群放在同一个上下文里读，按你写的说明处理，在群里拟草稿或直接回。</p>
        <div class="field">
          <span>哪些群</span>
          <UiSelect v-model="form.chats" multiple :options="groups" placeholder="从已采集的群里选" aria-label="关注哪些群" :search-at="6" />
          <span class="hint">只列出已经采集到的群；没看到的先在 设置 → 连接 的飞书会话里订阅。</span>
        </div>
        <label class="field"><span>名字（可选）</span><input v-model="form.name" class="input" maxlength="80" placeholder="不填就用群名" /></label>
        <label class="field"><span>你想让它做什么（可选）</span><textarea v-model="form.note" class="textarea" rows="2" maxlength="2000" placeholder="例如：值班群里问接口报错的先查日志再回，产品问排期的告诉我" /></label>
        <div class="field">
          <span>在群里回复</span>
          <UiSegmented v-model="form.reply" class="knob" size="sm" aria-label="在群里回复" :options="REPLY_OPTIONS" />
          <span class="hint">{{ form.reply === "none" ? "只读群里的消息、记下结论，不在群里发言。" : form.reply === "draft" ? "每条回复先变成只有你看得到的草稿卡片，你照发、改了再发或不发。" : "达到下面“值得发的结论”的回复直接发到群里。" }}</span>
        </div>
        <div class="brief">
          <label class="field"><span>要处理的{{ needsBrief ? "" : "（可选）" }}</span><textarea v-model="form.handle" class="textarea" rows="3" placeholder="一行一条，例如：&#10;接口报错、超时&#10;数据口径的问题" /></label>
          <label class="field"><span>不处理的（可选）</span><textarea v-model="form.skip" class="textarea" rows="3" placeholder="一行一条，例如：&#10;闲聊、团建通知&#10;要我拍板的事" /></label>
        </div>
        <label class="field"><span>值得发的结论（可选）</span><textarea v-model="form.valid" class="textarea short" rows="2" maxlength="600" placeholder="回复要有什么才发，例如：说清原因并带上日志或文档的出处；查不到就不回" /></label>
        <div class="row wrap actions">
          <span v-if="missing" class="small muted spacer">{{ missing }}</span>
          <span v-else class="spacer" />
          <button type="button" class="btn" @click="emit('close')">取消</button>
          <button type="submit" class="btn primary" :disabled="!ready || busy">开始关注</button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.ln-scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(15, 17, 20, 0.36);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 7vh 16px 16px;
  overflow-y: auto;
}
.ln-dialog {
  width: min(600px, 100%);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  padding: 18px 20px;
  display: grid;
  gap: 14px;
  min-width: 0;
}
h3 {
  margin: 0;
  font-size: 16px;
}
.lead {
  margin: -6px 0 0;
}
.brief {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.textarea {
  min-height: 0;
}
.knob {
  justify-self: start;
}
.actions {
  gap: 8px;
}
@media (max-width: 560px) {
  .ln-dialog {
    padding: 16px;
  }
  .brief {
    grid-template-columns: 1fr;
  }
}
</style>
