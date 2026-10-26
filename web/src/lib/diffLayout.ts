import { ref, watch } from "vue";

/** How diffs read everywhere: one column (上下) or old and new side by side (左右); the owner's choice is remembered. */
export type DiffLayout = "unified" | "split";
const KEY = "omem.diffLayout";
export const diffLayout = ref<DiffLayout>((() => {
  try {
    return localStorage.getItem(KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
})());
watch(diffLayout, (v) => {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* private mode */
  }
});
export const diffLayoutOptions = [
  { value: "unified" as const, label: "上下" },
  { value: "split" as const, label: "左右" },
];
