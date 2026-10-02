import type {
  ToolSummary,
  ToolsResponse,
} from '../../../contracts/contracts.ts';
import type {
  InternalToolSummary,
  ToolObservationCoverageReason,
} from '../../../contracts/tool-observations.ts';
import {
  TOOL_USAGE_ROLE_VERSION,
  toolUsageRole,
  type ToolUsageRole,
} from '../../../contracts/tool-observations.ts';

export type ToolSourceSort = 'direct' | 'internal';

export interface ToolStatisticsRow {
  name: string;
  role: ToolUsageRole;
  direct?: ToolSummary;
  internal?: InternalToolSummary;
}

export function internalReadable(data: ToolsResponse): boolean {
  return data.internal?.coverage.status === 'observed';
}

/** Outer join for presentation only; never mutate or add rows to legacy items. */
export function toolStatisticsRows(
  data: ToolsResponse,
  role: ToolUsageRole,
  source: ToolSourceSort,
  search = '',
): ToolStatisticsRow[] {
  const rows = new Map<string, ToolStatisticsRow>();
  for (const direct of data.items) {
    rows.set(direct.name, {
      name: direct.name,
      role: toolUsageRole(direct.name),
      direct,
    });
  }
  if (internalReadable(data)) {
    for (const internal of data.internal!.items) {
      const row = rows.get(internal.name) ?? {
        name: internal.name,
        role: toolUsageRole(internal.name),
      };
      rows.set(internal.name, { ...row, internal });
    }
  }
  const count = (row: ToolStatisticsRow) =>
    source === 'direct' ? row.direct?.calls : row.internal?.observedCalls;
  return [...rows.values()]
    .filter(
      (row) =>
        row.role === role &&
        row.name.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .sort(
      (a, b) =>
        (count(b) ?? -1) - (count(a) ?? -1) || a.name.localeCompare(b.name),
    );
}

const reasons: Record<ToolObservationCoverageReason, string> = {
  collector_not_enabled: '内部采集未启用',
  before_collection: '时间窗含采集启用前历史，未回填',
  retention_gap: '保留期裁剪造成历史缺口',
  known_write_gaps: '采集器历史存在写入故障，不确定是否影响当前时间窗',
  incompatible_schema: '遥测版本不兼容',
  source_unavailable: '遥测来源不可用',
  query_limit: '查询超过资源预算',
};

function coverageTime(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '时间不可表示';
}

export function internalCoverageNote(data: ToolsResponse): string {
  if (!data.internal) {
    return '仅有直接调用记录；JS 内部观测未知（旧响应或未提供）。';
  }
  const c = data.internal.coverage;
  const state =
    c.status === 'observed'
      ? 'JS 内部仅展示保留的已观测请求，不保证完整。'
      : 'JS 内部观测未知，不能视为 0。';
  const dates = [
    c.collectionStartedAt === null
      ? ''
      : `采集启用：${coverageTime(c.collectionStartedAt)}`,
    c.retainedSince === null || c.retainedSince === 0
      ? ''
      : `裁剪边界：${coverageTime(c.retainedSince)}（非完整覆盖起点）`,
  ];
  return [
    state,
    ...c.reasons.map((reason) => reasons[reason] ?? '未知采集限制'),
    ...dates,
  ]
    .filter(Boolean)
    .join('；');
}

export function roleVersionNote(data: ToolsResponse): string | null {
  return data.toolUsageRoleVersion !== undefined &&
    data.toolUsageRoleVersion !== TOOL_USAGE_ROLE_VERSION
    ? '服务端角色分类版本不同；当前按本地已知分类展示，分类不代表工具价值。'
    : null;
}

/** State and outcome are different dimensions; never add them into one remainder. */
export function directLifecycle(tool: ToolSummary): string {
  return `已结束 ${tool.finished} · 待执行 ${tool.pending} · 已开始 ${tool.started}`;
}

export function directOutcomes(tool: ToolSummary): string {
  return `已处理 ${tool.handled} · 失败 ${tool.errors} · 拒绝 ${tool.rejected} · 延后 ${tool.deferred} · 取消 ${tool.cancelled} · 不明 ${tool.unknown} · 跳过 ${tool.skipped}`;
}
