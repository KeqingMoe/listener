import { canonicalMessageId } from '../onebot/identity.ts';
import type {
  ImageReference,
  MessageSegment,
  TimelineEntry,
} from '../contracts/messages.ts';
import { type JsonObject, isDataObject } from '../contracts/json.ts';
import type { ForwardReference } from '../contracts/messages.ts';
import { FACE_CATALOG } from '../onebot/catalog/faces.ts';

interface MessageContent {
  segments: MessageSegment[];
  segments_omitted?: number;
  content_truncated?: boolean;
}

const MAX_SEGMENTS = 128,
  MAX_TEXT = 4000,
  MAX_CONTENT = 16000,
  MAX_REFS = 3,
  MAX_LEGACY_TEXT = 16384,
  MAX_LEGACY_CONTENT = 100000;
const faces = new Map(FACE_CATALOG.map((face) => [face.id, face.name]));

function array(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function item(values: unknown[], index: number): unknown {
  try {
    const d = Object.getOwnPropertyDescriptor(values, String(index));
    return d && Object.hasOwn(d, 'value') ? d.value : undefined;
  } catch {
    return undefined;
  }
}

function numeric(value: unknown, positive = false): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      return;
    }
    value = String(value);
  }
  if (
    typeof value !== 'string' ||
    value.length > 33 ||
    value.trim() !== value ||
    !(positive ? /^[1-9][0-9]{0,31}$/ : /^(0|[1-9][0-9]{0,31})$/).test(value)
  ) {
    return;
  }
  return value;
}

function faceId(value: unknown): string | undefined {
  const id = numeric(value);
  return id && id.length <= 16 && Number.isSafeInteger(Number(id))
    ? id
    : undefined;
}

function kind(value: unknown): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(value)
    ? value
    : 'unknown';
}

function safeRefs(
  messageId: string,
  images: unknown,
  forwards: unknown,
): { images: ImageReference[]; forwards: ForwardReference[] } {
  const output: { images: ImageReference[]; forwards: ForwardReference[] } = {
    images: [],
    forwards: [],
  };
  if (canonicalMessageId(messageId) !== messageId) {
    return output;
  }
  for (const [values, prefix, dest] of [
    [images, 'img', output.images],
    [forwards, 'fwd', output.forwards],
  ] as const) {
    if (!array(values)) {
      continue;
    }
    const seen = new Set<string>();
    for (
      let i = 0;
      i < Math.min(values.length, MAX_SEGMENTS) &&
      (prefix === 'img' || dest.length < MAX_REFS);
      i++
    ) {
      const ref = item(values, i);
      if (
        !isDataObject(ref) ||
        !Number.isInteger(ref.index) ||
        (ref.index as number) < 0 ||
        (ref.index as number) >= MAX_SEGMENTS ||
        ref.id !== `${prefix}_${messageId}_${ref.index}` ||
        seen.has(ref.id as string)
      ) {
        continue;
      }
      const value: ForwardReference = {
        id: ref.id as string,
        index: ref.index as number,
      };
      if (
        prefix === 'fwd' &&
        typeof ref.count === 'number' &&
        Number.isSafeInteger(ref.count) &&
        ref.count >= 0 &&
        ref.count <= 1000 &&
        (ref.countSource === 'verified' ||
          (ref.countSource === 'hint' && ref.count > 0))
      ) {
        value.count = ref.count;
        value.countSource = ref.countSource;
      }
      dest.push(value);
      seen.add(value.id);
    }
  }
  return output;
}

function media(
  type: 'image' | 'forward',
  ref: ImageReference | ForwardReference | undefined,
): MessageSegment {
  if (type === 'image') {
    return {
      type,
      content_status: 'not_viewed',
      ...(ref ? { image_id: ref.id } : { reason: 'reference_unavailable' }),
    };
  }
  const forward = ref as ForwardReference | undefined;
  return {
    type,
    content_status: 'not_read',
    ...(forward
      ? {
          forward_id: forward.id,
          ...(forward.count !== undefined
            ? { count: forward.count, count_source: forward.countSource }
            : {}),
        }
      : { reason: 'reference_unavailable' }),
  };
}

