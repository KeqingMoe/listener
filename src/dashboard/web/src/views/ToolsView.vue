<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { ToolsResponse } from '../../../contracts/contracts';
import type { ToolUsageRole } from '../../../contracts/tool-observations';
import { useResource, useFilters } from '../composables/useDashboard';
import { number, duration } from '../api/client';
import DataState from '../components/ui/DataState.vue';
import AvailabilityNote from '../components/ui/AvailabilityNote.vue';
import {
  directLifecycle,
  directOutcomes,
  internalCoverageNote,
  internalReadable,
  roleVersionNote,
  toolStatisticsRows,
  type ToolSourceSort,
} from './tool-statistics';

const route = useRoute();
const { query, identity } = useFilters();
const { data, loading, error, retry } = useResource<ToolsResponse>(
  computed(() => `tools?${query.value}`),
  identity,
);
const role = ref<ToolUsageRole>('tool');
const sourceSort = ref<ToolSourceSort>('direct');
const missing = '未记录或不可用，不能视为 0。';
const search = computed(() =>
  typeof route.query.q === 'string' ? route.query.q.trim().toLowerCase() : '',
);
const items = computed(() =>
  data.value
    ? toolStatisticsRows(data.value, role.value, sourceSort.value, search.value)
    : [],
);
const directTotal = computed(() =>
  items.value.some((row) => row.direct)
    ? items.value.reduce((sum, row) => sum + (row.direct?.calls ?? 0), 0)
    : null,
);
const internalTotal = computed(() =>
  items.value.some((row) => row.internal)
    ? items.value.reduce(
        (sum, row) => sum + (row.internal?.observedCalls ?? 0),
        0,
      )
    : null,
);
</script>

