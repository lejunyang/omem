import { describe, expect, it } from "vitest";
import type { KnowledgeOutlinePage } from "../../../../packages/contracts/src/knowledge-outline";
import { mergeOutlinePages, moveOutlineRoot } from "./outline-editing";

const page = (
  id: string,
  input: Partial<KnowledgeOutlinePage>,
): KnowledgeOutlinePage => ({
  id,
  existingKey: null,
  title: id,
  kind: "explanation",
  reader: "新读者",
  goal: "读懂系统",
  scenario: "准备接手维护",
  questions: ["系统如何运行？"],
  entryPaths: [],
  topicPath: ["系统学习"],
  materialKeys: [],
  contextIds: [],
  ...input,
});

describe("move a saved reading directory", () => {
  it("moves the reading route with its subdirectories while preserving pages placed in another topic", () => {
    const pages = [
      page("intro", { topicPath: ["系统学习"] }),
      page("message-flow", { topicPath: ["系统学习", "消息", "处理流程"] }),
      page("english", { topicPath: ["英语", "听力"] }),
    ];
    const moved = moveOutlineRoot(pages, ["系统学习"], ["工作", "系统指南"]);
    expect(moved.map((item) => item.topicPath)).toEqual([
      ["工作", "系统指南"],
      ["工作", "系统指南", "消息", "处理流程"],
      ["英语", "听力"],
    ]);
    expect(pages[0].topicPath).toEqual(["系统学习"]);

    const initiallyUnclassified = [
      page("intro", { topicPath: [] }),
      page("english", { topicPath: ["英语"] }),
    ];
    expect(
      moveOutlineRoot(initiallyUnclassified, [], ["工作"]).map(
        (item) => item.topicPath,
      ),
    ).toEqual([["工作"], ["英语"]]);
  });
});

describe("merge a reader's outline", () => {
  it("keeps the retained article identity and combines reading goals and scope without editing the saved input", () => {
    const pages = [
      page("overview", {
        existingKey: "article:existing",
        materialKeys: ["source:a"],
        contextIds: ["project:a"],
      }),
      page("flow", {
        goal: "能定位消息处理入口",
        scenario: "排查重复提醒",
        questions: ["系统如何运行？", "重复提醒在哪处理？"],
        materialKeys: ["source:a", "source:b"],
        contextIds: ["project:b"],
      }),
      page("reference", { materialKeys: ["source:c"] }),
    ];
    const before = JSON.stringify(pages);
    const merged = mergeOutlinePages(pages, "flow", "overview");
    expect(merged.map((item) => item.id)).toEqual(["overview", "reference"]);
    expect(merged[0]).toMatchObject({
      existingKey: "article:existing",
      title: "overview",
      goal: "读懂系统\n能定位消息处理入口",
      scenario: "准备接手维护\n排查重复提醒",
      questions: ["系统如何运行？", "重复提醒在哪处理？"],
      materialKeys: ["source:a", "source:b"],
      contextIds: ["project:a", "project:b"],
    });
    expect(JSON.stringify(pages)).toBe(before);
  });
});
