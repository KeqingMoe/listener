import { createHash } from 'node:crypto';
import { startExecution, encodeToolValue } from './executor.ts';
import type { JsonObject } from '../contracts/json.ts';
import type {
  ToolCallObserver,
  ToolObservationEnd,
  ToolObservationStart,
} from '../contracts/tool-observation.ts';
import { observationResult } from './tool-observation.ts';
import type {
  ExecutionOptions,
  ExecutionResult,
  ExecutionDiagnostic,
} from './protocol.ts';
import {
  type SandboxJobStore,
  validateInput,
  validateScope,
  type Job,
  type JobInput,
  type JobScope,
  type JobQuery,
  type JobStatus,
  type ToolCallSummary,
  type ToolCallStatus,
} from './store.ts';

type JobResponse =
  | { status: 'pending'; job_id: string }
  | {
      status: 'completed';
      job_id: string;
      value: string;
      logs: string[];
      diagnostic?: ExecutionDiagnostic;
      tool_calls?: ToolCallSummary;
    }
  | {
      status: 'failed' | 'cancelled' | 'interrupted' | 'timeout';
      job_id?: string;
      error: string;
      logs: string[];
      diagnostic?: ExecutionDiagnostic;
      tool_calls?: ToolCallSummary;
    };

/** 发起任务的人。只存在内存中：任务不会跨重启继续执行。 */
interface JobCaller {
  actorId: string;
  messageId: string;
}

/** guest代码可调用的host工具。鉴权在call()内部、按调用时刻进行。 */
interface SandboxToolBridge {
  names(scope: JobScope): readonly string[];
  call(
    scope: JobScope & JobCaller,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<JsonObject>;
}

const ID_FIELDS = [
  'message_id',
  'notification_message_id',
  'artifact_id',
  'job_id',
  'reminder_id',
  'code',
];

function callStatus(result: JsonObject): {
  status: ToolCallStatus;
  error?: string;
} {
  const error =
    typeof result.error === 'string' &&
    /^[-a-zA-Z0-9_]{1,128}$/.test(result.error)
      ? result.error
      : undefined;
  if (
    result.status === 'unknown' ||
    result.status === 'confirmation_required'
  ) {
    return { status: result.status, ...(error ? { error } : {}) };
  }
  if (result.status === 'error' || result.status === 'partial') {
    return { status: 'error', error: error ?? String(result.status) };
  }
  return { status: 'ok' };
}

type Executor = (options: ExecutionOptions) => {
  result: Promise<ExecutionResult>;
  cancel(): void;
};

interface Live {
  job: Job;
  code: string;
  caller?: JobCaller;
  calls: number;
  resolve: (value: JobResponse) => void;
  delivery: 'foreground' | 'background' | 'returned';
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
  handle?: ReturnType<Executor>;
}

const active = (j: Job) => j.status === 'queued' || j.status === 'running';
const response = (j: Job): JobResponse =>
  j.status === 'completed'
    ? {
        status: 'completed',
        job_id: j.jobId,
        value: j.value!,
        logs: j.logs,
        ...(j.diagnostic ? { diagnostic: j.diagnostic } : {}),
        ...(j.toolCalls ? { tool_calls: j.toolCalls } : {}),
      }
    : {
        status: j.status as 'failed' | 'cancelled' | 'interrupted' | 'timeout',
        job_id: j.jobId,
        error: j.error ?? 'execution_failed',
        logs: j.logs,
        ...(j.diagnostic ? { diagnostic: j.diagnostic } : {}),
        ...(j.toolCalls ? { tool_calls: j.toolCalls } : {}),
      };

/** 任务归属持久化，执行队列在内存中且有上限。不做单次调用配额。 */
export class SandboxService {
  private live = new Map<string, Live>();
  private queue: string[] = [];
  private running = 0;
  private stopped = false;
  private listeners = new Set<() => void>();
  private readonly executor: Executor;
  private readonly concurrency: number;
  private readonly queued: number;
  private bridge?: SandboxToolBridge;
  constructor(
    private options: {
      store: SandboxJobStore;
      /** Optional, fail-open metadata observation; never changes dispatch or results. */
      observer?: ToolCallObserver;
      maxConcurrent?: number;
      maxQueued?: number;
      executor?: Executor;
      limits?: Omit<ExecutionOptions, 'code' | 'tools' | 'callTool'>;
    },
  ) {
    this.executor = options.executor ?? startExecution;
    this.concurrency = options.maxConcurrent ?? 2;
    this.queued = options.maxQueued ?? 64;
    for (const n of [this.concurrency, this.queued]) {
      if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) {
        throw new Error('invalid_limits');
      }
    }
  }

  /** 延迟注入：bridge要用到群listener，而listener在本服务之后才创建。 */
  setToolBridge(bridge: SandboxToolBridge): void {
    this.bridge = bridge;
  }

