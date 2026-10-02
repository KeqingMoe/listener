import { DatabaseSync } from 'node:sqlite';
import {
  performanceMetrics,
  intervalDuration,
  requestDuration,
} from '../contracts/metrics.ts';
import { lstatSync } from 'node:fs';
import { sanitizeInspectionValue } from '../../observability/request-inspection.ts';
import { SESSION_PHYSICAL_TURN } from '../../agent/session/indexes.ts';
import { canonicalMessageId } from '../../onebot/identity.ts';
import { normalizeModelRequestDiagnostics } from '../../observability/model-diagnostics.ts';
import { type Repository, ResourceLimit, summarize } from './repository.ts';
import {
  requestOutcome,
  toolOutcome,
  toolReason,
} from '../contracts/outcomes.ts';
import { eventTitle } from '../contracts/event-labels.ts';
import { isJavascriptJobId } from '../contracts/javascript-jobs.ts';
import type { Range, WakeItem } from '../contracts/contracts.ts';
import type {
  ReviewRequest,
  ReviewTool,
  RequestReviewDetail,
  WakeReviewDetail,
  HealthResponse,
  ReviewEvent,
} from '../contracts/review.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SQLite行的列由本模块建表语句保证
type Row = Record<string, any>;
type Scope = { requestIds?: string[]; turnIds?: string[]; wakeIds?: string[] };
type ContentBudget = { remaining: number; truncated: boolean };

const newBudget = (): ContentBudget => ({
  remaining: 8 * 1024 * 1024,
  truncated: false,
});

/** 逐行迭代而不是一次性取出数百行可能很大的数据；超过条数或字节预算时标记truncated并停止。 */
function collectContent(
  iterator: Iterable<Row>,
  count: number,
  budget: ContentBudget,
): Row[] {
  const rows: Row[] = [];
  for (const row of iterator) {
    const bytes = Buffer.byteLength(JSON.stringify(row));
    if (rows.length >= count || bytes > budget.remaining) {
      budget.truncated = true;
      break;
    }
    budget.remaining -= bytes;
    rows.push(row);
  }
  return rows;
}

const n = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const s = (v: unknown): string | null =>
  typeof v === 'string' && v.length ? v : null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 解析本服务写入的JSON列，结构由写入方保证
const parse = (v: unknown): any => {
  if (typeof v !== 'string') {
    return v ?? null;
  }
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
const MEMBER_ID_KEY = /^(?:user_?id|actor_id|operator_id|recalled_by)$/i;
const REPLY_ID_KEY = /^(?:reply_to|replyTo)$/;
const MAX_LOOKUP_IDS = 200;
const MAX_QUOTED_TEXT = 500;

/** 收集工具参数与结果中出现的成员QQ号和被回复消息ID，深度和数量有界。 */
function lookupIds(values: unknown[]) {
  const members = new Set<string>(),
    replies = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 12 || !value) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, depth + 1));
    } else if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        const id = typeof item === 'number' ? String(item) : item;
        const valid = typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id);
        if (valid && MEMBER_ID_KEY.test(key)) {
          members.size < MAX_LOOKUP_IDS && members.add(id);
        } else if (REPLY_ID_KEY.test(key)) {
          const messageId = canonicalMessageId(item);
          if (messageId !== undefined && replies.size < MAX_LOOKUP_IDS) {
            replies.add(messageId);
          }
        } else {
          walk(item, depth + 1);
        }
      }
    }
  };
  values.forEach((value) => walk(value, 0));
  return { members: [...members], replies: [...replies] };
}

const columns = (db: DatabaseSync, table: string) =>
  new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => String(r.name)),
  );
const cap = (rows: Row[]) => {
  if (rows.length > 10000) {
    throw new ResourceLimit();
  }
  return rows;
};
// 本地logger产生的、经过审查的生命周期/连接事件的精确列表。
// group为null的工具/消息事件绝不会因此变为全局可见。
const GLOBAL_REVIEW_EVENTS = [
  'app.start',
  'app.stopping',
  'app.stopped',
  'app.startup_failed',
  'app.shutdown_failed',
  'app.faces_ready',
  'app.reactions_ready',
  'app.diagnostics_unavailable',
  'app.registry_failed',
  'app.group_discovery_failed',
  'app.group_cleanup_failed',
  'app.custom_faces_close_failed',
  'onebot.connecting',
  'onebot.ready',
  'onebot.disconnected',
  'onebot.connection_failed',
  'onebot.reconnect_scheduled',
  'onebot.heartbeat_timeout',
  'onebot.identity_failed',
  'onebot.api_failed',
];
const fields = [
  'request_id',
  'group_id',
  'turn_id',
  'wake_id',
  'model',
  'model_name',
  'transport',
  'started_at',
  'ended_at',
  'duration_ms',
  'ttft_ms',
  'decode_duration_ms',
  'status',
  'error_code',
  'http_status',
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'response_id',
  'previous_response_id',
  'provider_request_id',
  'request_mode',
  'content_truncated',
  'diagnostics',
];

