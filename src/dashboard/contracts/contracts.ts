import type { ModelRequestDiagnostics } from '../../observability/model-diagnostics.ts';
import type { RequestOutcome, ToolOutcome } from './outcomes.ts';
import type { CacheMetrics } from './metrics.ts';

export interface Range {
  since: number;
  until: number;
}

export interface Availability {
  telemetry: boolean;
  sessions: Array<{ groupId: string; available: boolean }>;
}

export interface GroupMeta {
  groupId: string;
}

export interface MetaResponse {
  groups: GroupMeta[];
  /** 当前配置中定义的具名模型名，供筛选使用。 */
  models: string[];
  readOnly: true;
  maxRangeDays: 31;
  now: number;
  availability: Availability;
}

export interface UsageSummary {
  performance: import('./metrics.ts').PerformanceMetrics;
  requests: number;
  successes: number;
  errors: number;
  timeouts: number;
  cancelled: number;
  running: number;
  interrupted: number;
  unknown: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheHitRate: number | null;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  /** 流式输出速率，不含TTFT，只统计计时和usage都有效的请求。 */
  tps: number | null;
  ttftMs: number | null;
}

export interface OverviewResponse {
  range: Range;
  availability: Availability;
  summary: UsageSummary;
  series: Array<UsageSummary & { bucketStart: number }>;
  groups: Array<UsageSummary & { groupId: string }>;
  /** 按具名模型名汇总；modelName为null表示未记录模型名的旧请求。 */
  models: Array<UsageSummary & { modelName: string | null }>;
}

export interface WakeItem extends CacheMetrics {
  performance: import('./metrics.ts').PerformanceMetrics;
  tps: number | null;
  ttftMs: number | null;
  wakeId: string;
  groupId: string;
  sessionId: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  outcome: string | null;
  reasonCode: string | null;
  diagnostics: Record<string, number>;
  /** 本次唤醒Bot发言的纯文本摘要（已脱敏、截断）；没有发言时为null。 */
  reply: string | null;
  modelRequests: number;
  toolCalls: number;
  /** 总输入token，包含缓存命中部分。 */
  inputTokens: number | null;
  uncachedInputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens: number | null;
}

export interface WakesResponse {
  range: Range;
  availability: Availability;
  items: WakeItem[];
  nextCursor: string | null;
}

export interface RequestItem extends CacheMetrics {
  performance: import('./metrics.ts').PerformanceMetrics;
  tps: number | null;
  ttftMs: number | null;
  requestId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: 'success' | 'error' | 'unknown';
  outcome: RequestOutcome;
  errorCode: string | null;
  httpStatus: number | null;
  diagnostics: ModelRequestDiagnostics | null;
  transport: 'chat' | 'responses' | 'unknown';
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}

export interface ToolItem {
  ordinal: number;
  name: string;
  state: string;
  proposedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  status: string | null;
  outcome: ToolOutcome;
  reasonCode: string | null;
}

export interface WakeDetailResponse {
  wake: WakeItem;
  requests: RequestItem[];
  tools: ToolItem[];
  truncated: boolean;
  availability: Availability;
}

export interface ToolSummary {
  name: string;
  calls: number;
  finished: number;
  pending: number;
  started: number;
  unknown: number;
  skipped: number;
  handled: number;
  rejected: number;
  deferred: number;
  cancelled: number;
  errors: number;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
}

export interface ToolsResponse {
  range: Range;
  availability: Availability;
  /** Legacy fields remain direct model_tool_ledger records, never direct + internal. */
  items: ToolSummary[];
  /** Absent on older servers: internal observations are unknown, not zero. */
  internal?: import('./tool-observations.ts').InternalToolsResponse;
  toolUsageRoleVersion?: number;
}

// 元数据API约定：
// GET /api/meta
// GET /api/overview|wakes|tools?since=<epoch ms>&until=<epoch ms>&groupId=<可选，已启用的群>
// GET /api/wakes另外接受limit（1..100，默认30）、不透明cursor、元数据搜索q和outcome。
// outcome=running表示尚未结束；failed/cancelled会归并相关的终止原因；其他值按原始outcome匹配。
// GET /api/wakes/:id必须带groupId。详情数组上限500项。
// 范围默认最近24小时，最长31天。未知值为null而非0。
// 翻页时须使用上次响应中的response.range since/until及原groupId。
// wake列表和review摘要按inspection/message记录的物理turn稳定关联请求，包含失败和进行中的请求。
// 元数据详情的请求数组只来自已持久化的message.request_id；不要假设wakeId=turnId。
// uncachedInputTokens和cacheHitRate只使用input/cache成对有效的样本；缺失的usage不按0计。
// performance.tps只统计output usage和生成计时已知的成功流式请求；ttftMs是有测量值请求的首token等待均值。
// performance.modelDurationMs是已结束HTTP请求的耗时之和（含失败），缺失测量由coverage暴露。
// toolDurationMs是ledger真实耗时的累加；toolWallDurationMs/modelWallDurationMs对嵌套或重叠区间取并集。
// otherDurationMs = wake墙钟时间减模型区间并集，并非独占的工具/NapCat/DB延迟；不要把工具累计耗时加到墙钟时间上。
// 全局的wall/round TPS以及单个请求的tool/other耗时为null：不做整轮或全局时间归因。
// 跨session的物理turn范围可能跨越wake边界，其墙钟分析保持null并给出whyIncomplete，不会为负或被截断。
// overview/tools扫描超过10,000行时返回503，应缩小范围，而不是展示不完整的合计。
// 元数据API不返回消息内容、原始工具参数/结果、checkpoint或文件系统路径。
// 经授权的review详情API返回有界且已清除凭据的内容，见review.ts。
