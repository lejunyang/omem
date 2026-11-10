<script setup lang="ts">
import { useInjectedPanelContext } from "../use-panel-context";

const { filterExamples, showFilterSyntaxDialog, useFilterExample } = useInjectedPanelContext();
</script>

<template>
  <div v-if="showFilterSyntaxDialog" class="dialog-backdrop" @click.self="showFilterSyntaxDialog = false">
    <section class="dialog dialog-wide">
      <header class="dialog-header">
        <strong>高级筛选语法</strong>
        <button class="button" type="button" @click="showFilterSyntaxDialog = false">关闭</button>
      </header>

      <div class="filter-help dialog-filter-help">
        <section class="syntax-section">
          <span>建议优先点击 <code>+</code> 按钮来可视化添加筛选条件。</span>
        </section>

        <section class="syntax-section">
          <strong>默认搜索</strong>
          <span>裸文本默认搜索 URL：<code>/api/users</code> 等价于 <code>url:/api/users</code>。</span>
          <span>裸正则默认搜索 URL：<code>~/api\/users/i</code> 等价于 <code>url~/api\/users/i</code>。</span>
          <span>全局关键字需要显式写 <code>keyword:</code>，例如 <code>keyword:traceId</code>。</span>
        </section>

        <section class="syntax-section">
          <strong>字段筛选</strong>
          <span>
            常用字段：<code>method</code>、<code>status</code>、<code>type</code>、<code>domain</code>、<code>url</code>、<code>name</code>、<code>mime</code>、<code>payload</code>、<code>response</code>、<code>header</code>、<code>has</code>、<code>duration</code>、<code>size</code>。
          </span>
          <span>多个条件用空格连接，默认按 AND 生效；使用 <code>OR</code> 或 <code>|</code> 表示 OR。</span>
          <span>使用括号分组：<code>(method:GET status:2xx) OR (method:POST status:4xx)</code>。</span>
          <span>前缀 <code>-</code> 表示否定：<code>-mime:image</code>。</span>
        </section>

        <section class="syntax-section">
          <strong>对比方式</strong>
          <span>包含：<code>url:/api/users</code>、<code>keyword:traceId</code>。</span>
          <span>等于：<code>method=GET</code>、<code>type=fetch/xhr</code>。</span>
          <span>数值比较：<code>status>=400</code>、<code>duration>500</code>、<code>size<=1mb</code>。</span>
          <span>正则匹配：<code>url~/api\/users/i</code>、<code>keyword~/traceId/i</code>。</span>
          <span>正则不匹配：<code>header!~/cookie/i</code>、<code>keyword!~/password|token/i</code>。</span>
        </section>

        <section class="syntax-section">
          <strong>has 字段</strong>
          <span>
            <code>has:</code> 可检测结构化内容，支持 <code>payload</code>、<code>request</code>、<code>response</code>、<code>query</code>、<code>form</code>、<code>headers</code>、<code>request-headers</code>、<code>response-headers</code>。
          </span>
        </section>

        <section class="syntax-section">
          <strong>示例</strong>
          <div class="filter-help-grid">
            <button
              v-for="example in filterExamples"
              :key="example"
              class="example-token"
              type="button"
              @click="useFilterExample(example)"
            >
              {{ example }}
            </button>
          </div>
        </section>
      </div>
    </section>
  </div>
</template>
