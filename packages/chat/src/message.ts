import type { GroupMessage, SendMessageSegment } from 'node-napcat-ts';
import { Structs } from 'node-napcat-ts';
import type { MessageCreated, Segment, Send } from './event';
import { type MessageId, messageId, userId as toUserId, UnixTime } from './id';

export function read(event: GroupMessage): MessageCreated | undefined {
  const userId = toUserId(event.user_id);
  const id = messageId(event.message_id);
  const ts = UnixTime(Math.floor(event.time));
  if (userId === undefined || id === undefined || ts === undefined) {
    return;
  }

  let replyTo: MessageId | undefined;
  const segments: Segment[] = [];
  for (const segment of event.message) {
    switch (segment.type) {
      case 'reply':
        replyTo ??= messageId(segment.data.id);
        break;
      case 'text':
        segments.push({ type: 'text', text: segment.data.text });
        break;
      case 'at': {
        if (segment.data.qq === 'all') {
          segments.push({ type: 'at.all' });
          break;
        }
        const atId = toUserId(segment.data.qq);
        if (atId === undefined) {
          segments.push({ type: 'unsupported' });
        } else {
          segments.push({ type: 'at', userId: atId });
        }
        break;
      }
      default:
        segments.push({ type: 'unsupported' });
    }
  }

  return {
    type: 'message.created',
    msgId: id,
    ts,
    userId,
    segments,
    replyTo,
  };
}

export function write(message: Send): SendMessageSegment[] {
  const napcat: SendMessageSegment[] = [];
  if (message.replyTo !== undefined) {
    napcat.push(Structs.reply(message.replyTo));
  }
  for (const segment of message.segments) {
    switch (segment.type) {
      case 'text':
        napcat.push(Structs.text(segment.text));
        break;
      case 'at':
        napcat.push(Structs.at(segment.userId));
        break;
      case 'at.all':
        napcat.push(Structs.at('all'));
        break;
      case 'unsupported':
        break;
    }
  }
  return napcat;
}
