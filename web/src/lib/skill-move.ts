import { put } from "../api";
import { promptDialog } from "./dialog";

/**
 * Move a skill to another group or purpose (src/agents/agent-skills.ts organizeSkills): what the owner
 * sets here the skill organizer leaves alone. Resolves to the new place, or null when cancelled.
 */
export async function moveSkill(name: string, now: { group?: string | null; purpose?: string }, hint: { groups: { id: string; title: string }[]; purposes?: string[] }) {
  const v = await promptDialog(`移动 ${name}`, {
    message: [
      `分组填分组名（小写字母、数字、连字符），留空就不放进分组。现有分组：${hint.groups.map((g) => (g.title === g.id ? g.id : `${g.id}（${g.title}）`)).join("、") || "无"}。`,
      hint.purposes?.length ? `这一组已有的用途：${hint.purposes.join("、")}。` : "",
      "改过以后后台整理不会再动它。",
    ]
      .filter(Boolean)
      .join("\n"),
    fields: [
      { id: "group", label: "分组", value: now.group ?? "", maxLength: 48 },
      { id: "purpose", label: "用途（组里按它分节）", value: now.purpose ?? "", maxLength: 40 },
    ],
    okText: "移动",
  });
  if (!v) return null;
  const group = v.group.trim() || null;
  const purpose = group ? v.purpose.trim() || null : null;
  await put("/api/skill-groups", { skills: [{ name, group, purpose }] });
  return { group, purpose: purpose ?? "" };
}