  execute(
    input: JobInput,
    signal?: AbortSignal,
    caller?: JobCaller,
  ): Promise<JobResponse> {
    validateInput(input);
    if (signal?.aborted) {
      return Promise.resolve({
        status: 'cancelled',
        error: 'cancelled',
        logs: [],
      });
    }
    if (this.stopped) {
      return Promise.resolve({
        status: 'failed',
        error: 'service_stopped',
        logs: [],
      });
    }
    if (this.running + this.queue.length >= this.concurrency + this.queued) {
      return Promise.resolve({
        status: 'failed',
        error: 'queue_full',
        logs: [],
      });
    }
    const job = this.options.store.create(input);
    return new Promise((resolve) => {
      const item: Live = {
        job,
        code: input.code,
        ...(caller ? { caller: { ...caller } } : {}),
        calls: 0,
        resolve,
        delivery: input.mode === 'async' ? 'background' : 'foreground',
      };
      this.live.set(job.jobId, item);
      this.queue.push(job.jobId);
      if (input.mode === 'async') {
        resolve({ status: 'pending', job_id: job.jobId });
      } else {
        item.timer = setTimeout(() => {
          if (item.delivery !== 'foreground') {
            return;
          }
          if (input.mode === 'sync') {
            this.terminate(item, 'timeout', 'execution_timeout');
          } else {
            this.detach(item);
          }
        }, input.waitMs!);
        if (signal) {
          item.signal = signal;
          item.abort = () => {
            if (item.delivery !== 'foreground') {
              return;
            }
            if (input.mode === 'sync') {
              this.terminate(item, 'cancelled', 'cancelled');
            } else {
              this.detach(item);
            }
          };
          signal.addEventListener('abort', item.abort, { once: true });
          if (signal.aborted) {
            item.abort();
          }
        }
      }
      this.pump();
    });
  }

  private clean(item: Live) {
    if (item.timer) {
      clearTimeout(item.timer);
    }
    if (item.signal && item.abort) {
      item.signal.removeEventListener('abort', item.abort);
    }
    item.timer = undefined;
    item.signal = undefined;
    item.abort = undefined;
  }

