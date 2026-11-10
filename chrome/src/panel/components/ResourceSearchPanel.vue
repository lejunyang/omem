<script setup lang="ts">
import { computed, ref } from "vue";
import { shouldHandleEnterKey } from "../../shared/keyboard";
import { buildResourceTree, type ResourceTreeFileRef, type ResourceTreeNode } from "../../shared/resource-tree";
import type { ResourceSearchContext } from "../use-resource-search-context";

const { context } = defineProps<{
  context: ResourceSearchContext;
}>();

interface VisibleTreeRow {
  node: ResourceTreeNode;
  depth: number;
}

const expandedNodeIds = ref<Set<string>>(new Set());
const resourceTree = computed(() =>
  buildResourceTree({
    frames: context.frames.value,
    resources: context.resources.value,
    sourceMappedResources: context.sourceMappedResources.value,
    showSkippedResources: context.showSkippedResources.value,
    skipChromeExtensionResources: context.skipChromeExtensionResources.value,
    skipAnonymousScripts: context.skipAnonymousScripts.value
  })
);
const visibleTreeRows = computed(() => flattenTree(resourceTree.value.root.children, 0));

function flattenTree(nodes: ResourceTreeNode[], depth: number): VisibleTreeRow[] {
  return nodes.flatMap((node) => {
    const row = { node, depth };
    if (node.type === "file" || !expandedNodeIds.value.has(node.id)) {
      return [row];
    }
    return [row, ...flattenTree(node.children, depth + 1)];
  });
}

function statusText(file: ResourceTreeFileRef): string {
  if (file.ignored) {
    return "已忽略";
  }
  if (file.contentState === "skipped") {
    return "已跳过";
  }
  if (file.contentState === "failed") {
    return "失败";
  }
  if (file.contentState === "loaded") {
    return "已加载";
  }
  if (file.contentState === "missing") {
    return "缺少内容";
  }
  return "未加载";
}

function nodeIcon(node: ResourceTreeNode): string {
  if (node.type === "file") {
    if (node.file?.kind === "source-mapped") {
      return "◇";
    }
    return node.file?.resourceType === "stylesheet" ? "□" : "▱";
  }
  if (node.type === "folder") {
    return expandedNodeIds.value.has(node.id) ? "▾" : "▸";
  }
  return expandedNodeIds.value.has(node.id) ? "▾" : "▸";
}

function toggleTreeNode(node: ResourceTreeNode): void {
  if (node.type === "file") {
    return;
  }
  const next = new Set(expandedNodeIds.value);
  if (next.has(node.id)) {
    next.delete(node.id);
  } else {
    next.add(node.id);
  }
  expandedNodeIds.value = next;
}

function openTreeFile(file: ResourceTreeFileRef): void {
  if (file.kind === "generated") {
    const resource = context.resources.value.find((item) => item.id === file.id);
    if (resource) {
      context.openGeneratedResource(resource);
    }
    return;
  }
  const resource = context.sourceMappedResources.value.find((item) => item.id === file.id);
  if (resource) {
    context.openSourceMappedResource(resource);
  }
}

function ignoreTreeFile(file: ResourceTreeFileRef): void {
  if (file.kind === "generated") {
    const resource = context.resources.value.find((item) => item.id === file.id);
    if (resource) {
      void context.ignoreGeneratedResource(resource);
    }
    return;
  }
  const resource = context.sourceMappedResources.value.find((item) => item.id === file.id);
  if (resource) {
    void context.ignoreSourceMappedResource(resource);
  }
}

function handleSearchKeydown(event: KeyboardEvent): void {
  if (shouldHandleEnterKey(event)) {
    void context.searchResources();
  }
}
</script>

