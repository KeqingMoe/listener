import type { DeclarationTable } from './types.ts';

const FACE_REF = `/** 收藏表情引用，取自 list_custom_faces、add_custom_face 或 set_custom_face_description 的结果；描述或标签变化后失效（invalid_face_ref），需重新列出。 */
type FaceRef = string;`;
const CUSTOM_FACE = `/** tags 是本地检索标签。 */
type CustomFace = { face_ref: FaceRef; description: string; tags: string[]; revision: number };`;
const REMINDER_ID = `/** 提醒ID，取自提醒工具的结果。 */
type ReminderId = string;`;
const REMINDER_STATE = `type ReminderState = 'pending' | 'sending' | 'sent' | 'unknown' | 'failed' | 'cancelled' | 'expired';`;
const REMINDER = `/**
 * 时间为ISO字符串；expires_at 后不再补发。message_id 是已发出的提醒消息。
 * text 过长时截断，带 text_truncated 和原长 text_bytes。
 */
type Reminder = {
  id: ReminderId;
  revision: number;
  state: ReminderState;
  creator_id: UserId;
  source_message_id: MessageId;
  text: string;
  text_truncated?: true;
  text_bytes?: number;
  due_at: string;
  expires_at: string;
  time_zone: string;
  created_at: string;
  updated_at: string;
  message_id?: MessageId;
  reason?: string;
};`;
const REMINDER_STORED = `/** 已存储，不代表已发送。 */
type ReminderStored = { status: 'ok'; stored: true; delivery_confirmed: false; catch_up_hours: 24; scope: 'current_group_shared'; reminder: Reminder };`;
const JOB_ID = `/** 任务ID，取自 execute_javascript 或 query_javascript_jobs 的结果。 */
type JobId = string;`;
const JOB_STATUS = `type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'timeout';`;
const JS_DIAGNOSTIC = `/** guest_exception 为代码异常，contract_error 为违反返回值或日志约定；内容可能截断。 */
type JsDiagnostic = { kind: 'guest_exception' | 'contract_error'; phase: 'compile' | 'execute' | 'result'; name?: string; message: string; stack?: string; truncated: boolean };`;
const TOOL_CALL_SUMMARY = `/** 代码内工具调用汇总；abnormal 为非 ok 调用，最多32条，其余计入 abnormal_omitted。 */
type ToolCallSummary = {
  counts: Record<string, Partial<Record<'ok' | 'error' | 'unknown' | 'confirmation_required', number>>>;
  abnormal: { seq: number; tool: string; status: 'error' | 'unknown' | 'confirmation_required'; error?: string }[];
  abnormal_omitted: number;
};`;
const JOB_SUMMARY = `/** 时间为Unix毫秒；background 表示结果走后台交付。 */
type JobSummary = {
  job_id: JobId;
  description: string;
  mode: 'sync' | 'async' | 'auto';
  status: JobStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  background: boolean;
  delivered_at: number | null;
};`;
const JOB = `/** value 是 completed 时代码返回的字符串。 */
type Job = JobSummary & { value?: string; error?: string; logs: string[]; diagnostic?: JsDiagnostic; tool_calls?: ToolCallSummary };`;
const ARTIFACT_ID = `/** 产物ID，取自 create_artifact、create_image 或 list_artifacts 的结果。 */
type ArtifactId = string;`;
const ARTIFACT_INFO = `/** size 为字节数；时间为ISO字符串，expires_at 后自动删除。 */
type ArtifactInfo = {
  artifact_id: ArtifactId;
  name: string;
  description: string;
  media_type: string;
  size: number;
  sha256: string;
  created_at: string;
  expires_at: string;
};`;

const REMINDER_TYPES = {
  ReminderId: REMINDER_ID,
  ReminderState: REMINDER_STATE,
  Reminder: REMINDER,
  ReminderStored: REMINDER_STORED,
};
const JOB_TYPES = {
  JobId: JOB_ID,
  JobStatus: JOB_STATUS,
  JsDiagnostic: JS_DIAGNOSTIC,
  ToolCallSummary: TOOL_CALL_SUMMARY,
  JobSummary: JOB_SUMMARY,
  Job: JOB,
};
const ARTIFACT_TYPES = { ArtifactId: ARTIFACT_ID, ArtifactInfo: ARTIFACT_INFO };

