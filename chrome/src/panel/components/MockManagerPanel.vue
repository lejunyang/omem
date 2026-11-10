<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { HeaderPair } from "../../shared/network";
import { DEFAULT_MOCK_GROUP_ID, describeMockRule, type MockAction } from "../../shared/mock-rules";
import { useInjectedMockContext } from "../use-mock-context";

const {
  addMockGroup,
  cancelMockDraft,
  canCloseMockManager,
  collapsedMockRuleIds,
  confirmMockDraft,
  createBlankMockDraft,
  deleteMockGroup,
  deleteMockRule,
  draftMockRule,
  mockGroups,
  mockRules,
  mockSyncMessage,
  moveMockGroup,
  registerMockPanel,
  selectMockGroup,
  selectedMockGroup,
  selectedMockGroupId,
  selectedMockGroupRules,
  showMockManager,
  toggleMockRule,
  toggleMockRuleCollapsed,
  updateMockDraft,
  updateMockGroup,
  updateMockRule
} = useInjectedMockContext();

const panelRef = ref<HTMLElement | null>(null);
const groupMenuExpanded = ref(false);
const showMockScriptHelp = ref(false);

function scrollToTop(): void {
  panelRef.value?.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}

onMounted(() => {
  registerMockPanel({ scrollToTop });
});

onBeforeUnmount(() => {
  registerMockPanel(null);
});

function isRuleCollapsed(collapsedRuleIds: Set<string>, ruleId: string): boolean {
  return collapsedRuleIds.has(ruleId);
}

function groupInitial(name: string): string {
  return name.trim().slice(0, 1) || "M";
}

function groupRuleCount(groupId: string): number {
  return mockRules.value.filter((rule) => rule.groupId === groupId).length;
}

function toggleGroupMenu(): void {
  groupMenuExpanded.value = !groupMenuExpanded.value;
}

function selectGroup(groupId: string): void {
  selectMockGroup(groupId);
}

function updateDraftHeader(index: number, patch: Partial<HeaderPair>): void {
  if (!draftMockRule.value) {
    return;
  }
  updateMockDraft({
    responseHeaders: draftMockRule.value.responseHeaders.map((header, headerIndex) =>
      headerIndex === index ? { ...header, ...patch } : header
    )
  });
}

function addDraftHeader(): void {
  if (!draftMockRule.value) {
    return;
  }
  updateMockDraft({
    responseHeaders: [...draftMockRule.value.responseHeaders, { name: "", value: "" }]
  });
}

function deleteDraftHeader(index: number): void {
  if (!draftMockRule.value) {
    return;
  }
  updateMockDraft({
    responseHeaders: draftMockRule.value.responseHeaders.filter((_, headerIndex) => headerIndex !== index)
  });
}

function updateRuleHeader(ruleId: string, headers: HeaderPair[], index: number, patch: Partial<HeaderPair>): void {
  void updateMockRule(ruleId, {
    responseHeaders: headers.map((header, headerIndex) =>
      headerIndex === index ? { ...header, ...patch } : header
    )
  });
}

function addRuleHeader(ruleId: string, headers: HeaderPair[]): void {
  void updateMockRule(ruleId, {
    responseHeaders: [...headers, { name: "", value: "" }]
  });
}

function deleteRuleHeader(ruleId: string, headers: HeaderPair[], index: number): void {
  void updateMockRule(ruleId, {
    responseHeaders: headers.filter((_, headerIndex) => headerIndex !== index)
  });
}

function openMockScriptHelp(): void {
  showMockScriptHelp.value = true;
}
</script>

