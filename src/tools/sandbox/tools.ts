import {
  type JsonObject,
  isPlainObject,
  hasExactFields,
} from '../../contracts/json.ts';
import type { ToolDefinition, TurnContext } from '../../contracts/tools.ts';
import type { SandboxService } from '../../sandbox/service.ts';
import {
  JOB_BOUNDS,
  type Job,
  type JobQuery,
  type JobStatus,
} from '../../sandbox/store.ts';

export const SANDBOX_TOOL_NAMES = [
  'execute_javascript',
  'query_javascript_jobs',
  'cancel_javascript_job',
] as const;
const statuses: JobStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'timeout',
];
const definitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'execute_javascript',
      description:
        '在隔离的 JavaScript 沙箱中执行计算。代码按 async 函数体执行，始终可以使用 await，必须 return 一个字符串；数字或BigInt请自行调用 .toString()，结构化结果请自行 JSON.stringify()，不会隐式序列化。mode=sync 等待并返回结果，mode=async 立即返回任务句柄，mode=auto 优先等待、超时后转为后台任务。sync和auto必须提供wait_ms整数1..2147483647，表示包含排队与启动的前台等待毫秒数，没有默认值；async禁止提供wait_ms。沙箱无文件、网络或环境变量访问。代码内可 await tools.<工具名>(与工具调用相同的参数)，返回与该工具结果相同的对象，失败不抛异常；finish、manage_attention、get_wake_state和execute_javascript除外；字节字段可传Uint8Array，view_images/view_custom_face在代码内返回RGBA像素。这些调用不占本轮工具预算，但有副作用的操作请慎用：结果为unknown时不要重试，不要写无退出条件的发送循环。结果的tool_calls汇总各工具调用次数并列出所有非ok调用。示例：let n=1n; for(let i=2n;i<=114n;i++) n*=i; return n.toString();',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'code', 'mode'],
        properties: {
          description: {
            type: 'string',
            description: '任务用途和预期结果，最多1024字节。',
          },
          code: {
            type: 'string',
            description:
              'JavaScript函数体，最多65536字节；最终必须return字符串。',
          },
          mode: {
            type: 'string',
            enum: ['sync', 'async', 'auto'],
            description:
              '等待模式：sync等待并超时终止，async立即后台执行，auto先等待再后台继续。',
          },
          wait_ms: {
            type: 'integer',
            minimum: 1,
            maximum: 2147483647,
            description:
              'sync和auto必填；async禁止传入。前台等待毫秒数，包含排队与启动，无默认值，不延长整轮唤醒预算。',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_javascript_jobs',
      description:
        '查询当前账号当前群的JavaScript沙箱任务。默认列出活动任务和完成但尚未交付的后台结果；提供job_id可查看该任务的详细结果。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          job_id: { type: 'string', description: '任务ID。' },
          status: { type: 'string', enum: statuses },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          calls_offset: {
            type: 'integer',
            minimum: 0,
            description:
              '仅配合job_id：列出该任务代码内工具调用的完整记录，从第几条开始，每页100条。任务详情默认只含tool_calls摘要。',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_javascript_job',
      description:
        '取消当前账号当前群的JavaScript后台任务。已完成或已取消的任务不会被重复执行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['job_id'],
        properties: { job_id: { type: 'string' } },
      },
    },
  },
];

function fields(
  v: unknown,
  required: string[],
  optional: string[],
): Record<string, unknown> {
  if (!hasExactFields(v, required, optional)) {
    throw new Error('invalid_arguments');
  }
  return v;
}

function text(v: unknown, max: number, nonempty = true): string {
  if (
    typeof v !== 'string' ||
    (nonempty && !v.trim()) ||
    Buffer.byteLength(v) > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
  ) {
    throw new Error('invalid_arguments');
  }
  return v;
}

function scope(context: TurnContext) {
  return {
    selfId: text(context.selfId, 64),
    groupId: text(context.groupId, 64),
  };
}

function caller(context: TurnContext) {
  return {
    actorId: typeof context.actorId === 'string' ? context.actorId : '',
    messageId: typeof context.messageId === 'string' ? context.messageId : '',
  };
}

function execution(
  value: Awaited<ReturnType<SandboxService['execute']>>,
): JsonObject {
  if (value.status === 'pending') {
    return { ...value };
  }
  // 在稳定的任务错误码之外，一并保留已校验的沙箱内诊断信息。
  const { status, ...detail } = value;
  return {
    ...detail,
    status: status === 'completed' ? 'ok' : 'error',
    task_status: status,
  };
}

