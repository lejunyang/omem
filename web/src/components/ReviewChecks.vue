<script setup lang="ts">
import { ref } from "vue";
import Markdown from "./Markdown.vue";
import { fmtTime } from "../store";
import { refAction } from "../lib/refs";
import { findingWhere, reviewAi, settled, severityCounts, SEV, type Reviews } from "../lib/reviews";

/**
 * The run page's “评审” tab: each check of the chosen round in full (its conclusion as written, and
 * every problem it reported, including those review-lead set aside), then review-lead's ruling.
 */
const props = defineProps<{ rv: Reviews; runId: string }>();
const rv = props.rv;
const current = rv.current;
const VERDICT: Record<string, string> = { approved: "通过", changes_requested: "需要修改", failed: "没有完成" };
const LEAD: Record<string, string> = { approve: "通过", revise: "再改一轮", escalate: "交给本人决定" };
const STATE: Record<string, string> = { accepted: "接受", rejected: "驳回", merged: "合并" };
const open = ref(new Set<string>());
const toggle = (id: string) => { const n = new Set(open.value); n.has(id) ? n.delete(id) : n.add(id); open.value = n; };
</script>

<template>
  <section class="block checks-tab">
    <p v-if="!rv.reviews.value.length" class="muted">这一轮还没有评审结果。</p>
    <div v-for="r in rv.reviews.value" :key="r.id" class="card check">
      <button class="check-head" :aria-expanded="open.has(r.id)" @click="toggle(r.id)">
        <span class="st" :class="r.verdict" />
        <strong>{{ rv.label(r.check_name) }}</strong>
        <span class="muted small">{{ VERDICT[r.verdict] ?? r.verdict }}</span>
        <span class="row sev"><span v-for="c in severityCounts(r)" :key="c.s" class="badge" :class="SEV[c.s].cls">{{ SEV[c.s].text }} {{ c.n }}</span></span>
        <span class="spacer" />
        <span class="muted small mono ai">{{ reviewAi(r) }}</span>
        <span class="muted small nowrap">{{ fmtTime(r.created_at) }}</span>
      </button>
      <div v-if="open.has(r.id)" class="check-body">
        <Markdown :source="r.summary" />
        <div v-if="r.findings.length" class="flist">
          <div v-for="f in r.findings" :key="f.id" class="f small" :class="{ dim: settled(f) }">
            <span class="badge" :class="SEV[f.severity].cls">{{ SEV[f.severity].text }}</span>
            <span class="grow">
              <span class="ft">{{ f.title }}</span>
              <a v-if="findingWhere(f)" href="#" class="mono loc" @click.prevent="refAction(findingWhere(f), runId)?.()"> {{ findingWhere(f) }}</a>
              <span v-if="STATE[f.state]" class="muted"> · 负责人{{ STATE[f.state] }}{{ f.triage_note ? `：${f.triage_note}` : "" }}</span>
            </span>
            <span class="muted">#{{ f.id }}</span>
          </div>
        </div>
      </div>
    </div>
    <div v-if="current?.lead" class="card pad lead">
      <div class="row wrap"><strong>{{ current.lead.by === "lead" ? "评审负责人" : "汇总" }}</strong><span class="badge">{{ LEAD[current.lead.verdict] ?? current.lead.verdict }}</span></div>
      <p>{{ current.lead.summary }}</p>
      <details v-if="current.lead.changeRequest">
        <summary class="small">修改单</summary>
        <Markdown :source="current.lead.changeRequest" />
      </details>
    </div>
  </section>
</template>

<style scoped>
.checks-tab { display: grid; gap: 10px; }
.check { overflow: hidden; }
.check-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 14px; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; text-align: left; flex-wrap: wrap; }
.check-head:hover { background: var(--hover); }
.check-body { border-top: 1px solid var(--line); padding: 12px 14px; display: grid; gap: 10px; }
.st { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.st.approved { background: var(--ok); }
.st.changes_requested { background: var(--warn); }
.st.failed { background: var(--danger); }
.sev { gap: 4px; }
.ai, .nowrap { white-space: nowrap; }
.flist { display: grid; gap: 6px; border-top: 1px solid var(--line); padding-top: 10px; }
.f { display: flex; gap: 8px; align-items: baseline; }
.f.dim { opacity: 0.6; }
.grow { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ft { font-weight: 550; }
.loc { color: var(--accent); }
.lead { display: grid; gap: 6px; }
.lead p { margin: 0; }
@media (max-width: 760px) { .ai { display: none; } }
</style>
