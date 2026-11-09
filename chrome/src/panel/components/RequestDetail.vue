<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { parseJsonView } from "../../shared/json-viewer";
import JsonTreeView from "./JsonTreeView.vue";
import {
  formatDate,
  formatDuration,
  formatSize,
  formatStatus,
  headerRows,
  responseText,
  sourceLocation,
  timingRows
} from "../formatters";
import { useInjectedPanelContext } from "../use-panel-context";

const { activeDetailTab, detailTabs, openSourceLocation, selectedRecord } = useInjectedPanelContext();
const showPayloadJson = ref(false);
const showResponseJson = ref(false);

const payloadJson = computed(() => parseJsonView(selectedRecord.value?.requestBody ?? ""));
const responseBodyText = computed(() => (selectedRecord.value ? responseText(selectedRecord.value) : ""));
const responseJson = computed(() => parseJsonView(responseBodyText.value));

// 切换请求后回到原文视图，避免上一条请求的 JSON 展开状态影响新选中的请求详情。
watch(
  () => selectedRecord.value?.id,
  () => {
    showPayloadJson.value = false;
    showResponseJson.value = false;
  }
);
</script>

<template>
  <aside class="detail">
    <div v-if="!selectedRecord" class="detail-empty">选择一条请求查看详情</div>
    <template v-else>
      <h2 class="detail-title">{{ selectedRecord.method }} {{ selectedRecord.url }}</h2>

      <nav class="detail-tabs">
        <button
          v-for="tab in detailTabs"
          :key="tab.value"
          class="detail-tab"
          type="button"
          :class="{ 'is-active': activeDetailTab === tab.value }"
          @click="activeDetailTab = tab.value"
        >
          {{ tab.label }}
        </button>
      </nav>

      <section v-if="activeDetailTab === 'headers'" class="section">
        <h3 class="section-title">Overview</h3>
        <table class="kv-table">
          <tbody>
            <tr><td>URL</td><td>{{ selectedRecord.url }}</td></tr>
            <tr><td>Method</td><td>{{ selectedRecord.method }}</td></tr>
            <tr><td>Status</td><td>{{ formatStatus(selectedRecord) }}</td></tr>
            <tr><td>Type</td><td>{{ selectedRecord.resourceType }}</td></tr>
            <tr><td>Mime</td><td>{{ selectedRecord.mimeType || "-" }}</td></tr>
            <tr><td>Size</td><td>{{ formatSize(selectedRecord.size) }}</td></tr>
            <tr><td>Duration</td><td>{{ formatDuration(selectedRecord.duration) }}</td></tr>
            <tr><td>Started</td><td>{{ formatDate(selectedRecord.startedAt) }}</td></tr>
          </tbody>
        </table>
      </section>

      <section v-if="activeDetailTab === 'headers'" class="section">
        <h3 class="section-title">Request Headers</h3>
        <pre v-if="!selectedRecord.requestHeaders.length" class="code">(empty)</pre>
        <table v-else class="kv-table">
          <tbody>
            <tr v-for="[name, value] in headerRows(selectedRecord.requestHeaders)" :key="name">
              <td>{{ name }}</td>
              <td>{{ value }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="activeDetailTab === 'headers'" class="section">
        <h3 class="section-title">Response Headers</h3>
        <pre v-if="!selectedRecord.responseHeaders.length" class="code">(empty)</pre>
        <table v-else class="kv-table">
          <tbody>
            <tr v-for="[name, value] in headerRows(selectedRecord.responseHeaders)" :key="name">
              <td>{{ name }}</td>
              <td>{{ value }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="activeDetailTab === 'payload'" class="section">
        <div class="section-heading">
          <h3 class="section-title">Payload</h3>
          <button
            v-if="payloadJson.ok && payloadJson.node"
            class="button detail-json-toggle"
            data-testid="payload-json-toggle"
            type="button"
            @click="showPayloadJson = !showPayloadJson"
          >
            {{ showPayloadJson ? "查看原文" : "查看 JSON 视图" }}
          </button>
        </div>
        <JsonTreeView
          v-if="showPayloadJson && payloadJson.node"
          :node="payloadJson.node"
          class="json-tree"
          data-testid="payload-json-tree"
        />
        <pre v-else class="code">{{ selectedRecord.requestBody || "(empty)" }}</pre>
      </section>

      <section v-if="activeDetailTab === 'response'" class="section">
        <div class="section-heading">
          <h3 class="section-title">Response</h3>
          <button
            v-if="responseJson.ok && responseJson.node"
            class="button detail-json-toggle"
            data-testid="response-json-toggle"
            type="button"
            @click="showResponseJson = !showResponseJson"
          >
            {{ showResponseJson ? "查看原文" : "查看 JSON 视图" }}
          </button>
        </div>
        <JsonTreeView
          v-if="showResponseJson && responseJson.node"
          :node="responseJson.node"
          class="json-tree"
          data-testid="response-json-tree"
        />
        <pre v-else class="code">{{ responseBodyText }}</pre>
      </section>

      <section v-if="activeDetailTab === 'timing'" class="section">
        <h3 class="section-title">Timing</h3>
        <table class="kv-table">
          <tbody>
            <tr v-for="[name, value] in timingRows(selectedRecord)" :key="name">
              <td>{{ name }}</td>
              <td>{{ value }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="activeDetailTab === 'initiator'" class="section">
        <h3 class="section-title">Initiator</h3>
        <pre v-if="!selectedRecord.initiator" class="code">当前记录未包含调用堆栈。后续会通过 CDP Network 事件补齐 Initiator/Stack 数据。</pre>
        <template v-else>
          <table class="kv-table">
            <tbody>
              <tr><td>Type</td><td>{{ selectedRecord.initiator.type }}</td></tr>
              <tr>
                <td>Source</td>
                <td>
                  <button
                    class="link-button"
                    type="button"
                    @click="openSourceLocation(selectedRecord.initiator.url, selectedRecord.initiator.lineNumber)"
                  >
                    {{ sourceLocation(selectedRecord.initiator.url, selectedRecord.initiator.lineNumber, selectedRecord.initiator.columnNumber) }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <h3 class="section-title">Call Stack</h3>
          <pre v-if="!selectedRecord.initiator.stack.length" class="code">(empty)</pre>
          <table v-else class="kv-table">
            <tbody>
              <tr v-for="(frame, index) in selectedRecord.initiator.stack" :key="`${frame.url}-${index}`">
                <td>{{ frame.functionName }}</td>
                <td>
                  <button class="link-button" type="button" @click="openSourceLocation(frame.url, frame.lineNumber)">
                    {{ sourceLocation(frame.url, frame.lineNumber, frame.columnNumber) }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </template>
      </section>
    </template>
  </aside>
</template>
