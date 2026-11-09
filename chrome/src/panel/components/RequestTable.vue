<script setup lang="ts">
import { formatDuration, formatSize, formatStatus, getProtocol, statusClass } from "../formatters";
import { useInjectedPanelContext } from "../use-panel-context";

const { enabledMockCount, filteredRecords, isRecording, openRequestMenu, selectedId, selectRecord } = useInjectedPanelContext();
</script>

<template>
  <section class="table-wrap">
    <table class="request-table">
      <thead>
        <tr>
          <th style="width: 30%">名称</th>
          <th style="width: 10%">状态</th>
          <th style="width: 10%">方法</th>
          <th style="width: 12%">类型</th>
          <th v-if="enabledMockCount > 0" style="width: 8%">Mock</th>
          <th style="width: 12%">大小</th>
          <th style="width: 12%">耗时</th>
          <th style="width: 6%">协议</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="record in filteredRecords"
          :key="record.id"
          class="request-row"
          :class="{ 'is-selected': record.id === selectedId, 'is-mocked': record.isMocked }"
          data-testid="request-row"
          @click="selectRecord(record)"
          @contextmenu.prevent.stop="openRequestMenu($event, record)"
        >
          <td :title="record.url">{{ record.name }}</td>
          <td :class="statusClass(record.status)">{{ formatStatus(record) }}</td>
          <td>{{ record.method }}</td>
          <td :title="record.mimeType">{{ record.resourceType }}</td>
          <td v-if="enabledMockCount > 0"><span v-if="record.isMocked" class="mock-badge">Mock</span></td>
          <td>{{ formatSize(record.size) }}</td>
          <td>{{ formatDuration(record.duration) }}</td>
          <td>{{ getProtocol(record.url) }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="filteredRecords.length === 0" class="request-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M2 12h5l3-8 4 16 3-8h5" /></svg>
      <strong>{{ isRecording ? "等待网络请求" : "录制已暂停" }}</strong>
      <span>{{ isRecording ? "操作页面或刷新以记录请求，也可以调整筛选条件。" : "点击顶部的「已暂停」按钮，继续记录请求。" }}</span>
    </div>
  </section>
</template>
