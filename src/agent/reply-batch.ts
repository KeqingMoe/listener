import { resolveOwnerId } from '../contracts/identity.ts';
import { type TimelineEntry } from '../contracts/messages.ts';
import { type TurnContext } from '../contracts/tools.ts';
import { newTraceId } from '../observability/logger.ts';
import type { AttentionHit } from './attention.ts';

export interface BatchItem {
  entry: TimelineEntry;
  context: TurnContext;
  sequence: number;
  worldSequence?: number;
  received: number;
  trigger?: 'mention' | 'quote';
  unverifiedQuote?: boolean;
}

const MAX_ITEMS = 64;
const copy = <T>(value: T): T => structuredClone(value);

/**
 * 一个turn待处理的消息批次，只负责按到达顺序保存和有界保留。调度、随机抽取和日志
 * 由Listener负责。满64条时优先淘汰普通消息，保留触发消息（@或引用）。
 */
export class ReplyBatch {
  readonly turnId = newTraceId();
  items: BatchItem[] = [];
  openedAt: number;
  readyAt: number;
  randomSelected: boolean;
  readonly attentionHits: AttentionHit[] = [];
  omittedAttentionHits = 0;
  addAttention(hits: readonly AttentionHit[]): void {
    for (const hit of hits) {
      if (
        this.attentionHits.some((previous) => previous.plan_id === hit.plan_id)
      ) {
        continue;
      }
      if (this.attentionHits.length >= 64) {
        this.omittedAttentionHits++;
        continue;
      }
      this.attentionHits.push(copy(hit));
    }
  }

  omittedMessages = 0;
  omittedDirect = 0;
  hasNonOwnerDirect = false;
  private readonly seen = new Set<string>();
  private firstDirectSequence = Infinity;

  private readonly ownerId: string;
  constructor(
    item: BatchItem,
    delayMs: number,
    randomSelected = false,
    ownerId: string,
  ) {
    this.ownerId = resolveOwnerId(ownerId);
    this.openedAt = item.received;
    this.readyAt = item.received + delayMs;
    this.randomSelected = randomSelected;
    this.add(item, delayMs);
  }

  add(item: BatchItem, delayMs: number): void {
    if (item.trigger && item.entry.userId !== this.ownerId) {
      this.hasNonOwnerDirect = true;
    }
    if (
      this.seen.has(item.entry.messageId) ||
      this.items.some(
        (existing) => existing.entry.messageId === item.entry.messageId,
      )
    ) {
      return;
    }
    this.seen.add(item.entry.messageId);
    // 传输层去重由Listener的memory负责，这里只保留有界的本地FIFO。
    if (this.seen.size > 256) {
      this.seen.delete(this.seen.values().next().value!);
    }
    this.openedAt = Math.min(this.openedAt, item.received);
    if (item.trigger && item.sequence < this.firstDirectSequence) {
      this.readyAt =
        this.firstDirectSequence === Infinity
          ? item.received + delayMs
          : Math.min(this.readyAt, item.received + delayMs);
      this.firstDirectSequence = item.sequence;
    }
    if (this.items.length === MAX_ITEMS) {
      const ordinary = this.items.findIndex((existing) => !existing.trigger);
      this.omittedMessages++;
      if (ordinary < 0) {
        if (!item.trigger) {
          return;
        }
        this.omittedDirect++;
        // 引用查询较慢时，先到达的消息可能后加入批次。
        // 按到达序号保留最早的消息，而不是最先完成查询的消息。
        if (item.sequence >= this.items[this.items.length - 1]!.sequence) {
          return;
        }
        this.items.pop();
      } else {
        if (!item.trigger && item.sequence <= this.items[ordinary]!.sequence) {
          return;
        }
        this.items.splice(ordinary, 1);
      }
    }
    this.items.push(copy(item));
    this.items.sort((a, b) => a.sequence - b.sequence);
  }

  get direct(): BatchItem[] {
    return this.items.filter((item) => item.trigger);
  }

  get kind(): 'direct' | 'attention' | 'random' {
    return this.direct.length
      ? 'direct'
      : this.attentionHits.length
        ? 'attention'
        : 'random';
  }

  get primary(): BatchItem {
    return this.direct[0] ?? this.items[this.items.length - 1]!;
  }
}
