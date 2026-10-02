/**
 * 把工具调用的参数和结果整理成可直接阅读的摘要。只用于展示，
 * 原始参数与结果仍按原样提供给“原始数据”。
 */

/** 消息中的一个片段；kind 决定展示样式。 */
export interface Part {
  kind: 'text' | 'at' | 'face' | 'media' | 'other';
  text: string;
  /** 悬停提示，例如 at 的QQ号。 */
  title?: string;
}

/** 被回复的消息；本地查不到时 quote 为 null，只显示ID。 */
export interface Reply {
  messageId: string;
  quote: ChatLine | null;
}

export interface ChatLine {
  /** 发言人显示名；未知时为空串。 */
  who: string;
  userId: string;
  parts: Part[];
  reply?: Reply;
  bot?: boolean;
  recalled?: boolean;
}

export type ToolView =
  /** 请求发送的消息内容，不代表已经发送成功。 */
  | { kind: 'send'; parts: Part[]; reply: Reply | null }
  /** 读取到的消息列表。 */
  | { kind: 'messages'; lines: ChatLine[]; more: number }
  /** 一行文字说明。 */
  | { kind: 'line'; text: string }
  /** 沙箱JavaScript任务：代码（若在参数中）与执行结果。 */
  | ({ kind: 'script'; code: string | null } & ScriptJob);

/** 沙箱任务的执行结果；返回值只保证是字符串，不假定为JSON。 */
export type ScriptOutcome =
  | { kind: 'value'; text: string }
  | { kind: 'pending'; jobId: string }
  | { kind: 'error'; message: string; stack: string }
  | { kind: 'state'; text: string };

export interface ScriptJob {
  description: string;
  mode: string;
  outcome: ScriptOutcome | null;
  /** 沙箱内工具调用，如 create_image ×1；非ok的状态单独写出。 */
  calls: { text: string; status: string; abnormal: boolean }[];
  logs: string[];
}

/** QQ号到显示名的对照，来自同一范围内读到的消息与成员资料。 */
export type Names = ReadonlyMap<string, string>;

/** 消息ID到原始消息对象，用于展示回复引用。 */
export type Quotes = ReadonlyMap<string, unknown>;

export interface LookupContext {
  names?: Names;
  quotes?: Quotes;
}

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
const str = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const nameOf = (names: Names, userId: string) => names.get(userId) || userId;

/**
 * 从工具结果中收集QQ号到显示名；群名片优先于昵称，先出现的保留。
 * 本次读到的名字反映当时状态，优先；fallback（服务端按本群消息记录查到的
 * 最近名字）只补足本次没出现过的人。
 */
export function collectNames(
  tools: readonly { result: unknown }[],
  fallback: Readonly<Record<string, string>> = {},
): Map<string, string> {
  const names = new Map<string, string>();
  const add = (userId: unknown, ...candidates: unknown[]) => {
    const id = str(userId);
    const name = candidates.map(str).find(Boolean);
    if (id && name && !names.has(id)) {
      names.set(id, name);
    }
  };
  const message = (raw: unknown) => {
    const m = record(raw);
    add(m?.userId, m?.nickname);
  };
  const member = (raw: unknown) => {
    const m = record(raw);
    add(m?.user_id, m?.card, m?.nickname);
  };
  for (const tool of tools) {
    const r = record(tool.result);
    if (!r) {
      continue;
    }
    list(r.messages).forEach(message);
    message(r.message);
    for (const raw of list(r.events)) {
      message(record(record(raw)?.payload)?.message);
    }
    list(r.members).forEach(member);
    member(r.member);
  }
  for (const [id, name] of Object.entries(fallback)) {
    add(id, name);
  }
  return names;
}

/** 从工具结果收集消息ID到消息；本次读到的优先，fallback 补足其余。 */
export function collectQuotes(
  tools: readonly { result: unknown }[],
  fallback: Readonly<Record<string, unknown>> = {},
): Map<string, unknown> {
  const quotes = new Map<string, unknown>();
  const add = (raw: unknown) => {
    const id = str(record(raw)?.messageId);
    if (id && !quotes.has(id)) {
      quotes.set(id, raw);
    }
  };
  for (const tool of tools) {
    const r = record(tool.result);
    if (!r) {
      continue;
    }
    list(r.messages).forEach(add);
    add(r.message);
    for (const raw of list(r.events)) {
      add(record(record(raw)?.payload)?.message);
    }
  }
  for (const [id, message] of Object.entries(fallback)) {
    if (!quotes.has(id)) {
      quotes.set(id, message);
    }
  }
  return quotes;
}