<template>
  <section :aria-busy="loading">
    <header class="page-heading"><h1>工具统计</h1></header>
    <DataState :loading="loading" :error="error" :stale="!!data" @retry="retry">
      <template v-if="data">
        <AvailabilityNote :value="data.availability" />
        <p class="muted tool-coverage" role="note">
          {{ internalCoverageNote(data) }}
        </p>
        <p v-if="roleVersionNote(data)" class="muted">
          {{ roleVersionNote(data) }}
        </p>
        <p class="muted">
          来源与角色独立：同名工具可直接调用或由 JS
          宿主内部调用。两层不相加为业务动作；调用和返回状态不证明外部效果成功。
        </p>
        <div class="section-title tool-statistics-filters">
          <label
            >工具角色
            <select v-model="role" aria-label="工具角色">
              <option value="tool">普通工具</option>
              <option value="flow_control">流程控制</option>
              <option value="javascript_dispatch">JS 调度</option>
            </select>
          </label>
          <label
            >排序来源
            <select v-model="sourceSort" aria-label="排序来源">
              <option value="direct">直接记录</option>
              <option value="internal">JS 内部已观测</option>
            </select>
          </label>
        </div>
        <p class="muted">
          默认展示普通工具（含读取、管理）；流程控制与 JS
          调度记录保留，可切换查看。角色不是价值判断。
        </p>
        <div class="metric-strip">
          <div>
            <span class="muted">当前分类直接记录</span
            ><strong>{{
              directTotal === null ? '—' : number(directTotal)
            }}</strong>
          </div>
          <div>
            <span class="muted">当前分类 JS 内部已观测</span
            ><strong>{{
              internalTotal === null ? '—' : number(internalTotal)
            }}</strong>
          </div>
          <div>
            <span class="muted">工具名</span
            ><strong>{{ number(items.length) }}</strong>
          </div>
        </div>
        <section class="panel">
          <div class="section-title">
            <h2>按工具汇总</h2>
            <RouterLink :to="{ path: '/wakes', query: route.query }"
              >直接调用复盘 →</RouterLink
            >
          </div>
          <p class="muted">
            直接记录为模型工具账本数，包含待执行、跳过；缺少某来源记录显示
            —，不是零。JS
            无结束观测不等于运行中或失败。内部目前仅展示观测汇总；复盘链接仅查看模型直接调用账本。
          </p>
          <p v-if="route.query.outcome || search" class="muted">
            搜索匹配工具名；此汇总接口统计全部结果，不按结果筛选。
          </p>
          <div class="table-wrap">
            <table class="compact-table tool-statistics-table">
              <thead>
                <tr>
                  <th>工具</th>
                  <th>直接记录</th>
                  <th>JS 内部已观测</th>
                  <th>直接返回结果</th>
                  <th>直接生命周期</th>
                  <th>JS 观测详情</th>
                  <th>直接 P50</th>
                  <th>直接 P95</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in items" :key="row.name">
                  <td>
                    <code>{{ row.name }}</code>
                  </td>
                  <td>
                    {{ row.direct ? number(row.direct.calls) : '— 无记录' }}
                  </td>
                  <td>
                    {{
                      row.internal
                        ? number(row.internal.observedCalls)
                        : internalReadable(data)
                          ? '— 无记录'
                          : '— 未知'
                    }}
                  </td>
                  <td>
                    <details v-if="row.direct">
                      <summary>
                        已处理 {{ number(row.direct.handled) }} · 失败
                        {{ number(row.direct.errors) }}
                      </summary>
                      <p>{{ directOutcomes(row.direct) }}</p>
                      <p class="muted">
                        已处理不保证外部操作成功；与生命周期独立，不合并求和。
                      </p>
                    </details>
                    <span v-else>—</span>
                  </td>
                  <td>
                    <span v-if="row.direct">{{
                      directLifecycle(row.direct)
                    }}</span
                    ><span v-else>—</span>
                  </td>
                  <td>
                    <details v-if="row.internal">
                      <summary>
                        有结束 {{ number(row.internal.withEnd) }} · 无结束
                        {{ number(row.internal.withoutEnd) }}
                      </summary>
                      <p>
                        有开始 {{ number(row.internal.withStart) }} · 无开始
                        {{ number(row.internal.withoutStart) }}
                      </p>
                      <p>
                        中断观测 {{ number(row.internal.interrupted) }} ·
                        桥接异常 {{ number(row.internal.bridgeFailures) }}
                      </p>
                      <p class="muted">
                        中断与结束可并存，不相加。无结束可能在途、丢失或中断；不是运行或失败的证明。
                      </p>
                      <p
                        v-for="(status, index) in row.internal.statuses"
                        :key="index"
                      >
                        原始返回：{{
                          status.kind === 'present'
                            ? status.status
                            : status.kind === 'missing'
                              ? '未提供状态'
                              : '无效状态'
                        }}
                        · {{ number(status.calls) }}
                      </p>
                      <p class="muted">
                        原始状态仅描述宿主返回，不表示外部业务成功。
                      </p>
                      <p>
                        JS P50
                        {{
                          row.internal.durationP50Ms === null
                            ? '—'
                            : duration(row.internal.durationP50Ms)
                        }}
                        · P95
                        {{
                          row.internal.durationP95Ms === null
                            ? '—'
                            : duration(row.internal.durationP95Ms)
                        }}
                      </p>
                    </details>
                    <span v-else>{{
                      internalReadable(data) ? '— 无记录' : '— 未知'
                    }}</span>
                  </td>
                  <td
                    :title="
                      row.direct?.durationP50Ms == null ? missing : undefined
                    "
                  >
                    {{
                      row.direct?.durationP50Ms == null
                        ? '—'
                        : duration(row.direct.durationP50Ms)
                    }}
                  </td>
                  <td
                    :title="
                      row.direct?.durationP95Ms == null ? missing : undefined
                    "
                  >
                    {{
                      row.direct?.durationP95Ms == null
                        ? '—'
                        : duration(row.direct.durationP95Ms)
                    }}
                  </td>
                </tr>
                <tr v-if="!items.length">
                  <td colspan="8" class="muted">
                    当前分类无已记录工具；未知来源不代表零调用。
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="section-title muted">
            <span>参数 / 返回值请进入逐次复盘。</span
            ><RouterLink :to="{ path: '/requests', query: route.query }"
              >请求复盘 →</RouterLink
            >
          </div>
        </section>
      </template>
    </DataState>
  </section>
</template>
