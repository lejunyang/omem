import { getResourceDisplayTitle, isVirtualDebuggerScript } from "./resource-search";
import type { IndexedResource, ResourceContentState, ResourceFrameNode, ResourceType, SourceMappedResource } from "./resource-search";

export type ResourceTreeNodeType = "root" | "frame" | "origin" | "folder" | "file";
export type ResourceTreeFileKind = "generated" | "source-mapped";

export interface ResourceTreeFileRef {
  kind: ResourceTreeFileKind;
  id: string;
  title: string;
  url: string;
  path: string;
  resourceType: ResourceType | "source";
  contentState: ResourceContentState | SourceMappedResource["contentState"];
  ignored: boolean;
}

export interface ResourceTreeNode {
  id: string;
  type: ResourceTreeNodeType;
  label: string;
  title: string;
  children: ResourceTreeNode[];
  file: ResourceTreeFileRef | null;
}

export interface BuildResourceTreeInput {
  frames: ResourceFrameNode[];
  resources: IndexedResource[];
  sourceMappedResources: SourceMappedResource[];
  showSkippedResources: boolean;
  skipChromeExtensionResources: boolean;
  skipAnonymousScripts: boolean;
}

export interface BuildResourceTreeResult {
  root: ResourceTreeNode;
  searchableCount: number;
  totalCount: number;
}

export function buildResourceTree(input: BuildResourceTreeInput): BuildResourceTreeResult {
  // 资源树模拟 DevTools Sources：先按 frame/origin/path 组织，再单独挂载 Source Map 源文件视角。
  const filteredResources = input.resources.filter(
    (resource) =>
      !shouldSkipChromeExtensionResource(resource, input.skipChromeExtensionResources) &&
      !(input.skipAnonymousScripts && isVirtualDebuggerScript(resource))
  );
  const generatedResourceIds = new Set(filteredResources.map((resource) => resource.id));
  const filteredSourceMappedResources = input.sourceMappedResources.filter(
    (resource) =>
      resource.contentState === "loaded" &&
      generatedResourceIds.has(resource.generatedResourceId) &&
      !shouldSkipChromeExtensionUrl(resource.url, input.skipChromeExtensionResources)
  );
  const searchableResources = filteredResources.filter((resource) => resource.contentState !== "skipped");
  const topFrameId = input.frames[0]?.frameId ?? "";
  // Debugger/CSS/Network 可能给同一 URL 多条记录，展示时保留内容更完整、来源更可靠的一条。
  const visibleResources = dedupeResourcesByFrameAndUrl(input.showSkippedResources ? filteredResources : searchableResources, topFrameId);
  const resourcesByFrame = groupResourcesByFrame(visibleResources, topFrameId);
  const root = createNode("root:top", "root", "top", "top");

  if (input.frames.length) {
    input.frames.forEach((frame, index) => appendFrameNode(root, frame, resourcesByFrame, index === 0));
  }

  const unframedResources = resourcesByFrame.get("") ?? [];
  if (unframedResources.length) {
    const unframedNode = createNode("frame:unframed", "frame", "Top", "Top");
    appendResourcesToFrame(unframedNode, unframedResources);
    root.children.push(unframedNode);
  }

  if (filteredSourceMappedResources.length) {
    // Source Map 的 sources 往往不是页面真实 URL，因此作为独立根节点展示并由面板内部预览内容。
    const sourceMapRoot = createNode("source-map-root", "frame", "Source Map 源文件", "Source Map 源文件");
    appendSourceMappedResources(sourceMapRoot, filteredSourceMappedResources);
    root.children.push(sourceMapRoot);
  }

  compressSingleFolderChains(root);
  sortChildren(root);
  return {
    root,
    searchableCount: searchableResources.length + filteredSourceMappedResources.length,
    totalCount: filteredResources.length + filteredSourceMappedResources.length
  };
}

function appendFrameNode(
  parent: ResourceTreeNode,
  frame: ResourceFrameNode,
  resourcesByFrame: Map<string, IndexedResource[]>,
  isTopFrame: boolean
): void {
  // 顶层 frame 与原生 DevTools 保持一致显示为 top，子 frame 则优先展示 frame name 或 URL。
  const frameNode = createNode(
    `frame:${frame.frameId}`,
    "frame",
    isTopFrame ? "top" : frame.name || frame.url || frame.frameId,
    frame.url || frame.frameId
  );
  appendResourcesToFrame(frameNode, resourcesByFrame.get(frame.frameId) ?? []);
  frame.children.forEach((child) => appendFrameNode(frameNode, child, resourcesByFrame, false));
  parent.children.push(frameNode);
}

function appendResourcesToFrame(frameNode: ResourceTreeNode, resources: IndexedResource[]): void {
  for (const resource of resources) {
    const origin = displayOrigin(resource);
    const originNode = ensureChild(frameNode, `origin:${frameNode.id}:${origin}`, "origin", origin, origin);
    appendFilePath(originNode, urlPathParts(resource.url), {
      kind: "generated",
      id: resource.id,
      title: getResourceDisplayTitle(resource),
      url: resource.url,
      path: resource.url,
      resourceType: resource.type,
      contentState: resource.contentState,
      ignored: resource.ignored
    });
  }
}