/** 片段转为展示片段；与 Segment 声明一一对应，reply 片段不展示。 */
export function segmentParts(segments: unknown, names: Names = new Map()) {
  const parts: Part[] = [];
  for (const raw of list(segments)) {
    const s = record(raw);
    switch (s?.type) {
      case 'text':
        if (str(s.text)) {
          parts.push({ kind: 'text', text: str(s.text) });
        }
        break;
      case 'face':
        parts.push({
          kind: 'face',
          text: str(s.name) || `表情${str(s.id)}`,
          title: `表情 ${str(s.id)}`,
        });
        break;
      case 'at': {
        const id = str(s.user_id);
        parts.push({ kind: 'at', text: `@${nameOf(names, id)}`, title: id });
        break;
      }
      case 'reply':
        break;
      case 'image':
        parts.push({
          kind: 'media',
          text: str(s.image_id) ? `图片 ${str(s.image_id)}` : '图片',
        });
        break;
      case 'record':
        parts.push({ kind: 'media', text: '语音' });
        break;
      case 'forward':
        parts.push({ kind: 'media', text: '合并转发' });
        break;
      default:
        parts.push({
          kind: 'other',
          text: str(s?.kind) || str(s?.type) || '未知',
        });
    }
  }
  return parts;
}

/** 展示片段拼成纯文本，用于测试与无障碍文本。 */
export function partsText(parts: readonly Part[]): string {
  return parts
    .map((part) => (part.kind === 'text' ? part.text : `[${part.text}]`))
    .join('');
}

function reply(id: string, ctx: Required<LookupContext>): Reply {
  // 引用只展开一层，避免链式回复无限嵌套。
  const quote = messageLine(ctx.quotes.get(id), {
    names: ctx.names,
    quotes: new Map(),
  });
  return { messageId: id, quote };
}

function context(ctx: LookupContext): Required<LookupContext> {
  return { names: ctx.names ?? new Map(), quotes: ctx.quotes ?? new Map() };
}

function messageLine(
  raw: unknown,
  ctx: Required<LookupContext>,
): ChatLine | null {
  const m = record(raw);
  if (!m) {
    return null;
  }
  const names = ctx.names;
  // 模型投影使用 reply_to；内部消息及历史证据仍保留 replyTo，不改写原始数据。
  const replyTo = str(m.reply_to ?? m.replyTo);
  const userId = str(m.userId);
  const parts =
    m.representation === 'legacy_text'
      ? [{ kind: 'text' as const, text: str(m.text) }]
      : segmentParts(m.segments, names);
  return {
    who: str(m.nickname) || nameOf(names, userId),
    userId,
    parts:
      parts.length || !str(m.text)
        ? parts
        : [{ kind: 'text', text: str(m.text) }],
    ...(replyTo ? { reply: reply(replyTo, ctx) } : {}),
    ...(m.bot === true ? { bot: true } : {}),
    ...(m.recalled === true ? { recalled: true } : {}),
  };
}

const MAX_LINES = 20;

function lines(items: (ChatLine | null)[]): ToolView {
  const shown = items.filter((line): line is ChatLine => !!line);
  return {
    kind: 'messages',
    lines: shown.slice(0, MAX_LINES),
    more: Math.max(0, shown.length - MAX_LINES),
  };
}

const scalar = (value: unknown) => value === null || typeof value !== 'object';