/**
 * review页面的数据访问层：合并telemetry与inspection两张表的请求记录，
 * 所有内容在返回前经过凭据清洗，并受条数和8MB内容预算限制。
 */
export class ReviewRepository {
  constructor(readonly base: Repository) {}
  private clean(value: unknown) {
    return sanitizeInspectionValue(
      value,
      this.base.sources.inspectionSecrets ?? [],
    );
  }

  private text(value: unknown): string | null {
    const c = this.clean(value).value;
    return typeof c === 'string' && c.trim()
      ? c
      : c && typeof c === 'object'
        ? JSON.stringify(c)
        : null;
  }

  private rows(
    table: string,
    groupId: string,
    range?: Range,
    id?: string,
    scope?: Scope,
    trendOnly = false,
    telemetry?: DatabaseSync | null,
  ): Row[] {
    const db = telemetry === undefined ? this.base.telemetry() : telemetry;
    if (!db) {
      return [];
    }
    const cols = columns(db, table);
    if (!cols.has('group_id') || !cols.has('request_id')) {
      return [];
    }
    const trendFields = new Set([
      'request_id',
      'group_id',
      'started_at',
      'ended_at',
      'duration_ms',
      'ttft_ms',
      'decode_duration_ms',
      'status',
      'error_code',
      'input_tokens',
      'cached_input_tokens',
      'output_tokens',
      'ttft_ms',
      'decode_duration_ms',
    ]);
    const selection = fields
      .map((f) =>
        cols.has(f) && (!trendOnly || trendFields.has(f)) ? f : `NULL AS ${f}`,
      )
      .join(',');
    const clauses: string[] = [],
      params: string[] = [];
    if (scope) {
      for (const [key, values] of [
        ['request_id', scope.requestIds],
        ['turn_id', scope.turnIds],
        ['wake_id', scope.wakeIds],
      ] as const) {
        if (cols.has(key) && values?.length) {
          clauses.push(`${key} IN (${values.map(() => '?').join(',')})`);
          params.push(...values);
        }
      }
    }
    if (scope && !clauses.length) {
      return [];
    }
    // 只按key刷新趋势时必须按request身份定位，不能扫描时间范围索引，因此显式指定索引。
    let indexed = '';
    if (trendOnly && scope?.requestIds?.length) {
      const index = db
        .prepare(`PRAGMA index_list(${table})`)
        .all()
        .find((i) => {
          const keys = db
            .prepare(`PRAGMA index_info(${JSON.stringify(String(i.name))})`)
            .all()
            .map((c) => c.name);
          return (
            keys[0] === 'request_id' ||
            (keys[0] === 'group_id' && keys[1] === 'request_id')
          );
        });
      if (index) {
        indexed = ` INDEXED BY ${JSON.stringify(String(index.name))}`;
      }
    }
    return cap(
      db
        .prepare(
          `SELECT ${selection} FROM ${table}${indexed} WHERE group_id=?${range ? ' AND started_at BETWEEN ? AND ?' : ''}${id ? ' AND request_id=?' : ''}${scope ? ` AND (${clauses.join(' OR ')})` : ''} LIMIT 10001`,
        )
        .all(
          groupId,
          ...(range ? [range.since, range.until] : []),
          ...(id ? [id] : []),
          ...params,
        ) as Row[],
    );
  }

  private messages(
    groupId: string,
    scope: Scope,
    content = false,
    budget = newBudget(),
  ): Row[] {
    const db = this.base.session(groupId);
    if (!db) {
      return [];
    }
    // 只提取用于关联的稳定元数据；列表读取时绝不传输历史消息内容。
    const turn = SESSION_PHYSICAL_TURN;
    const clauses: string[] = [],
      params: string[] = [];
    for (const [expression, values] of [
      ['request_id', scope.requestIds],
      [turn, scope.turnIds],
      ['wake_id', scope.wakeIds],
    ] as const) {
      if (values?.length) {
        clauses.push(`${expression} IN (${values.map(() => '?').join(',')})`);
        params.push(...values);
      }
    }
    if (!clauses.length) {
      return [];
    }
    const hasCreatedAt = columns(db, 'model_session_messages').has(
      'created_at',
    );
    const statement = db.prepare(
      `SELECT seq,session_id,wake_id,request_id,${hasCreatedAt ? 'created_at' : 'NULL AS created_at'},${turn} AS physical_turn,${content ? 'substr(message,1,1048576)' : 'NULL'} AS message,${content ? 'length(message)>1048576' : '0'} AS clipped FROM model_session_messages WHERE ${clauses.join(' OR ')} ORDER BY seq LIMIT ${content ? '501' : '10001'}`,
    );
    return content
      ? collectContent(statement.iterate(...params), 500, budget)
      : cap(statement.all(...params) as Row[]);
  }