/** 任务的对外表示：下划线命名，不含归属账号与群。 */
function project(job: Partial<Job>): JsonObject {
  return {
    job_id: job.jobId!,
    description: job.description!,
    mode: job.mode!,
    status: job.status!,
    created_at: job.createdAt!,
    started_at: job.startedAt ?? null,
    finished_at: job.finishedAt ?? null,
    background: job.background!,
    delivered_at: job.deliveredAt ?? null,
    ...(job.value !== undefined ? { value: job.value } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(job.logs !== undefined ? { logs: job.logs } : {}),
    ...(job.diagnostic
      ? { diagnostic: job.diagnostic as unknown as JsonObject }
      : {}),
    ...(job.toolCalls
      ? { tool_calls: job.toolCalls as unknown as JsonObject }
      : {}),
  };
}

function queryResult(value: unknown): JsonObject {
  if (value === undefined) {
    return { status: 'error', error: 'job_not_found' };
  }
  if (!isPlainObject(value)) {
    return { status: 'error', error: 'invalid_service_result' };
  }
  if (Object.hasOwn(value, 'jobId')) {
    return { status: 'ok', job: project(value as Partial<Job>) };
  }
  const page = value as { jobs?: unknown; offset?: unknown; hasMore?: unknown };
  if (!Array.isArray(page.jobs)) {
    return { status: 'error', error: 'invalid_service_result' };
  }
  return {
    status: 'ok',
    jobs: page.jobs.map((job) => project(job as Partial<Job>)),
    offset: page.offset as number,
    has_more: page.hasMore === true,
  };
}

export function buildSandboxTools(): ToolDefinition[] {
  return definitions.map((d) => structuredClone(d));
}

export class SandboxTools {
  constructor(private readonly service: SandboxService) {}
  definitions(): ToolDefinition[] {
    return definitions.map((d) => structuredClone(d));
  }

  async execute(
    name: string,
    args: unknown,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    try {
      const s = scope(context);
      if (![s.selfId, s.groupId].every((v) => /^[1-9]\d{0,31}$/.test(v))) {
        return { status: 'error', error: 'invalid_scope' };
      }
      if (name === 'execute_javascript') {
        const a = fields(args, ['description', 'code', 'mode'], ['wait_ms']);
        const description = text(a.description, JOB_BOUNDS.description),
          code = text(a.code, JOB_BOUNDS.code, false);
        if (
          typeof a.mode !== 'string' ||
          !['sync', 'async', 'auto'].includes(a.mode) ||
          Object.getPrototypeOf(a.mode) !== String.prototype
        ) {
          throw new Error('invalid_arguments');
        }
        if (a.mode === 'async') {
          if (Object.hasOwn(a, 'wait_ms')) {
            throw new Error('invalid_arguments');
          }
          return execution(
            await this.service.execute(
              { ...s, description, code, mode: 'async' },
              signal,
              caller(context),
            ),
          );
        }
        if (
          typeof a.wait_ms !== 'number' ||
          !Number.isInteger(a.wait_ms) ||
          a.wait_ms < 1 ||
          a.wait_ms > 2147483647
        ) {
          throw new Error('invalid_arguments');
        }
        return execution(
          await this.service.execute(
            {
              ...s,
              description,
              code,
              mode: a.mode as 'sync' | 'auto',
              waitMs: a.wait_ms,
            },
            signal,
            caller(context),
          ),
        );
      }
      if (name === 'query_javascript_jobs') {
        const a = fields(
          args,
          [],
          ['job_id', 'status', 'offset', 'limit', 'calls_offset'],
        );
        const q: JobQuery = {};
        if (a.job_id !== undefined) {
          q.jobId = text(a.job_id, 128);
        }
        if (a.status !== undefined) {
          if (!statuses.includes(a.status as JobStatus)) {
            throw new Error('invalid_arguments');
          }
          q.status = a.status as JobStatus;
        }
        if (a.offset !== undefined) {
          if (
            typeof a.offset !== 'number' ||
            !Number.isSafeInteger(a.offset) ||
            a.offset < 0
          ) {
            throw new Error('invalid_arguments');
          }
          q.offset = a.offset;
        }
        if (a.limit !== undefined) {
          if (
            typeof a.limit !== 'number' ||
            !Number.isSafeInteger(a.limit) ||
            a.limit < 1 ||
            a.limit > 100
          ) {
            throw new Error('invalid_arguments');
          }
          q.limit = a.limit;
        }
        if (a.calls_offset !== undefined) {
          if (
            q.jobId === undefined ||
            typeof a.calls_offset !== 'number' ||
            !Number.isSafeInteger(a.calls_offset) ||
            a.calls_offset < 0
          ) {
            throw new Error('invalid_arguments');
          }
        }
        const found = queryResult(await this.service.query(s, q));
        if (
          q.jobId === undefined ||
          a.calls_offset === undefined ||
          found.status !== 'ok'
        ) {
          return found;
        }
        const page = this.service.calls(
          s,
          q.jobId,
          a.calls_offset as number,
          100,
        );
        return {
          ...found,
          calls: page.calls.map((c) => ({
            seq: c.seq,
            tool: c.tool,
            status: c.status,
            ...(c.error ? { error: c.error } : {}),
            ...(Object.keys(c.ids).length ? { ids: c.ids } : {}),
            args_bytes: c.argsBytes,
            duration_ms: c.finishedAt - c.startedAt,
          })),
          calls_has_more: page.hasMore,
        };
      }
      if (name === 'cancel_javascript_job') {
        const a = fields(args, ['job_id'], []);
        return queryResult(await this.service.cancel(s, text(a.job_id, 128)));
      }
      throw new Error('unknown_tool');
    } catch (error) {
      const code =
        error instanceof Error &&
        ['invalid_arguments', 'invalid_scope', 'unknown_tool'].includes(
          error.message,
        )
          ? error.message
          : 'sandbox_failed';
      return { status: 'error', error: code };
    }
  }
}
