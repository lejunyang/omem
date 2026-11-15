import type { PropType } from "vue";
import type { ChartSeries, ChartSpec } from "@omem-ai/plugin-sdk/charts";

/** The props every chart component takes (ChartSpec without its kind); see Chart.vue. */
export const chartProps = {
  title: String,
  labels: { type: Array as PropType<string[]>, default: () => [] },
  series: { type: Array as PropType<ChartSeries[]>, default: () => [] },
  stack: Boolean,
  goal: Number,
  unit: String,
  note: String,
  highlight: String,
  caption: String,
  links: Array as PropType<(string | undefined)[]>,
  extras: Array as PropType<NonNullable<ChartSpec["extras"]>>,
  /** The numbers as a table under the chart (on unless set to false). */
  table: { type: Boolean, default: true },
};

/** The spec for a kind, dropping what was not given. */
export function specOf(kind: ChartSpec["kind"], p: Record<string, unknown>): ChartSpec {
  const spec = { kind } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null) spec[k] = v;
  return spec as ChartSpec;
}
