import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeWakeDiagnostics } from '../../observability/wake-diagnostics.ts';
import { SESSION_INSPECTION_INDEXES } from './indexes.ts';
import { resolveGroupId } from '../../contracts/identity.ts';
import {
  type ChatContentPart,
  type ChatMessage,
  type Completion,
} from '../../contracts/model.ts';
import { type JsonObject, isObject } from '../../contracts/json.ts';
import { type ToolDefinition } from '../../contracts/tools.ts';
import { immediate } from '../../storage/transaction.ts';

interface ModelSessionOptions {
  path: string;
  groupId: string;
  /** 所用具名模型的配置名；参与配置指纹，换模型即开新会话。 */
  model: string;
  maxTranscriptBytes?: number;
}

interface ModelSessionState {
  sessionId: string;
  generation: number;
  wakeId?: string;
  resetReason?: string;
  needsRecovery: boolean;
}

export interface ModelSessionScope {
  sessionId: string;
  wakeId?: string;
}

interface AssistantCheckpoint {
  assistantSeq: number;
  callIds: string[];
}

interface ToolWindow {
  since: number;
  until: number;
  wakeId?: string;
  sessionId?: string;
}

interface ToolCounts {
  invocations: number;
  started: number;
  completed: number;
  successes: number;
  errors: number;
  unknown: number;
  skipped: number;
  pending: number;
  totalDurationMs: number;
  meanDurationMs: number | null;
  modelRequests: number;
  externalRequests: null;
}

interface ToolSummary extends ToolCounts {
  byTool: Array<ToolCounts & { name: string }>;
  toolExposureCounts: Array<{ name: string; wakes: number }>;
}

const KNOWN_SUCCESS = [
  'ok',
  'executed',
  'pending',
  'confirmation_required',
  'staged',
  'duplicate',
  'success',
];

function fields(
  value: unknown,
  allowed: string[],
): asserts value is JsonObject {
  if (
    !isObject(value) ||
    Reflect.ownKeys(value).some(
      (k) => typeof k !== 'string' || !allowed.includes(k),
    )
  ) {
    throw new Error('invalid_analytics_filter');
  }
}

function windowFilter(value: ToolWindow): void {
  if (
    !Number.isSafeInteger(value.since) ||
    value.since < 0 ||
    !Number.isSafeInteger(value.until) ||
    value.until < value.since
  ) {
    throw new Error('invalid_analytics_window');
  }
  for (const key of ['wakeId', 'sessionId'] as const) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' ||
        !value[key] ||
        value[key]!.length > 256)
    ) {
      throw new Error('invalid_analytics_filter');
    }
  }
}

const safeName = (value: string): string =>
  /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : 'invalid';

type LedgerRow = {
  ordinal: number;
  assistant_seq: number;
  call_id: string;
  name: string;
  state: string;
  arguments: string;
  result: string | null;
};

const DEFAULT_MAX = 512 * 1024,
  CHECKPOINT_MAX = 256 * 1024,
  IMAGE_MAX = 8 * 1024 * 1024,
  RESULT_RESERVE = 1024;

