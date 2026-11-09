<script setup lang="ts">
import { isComposingKeyboardEvent } from "../keyboard";
import type { UserStateContext } from "../use-user-state-context";
import type { UserStateApplyMode } from "../user-state-profiles";

const { context } = defineProps<{
  context: UserStateContext;
}>();

function splitPatterns(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function handleDraftPatternKeydown(event: KeyboardEvent): void {
  if (isComposingKeyboardEvent(event)) {
    return;
  }
  if (event.key !== "Enter" && event.key !== ",") {
    return;
  }
  event.preventDefault();
  context.addProfileDraftPattern();
}

function storageScopeCount(profileId: string): number {
  const profile = context.profiles.value.find((item) => item.id === profileId);
  return profile ? Object.keys(profile.storageByScope).length : 0;
}
</script>

<template>
  <section class="user-state-panel">
    <header class="user-state-header">
      <div>
        <strong>用户状态</strong>
        <span>管理 Cookie 与可选 WebStorage 用户配置。</span>
      </div>
      <button class="button" data-testid="user-state-add-profile" type="button" @click="context.addProfile()">新建配置</button>
    </header>

    <div class="user-state-create">
      <div class="builder-field">
        <span>新配置域名规则</span>
        <div class="user-state-pattern-tag-editor">
          <span v-for="pattern in context.profileDraftPatterns.value" :key="pattern" class="user-state-pattern-tag">
            {{ pattern }}
            <button type="button" title="移除域名规则" @click="context.removeProfileDraftPattern(pattern)">×</button>
          </span>
        </div>
        <input
          class="filter-input"
          data-testid="user-state-draft-pattern"
          :value="context.profileDraftPattern.value"
          placeholder="输入域名规则后按 Enter，例如 sso.example.com"
          @input="context.profileDraftPattern.value = ($event.target as HTMLInputElement).value"
          @keydown="handleDraftPatternKeydown"
        />
        <button class="button" type="button" @click="context.addProfileDraftPattern()">添加域名</button>
      </div>
    </div>

    <div class="user-state-layout">
      <aside class="user-state-list">
        <article
          v-for="profile in context.profiles.value"
          :key="profile.id"
          class="user-state-row"
          :class="{ 'is-active': context.selectedProfileId.value === profile.id }"
          @click="context.selectedProfileId.value = profile.id"
        >
          <div class="user-state-row-title">
            <strong :title="profile.name">{{ profile.name }}</strong>
            <span v-if="profile.enabled" class="user-state-badge is-enabled">已开启</span>
          </div>
          <div class="user-state-tags">
            <span v-if="profile.controls.cookie" class="user-state-badge">Cookie</span>
            <span v-if="profile.controls.webStorage" class="user-state-badge">Storage</span>
            <span class="user-state-badge">{{ profile.cookieJar.length }} Cookie</span>
            <span class="user-state-badge">{{ storageScopeCount(profile.id) }} Scope</span>
          </div>
        </article>
        <p v-if="!context.profiles.value.length" class="mock-empty">暂无用户配置，点击“新建配置”开始。</p>
      </aside>

      <main v-if="context.selectedProfile.value" class="user-state-detail">
        <section class="mock-group-detail">
          <div class="mock-section-header">
            <strong>配置详情</strong>
            <div class="user-state-actions">
              <button
                v-if="!context.selectedProfile.value.enabled"
                class="button"
                type="button"
                @click="context.applyProfile(context.selectedProfile.value?.id || '')"
              >
                开启并应用
              </button>
              <button v-else class="button" type="button" @click="context.disableProfile()">停用</button>
              <button class="button" type="button" @click="context.captureProfile(context.selectedProfile.value?.id || '')">
                捕获状态
              </button>
              <button
                class="button button-danger"
                data-testid="user-state-delete-profile"
                type="button"
                @click="context.deleteProfile(context.selectedProfile.value?.id || '')"
              >
                删除
              </button>
            </div>
          </div>

          <div class="user-state-form">
            <label class="builder-field">
              配置名称
              <input
                class="filter-input"
                data-testid="user-state-profile-name"
                :value="context.selectedProfile.value.name"
                @input="
                  context.updateProfile(context.selectedProfile.value?.id || '', {
                    name: ($event.target as HTMLInputElement).value
                  })
                "
              />
            </label>
            <label class="builder-field">
              域名通配符规则
              <textarea
                class="code-input user-state-patterns"
                data-testid="user-state-profile-patterns"
                :value="context.selectedProfile.value.matchPatterns.join('\n')"
                placeholder="*.example.com"
                @input="
                  context.updateProfile(context.selectedProfile.value?.id || '', {
                    matchPatterns: splitPatterns(($event.target as HTMLTextAreaElement).value)
                  })
                "
              />
            </label>

            <div class="user-state-checks">
              <label class="builder-check">
                <input
                  data-testid="user-state-cookie-control"
                  :checked="context.selectedProfile.value.controls.cookie"
                  type="checkbox"
                  @change="
                    context.updateProfile(context.selectedProfile.value?.id || '', {
                      controls: { cookie: ($event.target as HTMLInputElement).checked }
                    })
                  "
                />
                接管 Cookie
              </label>
              <label class="builder-check">
                <input
                  data-testid="user-state-storage-control"
                  :checked="context.selectedProfile.value.controls.webStorage"
                  type="checkbox"
                  @change="
                    context.updateProfile(context.selectedProfile.value?.id || '', {
                      controls: { webStorage: ($event.target as HTMLInputElement).checked }
                    })
                  "
                />
                接管 Storage
              </label>
            </div>

            <label class="builder-field">
              覆盖策略
              <select
                class="preset-select"
                :value="context.selectedProfile.value.applyMode"
                @change="
                  context.updateProfile(context.selectedProfile.value?.id || '', {
                    applyMode: ($event.target as HTMLSelectElement).value as UserStateApplyMode
                  })
                "
              >
                <option value="patch-only">只覆盖配置键</option>
                <option value="clear-then-apply">清空后覆盖</option>
              </select>
            </label>
          </div>
        </section>

        <section class="user-state-preview">
          <strong>数据预览</strong>
          <div class="user-state-tags">
            <span class="user-state-badge">{{ context.selectedProfile.value.cookieJar.length }} 个 Cookie</span>
            <span class="user-state-badge">
              {{ Object.keys(context.selectedProfile.value.storageByScope).length }} 个 Storage Scope
            </span>
          </div>
          <p class="mock-empty">
            Storage 默认不接管；勾选后会注入脚本拦截 localStorage/sessionStorage 操作。插件自身覆盖会通过
            operationId 忽略，避免死循环。
          </p>
        </section>
      </main>
    </div>

    <footer v-if="context.userStateMessage.value" class="user-state-footer popup-footer">
      <span class="message">{{ context.userStateMessage.value }}</span>
    </footer>
  </section>
</template>
