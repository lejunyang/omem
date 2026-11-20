<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { demoAbout, demoCountsText, demoElapsed, organizeChoices } from "../shared/demo";
import type { RecordingTarget } from "../shared/omem-client";
import type { DemoContext } from "./use-demo";
import type { OmemContext } from "./use-omem";

// 侧栏顶部的「演示」：没在演示时是一个按钮，点开写要教什么、选连着的关注或事项；
// 演示中是一条醒目的横幅（计时、记下了什么、结束），拾取篮和录制的发送都改成记进这次演示。
// 只有 omem 的本人能演示（服务端也只认本人），别的账号不显示。

const props = defineProps<{ omem: OmemContext; demo: DemoContext }>();
const { current, ended, busy, error, now } = props.demo;

const isOwner = computed(() => props.omem.status.value.state === "ok" && props.omem.status.value.me.id === "owner");
const opening = ref(false);
const goal = ref("");
const target = ref("");
const targets = ref<RecordingTarget[]>([]);
const stopping = ref(false);

// 打开表单时读一次可以连着的关注和事项（读不到就只能不连）。
watch(opening, async (open) => {
  if (open && !targets.value.length) targets.value = await props.omem.recordingTargets().catch(() => []);
});
// 别处结束了演示：收起“结束”的选项。
watch(current, (demo) => {
  if (!demo) stopping.value = false;
});

const about = computed(() => (current.value ? demoAbout(current.value) : ""));
const choices = computed(() => (current.value ? organizeChoices(current.value) : []));
const link = computed(() => (current.value ? props.omem.webUrl(`/ask/${current.value.conversationId}`) : null));

async function start(): Promise<void> {
  if (!goal.value.trim()) return;
  if (await props.demo.start(goal.value, target.value)) {
    opening.value = false;
    goal.value = "";
    target.value = "";
  }
}

async function stop(organize: "skill" | "lessons" | "none"): Promise<void> {
  if (await props.demo.stop(organize)) stopping.value = false;
}
</script>

<template>
  <section v-if="isOwner" class="demo-bar" :class="{ 'is-live': current }" aria-label="演示" data-testid="demo-bar">
    <!-- 演示中 -->
    <template v-if="current">
      <div class="demo-live">
        <i class="demo-dot" aria-hidden="true" />
        <strong>演示中</strong>
        <span class="demo-goal" :title="current.goal">{{ current.goal }}</span>
        <span class="grow" />
        <span class="demo-time" data-testid="demo-elapsed">{{ demoElapsed(current.startedAt, now) }}</span>
      </div>
      <div class="demo-sub">
        <span v-if="about">{{ about }} · </span><span data-testid="demo-counts">{{ demoCountsText(current) }}</span>
        <a v-if="link" :href="link" target="_blank" rel="noreferrer">对话</a>
      </div>
      <p class="demo-tip">拾取和录制都记进这次演示；你在飞书里发的消息结束时一起收。</p>
      <div v-if="stopping" class="demo-actions">
        <button
          v-for="(choice, index) in choices"
          :key="choice.value"
          class="button"
          :class="{ 'button-primary': index === 0, 'button-ghost': choice.value === 'none' }"
          type="button"
          :title="choice.title"
          :disabled="busy"
          :data-testid="`demo-stop-${choice.value}`"
          @click="stop(choice.value)"
        >
          {{ choice.label }}
        </button>
        <span class="grow" />
        <button class="button button-ghost" type="button" :disabled="busy" @click="stopping = false">接着演示</button>
      </div>
      <div v-else class="demo-actions">
        <span class="grow" />
        <button class="button" type="button" data-testid="demo-stop" @click="stopping = true">结束演示</button>
      </div>
    </template>

    <!-- 没在演示：开始的表单 -->
    <template v-else-if="opening">
      <label class="demo-label" for="demo-goal">要教助手什么</label>
      <textarea
        id="demo-goal"
        v-model="goal"
        class="filter-input demo-textarea"
        rows="2"
        placeholder="例如：值班群里有人报退款失败时怎么查"
        data-testid="demo-goal"
        @keydown.enter.exact.prevent="start"
      />
      <select v-if="targets.length" v-model="target" class="preset-select demo-target" aria-label="连着哪件事" title="整理成经验时存进哪个关注或事项">
        <option value="">不连着关注或事项</option>
        <optgroup v-if="targets.some((t) => t.kind === 'context')" label="关注">
          <option v-for="t in targets.filter((x) => x.kind === 'context')" :key="t.id" :value="`context:${t.id}`">{{ t.name }}</option>
        </optgroup>
        <optgroup v-if="targets.some((t) => t.kind === 'item')" label="事项">
          <option v-for="t in targets.filter((x) => x.kind === 'item')" :key="t.id" :value="`item:${t.id}`">{{ t.name }}</option>
        </optgroup>
      </select>
      <p class="demo-tip muted">开始后在页面上做一遍、指给助手看（拾取、录制），需要时在飞书里照常回人。结束时助手把这一段整理成技能或经验，先跟你确认。</p>
      <div class="demo-actions">
        <span class="grow" />
        <button class="button button-ghost" type="button" @click="opening = false">取消</button>
        <button class="button button-primary" type="button" :disabled="busy || !goal.trim()" data-testid="demo-start" @click="start">开始演示</button>
      </div>
    </template>

    <div v-else class="demo-idle">
      <button class="button button-ghost" type="button" data-testid="demo-open" title="把一件事做给助手看：拾取、录制和你在飞书里发的消息都记进一次演示，结束时整理成技能或经验" @click="opening = true">
        <i class="demo-dot" aria-hidden="true" />演示
      </button>
      <span v-if="ended" class="demo-ended muted" data-testid="demo-ended">
        「{{ ended.goal }}」已结束{{ ended.organize === "none" ? "" : "，助手在整理" }}
        <a v-if="ended.link" :href="ended.link" target="_blank" rel="noreferrer">去看</a>
      </span>
    </div>
    <p v-if="error" class="demo-error" role="alert">{{ error }}</p>
  </section>
</template>
