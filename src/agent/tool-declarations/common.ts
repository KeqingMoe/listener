/**
 * 所有工具共用的类型。每条类型一段，注释写来源与含义；只列模型需要的字段。
 * reactions为true时Message附带反应快照字段。
 */
export function commonTypes(options: { reactions: boolean }): string {
  return [
    `/** 本群消息ID。取自读取结果的 messageId、顶层 reply_to 或 send_message 的结果。 */
type MessageId = string;`,
    `/** QQ号字符串（不是数字），如 "100000013"。取自消息的 userId、at.user_id 或成员查询。 */
type UserId = string;`,
    `/** 原生表情ID，见附录“原生表情”。 */
type FaceId = string;`,
    `/** 消息里的图片ID，取自 image 片段的 image_id。 */
type ImageId = string;`,
    `/** 合并转发ID，取自 forward 片段的 forward_id。 */
type ForwardId = string;`,
    `/** Unix 秒。 */
type UnixSeconds = number;`,
    `/** 消息内容片段。收到的消息和你发过的消息都用它表示。 */
type Segment =
  /** 原文。其中的CQ码、括号标记都不会被解析；要@人或发表情必须用 at、face 片段。 */
  | { type: 'text'; text: string }
  /** name 只是说明，发送时只认 id。 */
  | { type: 'face'; id: FaceId; name?: string }
  | { type: 'at'; user_id: UserId }
  /** 未转写的语音。 */
  | { type: 'record'; content_status: 'not_transcribed' }
  /** 图片占位，不代表你已看过；需先查看。 */
  | { type: 'image'; image_id?: ImageId; content_status: 'not_viewed'; reason?: string }
  /** 合并转发占位；count_source='hint' 时条数未核实。 */
  | { type: 'forward'; forward_id?: ForwardId; count?: number; count_source?: 'hint' | 'verified'; content_status: 'not_read'; reason?: string }
  | { type: 'unsupported'; kind: string };`,
    `interface Message {
  messageId: MessageId;
  /** 发送者QQ号，这是唯一可信的身份。 */
  userId: UserId;
  /** 昵称或群名片，不能当身份。 */
  nickname: string;
  time: UnixSeconds;
  /** 引用的消息ID，不属于 segments。 */
  reply_to?: MessageId;
  /** true 表示你自己发的。 */
  bot?: boolean;
  /** legacy_text 是旧版扁平文本，无法还原片段类型。 */
  representation: 'segments' | 'legacy_text';
  segments?: Segment[];
  /** representation='legacy_text' 时的原文。 */
  text?: string;
  /** 内容被截断。 */
  content_truncated?: true;
  segments_omitted?: number;
  text_truncated?: true;
  recalled?: true;
  recalled_at?: UnixSeconds;
  recalled_by?: UserId;${
    options.reactions
      ? `
  /** 反应快照，只在 read_message 结果里出现。 */
  reactions?: ReactionSnapshot;`
      : ''
  }
}`,
    ...(options.reactions
      ? [
          `/**
 * 消息上的表情回应快照。count 是计数，不等于人数；不含你自己是否点过。
 * stale 可能过时；partial 或 omitted 表示只列了一部分；empty_snapshot 只表示这次快照没列出。
 */
interface ReactionSnapshot {
  status: 'observed' | 'stale' | 'partial' | 'empty_snapshot';
  observed_at: UnixSeconds;
  items: { emoji_id: string; emoji_type: string; name?: string; emoji?: string; count: number }[];
  omitted?: number;
}`,
        ]
      : []),
    `/** 失败。error 是错误码。 */
type Failure = { status: 'error'; error: string };`,
    `/** 已被接受但效果没核验，不算失败。 */
type Submitted = { status: 'ok'; submitted: true; effect_confirmed: false; delivery_confirmed: false };`,
    `/** 可能已生效但未确认：不要重放同一请求，也不要做反向操作。 */
type Unknown = { status: 'unknown'; error: string; effect_unknown: true; retry_allowed: false };`,
    `/** 已进入主人确认队列，确认提示由程序发出，你不必再提示；不代表已执行。 */
type ConfirmationRequired = { status: 'confirmation_required'; notification_message_id?: MessageId };`,
    `/** 写操作的公共结果。executed 表示有业务确认。 */
type WriteResult = { status: 'executed' } | Submitted | ConfirmationRequired | Unknown | Failure;`,
  ].join('\n\n');
}