function encode(value: unknown, max: number): string {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || Buffer.byteLength(text) > max) {
    throw new Error('session_resource_limit');
  }
  return text;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',')}}`;
  }
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error('invalid_session_json');
  }
  return text;
}

function reasonText(reason: string): string {
  if (typeof reason !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(reason)) {
    throw new Error('invalid_session_reason');
  }
  return reason;
}

/**
 * 在接触文件之前拒绝链接（包括目录链接和SQLite附属文件的链接）。
 * 与其他本地数据库一样，所在目录必须由应用自身控制。
 */
function checkPath(path: string): void {
  for (let p = resolve(path); ; p = dirname(p)) {
    try {
      const stat = lstatSync(p);
      if (stat.isSymbolicLink()) {
        throw new Error('session_symlink_refused');
      }
      if (p === resolve(path) && (!stat.isFile() || stat.nlink !== 1)) {
        throw new Error('session_file_refused');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (dirname(p) === p) {
      break;
    }
  }
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try {
      const stat = lstatSync(path + suffix);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        throw new Error('session_sidecar_refused');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

/**
 * 单群的模型会话持久化，只保存AI历史：不读World Store、不调QQ API、不写日志、不重放写操作。
 * 所有修改方法同步执行，返回前已持久化。调用方必须在startTool返回true之后才能派发工具。
 * checkpoint失败时按fail-closed处理。reset只轮换当前投影，旧会话和工具账本审计行仍保留。
 */
export class ModelSession {
  private readonly db: DatabaseSync;
  private readonly maxBytes: number;
  private readonly groupId: string;
  private readonly model: string;
  private stateValue!: ModelSessionState;
  private readonly images = new Map<number, ChatMessage>();
  private closed = false;
  constructor(options: ModelSessionOptions) {
    if (!options || typeof options.path !== 'string' || !options.path) {
      throw new Error('invalid_session_options');
    }
    this.groupId = resolveGroupId(options.groupId);
    if (typeof options.model !== 'string' || !options.model) {
      throw new Error('invalid_session_options');
    }
    this.model = options.model;
    this.maxBytes = options.maxTranscriptBytes ?? DEFAULT_MAX;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 4096 ||
      this.maxBytes > 16 * 1024 * 1024
    ) {
      throw new Error('invalid_session_options');
    }
    if (options.path !== ':memory:') {
      checkPath(options.path);
      // 必须在chmod、建表或以可写方式打开SQLite之前读取身份。
      if (existsSync(options.path) && lstatSync(options.path).size) {
        const probe = new DatabaseSync(options.path, { readOnly: true });
        try {
          if (
            !probe
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='model_session_meta'",
              )
              .get() ||
            probe
              .prepare(
                'SELECT group_id FROM model_session_meta WHERE singleton=1',
              )
              .get()?.group_id !== this.groupId
          ) {
            throw new Error('session_group_mismatch');
          }
        } finally {
          probe.close();
        }
      }
      const fd = openSync(
        options.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) {
          throw new Error('session_file_refused');
        }
      } finally {
        closeSync(fd);
      }
      chmodSync(options.path, 0o600);
      for (const suffix of ['-journal', '-wal', '-shm']) {
        if (existsSync(options.path + suffix)) {
          chmodSync(options.path + suffix, 0o600);
        }
      }
    }
    this.db = new DatabaseSync(options.path);
    try {
      this.db
        .exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS model_session_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),group_id TEXT NOT NULL,session_id TEXT NOT NULL,generation INTEGER NOT NULL,wake_id TEXT,reset_reason TEXT,fingerprint TEXT,checkpoint TEXT);
    CREATE TABLE IF NOT EXISTS model_session_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,wake_id TEXT,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS model_session_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,wake_id TEXT,message TEXT NOT NULL,bytes INTEGER NOT NULL,transient_image INTEGER NOT NULL DEFAULT 0,request_id TEXT,UNIQUE(session_id,request_id));
    CREATE INDEX IF NOT EXISTS model_session_messages_session ON model_session_messages(session_id,seq);
     CREATE TABLE IF NOT EXISTS model_external_events(event_id TEXT PRIMARY KEY,self_id TEXT NOT NULL,payload TEXT NOT NULL,received_at INTEGER NOT NULL,projected_at INTEGER);
    CREATE TABLE IF NOT EXISTS model_tool_ledger(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,wake_id TEXT,assistant_seq INTEGER NOT NULL,call_id TEXT NOT NULL,name TEXT NOT NULL,arguments TEXT NOT NULL,state TEXT NOT NULL,result TEXT,proposed_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,UNIQUE(assistant_seq,call_id));
    CREATE INDEX IF NOT EXISTS model_tool_ledger_session ON model_tool_ledger(session_id,ordinal);`);
      try {
        this.db.exec(SESSION_INSPECTION_INDEXES);
      } catch {
        /* 这些索引只是只读查询的可选加速，建立失败不能导致bot不可用。 */
      }
      const meta = this.db
        .prepare('SELECT * FROM model_session_meta WHERE singleton=1')
        .get();
      if (meta && meta.group_id !== this.groupId) {
        throw new Error('session_group_mismatch');
      }
      if (meta) {
        this.stateValue = {
          sessionId: String(meta.session_id),
          generation: Number(meta.generation),
          ...(typeof meta.wake_id === 'string' ? { wakeId: meta.wake_id } : {}),
          ...(typeof meta.reset_reason === 'string'
            ? { resetReason: meta.reset_reason }
            : {}),
          needsRecovery:
            meta.fingerprint === null && typeof meta.reset_reason === 'string',
        };
      } else {
        this.stateValue = {
          sessionId: randomUUID(),
          generation: 0,
          needsRecovery: false,
        };
        this.db
          .prepare(
            'INSERT INTO model_session_meta(singleton,group_id,session_id,generation) VALUES(1,?,?,0)',
          )
          .run(this.groupId, this.stateValue.sessionId);
      }
      this.transaction(() => {
        this.resolvePending('recovered_after_crash');
        if (this.stateValue.wakeId) {
          this.audit('wake_recovered', {});
          delete this.stateValue.wakeId;
          this.saveMeta();
        }
        if (
          this.db
            .prepare(
              'SELECT 1 FROM model_session_messages WHERE session_id=? AND transient_image=1 LIMIT 1',
            )
            .get(this.stateValue.sessionId)
        ) {
          this.rotate('transient_images_lost');
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private check(): void {
    if (this.closed) {
      throw new Error('session_closed');
    }
  }

  private transaction<T>(fn: () => T): T {
    this.check();
    const before = structuredClone(this.stateValue);
    try {
      return immediate(this.db, fn);
    } catch (error) {
      this.stateValue = before;
      throw error;
    }
  }

  private saveMeta(): void {
    this.db
      .prepare(
        'UPDATE model_session_meta SET session_id=?,generation=?,wake_id=?,reset_reason=? WHERE singleton=1',
      )
      .run(
        this.stateValue.sessionId,
        this.stateValue.generation,
        this.stateValue.wakeId ?? null,
        this.stateValue.resetReason ?? null,
      );
  }

  private audit(kind: string, payload: JsonObject): void {
    this.db
      .prepare(
        'INSERT INTO model_session_journal(session_id,wake_id,kind,payload,created_at) VALUES(?,?,?,?,?)',
      )
      .run(
        this.stateValue.sessionId,
        this.stateValue.wakeId ?? null,
        kind,
        encode(payload, CHECKPOINT_MAX),
        Date.now(),
      );
  }

  private terminal(): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM model_session_journal WHERE session_id=? AND wake_id=? AND kind='wake_terminal' LIMIT 1",
      )
      .get(this.stateValue.sessionId, this.stateValue.wakeId ?? null);
  }

  private size(): number {
    return Number(
      this.db
        .prepare(
          'SELECT COALESCE(SUM(bytes),0) AS n FROM model_session_messages WHERE session_id=?',
        )
        .get(this.stateValue.sessionId)!.n,
    );
  }

  private pending(): LedgerRow[] {
    return this.db
      .prepare(
        "SELECT * FROM model_tool_ledger WHERE session_id=? AND state IN ('pending','started') ORDER BY ordinal",
      )
      .all(this.stateValue.sessionId) as unknown as LedgerRow[];
  }

  private append(
    message: ChatMessage,
    extraReserve = 0,
    transient = false,
    requestId?: string,
  ): number {
    const text = encode(message, this.maxBytes),
      bytes = Buffer.byteLength(text);
    if (this.size() + bytes + extraReserve > this.maxBytes) {
      throw new Error('session_resource_limit');
    }
    return Number(
      this.db
        .prepare(
          'INSERT INTO model_session_messages(session_id,wake_id,message,bytes,transient_image,request_id) VALUES(?,?,?,?,?,?)',
        )
        .run(
          this.stateValue.sessionId,
          this.stateValue.wakeId ?? null,
          text,
          bytes,
          transient ? 1 : 0,
          requestId ?? null,
        ).lastInsertRowid,
    );
  }

  private rotate(reason: string): void {
    if (
      [
        'transcript_resource_boundary',
        'transient_images_lost',
        'configuration_changed',
        'response_state_expired',
      ].includes(reason)
    ) {
      // 自动轮换不能丢失尚未参与任何已持久化模型响应的后台结果。
      this.db
        .prepare(
          `UPDATE model_external_events SET projected_at=NULL
        WHERE event_id IN (
          SELECT json_extract(payload,'$.event_id') FROM model_session_journal
          WHERE session_id=? AND kind='external_event_received' AND seq>(
            SELECT COALESCE(MAX(seq),0) FROM model_session_journal
            WHERE session_id=? AND kind='assistant_checkpoint'
          )
        )`,
        )
        .run(this.stateValue.sessionId, this.stateValue.sessionId);
    }
    this.resolvePending(reason);
    if (this.stateValue.wakeId) {
      // 轮换前先结束旧wake，避免迟到的回调误结束新会话。
      const detail = normalizeWakeDiagnostics({
        reason_code: reason === 'owner_reset' ? 'reset' : reason,
      });
      const terminal = {
        reason: 'session_reset',
        reason_code:
          typeof detail.reason_code === 'string'
            ? detail.reason_code
            : 'session_rotated',
      };
      this.audit('wake_terminal', terminal);
      this.audit('wake_finish', terminal);
    }
    this.audit('session_reset', {
      reason,
      next_generation: this.stateValue.generation + 1,
    });
    this.stateValue = {
      sessionId: randomUUID(),
      generation: this.stateValue.generation + 1,
      resetReason: reason,
      needsRecovery: true,
    };
    this.saveMeta();
    this.db
      .prepare(
        'UPDATE model_session_meta SET fingerprint=NULL,checkpoint=NULL WHERE singleton=1',
      )
      .run();
  }

  state(): ModelSessionState {
    this.check();
    return structuredClone(this.stateValue);
  }

  /** 持久化的宿主事件收件箱，与模型会话轮换及工具调用ID无关。 */
  receiveExternalEvent(
    eventId: string,
    selfId: string,
    payload: JsonObject,
  ): boolean {
    this.check();
    if (
      !/^[A-Za-z0-9:_-]{1,256}$/.test(eventId) ||
      !/^\d+$/.test(selfId) ||
      !isObject(payload)
    ) {
      throw new Error('invalid_external_event');
    }
    const encoded = encode(payload, 512 * 1024);
    return this.transaction(() => {
      if (
        this.db
          .prepare('SELECT 1 FROM model_external_events WHERE event_id=?')
          .get(eventId)
      ) {
        return false;
      }
      this.db
        .prepare(
          'INSERT INTO model_external_events(event_id,self_id,payload,received_at) VALUES(?,?,?,?)',
        )
        .run(eventId, selfId, encoded, Date.now());
      return true;
    });
  }

  externalEventProjected(eventId: string, selfId: string): boolean {
    this.check();
    return !!this.db
      .prepare(
        'SELECT 1 FROM model_external_events WHERE event_id=? AND self_id=? AND projected_at IS NOT NULL',
      )
      .get(eventId, selfId);
  }

  hasExternalEvents(selfId: string): boolean {
    this.check();
    return !!this.db
      .prepare(
        'SELECT 1 FROM model_external_events WHERE self_id=? AND projected_at IS NULL LIMIT 1',
      )
      .get(selfId);
  }

  /** journal是跨会话轮换的已投递截点；World的ack只是这个值的镜像。 */
  chatReadThrough(selfId: string): number {
    this.check();
    if (!/^\d+$/.test(selfId)) {
      throw new Error('invalid_context_update');
    }
    const row = this.db
      .prepare(
        "SELECT payload FROM model_session_journal WHERE kind='chat_read' AND json_extract(payload,'$.self_id')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(selfId);
    return row ? Number(JSON.parse(String(row.payload)).read_through) : 0;
  }

  /** QQ已由调用方安全投影。此处只按真实持久化字节预算分批宿主结果，不再裁剪QQ。 */
  appendContextUpdate(
    selfId: string,
    qq: {
      events: JsonObject[];
      unread_count: number;
      omitted_count: number;
      read_through: number;
    },
    options: { force?: boolean } = {},
  ): { appended: boolean; hostEvents: number } {
    this.check();
    if (
      !/^\d+$/.test(selfId) ||
      !qq ||
      !Array.isArray(qq.events) ||
      !qq.events.every(
        (event) =>
          isObject(event) &&
          typeof event.observed_at === 'number' &&
          Number.isFinite(event.observed_at * 1000),
      ) ||
      ![qq.unread_count, qq.omitted_count, qq.read_through].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    ) {
      throw new Error('invalid_context_update');
    }
    return this.transaction(() => {
      if (!this.stateValue.wakeId || this.terminal() || this.pending().length) {
        throw new Error('invalid_input_boundary');
      }
      const rows = this.db
        .prepare(
          'SELECT event_id,payload,received_at FROM model_external_events WHERE self_id=? AND projected_at IS NULL ORDER BY received_at,event_id',
        )
        .iterate(selfId);
      const items = qq.events.map((event) => ({
        at: Number(event.observed_at) * 1000,
        item: { type: 'world_event', event } as JsonObject,
      }));
      // 预留一次模型响应和一次工具结果；appendAssistant仍按实际工具数追加reserve。
      const reserve = 2 * RESULT_RESERVE;
      const budget = this.maxBytes - this.size() - reserve;
      const readThrough = Math.max(
        this.chatReadThrough(selfId),
        qq.read_through,
      );
      const message = (): ChatMessage => ({
        role: 'user',
        content: JSON.stringify({
          context_update: {
            unread_count: qq.unread_count,
            omitted_count: qq.omitted_count,
            read_through: readThrough,
            items: [...items]
              .sort((a, b) => a.at - b.at)
              .map(({ item }) => item),
          },
        }),
      });
      const fits = (): boolean =>
        Buffer.byteLength(JSON.stringify(message())) <= budget;
      const selected: string[] = [];
      for (const row of rows) {
        const payload = JSON.parse(String(row.payload)) as JsonObject;
        const entry = {
          at: Number(row.received_at),
          item: {
            type: 'job_result',
            event_id: String(row.event_id),
            result: payload,
          } as JsonObject,
        };
        items.push(entry);
        if (!fits()) {
          // 已选一批则留待下次；首条过大时有界简化，避免大结果堵死队列。
          if (!selected.length) {
            for (const preview of [512, 128, 0]) {
              const result: JsonObject = { ...payload, truncated: true };
              for (const key of [
                'value',
                'error',
                'logs',
                'diagnostic',
                'tool_calls',
              ]) {
                if (key in result) {
                  result[key] = preview
                    ? JSON.stringify(result[key]).slice(0, preview)
                    : '[truncated]';
                }
              }
              entry.item.result = result;
              if (fits()) {
                break;
              }
            }
            if (!fits()) {
              // 非结果字段也可能很大；最终摘要保留身份、状态和既有查询入口。
              entry.item.result = {
                job_id: payload.job_id ?? null,
                status: payload.status ?? null,
                truncated: true,
                query: {
                  tool: 'query_javascript_jobs',
                  arguments: { job_id: payload.job_id ?? null },
                },
              };
            }
          }
          if (!fits()) {
            items.pop();
            if (!selected.length && !qq.events.length) {
              throw new Error('session_resource_limit');
            }
            break;
          }
        }
        selected.push(String(row.event_id));
      }
      if (!options.force && !qq.events.length && !selected.length) {
        // 即使没有输入，下一模型/工具round也必须有reserve供父级及时轮换。
        if (budget < 0) {
          throw new Error('session_resource_limit');
        }
        return { appended: false, hostEvents: 0 };
      }
      this.append(message(), reserve);
      const projectedAt = Date.now();
      for (const eventId of selected) {
        this.audit('external_event_received', { event_id: eventId });
        this.db
          .prepare(
            'UPDATE model_external_events SET projected_at=? WHERE event_id=? AND self_id=? AND projected_at IS NULL',
          )
          .run(projectedAt, eventId, selfId);
      }
      this.audit('chat_read', { self_id: selfId, read_through: readThrough });
      return { appended: true, hostEvents: selected.length };
    });
  }

  /** 兼容入口；新调用方应同时投递QQ上下文。 */
  projectExternalEvents(selfId: string): number {
    return this.appendContextUpdate(selfId, {
      events: [],
      unread_count: 0,
      omitted_count: 0,
      read_through: this.chatReadThrough(selfId),
    }).hostEvents;
  }

  messages(): ChatMessage[] {
    this.check();
    return this.db
      .prepare(
        'SELECT seq,message FROM model_session_messages WHERE session_id=? ORDER BY seq',
      )
      .all(this.stateValue.sessionId)
      .map((row) =>
        structuredClone(
          this.images.get(Number(row.seq)) ??
            (JSON.parse(String(row.message)) as ChatMessage),
        ),
      );
  }

  /**
   * 系统指令、工具定义和模型名按指纹比对，不会修补进已有前缀。wake元数据为空时不追加占位输入。
   * 因资源或配置变化而reset时，追加明确的恢复提示让模型重新阅读工具，而不是编造摘要。
   */
  beginWake(
    system: string,
    tools: ToolDefinition[],
    wakeMeta: JsonObject = {},
  ): ChatMessage[] {
    this.check();
    if (this.stateValue.wakeId) {
      throw new Error('wake_already_active');
    }
    if (
      typeof system !== 'string' ||
      !Array.isArray(tools) ||
      !isObject(wakeMeta)
    ) {
      throw new Error('invalid_wake');
    }
    encode({ system, tools }, this.maxBytes);
    encode(wakeMeta, 65536);
    const fingerprint = createHash('sha256')
      .update(canonical({ system, tools, model: this.model }))
      .digest('hex');
    const oldSession = this.stateValue.sessionId;
    this.transaction(() => {
      const old = this.db
        .prepare('SELECT fingerprint FROM model_session_meta WHERE singleton=1')
        .get()!.fingerprint;
      if (old && old !== fingerprint) {
        this.rotate('configuration_changed');
      }
      const wakeBytes = Buffer.byteLength(
        encode(
          { role: 'user', content: JSON.stringify({ wake: wakeMeta }) },
          this.maxBytes,
        ),
      );
      if (
        this.size() &&
        (this.size() > this.maxBytes * 0.75 ||
          this.size() + wakeBytes + RESULT_RESERVE > this.maxBytes)
      ) {
        this.rotate('transcript_resource_boundary');
      }
      this.stateValue.wakeId = randomUUID();
      this.saveMeta();
      this.db
        .prepare(
          'UPDATE model_session_meta SET fingerprint=? WHERE singleton=1',
        )
        .run(fingerprint);
      if (!this.size()) {
        this.append({ role: 'system', content: system });
      }
      const reset = this.stateValue.needsRecovery
        ? this.stateValue.resetReason
        : undefined;
      if (Object.keys(wakeMeta).length || reset) {
        this.append({
          role: 'user',
          content: JSON.stringify({
            wake: wakeMeta,
            ...(reset
              ? { session_reset: { reason: reset, read_tools_again: true } }
              : {}),
          }),
        });
      }
      this.stateValue.needsRecovery = false;
      this.audit('wake_begin', {
        fingerprint,
        exposed_tool_names: [
          ...new Set(tools.map((tool) => safeName(tool.function.name))),
        ],
      });
    });
    if (this.stateValue.sessionId !== oldSession) {
      this.images.clear();
    }
    return this.messages();
  }

  /**
   * 图片字节和URL只保存在内存中，总量上限8MiB。重新打开的会话若包含这类输入，
   * 会显式轮换并丢弃传输链。
   */
  appendInput(content: ChatContentPart[] | string): void {
    this.check();
    if (!this.stateValue.wakeId || this.pending().length) {
      throw new Error('invalid_input_boundary');
    }
    if (typeof content !== 'string' && !Array.isArray(content)) {
      throw new Error('invalid_session_input');
    }
    const actual: ChatMessage = {
      role: 'user',
      content: structuredClone(content),
    };
    let hasImages = false;
    const persisted: ChatMessage = {
      role: 'user',
      content:
        typeof content === 'string'
          ? content
          : content.map((part) => {
              if (!isObject(part)) {
                throw new Error('invalid_session_input');
              }
              if (part.type === 'text' && typeof part.text === 'string') {
                return { type: 'text', text: part.text };
              }
              if (
                part.type === 'image_url' &&
                isObject(part.image_url) &&
                typeof part.image_url.url === 'string'
              ) {
                hasImages = true;
                return { type: 'text', text: '[session image omitted]' };
              }
              throw new Error('invalid_session_input');
            }),
    };
    if (hasImages) {
      let total = Buffer.byteLength(encode(actual, IMAGE_MAX));
      for (const value of this.images.values()) {
        total += Buffer.byteLength(JSON.stringify(value));
      }
      if (total > IMAGE_MAX) {
        throw new Error('session_image_resource_limit');
      }
    }
    const seq = this.transaction(() => {
      const seq = this.append(persisted, 0, hasImages);
      this.audit('input_checkpoint', {
        message_seq: seq,
        image_omitted: hasImages,
      });
      return seq;
    });
    if (hasImages) {
      this.images.set(seq, actual);
    }
  }

  appendAssistant(
    completion: Completion,
    requestId?: string,
  ): AssistantCheckpoint {
    this.check();
    if (!this.stateValue.wakeId) {
      throw new Error('wake_not_active');
    }
    if (
      !completion ||
      (completion.content !== null && typeof completion.content !== 'string') ||
      !Array.isArray(completion.tool_calls)
    ) {
      throw new Error('invalid_completion');
    }
    if (
      requestId !== undefined &&
      (typeof requestId !== 'string' || !requestId || requestId.length > 256)
    ) {
      throw new Error('invalid_request_id');
    }
    const ids = new Set<string>();
    for (const call of completion.tool_calls) {
      if (
        !call ||
        call.type !== 'function' ||
        typeof call.id !== 'string' ||
        !call.id ||
        Buffer.byteLength(JSON.stringify(call.id)) > 256 ||
        ids.has(call.id) ||
        !call.function ||
        typeof call.function.name !== 'string' ||
        !call.function.name ||
        call.function.name.length > 128 ||
        typeof call.function.arguments !== 'string'
      ) {
        throw new Error('invalid_completion');
      }
      ids.add(call.id);
    }
    const message: ChatMessage = {
      role: 'assistant',
      content: completion.content,
      ...(completion.tool_calls.length
        ? { tool_calls: structuredClone(completion.tool_calls) }
        : {}),
    };
    if (requestId) {
      const old = this.db
        .prepare(
          'SELECT seq,message FROM model_session_messages WHERE session_id=? AND request_id=?',
        )
        .get(this.stateValue.sessionId, requestId);
      if (old) {
        if (String(old.message) !== encode(message, this.maxBytes)) {
          throw new Error('request_id_conflict');
        }
        return { assistantSeq: Number(old.seq), callIds: [...ids] };
      }
    }
    if (this.terminal()) {
      throw new Error('wake_finished');
    }
    if (this.pending().length) {
      throw new Error('tool_results_pending');
    }
    return this.transaction(() => {
      const seq = this.append(
        message,
        completion.tool_calls.length * RESULT_RESERVE,
        false,
        requestId,
      );
      for (const call of completion.tool_calls) {
        this.db
          .prepare(
            "INSERT INTO model_tool_ledger(session_id,wake_id,assistant_seq,call_id,name,arguments,state,proposed_at) VALUES(?,?,?,?,?,?,'pending',?)",
          )
          .run(
            this.stateValue.sessionId,
            this.stateValue.wakeId!,
            seq,
            call.id,
            call.function.name,
            call.function.arguments,
            Date.now(),
          );
      }
      this.audit('assistant_checkpoint', {
        assistant_seq: seq,
        tool_count: ids.size,
        ...(requestId ? { request_id: requestId } : {}),
      });
      return { assistantSeq: seq, callIds: [...ids] };
    });
  }

  private call(callId: string, assistantSeq?: number): LedgerRow | undefined {
    const seq =
      assistantSeq ??
      Number(
        this.db
          .prepare(
            'SELECT COALESCE(MAX(assistant_seq),0) AS n FROM model_tool_ledger WHERE session_id=?',
          )
          .get(this.stateValue.sessionId)!.n,
      );
    return this.db
      .prepare(
        'SELECT * FROM model_tool_ledger WHERE session_id=? AND assistant_seq=? AND call_id=?',
      )
      .get(this.stateValue.sessionId, seq, callId) as unknown as
      LedgerRow | undefined;
  }

  startTool(callId: string, assistantSeq?: number): boolean {
    this.check();
    return this.transaction(() => {
      const row = this.call(callId, assistantSeq);
      if (
        !this.stateValue.wakeId ||
        !row ||
        row.state !== 'pending' ||
        this.pending()[0]?.ordinal !== row.ordinal
      ) {
        return false;
      }
      this.db
        .prepare(
          "UPDATE model_tool_ledger SET state='started',started_at=? WHERE ordinal=? AND state='pending'",
        )
        .run(Date.now(), row.ordinal);
      this.audit('tool_intent', {
        ordinal: row.ordinal,
        assistant_seq: row.assistant_seq,
        call_id: callId,
      });
      return true;
    });
  }

  private complete(row: LedgerRow, result: JsonObject, state: string): void {
    const text = encode(result, CHECKPOINT_MAX);
    this.append(
      { role: 'tool', tool_call_id: row.call_id, content: text },
      Math.max(0, this.pending().length - 1) * RESULT_RESERVE,
    );
    this.db
      .prepare(
        'UPDATE model_tool_ledger SET state=?,result=?,finished_at=? WHERE ordinal=?',
      )
      .run(state, text, Date.now(), row.ordinal);
    this.audit('tool_result', { ordinal: row.ordinal, state });
  }

  /** 重复完成不会覆盖第一次持久化的结果。 */
  finishTool(callId: string, result: JsonObject, assistantSeq?: number): void {
    this.check();
    if (!isObject(result)) {
      throw new Error('invalid_tool_result');
    }
    this.transaction(() => {
      const row = this.call(callId, assistantSeq);
      if (!row) {
        throw new Error('tool_not_found');
      }
      if (!['pending', 'started'].includes(row.state)) {
        return;
      }
      if (row.state !== 'started') {
        throw new Error('tool_not_started');
      }
      this.complete(row, result, 'finished');
      if (
        row.name === 'finish' &&
        result.status === 'ok' &&
        result.closed === true
      ) {
        let valid = false;
        try {
          const args: unknown = JSON.parse(row.arguments);
          valid =
            isObject(args) &&
            Object.keys(args).length === 1 &&
            (args.mode === 'soft' || args.mode === 'hard');
        } catch {}
        if (valid) {
          this.resolvePending('turn_finished');
          this.audit('wake_terminal', { reason: 'finish' });
        }
      }
    });
  }

  private resolvePending(reason: string): void {
    for (const row of this.pending()) {
      this.complete(
        row,
        row.state === 'started'
          ? { status: 'unknown', error: 'execution_result_unknown', reason }
          : { status: 'skipped', error: reason },
        row.state === 'started' ? 'unknown' : 'skipped',
      );
    }
  }

  private matchesScope(scope?: ModelSessionScope): boolean {
    return (
      scope === undefined ||
      (!!scope.wakeId &&
        scope.sessionId === this.stateValue.sessionId &&
        scope.wakeId === this.stateValue.wakeId)
    );
  }

  skipPending(reason: string, scope?: ModelSessionScope): void {
    reasonText(reason);
    this.transaction(() => {
      if (this.matchesScope(scope)) {
        this.resolvePending(reason);
      }
    });
  }

  finishWake(
    reason = 'finished',
    diagnostics?: unknown,
    scope?: ModelSessionScope,
  ): void {
    reasonText(reason);
    const detail = normalizeWakeDiagnostics(diagnostics);
    this.transaction(() => {
      if (!this.matchesScope(scope)) {
        return;
      }
      this.resolvePending(
        typeof detail.reason_code === 'string' ? detail.reason_code : reason,
      );
      this.audit('wake_terminal', { reason, ...detail });
      this.audit('wake_finish', { reason, ...detail });
      delete this.stateValue.wakeId;
      this.saveMeta();
    });
  }

  reset(reason = 'reset'): void {
    reasonText(reason);
    this.transaction(() => this.rotate(reason));
    this.images.clear();
  }

  getTransportCheckpoint(): JsonObject | undefined {
    this.check();
    const value = this.db
      .prepare('SELECT checkpoint FROM model_session_meta WHERE singleton=1')
      .get()!.checkpoint;
    return typeof value === 'string'
      ? (JSON.parse(value) as JsonObject)
      : undefined;
  }

  setTransportCheckpoint(value: JsonObject | undefined): void {
    this.check();
    if (value !== undefined && !isObject(value)) {
      throw new Error('invalid_transport_checkpoint');
    }
    let text: string | null;
    try {
      text =
        value === undefined
          ? null
          : encode(
              value,
              Array.isArray(value.outputHistory)
                ? 16 * 1024 * 1024
                : CHECKPOINT_MAX,
            );
    } catch (error) {
      this.reset('transport_checkpoint_limit');
      throw error;
    }
    this.transaction(() => {
      this.db
        .prepare('UPDATE model_session_meta SET checkpoint=? WHERE singleton=1')
        .run(text);
      this.audit('transport_checkpoint', { present: value !== undefined });
    });
  }

  /**
   * 统计工具账本。completed是账本的终态，不代表外部写操作成功。明确的提案/暂存状态
   * 计为工具处理成功，而非QQ侧已执行。无法识别的终态计为unknown。耗时按每个已知的
   * started→finished区间加权；无法从工具开始记录推断外部RPC。
   */
  summarizeTools(options: ToolWindow): ToolSummary {
    this.check();
    fields(options, ['since', 'until', 'wakeId', 'sessionId']);
    windowFilter(options);
    const params: Array<string | number> = [options.since, options.until];
    let where = 'l.proposed_at BETWEEN ? AND ?';
    if (options.wakeId !== undefined) {
      where += ' AND l.wake_id=?';
      params.push(options.wakeId);
    }
    if (options.sessionId !== undefined) {
      where += ' AND l.session_id=?';
      params.push(options.sessionId);
    }
    const sql = `WITH source AS (SELECT l.*,m.request_id,
    CASE WHEN length(l.name) BETWEEN 1 AND 128 AND l.name NOT GLOB '*[^a-zA-Z0-9_-]*' THEN l.name ELSE 'invalid' END AS tool_name,
    CASE WHEN l.state IN ('pending','started') THEN 'pending' WHEN l.state='skipped' THEN 'skipped' WHEN l.state='unknown' THEN 'unknown'
      WHEN json_extract(l.result,'$.status') IN (${KNOWN_SUCCESS.map((s) => `'${s}'`).join(',')}) THEN 'success'
      WHEN json_extract(l.result,'$.status')='error' THEN 'error' WHEN json_extract(l.result,'$.status')='skipped' THEN 'skipped' ELSE 'unknown' END AS outcome,
    CASE WHEN l.started_at IS NOT NULL AND l.finished_at>=l.started_at THEN l.finished_at-l.started_at ELSE NULL END AS duration
    FROM model_tool_ledger l LEFT JOIN model_session_messages m ON m.seq=l.assistant_seq WHERE ${where})`;
    const aggregate = `COUNT(*) AS invocations,COALESCE(SUM(started_at IS NOT NULL),0) AS started,
    COALESCE(SUM(state NOT IN ('pending','started')),0) AS completed,
    COALESCE(SUM(outcome='success'),0) AS successes,COALESCE(SUM(outcome='error'),0) AS errors,
    COALESCE(SUM(outcome='unknown'),0) AS unknown,COALESCE(SUM(outcome='skipped'),0) AS skipped,
    COALESCE(SUM(outcome='pending'),0) AS pending,COALESCE(SUM(duration),0) AS totalDurationMs,AVG(duration) AS meanDurationMs,
    COUNT(DISTINCT CASE WHEN request_id IS NOT NULL THEN session_id||':'||request_id END) AS modelRequests`;
    const counts = (row: Record<string, unknown>): ToolCounts => ({
      invocations: Number(row.invocations),
      started: Number(row.started),
      completed: Number(row.completed),
      successes: Number(row.successes),
      errors: Number(row.errors),
      unknown: Number(row.unknown),
      skipped: Number(row.skipped),
      pending: Number(row.pending),
      totalDurationMs: Number(row.totalDurationMs),
      meanDurationMs:
        row.meanDurationMs === null ? null : Number(row.meanDurationMs),
      modelRequests: Number(row.modelRequests),
      externalRequests: null,
    });
    const total = counts(
      this.db.prepare(sql + ` SELECT ${aggregate} FROM source`).get(...params)!,
    );
    const byTool: Array<ToolCounts & { name: string }> = [];
    for (const row of this.db
      .prepare(
        sql +
          ` SELECT tool_name,${aggregate} FROM source GROUP BY tool_name ORDER BY tool_name`,
      )
      .iterate(...params)) {
      byTool.push({ name: String(row.tool_name), ...counts(row) });
    }
    const exposureParams: Array<string | number> = [
      options.since,
      options.until,
    ];
    let exposureWhere = "j.kind='wake_begin' AND j.created_at BETWEEN ? AND ?";
    if (options.wakeId !== undefined) {
      exposureWhere += ' AND j.wake_id=?';
      exposureParams.push(options.wakeId);
    }
    if (options.sessionId !== undefined) {
      exposureWhere += ' AND j.session_id=?';
      exposureParams.push(options.sessionId);
    }
    const toolExposureCounts: Array<{ name: string; wakes: number }> = [];
    for (const row of this.db
      .prepare(
        `SELECT names.value AS name,COUNT(DISTINCT j.wake_id) AS wakes FROM model_session_journal j,json_each(j.payload,'$.exposed_tool_names') names WHERE ${exposureWhere} GROUP BY names.value ORDER BY names.value`,
      )
      .iterate(...exposureParams)) {
      toolExposureCounts.push({
        name: String(row.name),
        wakes: Number(row.wakes),
      });
    }
    return { ...total, byTool, toolExposureCounts };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.db.close();
    this.closed = true;
    this.images.clear();
  }
}