/** 参数概要：标量和标量数组写成 key=value，其他复杂值只写键名，按原顺序。 */
export function argumentsLine(args: unknown, max = 160): string {
  const a = record(args);
  if (!a) {
    return '';
  }
  const parts = Object.entries(a).map(([key, value]) =>
    Array.isArray(value) && value.every(scalar)
      ? `${key}=${value.map(String).join(',')}`
      : scalar(value)
        ? `${key}=${String(value)}`
        : key,
  );
  const line = parts.join(' ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 无法给出专门展示时返回 null，由调用方显示参数概要。 */
export function toolView(
  name: string,
  args: unknown,
  result: unknown,
  lookup: LookupContext = {},
): ToolView | null {
  const ctx = context(lookup);
  const names = ctx.names;
  const a = record(args) ?? {};
  const r = record(result) ?? {};
  switch (name) {
    case 'send_message':
      return {
        kind: 'send',
        parts: segmentParts(a.segments, names),
        reply: str(a.reply_to) ? reply(str(a.reply_to), ctx) : null,
      };
    case 'read_messages':
      return Array.isArray(r.messages)
        ? lines(r.messages.map((m) => messageLine(m, ctx)))
        : null;
    case 'read_message': {
      const line = messageLine(r.message, ctx);
      return line ? lines([line]) : null;
    }
    case 'read_events':
      return Array.isArray(r.events)
        ? lines(
            r.events.map((raw) => {
              const e = record(raw);
              const payload = record(e?.payload);
              if (e?.type === 'message.created' && payload?.message) {
                return messageLine(payload.message, ctx);
              }
              const actor = str(e?.actor_id);
              return {
                who: actor ? nameOf(names, actor) : '',
                userId: actor,
                parts: [{ kind: 'other', text: str(e?.type) }],
              };
            }),
          )
        : null;
    case 'react_message':
      return {
        kind: 'line',
        text: `${a.action === 'remove' ? '撤回回应' : a.action === 'add' ? '添加回应' : '回应操作'} ${str(a.emoji_id)} → 消息 ${str(a.message_id)}`,
      };
    case 'poke_member':
      return {
        kind: 'line',
        text: `戳一戳 ${nameOf(names, str(a.user_id))}`,
      };
    case 'send_group_ai_voice':
      return {
        kind: 'send',
        parts: [
          { kind: 'media', text: 'AI语音' },
          { kind: 'text', text: str(a.text) },
        ],
        reply: null,
      };
    case 'finish':
      return { kind: 'line', text: '结束本次唤醒' };
    case 'execute_javascript':
      return {
        kind: 'script',
        code: typeof a.code === 'string' ? a.code : null,
        ...scriptJob(a, r),
      };
    case 'query_javascript_jobs': {
      const job = record(r.job);
      if (job) {
        return { kind: 'script', code: null, ...scriptJob(job, job) };
      }
      return Array.isArray(r.jobs)
        ? { kind: 'line', text: `列出 ${r.jobs.length} 个任务` }
        : null;
    }
    default:
      return null;
  }
}

const SCRIPT_MODES: Record<string, string> = {
  sync: '同步',
  auto: '自动',
  async: '异步',
};

/** 任务字段：execute_javascript 的参数与结果，或 query_javascript_jobs 返回的任务对象。 */
function scriptJob(
  meta: Record<string, unknown>,
  r: Record<string, unknown>,
): ScriptJob {
  // 旧版任务查询结果使用驼峰字段名，历史记录仍按原样读取。
  const summary = record(r.tool_calls ?? r.toolCalls);
  const diagnostic = record(r.diagnostic);
  const state = str(r.task_status) || str(r.status);
  const outcome: ScriptOutcome | null =
    typeof r.value === 'string'
      ? { kind: 'value', text: r.value }
      : diagnostic
        ? {
            kind: 'error',
            message: [str(diagnostic.name), str(diagnostic.message)]
              .filter(Boolean)
              .join(': '),
            stack: str(diagnostic.stack),
          }
        : str(r.error)
          ? { kind: 'error', message: str(r.error), stack: '' }
          : state === 'pending' || state === 'queued' || state === 'running'
            ? { kind: 'pending', jobId: str(r.job_id ?? r.jobId) }
            : state && state !== 'ok' && state !== 'completed'
              ? { kind: 'state', text: state }
              : null;
  const calls = Object.entries(record(summary?.counts) ?? {}).flatMap(
    ([tool, raw]) =>
      !tool.trim()
        ? []
        : Object.entries(record(raw) ?? {}).flatMap(([status, count]) =>
            status.trim() &&
            typeof count === 'number' &&
            Number.isSafeInteger(count) &&
            count > 0
              ? [
                  {
                    text: `${tool}${status === 'ok' ? '' : ` ${status}`} ×${count}`,
                    status,
                    abnormal: status !== 'ok',
                  },
                ]
              : [],
          ),
  );
  return {
    description: str(meta.description),
    mode: SCRIPT_MODES[str(meta.mode)] ?? str(meta.mode),
    outcome,
    calls,
    logs: Array.isArray(r.logs) ? r.logs.map(String) : [],
  };
}

/**
 * 只有整个字符串是JSON对象或数组时才按JSON展示；标量与普通文本（如字符画）按原文展示。
 */
export function structuredText(text: string): object | null {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** 错误或未知状态的原始详情；成功和正常流程状态交给结果证据摘要。 */
export function resultProblem(result: unknown): string | null {
  const r = record(result);
  if (!r) {
    return null;
  }
  const status = str(r.status);
  // 已处理、待确认、暂存或后台句柄都不是错误，实际含义由结果摘要说明。
  if (
    !status ||
    [
      'ok',
      'pending',
      'executed',
      'success',
      'submitted',
      'confirmation_required',
      'staged',
      'duplicate',
    ].includes(status)
  ) {
    return null;
  }
  const detail = str(r.error) || str(r.reason_code) || str(r.reason);
  return detail ? `${status}: ${detail}` : status;
}