<template>
  <section v-if="showMockManager" ref="panelRef" class="mock-panel" @click.stop>
    <div class="mock-panel-header">
      <div class="mock-panel-summary">
        <strong>全部 Mock</strong>
        <span class="text-ellipsis" title="跨域共享的全部规则">跨域共享的全部规则</span>
        <span class="text-ellipsis" :title="mockSyncMessage">{{ mockSyncMessage }}</span>
      </div>
      <button v-if="canCloseMockManager" class="button" type="button" @click="showMockManager = false">关闭</button>
    </div>

    <div class="mock-manager-layout" :class="{ 'is-group-menu-expanded': groupMenuExpanded }">
      <aside class="mock-group-sidebar">
        <div class="mock-group-sidebar-header">
          <strong>Mock 组</strong>
          <div class="mock-group-header-actions">
            <button
              class="button button-icon mock-group-toggle-button"
              type="button"
              :aria-expanded="groupMenuExpanded"
              :title="groupMenuExpanded ? '收起 Mock 组' : '展开 Mock 组'"
              @click="toggleGroupMenu"
            >
              {{ groupMenuExpanded ? "←" : "→" }}
            </button>
            <button
              class="button button-icon"
              data-testid="mock-add-group"
              type="button"
              title="新增 Mock 组"
              @click="addMockGroup()"
            >
              +
            </button>
          </div>
        </div>

        <div class="mock-group-icon-list">
          <button
            class="button button-icon mock-group-toggle-button"
            type="button"
            :aria-expanded="groupMenuExpanded"
            :title="groupMenuExpanded ? '收起 Mock 组' : '展开 Mock 组'"
            @click="toggleGroupMenu"
          >
            {{ groupMenuExpanded ? "←" : "→" }}
          </button>
          <button
            v-for="group in mockGroups"
            :key="group.id"
            class="mock-group-avatar"
            type="button"
            :class="{ 'is-active': selectedMockGroupId === group.id }"
            :title="group.name"
            @click="selectGroup(group.id)"
          >
            {{ groupInitial(group.name) }}
            <span class="mock-group-status" :class="{ 'is-enabled': group.enabled }"></span>
          </button>
        </div>

        <div class="mock-group-list">
          <article
            v-for="(group, index) in mockGroups"
            :key="group.id"
            class="mock-group-row"
            :class="{ 'is-active': selectedMockGroupId === group.id }"
            @click="selectGroup(group.id)"
          >
            <span class="mock-group-enabled" :class="{ 'is-enabled': group.enabled }"></span>
            <div class="mock-group-row-text">
              <strong :title="group.name">{{ group.name }}</strong>
              <span>{{ groupRuleCount(group.id) }} 条规则</span>
            </div>
            <button
              class="button button-icon"
              type="button"
              title="上移"
              aria-label="上移"
              :disabled="index === 0"
              @click.stop="moveMockGroup(group.id, 'up')"
            >
              ↑
            </button>
            <button
              class="button button-icon"
              type="button"
              title="下移"
              aria-label="下移"
              :disabled="index === mockGroups.length - 1"
              @click.stop="moveMockGroup(group.id, 'down')"
            >
              ↓
            </button>
            <button
              class="button button-danger button-icon"
              type="button"
              title="删除"
              aria-label="删除"
              :disabled="group.id === DEFAULT_MOCK_GROUP_ID"
              @click.stop="deleteMockGroup(group.id)"
            >
              ×
            </button>
          </article>
        </div>
      </aside>

      <main v-if="selectedMockGroup" class="mock-rule-pane">
        <section class="mock-group-detail">
          <div class="mock-section-header">
            <strong>当前组</strong>
            <button class="button" data-testid="mock-add-rule" type="button" @click="createBlankMockDraft(selectedMockGroup.id)">
              新增规则
            </button>
          </div>
          <div class="mock-group-detail-grid">
            <label class="builder-check">
              <input
                :checked="selectedMockGroup.enabled"
                type="checkbox"
                @change="updateMockGroup(selectedMockGroup.id, { enabled: ($event.target as HTMLInputElement).checked })"
              />
              启用
            </label>
            <label class="builder-field">
              组名称
              <input
                class="filter-input"
                data-testid="mock-group-name"
                :value="selectedMockGroup.name"
                :title="selectedMockGroup.name"
                @change="updateMockGroup(selectedMockGroup.id, { name: ($event.target as HTMLInputElement).value })"
              />
            </label>
            <label class="builder-field builder-field-wide">
              页面 URL 条件
              <input
                class="filter-input mock-matcher-input"
                data-testid="mock-group-page-url"
                :value="selectedMockGroup.pageUrlContains"
                :title="selectedMockGroup.pageUrlContains || '页面 URL 包含此文本时生效；为空表示所有页面生效'"
                placeholder="页面 URL 包含；为空表示所有页面"
                @change="updateMockGroup(selectedMockGroup.id, { pageUrlContains: ($event.target as HTMLInputElement).value })"
              />
            </label>
          </div>
        </section>

        <article v-if="draftMockRule && draftMockRule.groupId === selectedMockGroup.id" class="mock-rule-card mock-rule-draft">
          <div class="mock-rule-title">
            <strong>Mock 草稿</strong>
            <input
              class="filter-input"
              data-testid="mock-draft-name"
              :value="draftMockRule.name"
              :title="draftMockRule.name"
              @change="updateMockDraft({ name: ($event.target as HTMLInputElement).value })"
            />
            <button class="button" data-testid="mock-confirm-draft" type="button" @click="confirmMockDraft()">确认</button>
            <button class="button" data-testid="mock-cancel-draft" type="button" @click="cancelMockDraft">取消</button>
          </div>
          <label class="builder-field">
            所属组
            <select
              class="preset-select"
              :value="draftMockRule.groupId"
              @change="updateMockDraft({ groupId: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="group in mockGroups" :key="group.id" :value="group.id">{{ group.name }}</option>
            </select>
          </label>
          <label class="builder-field">
            匹配条件
            <input
              class="filter-input mock-matcher-input"
              data-testid="mock-draft-matcher"
              :value="draftMockRule.matcherQuery"
              :title="draftMockRule.matcherQuery"
              @change="updateMockDraft({ matcherQuery: ($event.target as HTMLInputElement).value })"
            />
          </label>
          <label class="builder-field">
            Mock 方式
            <select
              class="preset-select"
              data-testid="mock-draft-action"
              :value="draftMockRule.action"
              @change="updateMockDraft({ action: ($event.target as HTMLSelectElement).value as MockAction })"
            >
              <option value="replace-headers">替换响应头</option>
              <option value="replace-body">替换 JSON 响应体</option>
              <option value="script">JS 修改响应</option>
            </select>
          </label>
          <label v-if="draftMockRule.action === 'replace-body'" class="builder-field">
            JSON 响应体
            <textarea
              class="code-input"
              data-testid="mock-draft-response-body"
              :value="draftMockRule.responseBody"
              @change="updateMockDraft({ responseBody: ($event.target as HTMLTextAreaElement).value })"
            />
          </label>
          <div v-else-if="draftMockRule.action === 'script'" class="builder-field">
            <div class="mock-field-title">
              <span>JS 脚本</span>
              <button class="button button-icon" type="button" title="查看 JS 脚本说明" @click="openMockScriptHelp">?</button>
            </div>
            <textarea
              class="code-input"
              data-testid="mock-draft-script"
              :value="draftMockRule.script"
              @change="updateMockDraft({ script: ($event.target as HTMLTextAreaElement).value })"
            />
          </div>
          <section v-else class="mock-headers-editor">
            <div class="mock-section-header">
              <strong>响应头</strong>
              <button class="button" type="button" @click="addDraftHeader">新增响应头</button>
            </div>
            <div v-if="!draftMockRule.responseHeaders.length" class="mock-empty">暂无响应头，新增后会覆盖或追加到原响应。</div>
            <div v-for="(header, index) in draftMockRule.responseHeaders" :key="`${header.name}-${index}`" class="mock-header-row">
              <input
                class="filter-input"
                :value="header.name"
                placeholder="Header 名称"
                @change="updateDraftHeader(index, { name: ($event.target as HTMLInputElement).value })"
              />
              <input
                class="filter-input"
                :value="header.value"
                placeholder="Header 值"
                @change="updateDraftHeader(index, { value: ($event.target as HTMLInputElement).value })"
              />
              <button class="button button-danger" type="button" @click="deleteDraftHeader(index)">删除</button>
            </div>
          </section>
        </article>

        <div v-if="!selectedMockGroupRules.length" class="mock-empty">
          当前组暂无 Mock 规则。可以点击“新增规则”，或在请求列表右键选择 Mock 方式创建。
        </div>
        <article v-for="rule in selectedMockGroupRules" v-else :key="rule.id" class="mock-rule-card">
          <div class="mock-rule-title">
            <label class="builder-check">
              <input :checked="rule.enabled" type="checkbox" @change="toggleMockRule(rule)" />
              启用
            </label>
            <button
              class="button button-icon"
              type="button"
              :aria-expanded="!isRuleCollapsed(collapsedMockRuleIds, rule.id)"
              @click="toggleMockRuleCollapsed(rule.id)"
            >
              {{ isRuleCollapsed(collapsedMockRuleIds, rule.id) ? "展开" : "折叠" }}
            </button>
            <input
              class="filter-input"
              :value="rule.name"
              :title="rule.name"
              @change="updateMockRule(rule.id, { name: ($event.target as HTMLInputElement).value })"
            />
            <button class="button button-danger" type="button" @click="deleteMockRule(rule.id)">删除</button>
          </div>
          <div class="mock-rule-meta" :title="describeMockRule(rule)">{{ describeMockRule(rule) }}</div>
          <div v-if="isRuleCollapsed(collapsedMockRuleIds, rule.id)" class="mock-rule-collapsed">
            已折叠。当前规则仅按所选 Mock 方式生效，JSON 和 JS 不会同时执行。
          </div>
          <template v-else>
            <label class="builder-field">
              所属组
              <select
                class="preset-select"
                :value="rule.groupId"
                @change="updateMockRule(rule.id, { groupId: ($event.target as HTMLSelectElement).value })"
              >
                <option v-for="group in mockGroups" :key="group.id" :value="group.id">{{ group.name }}</option>
              </select>
            </label>
            <label class="builder-field">
              匹配条件
              <input
                class="filter-input mock-matcher-input"
                :value="rule.matcherQuery"
                :title="rule.matcherQuery"
                @change="updateMockRule(rule.id, { matcherQuery: ($event.target as HTMLInputElement).value })"
              />
            </label>
            <label class="builder-field">
              Mock 方式
              <select
                class="preset-select"
                :value="rule.action"
                @change="updateMockRule(rule.id, { action: ($event.target as HTMLSelectElement).value as MockAction })"
              >
                <option value="replace-headers">替换响应头</option>
                <option value="replace-body">替换 JSON 响应体</option>
                <option value="script">JS 修改响应</option>
              </select>
            </label>
            <label v-if="rule.action === 'replace-body'" class="builder-field">
              JSON 响应体
              <textarea
                class="code-input"
                :value="rule.responseBody"
                @change="updateMockRule(rule.id, { responseBody: ($event.target as HTMLTextAreaElement).value })"
              />
            </label>
            <div v-else-if="rule.action === 'script'" class="builder-field">
              <div class="mock-field-title">
                <span>JS 脚本</span>
                <button class="button button-icon" type="button" title="查看 JS 脚本说明" @click="openMockScriptHelp">?</button>
              </div>
              <textarea
                class="code-input"
                :value="rule.script"
                @change="updateMockRule(rule.id, { script: ($event.target as HTMLTextAreaElement).value })"
              />
            </div>
            <section v-else class="mock-headers-editor">
              <div class="mock-section-header">
                <strong>响应头</strong>
                <button class="button" type="button" @click="addRuleHeader(rule.id, rule.responseHeaders)">新增响应头</button>
              </div>
              <div v-if="!rule.responseHeaders.length" class="mock-empty">暂无响应头，新增后会覆盖或追加到原响应。</div>
              <div v-for="(header, index) in rule.responseHeaders" :key="`${rule.id}-${header.name}-${index}`" class="mock-header-row">
                <input
                  class="filter-input"
                  :value="header.name"
                  placeholder="Header 名称"
                  @change="updateRuleHeader(rule.id, rule.responseHeaders, index, { name: ($event.target as HTMLInputElement).value })"
                />
                <input
                  class="filter-input"
                  :value="header.value"
                  placeholder="Header 值"
                  @change="updateRuleHeader(rule.id, rule.responseHeaders, index, { value: ($event.target as HTMLInputElement).value })"
                />
                <button class="button button-danger" type="button" @click="deleteRuleHeader(rule.id, rule.responseHeaders, index)">删除</button>
              </div>
              <div class="mock-rule-collapsed">
                当前选择“替换响应头”，仅修改响应头并保留原响应体；JSON 响应体和 JS 脚本不会生效。
              </div>
            </section>
          </template>
        </article>
      </main>
    </div>
  </section>

  <div v-if="showMockScriptHelp" class="dialog-backdrop" @click.self="showMockScriptHelp = false">
    <section class="dialog dialog-wide">
      <header class="dialog-header">
        <strong>Mock JS 脚本说明</strong>
        <button class="button" type="button" @click="showMockScriptHelp = false">关闭</button>
      </header>
      <div class="dialog-filter-help">
        <section class="syntax-section">
          <h4>入口函数</h4>
          <p>脚本需要声明 <code>function mock({ request, response })</code>，可以同步或异步返回结果。</p>
        </section>
        <section class="syntax-section">
          <h4>request 参数</h4>
          <p><code>request</code> 包含 <code>method</code>、<code>url</code>、<code>origin</code>、<code>protocol</code>、<code>host</code>、<code>hostname</code>、<code>port</code>、<code>pathname</code>、<code>search</code>、<code>queryString</code>、<code>query</code>、<code>headers</code>、<code>body</code>。</p>
        </section>
        <section class="syntax-section">
          <h4>response 参数</h4>
          <p><code>response</code> 包含原响应的 <code>status</code>、<code>headers</code>、<code>body</code>。</p>
        </section>
        <section class="syntax-section">
          <h4>返回对象</h4>
          <p>返回 <code>{ status, headers, body }</code>。缺失字段会回退到原响应；<code>body</code> 返回对象时会自动转成格式化 JSON。</p>
        </section>
        <pre class="code">function mock({ request, response }) {
  return {
    status: response.status,
    headers: {
      ...response.headers,
      "x-mock-path": request.pathname
    },
    body: JSON.stringify({
      mocked: true,
      query: request.query
    })
  };
}</pre>
      </div>
    </section>
  </div>
</template>