  private associations(
    groupId: string,
    scope: Scope,
    content = false,
    budget = newBudget(),
  ) {
    const messages = this.messages(groupId, scope, content, budget),
      byRequest = new Map<string, string>(),
      byTurn = new Map<string, Set<string>>();
    for (const row of messages) {
      if (s(row.request_id) && s(row.wake_id)) {
        byRequest.set(row.request_id, row.wake_id);
      }
      const turn = s(row.physical_turn);
      if (turn && s(row.wake_id)) {
        const wakes = byTurn.get(turn) ?? new Set<string>();
        wakes.add(row.wake_id);
        byTurn.set(turn, wakes);
      }
    }
    return { messages, byRequest, byTurn };
  }

  requests(
    range?: Range,
    groupId?: string,
    id?: string,
    scope?: Scope,
    options?: { skipAssociations?: boolean; telemetry?: DatabaseSync | null },
  ): ReviewRequest[] {
    const result: ReviewRequest[] = [];
    for (const g of this.base.groups.filter(
      (g) => !groupId || g.groupId === groupId,
    )) {
      const telemetry = this.rows(
          'model_requests',
          g.groupId,
          range,
          id,
          scope,
          options?.skipAssociations,
          options?.telemetry,
        ),
        inspection = this.rows(
          'model_request_inspections',
          g.groupId,
          range,
          id,
          scope,
          options?.skipAssociations,
          options?.telemetry,
        );
      const primaryById = new Map(
        telemetry.map((row) => [row.request_id, row]),
      );
      // 先放inspection行，再用telemetry中的非null字段覆盖：telemetry是主测量来源。
      const merged = new Map<string, Row>();
      for (const row of inspection) {
        merged.set(row.request_id, { ...row, hasInspection: true });
      }
      for (const row of telemetry) {
        const old = merged.get(row.request_id);
        merged.set(row.request_id, {
          ...old,
          ...Object.fromEntries(
            Object.entries(row).filter(([, v]) => v !== null),
          ),
          hasInspection: !!old,
        });
      }
      if (!merged.size) {
        continue;
      }
      const legacy = [...merged.values()].filter((row) => !s(row.wake_id));
      const a =
        legacy.length && !options?.skipAssociations
          ? this.associations(g.groupId, {
              requestIds: legacy.map((row) => String(row.request_id)),
              turnIds: [
                ...new Set(
                  legacy
                    .map((row) => s(row.turn_id))
                    .filter((v): v is string => v !== null),
                ),
              ],
            })
          : {
              byRequest: new Map<string, string>(),
              byTurn: new Map<string, Set<string>>(),
            };
      for (const row of merged.values()) {
        // inspection恢复时写入的ended_at是重启时刻，并非HTTP结束时刻。
        // 只有telemetry中的真实测量才能确定被中断请求的耗时。
        if (
          row.status === 'interrupted' &&
          n(primaryById.get(row.request_id)?.ended_at) === null
        ) {
          row.ended_at = null;
          row.duration_ms = null;
        }
        const total = n(row.input_tokens),
          cached = n(row.cached_input_tokens),
          output = n(row.output_tokens),
          duration = requestDuration(row);
        const usage = summarize([row]),
          performance = performanceMetrics([row], { attribution: 'request' });
        const wakes = a.byTurn.get(row.turn_id),
          wake =
            s(row.wake_id) ??
            a.byRequest.get(row.request_id) ??
            // 按turn反查时，只有唯一对应一个wake才采用，避免错误归属。
            (wakes?.size === 1 ? [...wakes][0]! : null);
        result.push({
          performance,
          cacheHitRate: usage.cacheHitRate,
          requestId: row.request_id,
          groupId: g.groupId,
          wakeId: wake,
          turnId: s(row.turn_id),
          model: this.text(row.model),
          modelName: this.text(row.model_name),
          transport: s(row.transport) ?? 'unknown',
          startedAt: n(row.started_at) ?? 0,
          endedAt: n(row.ended_at),
          durationMs: duration,
          status: s(row.status) ?? 'unknown',
          outcome:
            row.status === 'running' || row.status === 'interrupted'
              ? row.status
              : requestOutcome(row.status, row.error_code),
          errorCode: this.text(row.error_code),
          httpStatus: n(row.http_status),
          diagnostics:
            normalizeModelRequestDiagnostics(parse(row.diagnostics)) ?? null,
          inputTokens:
            total !== null && cached !== null && cached <= total
              ? total - cached
              : null,
          totalInputTokens: total,
          cachedInputTokens:
            cached !== null && total !== null && cached > total ? null : cached,
          outputTokens: output,
          reasoningTokens: n(row.reasoning_tokens),
          tps: performance.tps,
          ttftMs: performance.ttftMs,
          decodeDurationMs: performance.decodeDurationMs,
          responseId: this.text(row.response_id),
          previousResponseId: this.text(row.previous_response_id),
          providerRequestId: this.text(row.provider_request_id),
          requestMode: this.text(row.request_mode),
          hasInspection: row.hasInspection,
        });
      }
      cap(result);
    }
    return result.sort(
      (a, b) =>
        b.startedAt - a.startedAt ||
        a.groupId.localeCompare(b.groupId) ||
        a.requestId.localeCompare(b.requestId),
    );
  }