function appendSourceMappedResources(parent: ResourceTreeNode, resources: SourceMappedResource[]): void {
  for (const resource of resources) {
    const parts = pathParts(resource.path || resource.url || resource.id);
    appendFilePath(parent, parts, {
      kind: "source-mapped",
      id: resource.id,
      title: parts.at(-1) || resource.path || resource.id,
      url: resource.url,
      path: resource.path || resource.url,
      resourceType: "source",
      contentState: resource.contentState,
      ignored: resource.ignored
    });
  }
}

function compressSingleFolderChains(node: ResourceTreeNode): void {
  // 当文件夹链条中没有同级资源时压缩路径，避免 /assets/src/js/service 这类路径占用多层空节点。
  for (const child of node.children) {
    compressSingleFolderChains(child);
  }
  for (const child of node.children) {
    while (child.type === "folder" && child.file === null && child.children.length === 1 && child.children[0].type === "folder") {
      const grandchild = child.children[0];
      child.id = `${child.id}/${grandchild.label}`;
      child.label = `${child.label}/${grandchild.label}`;
      child.title = `${child.title}/${grandchild.title}`;
      child.children = grandchild.children;
    }
  }
}

function shouldSkipChromeExtensionResource(resource: IndexedResource, enabled: boolean): boolean {
  return shouldSkipChromeExtensionUrl(resource.url, enabled) || shouldSkipChromeExtensionUrl(resource.origin, enabled);
}

function shouldSkipChromeExtensionUrl(url: string, enabled: boolean): boolean {
  return enabled && url.startsWith("chrome-extension://");
}

function appendFilePath(parent: ResourceTreeNode, parts: string[], file: ResourceTreeFileRef): void {
  const normalizedParts = parts.length ? parts : [file.title || "(inline)"];
  const folderParts = normalizedParts.slice(0, -1);
  const fileName = file.title || normalizedParts.at(-1) || "(inline)";
  let current = parent;
  for (const folder of folderParts) {
    current = ensureChild(current, `folder:${current.id}/${folder}`, "folder", folder, folder);
  }
  current.children.push({
    id: `file:${file.kind}:${file.id}`,
    type: "file",
    label: fileName,
    title: file.path || file.url || fileName,
    children: [],
    file: {
      ...file,
      title: fileName
    }
  });
}

function ensureChild(
  parent: ResourceTreeNode,
  id: string,
  type: Exclude<ResourceTreeNodeType, "file">,
  label: string,
  title: string
): ResourceTreeNode {
  const existing = parent.children.find((child) => child.id === id);
  if (existing) {
    return existing;
  }
  const node = createNode(id, type, label, title);
  parent.children.push(node);
  return node;
}

function createNode(id: string, type: Exclude<ResourceTreeNodeType, "file">, label: string, title: string): ResourceTreeNode {
  return {
    id,
    type,
    label,
    title,
    children: [],
    file: null
  };
}

function groupResourcesByFrame(resources: IndexedResource[], topFrameId: string): Map<string, IndexedResource[]> {
  const groups = new Map<string, IndexedResource[]>();
  for (const resource of resources) {
    const frameId = normalizeResourceFrameId(resource.frameId, topFrameId);
    const group = groups.get(frameId) ?? [];
    group.push(resource);
    groups.set(frameId, group);
  }
  return groups;
}

function dedupeResourcesByFrameAndUrl(resources: IndexedResource[], topFrameId: string): IndexedResource[] {
  const resourceByKey = new Map<string, IndexedResource>();
  for (const resource of resources) {
    const key = `${normalizeResourceFrameId(resource.frameId, topFrameId)}\n${resource.url}`;
    const existing = resourceByKey.get(key);
    if (!existing || resourceRank(resource) > resourceRank(existing)) {
      resourceByKey.set(key, resource);
    }
  }
  return Array.from(resourceByKey.values());
}

function normalizeResourceFrameId(frameId: string, topFrameId: string): string {
  // 部分 CDP 事件缺少 frameId，但实际属于当前 top frame；合并可避免界面出现两个 Top。
  return frameId || topFrameId;
}

function resourceRank(resource: IndexedResource): number {
  // 同 URL 资源去重时优先保留已加载内容，其次保留 Debugger/CSS 这类更接近 Sources 的来源。
  const stateRank: Record<ResourceContentState, number> = {
    loaded: 4,
    unloaded: 3,
    loading: 2,
    failed: 1,
    skipped: 0
  };
  const sourceRank: Record<IndexedResource["source"], number> = {
    debugger: 4,
    css: 4,
    network: 3,
    page: 2
  };
  return stateRank[resource.contentState] * 10 + sourceRank[resource.source];
}

function displayOrigin(resource: IndexedResource): string {
  return normalizeOrigin(resource.origin) || normalizeOrigin(originFromUrl(resource.url)) || "(no origin)";
}

function normalizeOrigin(origin: string): string {
  return origin && origin !== "null" ? origin : "";
}

function sortChildren(node: ResourceTreeNode): void {
  node.children.sort((left, right) => {
    if (left.type === "file" && right.type !== "file") {
      return 1;
    }
    if (left.type !== "file" && right.type === "file") {
      return -1;
    }
    return left.label.localeCompare(right.label);
  });
  node.children.forEach(sortChildren);
}

function urlPathParts(url: string): string[] {
  try {
    return pathParts(new URL(url).pathname);
  } catch {
    return pathParts(url);
  }
}

function pathParts(path: string): string[] {
  return path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function fileNameFromUrl(url: string): string {
  const parts = urlPathParts(url);
  return parts.at(-1) || url || "(inline)";
}

function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
