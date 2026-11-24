/**
 * How the capabilities (src/auth/capabilities.ts) are grouped wherever they are picked: a member's
 * 能做什么 sheet (components/MemberCaps.vue) and the role editor (components/MembersSettings.vue).
 */
export const CAPABILITY_AREAS: { label: string; areas: string[] }[] = [
  { label: "工作与事项", areas: ["work", "items", "metrics"] },
  { label: "资料与知识", areas: ["sources", "search", "wiki", "memories", "requirements", "designs"] },
  { label: "规则与流程", areas: ["rules", "flows"] },
  { label: "运行与编码", areas: ["runs", "code.work", "code.review"] },
  { label: "对话与通知", areas: ["conversations", "ask", "notifications"] },
  { label: "远程", areas: ["remote"] },
  { label: "成员管理", areas: ["settings"] },
];
export function groupCapabilities<T extends { area: string }>(catalog: T[]) {
  const known = new Set(CAPABILITY_AREAS.flatMap((a) => a.areas));
  const out = CAPABILITY_AREAS.map((a) => ({ label: a.label, caps: catalog.filter((c) => a.areas.includes(c.area)) }));
  const rest = catalog.filter((c) => !known.has(c.area));
  if (rest.length) out.push({ label: "其他", caps: rest });
  return out.filter((g) => g.caps.length);
}