  private tools(
    groupId: string,
    wakeIds: Set<string>,
    messages: Row[],
    budget = newBudget(),
    requestId?: string,
  ): { items: ReviewTool[]; truncated: boolean } {
    const db = this.base.session(groupId);
    if (!db) {
      return { items: [], truncated: false };
    }
    const cols = columns(db, 'model_tool_ledger');
    const items: ReviewTool[] = [];
    let truncated = false;
    const bySeq = new Map(messages.map((m) => [m.seq, m]));
    const assistantSeqs = requestId
      ? messages.filter((m) => m.request_id === requestId).map((m) => m.seq)
      : [];
    if (requestId && (!cols.has('assistant_seq') || !assistantSeqs.length)) {
      return { items: [], truncated: false };
    }
    for (const wake of wakeIds) {
      if (items.length >= 500 || budget.remaining <= 0) {
        truncated = true;
        break;
      }
      const statement = db.prepare(
        `SELECT ordinal,name,state,proposed_at,started_at,finished_at,substr(arguments,1,1048576) AS arguments,substr(result,1,1048576) AS result,length(arguments)>1048576 OR length(result)>1048576 AS clipped,${cols.has('assistant_seq') ? 'assistant_seq' : 'NULL AS assistant_seq'},${cols.has('call_id') ? 'call_id' : 'NULL AS call_id'} FROM model_tool_ledger WHERE wake_id=?${requestId ? ` AND assistant_seq IN (${assistantSeqs.map(() => '?').join(',')})` : ''} ORDER BY ordinal LIMIT 501`,
      );
      const rows = collectContent(
        statement.iterate(wake, ...assistantSeqs),
        500 - items.length,
        budget,
      );
      truncated ||= budget.truncated;
      for (const row of rows.slice(0, 500)) {
        const args = this.clean(parse(row.arguments)),
          res = this.clean(parse(row.result)),
          raw = parse(row.result),
          diagnostic = {
            ...row,
            ...(raw && typeof raw === 'object' ? raw : {}),
          };
        truncated ||= args.truncated || res.truncated || !!row.clipped;
        items.push({
          ordinal: row.ordinal,
          name: this.text(row.name) ?? 'unknown',
          requestId: s(bySeq.get(row.assistant_seq)?.request_id),
          callId: s(row.call_id),
          state: s(row.state) ?? 'unknown',
          status: this.text(raw?.status),
          outcome: toolOutcome(diagnostic),
          reasonCode: toolReason(diagnostic),
          proposedAt: n(row.proposed_at),
          startedAt: n(row.started_at),
          finishedAt: n(row.finished_at),
          durationMs: intervalDuration(row.started_at, row.finished_at),
          arguments: args.value,
          result: res.value,
        });
      }
    }
    if (items.length > 500) {
      truncated = true;
    }
    return {
      items: items.sort((a, b) => a.ordinal - b.ordinal).slice(0, 500),
      truncated,
    };
  }