<template>
  <section class="resource-search-panel">
    <header class="resource-search-header">
      <div>
        <strong>资源搜索</strong>
        <span>搜索当前 Tab 的静态资源、脚本、样式和 Source Map 原始源码。</span>
      </div>
      <div class="resource-search-actions">
        <button class="button" type="button" :disabled="context.isIndexing.value" @click="context.refreshResourceIndex()">
          {{ context.isIndexing.value ? "索引中" : "刷新索引" }}
        </button>
        <button class="button" type="button" @click="context.showIgnoreManager.value = !context.showIgnoreManager.value">
          忽略资源
          <span v-if="context.ignoredRuleCount.value" class="button-badge">{{ context.ignoredRuleCount.value }}</span>
        </button>
      </div>
    </header>

    <section class="resource-search-toolbar">
      <input
        class="filter-input"
        :value="context.query.value"
        placeholder="输入要搜索的内容"
        @input="context.query.value = ($event.target as HTMLInputElement).value"
        @keydown="handleSearchKeydown"
      />
      <select v-model="context.scope.value" class="preset-select" title="搜索范围">
        <option value="all">全部</option>
        <option value="generated">解析前</option>
        <option value="source-mapped">解析后</option>
      </select>
      <label class="builder-check">
        <input v-model="context.caseSensitive.value" type="checkbox" />
        区分大小写
      </label>
      <label class="builder-check">
        <input v-model="context.regexEnabled.value" type="checkbox" />
        正则
      </label>
      <button class="button" type="button" @click="context.searchResources()">搜索</button>
    </section>

    <section v-if="context.showIgnoreManager.value" class="resource-ignore-panel">
      <div class="mock-section-header">
        <strong>忽略资源规则</strong>
      </div>
      <div class="resource-ignore-form">
        <input
          class="filter-input"
          :value="context.newIgnorePattern.value"
          placeholder="输入 URL、路径或正则"
          @input="context.newIgnorePattern.value = ($event.target as HTMLInputElement).value"
        />
        <select v-model="context.newIgnoreMatchType.value" class="preset-select">
          <option value="contains">包含</option>
          <option value="exact">完全匹配</option>
          <option value="regex">正则</option>
        </select>
        <select v-model="context.newIgnoreTarget.value" class="preset-select">
          <option value="both">全部</option>
          <option value="generated-url">解析前 URL</option>
          <option value="source-path">解析后路径</option>
        </select>
        <button class="button" type="button" @click="context.addIgnoreRule()">新增忽略</button>
      </div>
      <div v-if="!context.ignoredRules.value.length" class="mock-empty">暂无忽略规则。</div>
      <article v-for="rule in context.ignoredRules.value" :key="rule.id" class="resource-ignore-rule">
        <label class="builder-check">
          <input :checked="rule.enabled" type="checkbox" @change="context.toggleIgnoreRule(rule.id)" />
          启用
        </label>
        <span class="resource-ignore-pattern" :title="rule.pattern">{{ rule.pattern }}</span>
        <span class="user-state-badge">{{ rule.matchType }}</span>
        <span class="user-state-badge">{{ rule.target }}</span>
        <button class="button button-danger" type="button" @click="context.deleteIgnoreRule(rule.id)">删除</button>
      </article>
    </section>

    <main class="resource-search-layout">
      <section class="resource-tree-pane">
        <div class="mock-section-header">
          <strong>资源树</strong>
          <span class="mock-empty">可搜索 {{ resourceTree.searchableCount }} / 总计 {{ resourceTree.totalCount }}</span>
        </div>
        <label class="builder-check resource-skipped-toggle">
          <input v-model="context.skipChromeExtensionResources.value" type="checkbox" />
          跳过 chrome-extension 资源
        </label>
        <label class="builder-check resource-skipped-toggle">
          <input v-model="context.showSkippedResources.value" type="checkbox" />
          显示已跳过二进制资源
        </label>
        <label class="builder-check resource-skipped-toggle">
          <input v-model="context.skipAnonymousScripts.value" type="checkbox" />
          跳过匿名脚本
        </label>
        <div v-if="!visibleTreeRows.length" class="mock-empty">暂无资源索引。</div>
        <div v-else class="resource-tree">
          <div
            v-for="{ node, depth } in visibleTreeRows"
            :key="node.id"
            class="resource-tree-row"
            :class="{ 'is-file': node.type === 'file', 'is-ignored': node.file?.ignored }"
          >
            <button
              v-if="node.type !== 'file'"
              class="resource-tree-node"
              type="button"
              :title="node.title"
              :style="{ paddingLeft: `${4 + depth * 14}px` }"
              @click="toggleTreeNode(node)"
            >
              <span class="resource-tree-icon">{{ nodeIcon(node) }}</span>
              <span class="resource-tree-label">{{ node.label }}</span>
            </button>
            <button
              v-else-if="node.file"
              class="resource-tree-node resource-tree-file"
              type="button"
              :title="node.title"
              :style="{ paddingLeft: `${4 + depth * 14}px` }"
              @click="openTreeFile(node.file)"
            >
              <span class="resource-tree-icon">{{ nodeIcon(node) }}</span>
              <span class="resource-tree-label">{{ node.label }}</span>
              <span class="resource-tree-status">{{ statusText(node.file) }}</span>
            </button>
            <button
              v-if="node.file"
              class="button resource-tree-ignore"
              type="button"
              @click="ignoreTreeFile(node.file)"
            >
              忽略
            </button>
          </div>
        </div>
      </section>

      <section class="resource-result-pane">
        <div class="mock-section-header">
          <strong>搜索结果</strong>
          <span class="mock-empty">{{ context.results.value.length }} 条</span>
        </div>
        <div v-if="context.message.value" class="resource-search-message">{{ context.message.value }}</div>
        <article v-if="context.sourcePreview.value" class="resource-source-preview">
          <div class="mock-section-header">
            <div>
              <strong>{{ context.sourcePreview.value.title }}</strong>
              <span class="mock-empty">命中行 {{ context.sourcePreview.value.lineNumber }}</span>
            </div>
            <button class="button" type="button" @click="context.closeSourcePreview()">关闭预览</button>
          </div>
          <div class="mock-empty">{{ context.sourcePreview.value.url || "无真实 URL，来自 Debugger 脚本源码" }}</div>
          <div v-for="item in context.sourcePreview.value.meta" :key="item" class="mock-empty">{{ item }}</div>
          <pre class="code resource-source-preview-code">{{ context.sourcePreview.value.excerpt }}</pre>
        </article>
        <div v-if="!context.results.value.length" class="mock-empty">暂无搜索结果。</div>
        <article v-for="result in context.results.value" :key="result.id" class="resource-result-card">
          <div class="resource-result-title">
            <button class="link-button" type="button" @click="context.openResourceResult(result)">
              {{ result.title }}
            </button>
            <span class="user-state-badge">{{ result.scope === "generated" ? "解析前" : "解析后" }}</span>
          </div>
          <div class="mock-empty">{{ result.url }}:{{ result.lineNumber }}:{{ result.columnNumber }}</div>
          <pre class="code resource-result-snippet">{{ result.snippet }}</pre>
          <button class="button" type="button" @click="context.ignoreSearchResult(result)">忽略该资源</button>
        </article>

        <div class="mock-empty">Source Map 源文件已归入左侧资源树，可直接点击定位或忽略。</div>
      </section>
    </main>
  </section>
</template>
