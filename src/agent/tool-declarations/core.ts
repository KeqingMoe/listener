import type { DeclarationTable } from './types.ts';

/** 发言、结束、成员与消息读取、世界观察。 */
export const CORE_DECLARATIONS: DeclarationTable = {
  send_message: {
    summary: '向本群发送一条消息。',
    ts: ({ config }) => `/**
 * 发送后唤醒继续，多条分多次发。
 * 超级表情（目录中带★）须单独发：segments 只含该 face、不设 reply_to，才显示为大表情。${
   config.messageMentions === false ? '\n * 本群禁用 at 片段。' : ''
 }
 */
function send_message(_: {
  segments: (${
    config.messageMentions === false
      ? "{ type: 'text'; text: string } | { type: 'face'; id: FaceId; name?: string }"
      : "{ type: 'text'; text: string } | { type: 'at'; user_id: UserId } | { type: 'face'; id: FaceId; name?: string }"
  })[];
  reply_to?: MessageId;
}): { status: 'ok'; effect_confirmed: true; message_id: MessageId } | Unknown | Failure;`,
  },
  finish: {
    summary: '结束本次唤醒。',
    ts: `/** 不发言时直接调用；之后的调用都不执行。 */
function finish(_: {}): { status: 'ok' };`,
  },
  get_group_members: {
    summary: '分页搜索本群成员。',
    ts: `/** search 匹配QQ号、昵称或群名片；用 next_offset 续页。 */
function get_group_members(_: { limit: number; offset?: number; search?: string }): {
  status: 'ok';
  members: { user_id: UserId; nickname: string; card: string; role: 'owner' | 'admin' | 'member' | 'unknown' }[];
  total: number;
  truncated: boolean;
  next_offset?: number;
} | Failure;`,
  },
  get_member_info: {
    summary: '读取本群某个成员的资料。',
    ts: `function get_member_info(_: { user_id: UserId }): {
  status: 'ok';
  member: { user_id: UserId; nickname: string; card: string; role: 'owner' | 'admin' | 'member' | 'unknown' };
} | Failure;`,
  },
  read_message: {
    summary: '读取一条本群消息或其引用的消息。',
    ts: ({
      config,
    }) => `/** 也可用最近消息的顶层 reply_to 读取被引用消息（取其 image_id 等）。${
      config.observeReactions ? '会刷新反应快照。' : ''
    } */
function read_message(_: { message_id: MessageId }): { status: 'ok'; message: Message } | Failure;`,
  },
  get_wake_state: {
    summary: '查询唤醒信息、未读计数、预算和时间。',
    ts: `/** 不读正文，不推进已读位置。 */
function get_wake_state(_: {}): {
  status: 'ok';
  unread_count: number;
  unread_by_type: Record<string, number>;
  wake_budget?: WakeBudget;
  current_time: Clock;
};`,
    types: {
      WakeBudget: `type WakeBudget = { max_tool_calls: number; used_tool_calls: number; remaining_tool_calls: number; remaining_ms: number };`,
      Clock: `/** local 按配置时区格式化，timezone 是IANA时区。 */
type Clock = { unix_seconds: UnixSeconds; utc: string; local: string; timezone: string };`,
    },
  },
  get_time: {
    summary: '获取当前时间。',
    ts: `function get_time(_: {}): { status: 'ok' } & Clock;`,
    types: {
      Clock: `/** local 按配置时区格式化，timezone 是IANA时区。 */
type Clock = { unix_seconds: UnixSeconds; utc: string; local: string; timezone: string };`,
    },
  },
  read_events: {
    summary: '读取本群事件流。',
    ts: `/**
 * 默认 forward 从已确认处往后读，backward 从最新往前读；续页只传 limit 和 cursor。
 * 仅无任何过滤且 forward 时返回 ack_cursor。
 */
function read_events(
  _:
    | { limit: number; direction?: 'forward' | 'backward'; actor_id?: UserId; since?: UnixSeconds; until?: UnixSeconds; types?: EventType[] }
    | { limit: number; cursor: string },
): ({ status: 'ok'; events: WorldEvent[]; next_cursor?: string; ack_cursor?: string } & Page) | Failure;`,
    types: {
      Page: `/** truncated=true 时用 next_cursor 继续。 */
type Page = { returned: number; truncated: boolean; current_time: Clock };`,
      Clock: `/** local 按配置时区格式化，timezone 是IANA时区。 */
type Clock = { unix_seconds: UnixSeconds; utc: string; local: string; timezone: string };`,
      EventType: `type EventType = 'message.created' | 'message.recalled' | 'reaction.changed' | 'poke.created' | 'member.joined' | 'member.left' | 'group.ban_changed' | 'file.uploaded' | 'group.name_changed';`,
      WorldEvent: `/** payload 随 type 变化，message.created 的 payload.message 是 Message。 */
type WorldEvent = { event_id: string; sequence: number; type: EventType; observed_at: UnixSeconds; occurred_at?: UnixSeconds; actor_id?: UserId; payload: object | null; payload_omitted?: true };`,
    },
  },
  read_messages: {
    summary: '读取本群消息。',
    ts: `/**
 * 含已知撤回状态，不推进已读位置。
 * 默认 forward 从已确认处往后读，backward 从最新往前读；续页只传 limit 和 cursor。
 */
function read_messages(
  _:
    | { limit: number; direction?: 'forward' | 'backward'; actor_id?: UserId; since?: UnixSeconds; until?: UnixSeconds }
    | { limit: number; cursor: string },
): ({ status: 'ok'; messages: Message[]; next_cursor?: string } & Page) | Failure;`,
    types: {
      Page: `/** truncated=true 时用 next_cursor 继续。 */
type Page = { returned: number; truncated: boolean; current_time: Clock };`,
      Clock: `/** local 按配置时区格式化，timezone 是IANA时区。 */
type Clock = { unix_seconds: UnixSeconds; utc: string; local: string; timezone: string };`,
    },
  },
  ack_events: {
    summary: '确认已读取的事件。',
    ts: `/** 确认已读到 ack_cursor 为止的事件；读取不会自动确认。 */
function ack_events(_: { ack_cursor: string }): { status: 'ok'; observed_through: number } | Failure;`,
  },
};