  detail(groupId: string, id: string): RequestReviewDetail | null {
    const request = this.requests(undefined, groupId, id)[0];
    if (!request) {
      return null;
    }
    const db = this.base.telemetry(),
      cols = db ? columns(db, 'model_request_inspections') : new Set<string>();
    const bodyFields = [
      'request_json',
      'response_json',
      'reasoning_text',
      'error_text',
    ];
    const row =
      db && cols.has('group_id')
        ? (db
            .prepare(
              `SELECT ${bodyFields.map((f) => (cols.has(f) ? `substr(${f},1,1048576) AS ${f}` : `NULL AS ${f}`)).join(',')},${cols.has('content_truncated') ? 'content_truncated' : '0 AS content_truncated'},(${
                bodyFields
                  .filter((f) => cols.has(f))
                  .map((f) => `COALESCE(length(${f})>1048576,0)`)
                  .join(' OR ') || '0'
              }) AS clipped FROM model_request_inspections WHERE group_id=? AND request_id=?`,
            )
            .get(groupId, id) as Row | undefined)
        : undefined;
    const budget = newBudget();
    budget.remaining -= Buffer.byteLength(JSON.stringify(row ?? {}));
    const a = this.associations(
      groupId,
      { requestIds: [id] },
      typeof row?.response_json !== 'string',
      budget,
    );
    const assistant = a.messages.find((m) => m.request_id === id);
    // 没有保存请求体时，用session中的历史消息作为回退，明确标注来源，并非还原的HTTP快照。
    const historical =
      assistant && typeof row?.request_json !== 'string'
        ? collectContent(
            this.base
              .session(groupId)!
              .prepare(
                'SELECT substr(message,1,1048576) AS message,length(message)>1048576 AS clipped FROM model_session_messages WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT 501',
              )
              .iterate(assistant.session_id, assistant.seq),
            500,
            budget,
          )
            .reverse()
            .map((m) => {
              budget.truncated ||= !!m.clipped;
              return parse(m.message);
            })
        : null;
    const tools = this.tools(
      groupId,
      new Set(
        a.messages.filter((m) => m.request_id === id).map((m) => m.wake_id),
      ),
      a.messages,
      budget,
      id,
    );
    const req = this.clean(
        parse(row?.request_json) ??
          (historical
            ? { source: 'persisted_session_context', messages: historical }
            : null),
      ),
      res = this.clean(
        parse(row?.response_json) ??
          (assistant ? parse(assistant.message) : null),
      );
    // response链只在当前已授权的群内查找，session轮换后也能串起来。
    const chainIds =
      db && cols.has('response_id') && cols.has('previous_response_id')
        ? db
            .prepare(
              'SELECT request_id FROM model_request_inspections WHERE group_id=? AND (response_id=? OR previous_response_id=?) LIMIT 502',
            )
            .all(groupId, request.previousResponseId, request.responseId)
            .map((r) => String(r.request_id))
        : [];
    const all = chainIds.length
        ? this.requests(undefined, groupId, undefined, { requestIds: chainIds })
        : [],
      link = (r: ReviewRequest) => ({
        requestId: r.requestId,
        groupId: r.groupId,
        wakeId: r.wakeId,
      });
    const previous = request.previousResponseId
      ? all.find(
          (r) =>
            r.requestId !== id && r.responseId === request.previousResponseId,
        )
      : undefined;
    return {
      request,
      requestBody: req.value,
      responseBody: res.value,
      reasoningText: this.text(row?.reasoning_text),
      errorText: this.text(row?.error_text),
      contentTruncated:
        budget.truncated ||
        chainIds.length > 501 ||
        !!row?.content_truncated ||
        !!row?.clipped ||
        req.truncated ||
        res.truncated ||
        tools.truncated ||
        this.clean(row?.reasoning_text).truncated ||
        this.clean(row?.error_text).truncated,
      tools: tools.items.filter((t) => t.requestId === id),
      ...this.worldLookup(
        groupId,
        tools.items.filter((t) => t.requestId === id),
      ),
      previousRequest: previous ? link(previous) : null,
      nextRequests: request.responseId
        ? all
            .filter(
              (r) =>
                r.requestId !== id &&
                r.previousResponseId === request.responseId,
            )
            .slice(0, 500)
            .map(link)
        : [],
    };
  }

  /**
   * 列表和展开的review共用的、有界且只含元数据的范围。
   * 从wake出发经物理turn扩展，收集相关请求以及同turn涉及的其他wake。
   */
  private wakeRequestScope(groupId: string, wakeId: string) {
    const initial = this.associations(groupId, { wakeIds: [wakeId] }),
      turns = new Set(initial.byTurn.keys());
    const direct = this.requests(undefined, groupId, undefined, {
      wakeIds: [wakeId],
      requestIds: [...initial.byRequest.keys()],
    });
    for (const r of direct) {
      if (r.turnId) {
        turns.add(r.turnId);
      }
    }
    const requests = this.requests(undefined, groupId, undefined, {
      wakeIds: [wakeId],
      requestIds: [...initial.byRequest.keys()],
      turnIds: [...turns],
    });
    const related = this.associations(groupId, { turnIds: [...turns] });
    const wakes = new Set([
      wakeId,
      ...requests.map((r) => r.wakeId).filter((w): w is string => w !== null),
    ]);
    for (const t of turns) {
      for (const w of related.byTurn.get(t) ?? []) {
        wakes.add(w);
      }
    }
    return { requests, turns, wakes };
  }

  private summarizeWake(wake: WakeItem, requests: ReviewRequest[]): WakeItem {
    const rows = requests.map((request) => ({
      interval_known: request.performance.coverage.modelIntervalRequests === 1,
      started_at: request.startedAt,
      ended_at: request.endedAt,
      input_tokens: request.totalInputTokens,
      cached_input_tokens: request.cachedInputTokens,
      output_tokens: request.outputTokens,
      ttft_ms: request.ttftMs,
      decode_duration_ms: request.decodeDurationMs,
      status: request.status,
      error_code: request.errorCode,
      duration_ms: request.durationMs,
    }));
    const usage = summarize(rows);
    const tools = this.base.toolTimings(undefined, wake.groupId, wake.wakeId);
    const performance = performanceMetrics(rows, {
      attribution: 'wake',
      startedAt: wake.startedAt,
      finishedAt: wake.finishedAt,
      tools,
      sourceComplete:
        this.base.telemetry() !== null &&
        this.base.session(wake.groupId) !== null,
    });
    return {
      ...wake,
      performance,
      tps: usage.tps,
      ttftMs: usage.ttftMs,
      cacheHitRate: usage.cacheHitRate,
      modelRequests: requests.length,
      inputTokens: usage.inputTokens,
      uncachedInputTokens: usage.uncachedInputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
    };
  }