/** 收藏表情、提醒、JavaScript沙箱、网页与产物。 */
export const EXTENDED_DECLARATIONS: DeclarationTable = {
  list_custom_faces: {
    summary: '列出或检索Bot账号的收藏表情。',
    ts: `/**
 * 按描述或标签检索收藏，目录有上限，结果不保证完整。limit 1至100，默认48。
 * 续页传 next_cursor（1小时内有效，带 query 须与首页相同）；不带 cursor 会刷新目录。
 * snapshot_count 是本次目录条数，stale_omitted 是其后失效而跳过的条数，observed_in_current_read 是本次从QQ读到的条数。
 */
function list_custom_faces(_: { query?: string; limit?: number; cursor?: string }): {
  status: 'ok';
  items: CustomFace[];
  coverage: 'observed_prefix';
  pagination: 'local_fixed_snapshot';
  snapshot_count: number;
  stale_omitted: number;
  observed_in_current_read?: number;
  returned_count: number;
  directory_complete: false;
  next_cursor?: string;
} | Failure;`,
    types: { FaceRef: FACE_REF, CustomFace: CUSTOM_FACE },
  },
  view_custom_face: {
    summary: '查看一张收藏表情图片。',
    ts: `/**
 * 图片随结果附给你，动图只给首帧；本轮已看过同一引用则返回 reused，不再附图。
 * 沙箱内没有 visual_content_* 字段，改为 images 返回RGBA像素。
 */
function view_custom_face(_: { face_ref: FaceRef }):
  | { status: 'ok'; face_ref: FaceRef; visual_content_provided?: true; first_frame_only: boolean; animated: boolean; width: number; height: number; images?: FacePixels[] }
  | { status: 'ok'; face_ref: FaceRef; reused: true; visual_content_already_provided?: true; images?: FacePixels[] }
  | Failure;`,
    types: {
      FaceRef: FACE_REF,
      FacePixels: `/** 仅沙箱内：按行排列的RGBA像素。 */
type FacePixels = { face_ref?: FaceRef; width: number; height: number; pixels: Uint8Array };`,
    },
  },
  send_custom_face: {
    summary: '把一张收藏表情发到本群。',
    ts: `/** 以原图格式发送收藏表情，保留GIF/PNG等格式，动图仍是动图。 */
function send_custom_face(_: { face_ref: FaceRef }):
  | { status: 'executed'; message_id: MessageId; face_ref: FaceRef; local_projection_failed?: true }
  | ConfirmationRequired
  | Unknown
  | Failure;`,
    types: { FaceRef: FACE_REF },
  },
  add_custom_face: {
    summary: '把本群消息里的一张图片加入收藏表情。',
    ts: `/**
 * 收藏本群近期消息（或其引用消息）里的图片并设描述（最多2048字节），tags 最多16个。
 * description_result 是描述那一步的结果；描述失败不回滚收藏。
 * already_collected=true 表示原本已收藏，只更新描述。
 * 收藏已提交但未核实绑定时返回带 error 的 Submitted；reconcile_allowed=true 时可用同一 image_id 再调用一次对账，不会重复收藏。
 */
function add_custom_face(_: { image_id: ImageId; description: string; tags?: string[] }):
  | {
      status: 'ok' | 'error' | 'unknown';
      collection_submitted: boolean;
      already_collected: boolean;
      collection_binding_confirmed: true;
      reconciled_previous_add?: true;
      face_ref?: FaceRef;
      description_result: object;
      description_submitted: boolean;
      description_confirmed: boolean;
    }
  | (Submitted & {
      collection_submitted: boolean;
      collection_binding_confirmed: false;
      description_submitted: false;
      reconcile_allowed: boolean;
      error: string;
    })
  | ConfirmationRequired
  | Unknown
  | Failure;`,
    types: { FaceRef: FACE_REF },
  },
  delete_custom_face: {
    summary: '删除一张收藏表情。',
    ts: `/** reference_revoked=true 表示该引用已失效。 */
function delete_custom_face(_: { face_ref: FaceRef }):
  | (Submitted & { reference_revoked: boolean; local_projection_failed?: true })
  | ConfirmationRequired
  | Unknown
  | Failure;`,
    types: { FaceRef: FACE_REF },
  },
  set_custom_face_description: {
    summary: '修改一张收藏表情的描述。',
    ts: `/**
 * 描述最多2048字节；不传 tags 保留原标签，传入则整体替换。
 * description_confirmed=true 时返回新 face_ref，旧引用失效。
 */
function set_custom_face_description(_: { face_ref: FaceRef; description: string; tags?: string[] }):
  | (Submitted & { description_confirmed: false; readback: 'not_confirmed'; local_tags_updated?: false })
  | ({
      status: 'ok';
      submitted: true;
      effect_confirmed: true;
      delivery_confirmed: false;
      description_confirmed: true;
      local_tags_updated?: boolean;
      local_projection_failed?: true;
    } & Partial<CustomFace>)
  | ConfirmationRequired
  | Unknown
  | Failure;`,
    types: { FaceRef: FACE_REF, CustomFace: CUSTOM_FACE },
  },
  create_reminder: {
    summary: '创建一次性群提醒。',
    ts: `/**
 * 到点向本群发纯文字提醒（不@人，不唤醒你），错过后24小时内补发。
 * source_message_id 是本群一条非你发的已见消息，其作者记为 creator_id；text 非空，最多24000字节。
 * due_at 为未来时间，RFC3339 含秒和偏移（Z 或 ±HH:MM），如 2025-01-02T08:00:00+08:00。
 * time_zone 为IANA时区（如 Asia/Shanghai），其在该时刻的偏移须与 due_at 一致。
 */
function create_reminder(_: { source_message_id: MessageId; text: string; due_at: string; time_zone: string }): ReminderStored | Failure;`,
    types: REMINDER_TYPES,
  },
  list_reminders: {
    summary: '查询本群提醒。',
    ts: `/** 查询本群所有人的提醒；next_offset 为 null 表示没有更多。 */
function list_reminders(_: { limit: number; offset?: number; state?: ReminderState }): {
  status: 'ok';
  scope: 'current_group_shared';
  pagination: 'live_offset';
  requested: number;
  returned: number;
  offset: number;
  next_offset: number | null;
  items: Reminder[];
} | Failure;`,
    types: {
      ReminderId: REMINDER_ID,
      ReminderState: REMINDER_STATE,
      Reminder: REMINDER,
    },
  },
  update_reminder: {
    summary: '修改一条待发送的提醒。',
    ts: `/**
 * 修改 pending 提醒，id 与 revision 取自最近的提醒结果。至少改一项；due_at 与 time_zone 须一起给（格式同 create_reminder）。
 * not_pending_or_conflict 表示状态或版本已变，需重新查询。成功后 revision 会变。
 */
function update_reminder(_: { id: ReminderId; revision: number; text?: string; due_at?: string; time_zone?: string }): ReminderStored | Failure;`,
    types: REMINDER_TYPES,
  },
  cancel_reminder: {
    summary: '取消一条待发送的提醒。',
    ts: `/** 取消 pending 提醒，id 与 revision 取自最近的提醒结果；不撤回已发消息。 */
function cancel_reminder(_: { id: ReminderId; revision: number }): ReminderStored | Failure;`,
    types: REMINDER_TYPES,
  },
  execute_javascript: {
    summary: '在隔离的JavaScript沙箱中执行代码。',
    ts: `/**
 * code 是 async 函数体（最多65536字节），必须 return 字符串（结构化结果自行 JSON.stringify）；description 写用途（最多1024字节）。
 * 无文件、网络、环境变量、Intl、setTimeout；console.log 等只接受字符串，输出进 logs。
 * 代码内 await tools.<name>(_) 调用工具，参数与结果相同，失败返回 status 结果、不抛异常。
 * 代码内不可用：finish、manage_attention、get_wake_state、execute_javascript。
 * 代码内字节字段可传 Uint8Array；view_images、view_custom_face 返回 RGBA 像素。
 * 代码内调用不占本轮工具调用次数，最多8个在途。
 * mode：sync 等 wait_ms 毫秒（含排队与启动）后终止；auto 等 wait_ms 后转后台；async 立即返回。
 * pending 的结果完成后另起一次唤醒送达，不必轮询。
 * 失败时看 error 与 diagnostic 修代码。
 */
function execute_javascript(
  _:
    | { description: string; code: string; mode: 'sync' | 'auto'; wait_ms: number }
    | { description: string; code: string; mode: 'async' },
):
  | { status: 'pending'; job_id: JobId }
  | { status: 'ok'; task_status: 'completed'; job_id: JobId; value: string; logs: string[]; diagnostic?: JsDiagnostic; tool_calls?: ToolCallSummary }
  | {
      status: 'error';
      task_status: 'failed' | 'cancelled' | 'interrupted' | 'timeout';
      job_id?: JobId;
      error: string;
      logs: string[];
      diagnostic?: JsDiagnostic;
      tool_calls?: ToolCallSummary;
    }
  | Failure;`,
    types: {
      JobId: JOB_ID,
      JsDiagnostic: JS_DIAGNOSTIC,
      ToolCallSummary: TOOL_CALL_SUMMARY,
    },
  },
  query_javascript_jobs: {
    summary: '查询本群的JavaScript沙箱任务。',
    ts: `/**
 * 不给 job_id 时列出概要（默认只列活动中和未交付的），limit 1至100，默认20。
 * 给 job_id 时返回详情；再给 calls_offset 附带代码内工具调用明细（每页100条）。
 */
function query_javascript_jobs(_: { job_id?: JobId; status?: JobStatus; offset?: number; limit?: number; calls_offset?: number }):
  | { status: 'ok'; jobs: JobSummary[]; offset: number; has_more: boolean }
  | {
      status: 'ok';
      job: Job;
      calls?: { seq: number; tool: string; status: 'ok' | 'error' | 'unknown' | 'confirmation_required'; error?: string; ids?: Record<string, string>; args_bytes: number; duration_ms: number }[];
      calls_has_more?: boolean;
    }
  | Failure;`,
    types: JOB_TYPES,
  },
  cancel_javascript_job: {
    summary: '取消本群的一个JavaScript任务。',
    ts: `/** 取消排队或运行中的任务；已结束的原样返回。 */
function cancel_javascript_job(_: { job_id: JobId }): { status: 'ok'; job: Job } | Failure;`,
    types: JOB_TYPES,
  },
  web_search: {
    summary: '搜索网页。',
    ts: `/**
 * queries 1至4个，每个最多512字节；合并去重后最多10个来源，全文用 web_fetch。
 * truncated 表示还有来源未列出；failed_queries 是失败的查询数。
 */
function web_search(_: { queries: string[] }): {
  status: 'ok';
  sources: { url: string; title: string; snippet?: string; published_at?: string }[];
  truncated: boolean;
  failed_queries?: number;
} | Failure;`,
  },
  web_fetch: {
    summary: '读取一个公开网页的正文。',
    ts: `/**
 * 读取公开 http(s) 网页正文（Markdown），每次最多20000字符；truncated=true 时以 next_start 作 start 续读。
 * 跨站重定向不跟随，返回 redirect_to，要读需再调用。不能访问内网、本机或需登录的页面。
 */
function web_fetch(_: { url: string; start?: number }):
  | { status: 'ok'; url: string; http_status: number; redirect_to: string }
  | {
      status: 'ok';
      url: string;
      http_status: number;
      content_type: 'html' | 'text' | 'json' | 'xml';
      title?: string;
      content: string;
      total_chars: number;
      truncated: boolean;
      next_start?: number;
    }
  | Failure;`,
  },
  create_artifact: {
    summary: '把文本或字节保存为本群的产物。',
    ts: `/**
 * artifact_id 可交给 upload_group_file 等工具。单个最大64MiB；总容量满时返回 artifact_storage_full。
 * name 1至128字符，作显示名和上传文件名，不能含斜杠或控制字符；description 1至500字符，确认上传时展示给主人。
 * ttl_ms 1至86400000（24小时）。media_type 默认 application/octet-stream，不按内容推断。
 */
function create_artifact(_: {
  name: string;
  description: string;
  ttl_ms: number;
  /** 字符串按UTF-8；数组为0..255字节；Uint8Array 仅限沙箱内。 */
  content: string | number[] | Uint8Array;
  media_type?: string;
}): ({ status: 'ok' } & ArtifactInfo) | Failure;`,
    types: ARTIFACT_TYPES,
  },
  create_image: {
    summary: '把RGBA像素编码为图片产物。',
    ts: `/**
 * 可用 send_group_image 发送或 view_images 查看；jpeg 透明部分铺白。
 * width、height 各1至8192，pixels 按行排列，长度须为 width×height×4。name、description、ttl_ms 同 create_artifact。
 */
function create_image(_: {
  name: string;
  description: string;
  ttl_ms: number;
  width: number;
  height: number;
  /** 0..255 字节；Uint8Array 仅限沙箱内。 */
  pixels: number[] | Uint8Array;
  format: 'png' | 'jpeg' | 'webp';
}): ({ status: 'ok'; width: number; height: number } & ArtifactInfo) | Failure;`,
    types: ARTIFACT_TYPES,
  },
  list_artifacts: {
    summary: '列出本群未过期的产物。',
    ts: `/** 从新到旧；limit 1至100，默认20。 */
function list_artifacts(_: { offset?: number; limit?: number }): { status: 'ok'; artifacts: ArtifactInfo[]; has_more: boolean } | Failure;`,
    types: ARTIFACT_TYPES,
  },
};
