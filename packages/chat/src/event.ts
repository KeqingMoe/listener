import type { GapId, MessageId, UnixTime, UserId } from './id';

export type TextSegment = {
  type: 'text';
  text: string;
};

export type AtSegment = {
  type: 'at';
  userId: UserId;
};

export type AtAllSegment = {
  type: 'at.all';
};

export type UnsupportedSegment = {
  type: 'unsupported';
};

export type Segment =
  | TextSegment
  | AtSegment
  | AtAllSegment
  | UnsupportedSegment;

export type MessageCreated = {
  type: 'message.created';
  msgId: MessageId;
  ts: UnixTime;
  userId: UserId;
  replyTo?: MessageId;
  segments: Segment[];
};

export type UnreadGap = {
  type: 'gap';
  gapId: GapId;
  skipped: number;
  mentioned: boolean;
};

export type Send = {
  segments: Segment[];
  replyTo?: MessageId;
};

export type ChatEvent = MessageCreated;

export type Event = ChatEvent | UnreadGap;