  wakeSummary(wake: WakeItem): WakeItem {
    return this.summarizeWake(
      wake,
      this.wakeRequestScope(wake.groupId, wake.wakeId).requests,
    );
  }

  wake(groupId: string, wakeId: string): WakeReviewDetail | null {
    const legacy = this.base.detail(groupId, wakeId);
    if (!legacy) {
      return null;
    }
    const { requests, turns, wakes } = this.wakeRequestScope(groupId, wakeId);
    const budget = newBudget();
    const a = this.associations(groupId, { wakeIds: [...wakes] }, true, budget);
    const tools = this.tools(
      groupId,
      wakes,
      this.messages(groupId, { wakeIds: [...wakes] }),
      budget,
    );
    let truncated = tools.truncated || requests.length > 500;
    const rawMessages = a.messages.filter((m) => wakes.has(m.wake_id));
    truncated ||= rawMessages.length > 500;
    const messages = rawMessages.slice(0, 500).map((row) => {
      const raw = parse(row.message),
        clean = this.clean(raw?.content ?? raw);
      truncated ||= clean.truncated || !!row.clipped;
      return {
        role: s(raw?.role) ?? 'unknown',
        content: clean.value,
        ...(s(raw?.tool_call_id) ? { toolCallId: raw.tool_call_id } : {}),
        ...(s(row.request_id) ? { requestId: row.request_id } : {}),
        createdAt: n(row.created_at),
      };
    });
    const events: WakeReviewDetail['events'] = [];
    const db = this.base.session(groupId)!;
    for (const w of wakes) {
      const rows = collectContent(
        db
          .prepare(
            'SELECT created_at,kind,substr(payload,1,1048576) AS payload,length(payload)>1048576 AS clipped FROM model_session_journal WHERE wake_id=? ORDER BY seq LIMIT 501',
          )
          .iterate(w),
        Math.max(0, 500 - events.length),
        budget,
      );
      truncated ||= budget.truncated;
      for (const row of rows.slice(0, 500)) {
        const payload = parse(row.payload);
        const clean = this.clean(payload);
        const jobId =
          row.kind === 'external_event_received' &&
          typeof payload?.event_id === 'string' &&
          payload.event_id.length <= 256
            ? /^\d+:(js_[A-Za-z0-9_-]+)$/.exec(payload.event_id)?.[1]
            : undefined;
        truncated ||= clean.truncated || !!row.clipped;
        events.push({
          time: n(row.created_at),
          kind: s(row.kind) ?? 'unknown',
          title: eventTitle(s(row.kind) ?? 'unknown'),
          detail: clean.value,
          ...(jobId && isJavascriptJobId(jobId) && this.text(jobId) === jobId
            ? { javascriptJobId: jobId }
            : {}),
        });
      }
    }
    const telemetry = this.base.telemetry();
    if (telemetry && columns(telemetry, 'runtime_events').has('turn_id')) {
      for (const turn of turns) {
        const rows = collectContent(
          telemetry
            .prepare(
              'SELECT observed_at,event,substr(fields,1,1048576) AS fields FROM runtime_events WHERE group_id=? AND turn_id=? ORDER BY seq LIMIT 501',
            )
            .iterate(groupId, turn),
          Math.max(0, 500 - events.length),
          budget,
        );
        truncated ||= budget.truncated;
        for (const row of rows.slice(0, 500)) {
          const clean = this.clean(parse(row.fields));
          truncated ||= clean.truncated;
          events.push({
            time: n(row.observed_at),
            kind: s(row.event) ?? 'unknown',
            title: eventTitle(s(row.event) ?? 'unknown'),
            detail: clean.value,
          });
        }
      }
    }
    const meta = rawMessages
      .map((m) => parse(parse(m.message)?.content)?.wake)
      .find((w) => w?.trigger);
    const trigger = meta?.trigger
      ? {
          ...(s(meta.trigger.type)
            ? { type: this.text(meta.trigger.type)! }
            : {}),
          ...(Array.isArray(meta.trigger.message_ids)
            ? {
                messageIds: meta.trigger.message_ids.filter(
                  (v: unknown) => typeof v === 'string',
                ),
              }
            : {}),
          ...(s(meta.trigger.actor_id)
            ? { actorId: meta.trigger.actor_id }
            : {}),
        }
      : null;
    return {
      wake: this.summarizeWake(legacy.wake, requests),
      requests: requests.slice(0, 500),
      tools: tools.items,
      ...this.worldLookup(groupId, tools.items),
      messages,
      events: events
        .sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
        .slice(0, 500),
      trigger,
      contentTruncated: truncated || budget.truncated || events.length > 500,
    };
  }