function part(
  value: unknown,
  index: number,
  wire: boolean,
  refs: ReturnType<typeof safeRefs>,
): { segment: MessageSegment; lost: boolean } {
  if (!isDataObject(value)) {
    return { segment: { type: 'unsupported', kind: 'unknown' }, lost: true };
  }
  const type = kind(value.type),
    data = wire ? (isDataObject(value.data) ? value.data : undefined) : value;
  const bad = () => ({
    segment: { type: 'unsupported' as const, kind: type },
    lost: true,
  });
  if (type === 'unsupported' && !wire) {
    return {
      segment: { type: 'unsupported', kind: kind(value.kind) },
      lost: false,
    };
  }
  if (type === 'record') {
    return {
      segment: { type: 'record', content_status: 'not_transcribed' },
      lost: false,
    };
  }
  if (type === 'image') {
    return {
      segment: media(
        'image',
        refs.images.find((ref) =>
          wire ? ref.index === index : ref.id === value.image_id,
        ),
      ),
      lost: false,
    };
  }
  if (
    type === 'forward' ||
    (wire &&
      type === 'json' &&
      refs.forwards.some((ref) => ref.index === index))
  ) {
    return {
      segment: media(
        'forward',
        refs.forwards.find((ref) =>
          wire ? ref.index === index : ref.id === value.forward_id,
        ),
      ),
      lost: false,
    };
  }
  if (!data) {
    return bad();
  }
  if (type === 'text') {
    return typeof data.text === 'string'
      ? { segment: { type, text: data.text }, lost: false }
      : bad();
  }
  if (type === 'face') {
    const id = faceId(data.id);
    if (!id) {
      return bad();
    }
    const name = faces.get(id);
    return { segment: { type, id, ...(name ? { name } : {}) }, lost: false };
  }
  if (type === 'at') {
    const id = wire ? data.qq : data.user_id;
    const user_id = id === 'all' ? 'all' : numeric(id, true);
    return user_id ? { segment: { type, user_id }, lost: false } : bad();
  }
  if (type === 'reply') {
    const message_id = canonicalMessageId(wire ? data.id : data.message_id);
    return message_id ? { segment: { type, message_id }, lost: false } : bad();
  }
  return bad();
}

function size(value: unknown): number {
  return JSON.stringify(value).length;
}

function clip(text: string, count: number): string {
  let end = Math.min(text.length, Math.max(0, count));
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) {
    end--;
  }
  return text.slice(0, end);
}

function prefix(text: string, maximum: number, maxChars = MAX_TEXT): string {
  let low = 0,
    high = Math.min(text.length, maxChars);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(text.slice(0, mid)) <= maximum) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  // 截断边界处不能留下未配对的高位代理项。
  if (low < text.length && low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1]!)) {
    low--;
  }
  return text.slice(0, low);
}

/** 按序列化大小预算只取段的前缀，使内容不完整时占用的空间保持单调；截断或省略会如实标记。 */
function bound(
  segments: readonly MessageSegment[],
  maximum: number,
  priorOmitted = 0,
  priorTruncated = false,
): MessageContent {
  const budget = Math.max(
    0,
    Math.min(
      MAX_CONTENT,
      Number.isFinite(maximum)
        ? Math.floor(maximum)
        : maximum === Infinity
          ? MAX_CONTENT
          : 0,
    ),
  );
  const output: MessageSegment[] = [];
  let omitted = priorOmitted,
    changed = priorTruncated || budget === 0,
    textChars = 0,
    used = 2;
  for (let i = 0; i < segments.length; i++) {
    let segment = segments[i]!;
    if (segment.type === 'text') {
      const text = clip(segment.text, Math.max(0, MAX_TEXT - textChars));
      if (text !== segment.text) {
        changed = true;
        if (!text && segment.text) {
          omitted++;
          continue;
        }
      }
      segment = { type: 'text', text };
    }
    const comma = output.length ? 1 : 0,
      addition = comma + size(segment);
    if (used + addition <= budget) {
      output.push(segment);
      used += addition;
      if (segment.type === 'text') {
        textChars += segment.text.length;
      }
      continue;
    }
    changed = true;
    if (segment.type === 'text') {
      const overhead = used + comma + size({ type: 'text', text: '' }) - 2;
      const text = prefix(segment.text, budget - overhead);
      if (text) {
        output.push({ type: 'text', text });
        omitted += segments.length - i - 1;
        break;
      }
    }
    omitted += segments.length - i;
    break;
  }
  return {
    segments: output,
    ...(omitted > 0 ? { segments_omitted: omitted } : {}),
    ...(changed || omitted > 0 ? { content_truncated: true } : {}),
  };
}