  private notify() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 完成状态已持久化，可在之后重试投递 */
      }
    }
  }

  private detach(item: Live) {
    if (item.delivery !== 'foreground') {
      return;
    }
    try {
      this.options.store.detach(item.job, item.job.jobId);
    } catch {
      this.terminate(item, 'cancelled', 'storage_failed');
      return;
    }
    item.delivery = 'background';
    this.clean(item);
    item.resolve({ status: 'pending', job_id: item.job.jobId });
  }

  private finish(
    item: Live,
    result: {
      status: Exclude<JobStatus, 'queued' | 'running'>;
      value?: string;
      error?: string;
      logs?: string[];
      diagnostic?: ExecutionDiagnostic;
    },
  ) {
    if (!this.live.has(item.job.jobId)) {
      return;
    }
    let job: Job;
    try {
      job = this.options.store.settle(item.job, item.job.jobId, result)!;
    } catch {
      console.error('sandbox job persistence failed', item.job.jobId);
      this.clean(item);
      this.live.delete(item.job.jobId);
      this.queue = this.queue.filter((id) => id !== item.job.jobId);
      item.code = '';
      if (item.delivery === 'foreground') {
        item.resolve({
          status: 'failed',
          job_id: item.job.jobId,
          error: 'storage_failed',
          logs: [],
        });
      }
      item.delivery = 'returned';
      return;
    }
    this.clean(item);
    this.live.delete(job.jobId);
    this.queue = this.queue.filter((id) => id !== job.jobId);
    item.code = '';
    if (item.delivery === 'foreground') {
      item.delivery = 'returned';
      item.resolve(response(job));
    } else if (item.delivery === 'background') {
      this.notify();
    }
  }

  private terminate(
    item: Live,
    status: 'cancelled' | 'timeout' | 'interrupted',
    error: string,
  ) {
    try {
      item.handle?.cancel();
    } catch {
      /* 即使取消失败，finally里仍会记录终止状态 */
    } finally {
      this.finish(item, { status, error, logs: [] });
    }
    this.pump();
  }

  private pump() {
    if (this.stopped) {
      return;
    }
    while (this.running < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!,
        item = this.live.get(id);
      if (!item) {
        continue;
      }
      try {
        if (!this.options.store.start(item.job, id)) {
          continue;
        }
      } catch {
        this.finish(item, { status: 'failed', error: 'storage_failed' });
        continue;
      }
      this.running++;
      try {
        const tools = this.bridge ? [...this.bridge.names(item.job)] : [];
        item.handle = this.executor({
          ...this.options.limits,
          code: item.code,
          ...(tools.length
            ? {
                tools,
                callTool: (name, args, signal) =>
                  this.callTool(item, name, args, signal),
              }
            : {}),
        });
        item.code = '';
        Promise.resolve(item.handle.result)
          .then(
            (r) => this.finish(item, r),
            () =>
              this.finish(item, {
                status: 'failed',
                error: 'executor_failed',
                logs: [],
              }),
          )
          .finally(() => {
            this.running--;
            this.pump();
          });
      } catch {
        this.running--;
        this.finish(item, {
          status: 'failed',
          error: 'executor_failed',
          logs: [],
        });
      }
    }
  }

  private async callTool(
    item: Live,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    const seq = ++item.calls,
      startedAt = Date.now();
    const observation: ToolObservationStart = {
      selfId: item.job.selfId,
      groupId: item.job.groupId,
      jobId: item.job.jobId,
      seq,
      tool: name,
      startedAt,
    };
    try {
      this.options.observer?.start({ ...observation });
    } catch {
      // An observer cannot block a call, retry it, or change its result.
    }
    let encoded: { json: string; attachments: Uint8Array[] };
    try {
      encoded = encodeToolValue(args);
    } catch {
      encoded = { json: 'null', attachments: [] };
    }
    const hash = createHash('sha256').update(encoded.json);
    for (const a of encoded.attachments) {
      hash.update(a);
    }
    let result: JsonObject;
    let bridgeOutcome: ToolObservationEnd['bridgeOutcome'] =
      this.bridge && item.caller ? 'returned' : 'unavailable';
    try {
      result =
        this.bridge && item.caller
          ? await this.bridge.call(
              {
                selfId: item.job.selfId,
                groupId: item.job.groupId,
                ...item.caller,
              },
              name,
              args,
              signal,
            )
          : { status: 'error', error: 'host_unavailable' };
    } catch {
      bridgeOutcome = 'threw';
      result = { status: 'error', error: 'tool_failed' };
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      bridgeOutcome = 'invalid_result';
      result = { status: 'error', error: 'invalid_host_result' };
    }
    try {
      this.options.observer?.end({
        ...observation,
        finishedAt: Date.now(),
        ...observationResult(result),
        bridgeOutcome,
      });
    } catch {
      // Keep observing late receipts even after the job has settled, while the writer is open.
      // A failed observation must not replace the caller's result.
    }
    const ids: Record<string, string> = {};
    for (const key of ID_FIELDS) {
      const v = result[key];
      if (
        (typeof v === 'string' && v.length <= 128) ||
        (typeof v === 'number' && Number.isSafeInteger(v))
      ) {
        ids[key] = String(v);
      }
    }
    try {
      this.options.store.recordCall(item.job, item.job.jobId, {
        seq,
        tool: name,
        ...callStatus(result),
        ids,
        argsBytes:
          Buffer.byteLength(encoded.json) +
          encoded.attachments.reduce((n, a) => n + a.byteLength, 0),
        argsHash: hash.digest('hex'),
        startedAt,
        finishedAt: Date.now(),
      });
    } catch {
      console.error('sandbox tool call record failed', item.job.jobId);
    }
    return result;
  }

  calls(scope: JobScope, jobId: string, offset?: number, limit?: number) {
    return this.options.store.calls(scope, jobId, offset, limit);
  }

  query(scope: JobScope, q: JobQuery = {}) {
    return this.options.store.query(scope, q);
  }

  cancel(scope: JobScope, jobId: string): Job | undefined {
    validateScope(scope);
    const job = this.options.store.get(scope, jobId);
    if (!job || !active(job)) {
      return job;
    }
    const item = this.live.get(jobId);
    if (item) {
      this.terminate(item, 'cancelled', 'cancelled');
    } else {
      this.options.store.settle(scope, jobId, {
        status: 'cancelled',
        error: 'cancelled',
      });
    }
    return this.options.store.get(scope, jobId);
  }

  pendingResults(selfId: string, limit = 100, cursor = 0) {
    return this.options.store.pendingResults(selfId, limit, cursor);
  }

  ackResult(selfId: string, groupId: string, jobId: string) {
    return this.options.store.markDelivered({ selfId, groupId }, jobId);
  }

  summary(selfId: string, groupId: string) {
    return this.options.store.summary(selfId, groupId);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const waits: Promise<unknown>[] = [];
    for (const item of [...this.live.values()]) {
      if (item.delivery === 'foreground') {
        try {
          this.options.store.detach(item.job, item.job.jobId);
        } catch {
          /* 写库失败时，下次启动会把未完成的任务标记为interrupted */
        }
        this.clean(item);
        item.delivery = 'background';
        item.resolve({
          status: 'interrupted',
          job_id: item.job.jobId,
          error: 'service_stopped',
          logs: [],
        });
      }
      if (item.handle) {
        waits.push(item.handle.result.catch(() => {}));
      }
      this.terminate(item, 'interrupted', 'service_stopped');
    }
    await Promise.all(waits);
    this.listeners.clear();
  }
}
