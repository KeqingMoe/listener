import type { Brand } from './brand';

export type UnixTime = Brand<number, 'UnixTime'>;
export type UserId = Brand<string, 'UserId'>;
export type GroupId = Brand<string, 'GroupId'>;
export type MessageId = Brand<number, 'MessageId'>;
export type GapId = Brand<number, 'GapId'>;

export function UnixTime(n: number): UnixTime | undefined {
  if (!Number.isInteger(n)) {
    return;
  }
  return n as UnixTime;
}

export function UserId(value: string): UserId | undefined {
  if (!/^[1-9]\d*$/.test(value)) {
    return;
  }
  return value as UserId;
}

export function GroupId(value: string): GroupId | undefined {
  if (!/^[1-9]\d*$/.test(value)) {
    return;
  }
  return value as GroupId;
}

export function GapId(value: number): GapId | undefined {
  if (!Number.isInteger(value) || value < 0) {
    return;
  }
  return value as GapId;
}

export function MessageId(value: number): MessageId | undefined {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    return;
  }
  return value as MessageId;
}

function digits(value: number | string): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    return value;
  }
  return undefined;
}

export function userId(value: number | string): UserId | undefined {
  const id = digits(value);
  return id === undefined ? undefined : UserId(id);
}

export function groupId(value: number | string): GroupId | undefined {
  const id = digits(value);
  return id === undefined ? undefined : GroupId(id);
}

export function messageId(value: number | string): MessageId | undefined {
  if (typeof value === 'number') {
    return MessageId(value);
  }
  if (!/^(0|-?[1-9]\d{0,15})$/.test(value)) {
    return;
  }
  return MessageId(Number(value));
}