function content(
  messageId: string,
  values: unknown[],
  wire: boolean,
  images: unknown,
  forwards: unknown,
): MessageContent {
  const refs = safeRefs(messageId, images, forwards),
    segments: MessageSegment[] = [];
  let omitted = Math.max(0, values.length - MAX_SEGMENTS);
  for (let i = 0; i < Math.min(values.length, MAX_SEGMENTS); i++) {
    const parsed = part(item(values, i), i, wire, refs);
    segments.push(parsed.segment);
    if (parsed.lost) {
      omitted++;
    }
  }
  return bound(segments, MAX_CONTENT, omitted, omitted > 0);
}

/** 只解释真实的OneBot段结构；文本（包括形似CQ码或标记的内容）保持字面原样。 */
export function extractMessageContent(
  messageId: string,
  wire: unknown,
  images: readonly ImageReference[] = [],
  forwards: readonly ForwardReference[] = [],
): MessageContent {
  if (typeof wire === 'string') {
    return bound([{ type: 'text', text: wire }], MAX_CONTENT);
  }
  if (!array(wire)) {
    return {
      segments: [{ type: 'unsupported', kind: 'unknown' }],
      segments_omitted: 1,
      content_truncated: true,
    };
  }
  return content(messageId, wire, true, images, forwards);
}

/** 从安全字段重建已持久化的content。没有段数组即表示旧格式纯文本，不会触发转换。 */
export function sanitizeMessageContent(
  messageId: string,
  value: unknown,
  images: readonly ImageReference[] = [],
  forwards: readonly ForwardReference[] = [],
): MessageContent | undefined {
  return array(value)
    ? content(messageId, value, false, images, forwards)
    : undefined;
}

/** 模型侧有界投影；内部引用表示不变，输出仅使用顶层 reply_to。 */
export function projectMessage(
  entry: TimelineEntry,
  limit = Infinity,
): JsonObject {
  const source: JsonObject = isDataObject(entry)
    ? (entry as unknown as JsonObject)
    : {};
  const projected: JsonObject = {};
  for (const field of ['messageId', 'userId'] as const) {
    if (
      typeof source[field] === 'string' &&
      (source[field] as string).length <= 256
    ) {
      projected[field] = source[field];
    }
  }
  if (typeof source.nickname === 'string') {
    projected.nickname = clip(source.nickname, 256);
  }
  if (typeof source.time === 'number' && Number.isFinite(source.time)) {
    projected.time = source.time;
  }
  if (
    typeof source.replyTo === 'string' &&
    canonicalMessageId(source.replyTo) === source.replyTo
  ) {
    projected.reply_to = source.replyTo;
  }
  if (typeof source.bot === 'boolean') {
    projected.bot = source.bot;
  }
  const messageId =
    typeof source.messageId === 'string' ? source.messageId : '';
  const refs = safeRefs(messageId, source.images, source.forwards);
  if (array(source.images)) {
    projected.images = refs.images;
  }
  if (array(source.forwards)) {
    projected.forwards = refs.forwards;
  }
  const normalized = sanitizeMessageContent(
    messageId,
    source.segments,
    refs.images,
    refs.forwards,
  );
  if (normalized) {
    const storedOmitted =
      typeof source.segments_omitted === 'number' &&
      Number.isSafeInteger(source.segments_omitted) &&
      source.segments_omitted > 0
        ? source.segments_omitted
        : 0;
    const result = bound(
      normalized.segments.filter((segment) => segment.type !== 'reply'),
      limit,
      Math.min(
        Number.MAX_SAFE_INTEGER,
        storedOmitted + (normalized.segments_omitted ?? 0),
      ),
      source.content_truncated === true ||
        normalized.content_truncated === true,
    );
    return { ...projected, representation: 'segments', ...result };
  }
  const original = typeof source.text === 'string' ? source.text : '';
  const budget = Math.max(
    0,
    Math.min(
      MAX_LEGACY_CONTENT,
      Number.isFinite(limit)
        ? Math.floor(limit)
        : limit === Infinity
          ? MAX_LEGACY_CONTENT
          : 0,
    ),
  );
  const text = prefix(original, budget, MAX_LEGACY_TEXT);
  return {
    ...projected,
    representation: 'legacy_text',
    text,
    ...(text !== original ||
    source.text_truncated === true ||
    source.content_truncated === true ||
    budget === 0
      ? { text_truncated: true }
      : {}),
  };
}
