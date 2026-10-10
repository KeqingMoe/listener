import type { Client } from './client';
import type {
  ChatEvent,
  Event,
  MessageCreated,
  Send,
  UnreadGap,
} from './event';
import { GapId, type GroupId, type MessageId, type UserId } from './id';

export type ChatIdentity = {
  selfId: UserId;
  groupId: GroupId;
};

export type ReadEventsQuery = {
  gapId: GapId;
  side: 'earliest' | 'latest';
  limit: number;
};

export const chatError = {
  notNatural: '必须是自然数',
  missing: '找不到缺口',
} as const;

export type Mentioned = {
  at: boolean;
  reply: boolean;
};

function hit(mentioned: Mentioned): boolean {
  return mentioned.at || mentioned.reply;
}

type Item = {
  event: ChatEvent;
  mentioned: Mentioned;
};

type Gap = {
  items: Item[];
  mentioned: number;
};

function emptyGap(): Gap {
  return { items: [], mentioned: 0 };
}

type TakeResult = { events: ChatEvent[]; rest?: Gap };

function take(gap: Gap): { events: ChatEvent[] };
function take(gap: Gap, query: Omit<ReadEventsQuery, 'gapId'>): TakeResult;
function take(gap: Gap, query?: Omit<ReadEventsQuery, 'gapId'>): TakeResult {
  const { items } = gap;
  const { side = 'latest', limit = items.length } = query ?? {};
  const n = Math.min(limit, items.length);
  if (n === items.length) {
    return { events: items.map(item => item.event) };
  }
  const taken =
    side === 'earliest' ? items.slice(0, n) : items.slice(items.length - n);
  const restItems =
    side === 'earliest' ? items.slice(n) : items.slice(0, items.length - n);
  let mentioned = 0;
  for (const item of restItems) {
    if (hit(item.mentioned)) {
      mentioned += 1;
    }
  }
  return {
    events: taken.map(item => item.event),
    rest: { items: restItems, mentioned },
  };
}

export type ChatHandler = (payload: {
  event: ChatEvent;
  mentioned: Mentioned;
}) => void;

export class Chat {
  readonly selfId: UserId;
  readonly groupId: GroupId;
  readonly client: Client;
  #unread: Gap = emptyGap();
  // 缺口一直留着，压缩再收。
  #gaps = new Map<GapId, Gap>();
  #nextGap = 0;
  #handlers = new Set<ChatHandler>();
  #unwatch: () => void;

  constructor(identity: ChatIdentity, client: Client) {
    this.selfId = identity.selfId;
    this.groupId = identity.groupId;
    this.client = client;
    this.#unwatch = client.watch(this.groupId, this.append.bind(this));
  }

  on(handler: ChatHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  dispose(): void {
    this.#unwatch();
    this.#handlers.clear();
  }

  async append(event: ChatEvent): Promise<void> {
    if (event.type !== 'message.created') {
      return;
    }
    const mentioned = await this.#mentioned(event);
    this.#unread.items.push({ event, mentioned });
    if (hit(mentioned)) {
      this.#unread.mentioned += 1;
    }
    for (const handler of this.#handlers) {
      handler({ event, mentioned });
    }
  }

  send(message: Send): Promise<MessageId> {
    return this.client.send(this.groupId, message);
  }

  // 整袋拿走，不留缺口。
  openWindow(): ChatEvent[];
  // 最新 n 条给模型；更早的变成一条 gap 放在最前。
  openWindow(n: number): Event[];
  openWindow(n?: number): Event[] {
    if (n === undefined) {
      return take(this.#takeUnread()).events;
    }
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(chatError.notNatural);
    }
    const { events, rest } = take(this.#takeUnread(), {
      side: 'latest',
      limit: n,
    });
    if (rest === undefined) {
      return events;
    }
    return [this.#putGap(rest), ...events];
  }

  // 点开一条 gap：从最早或最晚揭 limit 条。没揭完再挂一条新 gap。
  readEvents(query: ReadEventsQuery): Event[] {
    if (!Number.isInteger(query.limit) || query.limit < 0) {
      throw new Error(chatError.notNatural);
    }
    const gap = this.#gaps.get(query.gapId);
    if (gap === undefined) {
      throw new Error(chatError.missing);
    }
    const { events, rest } = take(gap, query);
    if (rest === undefined) {
      return events;
    }
    const leftover = this.#putGap(rest);
    return query.side === 'earliest'
      ? [...events, leftover]
      : [leftover, ...events];
  }

  #takeUnread(): Gap {
    const unread = this.#unread;
    this.#unread = emptyGap();
    return unread;
  }

  async #mentioned(event: MessageCreated): Promise<Mentioned> {
    const at = event.segments.some(
      segment =>
        segment.type === 'at.all' ||
        (segment.type === 'at' && segment.userId === this.selfId),
    );
    if (event.replyTo === undefined) {
      return { at, reply: false };
    }
    const orig = await this.client.message(event.replyTo);
    return { at, reply: orig?.userId === this.selfId };
  }

  #putGap(gap: Gap): UnreadGap {
    const gapId = GapId(this.#nextGap);
    this.#nextGap += 1;
    if (gapId === undefined) {
      throw new Error(chatError.missing);
    }
    this.#gaps.set(gapId, gap);
    return {
      type: 'gap',
      gapId,
      skipped: gap.items.length,
      mentioned: gap.mentioned > 0,
    };
  }
}
