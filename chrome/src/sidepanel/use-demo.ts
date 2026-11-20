import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { type DemoInfo, type DemoOrganize, parseDemoTarget } from "../shared/demo";
import type { OmemContext } from "./use-omem";

/** 刚结束的一次演示：侧栏显示“助手在整理”和去 omem 的链接。 */
export interface DemoEnded {
  goal: string;
  organize: DemoOrganize;
  link: string | null;
}

const POLL_MS = 15_000;

/**
 * 侧栏的演示状态。状态在 omem 那边（网页和飞书命令也能开始、结束），所以这里只读：连接变了、
 * 开始或结束之后、侧栏开着时每 15 秒读一次 GET /api/demos。读失败时保留上一次的状态，不当成“没有演示”，
 * 免得网络抖一下拾取就悄悄发去问答。
 */
export function useDemo(omem: OmemContext) {
  const current = ref<DemoInfo | null>(null);
  const ended = ref<DemoEnded | null>(null);
  const busy = ref(false);
  const error = ref("");
  const now = ref(Date.now());
  let clock = 0;
  let poll = 0;
  let seq = 0;

  async function refresh(): Promise<void> {
    const my = ++seq;
    try {
      const list = await omem.demos();
      if (my !== seq) return;
      current.value = list.current;
      error.value = "";
    } catch (e) {
      if (my === seq) error.value = (e as Error).message;
    }
  }

  // 换了连接或重新登录：先清掉上一个 omem 的演示，再读这一个的。
  watch(
    () => (omem.status.value.state === "ok" ? `${omem.activeId.value}:${omem.status.value.me.id}` : ""),
    (key) => {
      seq++;
      current.value = null;
      ended.value = null;
      if (key) void refresh();
    },
    { immediate: true }
  );

  onMounted(() => {
    clock = window.setInterval(() => (now.value = Date.now()), 1000);
    poll = window.setInterval(() => {
      if (omem.status.value.state === "ok" && document.visibilityState === "visible") void refresh();
    }, POLL_MS);
  });
  onBeforeUnmount(() => {
    clearInterval(clock);
    clearInterval(poll);
  });

  /** 开始：要教什么，和可选的关注或事项（选择框的值 context:<id> / item:<id>）。 */
  async function start(goal: string, target: string): Promise<boolean> {
    busy.value = true;
    error.value = "";
    try {
      seq++;
      current.value = await omem.startDemo({ goal: goal.trim(), ...parseDemoTarget(target) });
      ended.value = null;
      return true;
    } catch (e) {
      error.value = (e as Error).message;
      // 已经有一个在进行（别处开始的）：读回来显示它。
      await refresh();
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function stop(organize: DemoOrganize): Promise<boolean> {
    const demo = current.value;
    if (!demo) return false;
    busy.value = true;
    error.value = "";
    try {
      seq++;
      const result = await omem.stopDemo(demo.id, organize);
      ended.value = { goal: demo.goal, organize, link: omem.webUrl(`/ask/${result.conversationId}`) };
      current.value = null;
      return true;
    } catch (e) {
      error.value = (e as Error).message;
      await refresh();
      return false;
    } finally {
      busy.value = false;
    }
  }

  return { busy, current, ended, error, now, refresh, start, stop };
}

export type DemoContext = ReturnType<typeof useDemo>;