  events(
    range: Range,
    groupId: string | undefined,
    category: string | undefined,
    query: string | undefined,
    after: number,
    limit: number,
  ): { items: ReviewEvent[]; hasMore: boolean } {
    const db = this.base.telemetry();
    if (!db || !columns(db, 'runtime_events').has('event')) {
      return { items: [], hasMore: false };
    }
    const groups = this.base.groups
      .filter((g) => !groupId || g.groupId === groupId)
      .map((g) => g.groupId);
    // 只有连接/生命周期事件是全局的；未知的null-group事件一律不可见。
    const global = `(group_id IS NULL AND event IN (${GLOBAL_REVIEW_EVENTS.map(() => '?').join(',')}))`;
    // 心跳只用于推断health，不出现在给人看的事件时间线里。
    const terms = [
      'observed_at BETWEEN ? AND ?',
      'seq<?',
      "event!='app.heartbeat'",
      `(${global}${groups.length ? ` OR group_id IN (${groups.map(() => '?').join(',')})` : ''})`,
    ];
    const params: (number | string)[] = [
      range.since,
      range.until,
      after,
      ...GLOBAL_REVIEW_EVENTS,
      ...groups,
    ];
    if (category) {
      terms.push("(event=? OR event LIKE ? ESCAPE '\\')");
      params.push(category, category + '.%');
    }
    if (query) {
      terms.push(
        "(instr(lower(event),?)>0 OR instr(lower(COALESCE(group_id,'')),?)>0 OR instr(lower(COALESCE(turn_id,'')),?)>0 OR instr(lower(COALESCE(message_id,'')),?)>0)",
      );
      params.push(...Array(4).fill(query.toLowerCase()));
    }
    const rows = db
      .prepare(
        `SELECT seq,observed_at,event,group_id,turn_id,message_id,substr(fields,1,65536) AS fields FROM runtime_events WHERE ${terms.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as Row[];
    return {
      items: rows.slice(0, limit).map((row) => {
        const raw = parse(row.fields);
        return {
          sequence: row.seq,
          time: row.observed_at,
          event: this.text(row.event) ?? 'unknown',
          level: this.text(raw?.level),
          groupId: s(row.group_id),
          turnId: s(row.turn_id),
          messageId: s(row.message_id),
          title: eventTitle(s(row.event) ?? 'unknown'),
          detail: this.clean(raw).value,
        };
      }),
      hasMore: rows.length > limit,
    };
  }

  /**
   * 按本群world库补全工具内容引用的对象：成员QQ号到最近一次观测的群名片或昵称，
   * 以及被回复消息的发送者和内容。只读、有界；world库缺失或不属于本群时为空。
   */
  private worldLookup(
    groupId: string,
    tools: readonly { arguments: unknown; result: unknown }[],
  ): Pick<WakeReviewDetail, 'memberNames' | 'quotedMessages'> {
    const ids = lookupIds(tools.flatMap((t) => [t.arguments, t.result]));
    const source = this.base.groups.find((g) => g.groupId === groupId);
    const out: Pick<WakeReviewDetail, 'memberNames' | 'quotedMessages'> = {
      memberNames: {},
      quotedMessages: {},
    };
    if ((!ids.members.length && !ids.replies.length) || !source?.worldPath) {
      return out;
    }
    let db: DatabaseSync | undefined;
    try {
      if (!lstatSync(source.worldPath).isFile()) {
        return out;
      }
      db = new DatabaseSync(source.worldPath, { readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
      if (
        db
          .prepare('SELECT group_id FROM world_identity WHERE singleton=1')
          .get()?.group_id !== groupId
      ) {
        return out;
      }
      const marks = (list: string[]) => list.map(() => '?').join(',');
      const quoted = ids.replies.length
        ? db
            .prepare(
              `SELECT message_id, substr(entry,1,65536) AS entry FROM world_messages WHERE message_id IN (${marks(ids.replies)})`,
            )
            .all(...ids.replies)
        : [];
      for (const row of quoted) {
        const entry = parse(row.entry),
          id = s(row.message_id);
        if (!id || !entry || typeof entry !== 'object') {
          continue;
        }
        const clean = this.clean({
          userId: s(entry.userId) ?? '',
          nickname: s(entry.nickname)?.slice(0, 256) ?? '',
          text: s(entry.text)?.slice(0, MAX_QUOTED_TEXT) ?? '',
          ...(Array.isArray(entry.segments)
            ? { segments: entry.segments.slice(0, 20) }
            : {}),
        }).value as WakeReviewDetail['quotedMessages'][string];
        out.quotedMessages[id] = clean;
        if (clean.userId && !ids.members.includes(clean.userId)) {
          ids.members.push(clean.userId);
        }
      }
      // 聚合中的裸列取自MAX(sequence)所在行，即每人最近一条消息的显示名。
      const rows = ids.members.length
        ? db
            .prepare(
              `SELECT actor_id, json_extract(payload,'$.message.nickname') AS name, MAX(sequence) FROM world_events WHERE type='message.created' AND group_id=? AND actor_id IN (${marks(ids.members)}) GROUP BY actor_id`,
            )
            .all(groupId, ...ids.members)
        : [];
      for (const row of rows) {
        const id = s(row.actor_id),
          name = s(row.name);
        if (id && name && name !== id) {
          out.memberNames[id] = name.slice(0, 256);
        }
      }
    } catch {
      return { memberNames: {}, quotedMessages: {} };
    } finally {
      db?.close();
    }
    return out;
  }

  health(now: number): HealthResponse {
    const availability = this.base.availability();
    const groups = this.base.groups.map((g) => {
      let lastObservedMessageAt: number | null = null,
        db: DatabaseSync | undefined;
      try {
        if (g.worldPath && lstatSync(g.worldPath).isFile()) {
          db = new DatabaseSync(g.worldPath, { readOnly: true });
          db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
          if (
            db
              .prepare('SELECT group_id FROM world_identity WHERE singleton=1')
              .get()?.group_id === g.groupId
          ) {
            lastObservedMessageAt = n(
              db
                .prepare(
                  "SELECT MAX(observed_at)*1000 AS time FROM world_events WHERE group_id=? AND type='message.created'",
                )
                .get(g.groupId)?.time,
            );
          }
        }
      } catch {
      } finally {
        db?.close();
      }
      const t = this.base.telemetry();
      let lastRequestAt: number | null = null;
      try {
        lastRequestAt = n(
          t
            ?.prepare(
              'SELECT MAX(started_at) AS time FROM model_requests WHERE group_id=?',
            )
            .get(g.groupId)?.time,
        );
      } catch {}
      let observationSource: 'runtime_received' | 'legacy_world' | null =
        lastObservedMessageAt !== null ? 'legacy_world' : null;
      if (t && columns(t, 'runtime_events').has('event')) {
        const received = n(
          t
            .prepare(
              "SELECT MAX(observed_at) AS time FROM runtime_events WHERE group_id=? AND event='onebot.message_received'",
            )
            .get(g.groupId)?.time,
        );
        if (received !== null) {
          lastObservedMessageAt = received;
          observationSource = 'runtime_received';
        }
      }
      return {
        groupId: g.groupId,
        sessionAvailable:
          availability.sessions.find((s) => s.groupId === g.groupId)
            ?.available ?? false,
        lastObservedMessageAt,
        observationSource,
        lastRequestAt,
      };
    });
    // 心跳超过45秒未更新判为stale；否则优先采信比最近连接事件更新的心跳状态。
    let connectivity: HealthResponse['connectivity'] = 'unknown',
      lastHeartbeatAt: number | null = null,
      lastConnectionEventAt: number | null = null;
    const telemetry = this.base.telemetry();
    if (telemetry && columns(telemetry, 'runtime_events').has('event')) {
      const heartbeat = telemetry
        .prepare(
          "SELECT observed_at,fields FROM runtime_events WHERE event='app.heartbeat' ORDER BY seq DESC LIMIT 1",
        )
        .get();
      lastHeartbeatAt = n(heartbeat?.observed_at);
      const heartbeatStatus = parse(heartbeat?.fields)?.status;
      const latest = telemetry
        .prepare(
          "SELECT observed_at,event FROM runtime_events WHERE event IN ('onebot.ready','onebot.disconnected','app.stopping','app.stopped') ORDER BY seq DESC LIMIT 1",
        )
        .get();
      lastConnectionEventAt = n(latest?.observed_at);
      if (lastHeartbeatAt !== null && now - lastHeartbeatAt > 45000) {
        connectivity = 'stale';
      } else if (
        lastHeartbeatAt !== null &&
        lastHeartbeatAt >= (lastConnectionEventAt ?? 0) &&
        ['connected', 'disconnected'].includes(heartbeatStatus)
      ) {
        connectivity = heartbeatStatus;
      } else if (latest?.event && latest.event !== 'onebot.ready') {
        connectivity = 'disconnected';
      } else if (latest?.event === 'onebot.ready' && lastHeartbeatAt !== null) {
        connectivity = 'connected';
      }
    }
    return {
      now,
      availability,
      connectivity,
      lastHeartbeatAt,
      lastConnectionEventAt,
      groups,
      note: 'Local observations only; silence does not establish offline status.',
    };
  }
}
