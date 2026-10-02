import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolveGroupId } from '../contracts/identity.ts';
import { isPlainObject } from '../contracts/json.ts';
import type { TimelineEntry } from '../contracts/messages.ts';
import { immediate } from '../storage/transaction.ts';

import {
  type EventPage,
  type EventSource,
  type MessageCreatedPayload,
  type MessagePage,
  type MessageRecalledPayload,
  type MessageView,
  type ProjectedWorldEvent,
  type ReadEventsInput,
  type StoredRow,
  type WorldEvent,
  type WorldEventInput,
  type WorldEventType,
  type WorldState,
} from './event-types.ts';
import {
  allowedTypes,
  eventFrom,
  finiteTime,
  nowSeconds,
  safeJson,
  subjectFor,
  text,
  validateMessage,
  validatePayload,
} from './event-validation.ts';

export class WorldEventStore {
  private readonly db: DatabaseSync;
  readonly groupId: string;
  private readonly retentionDays: number;
  private closed = false;
  constructor(options: {
    path: string;
    groupId: string;
    retentionDays?: number;
  }) {
    this.groupId = resolveGroupId(options.groupId);
    this.retentionDays = options.retentionDays ?? 30;
    if (
      !Number.isFinite(this.retentionDays) ||
      this.retentionDays <= 0 ||
      this.retentionDays > 3650
    ) {
      throw new Error('Invalid event retention');
    }
    if (!text(options.path, 4096)) {
      throw new Error('Invalid event store path');
    }
    if (options.path !== ':memory:') {
      const fd = openSync(
        options.path,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1) {
          throw new Error('Invalid event store file');
        }
        if (info.size > 0) {
          const probe = new DatabaseSync(options.path, { readOnly: true });
          try {
            const identity = probe
              .prepare('SELECT group_id FROM world_identity WHERE singleton=1')
              .get();
            if (identity?.group_id !== this.groupId) {
              throw new Error('Event store group mismatch');
            }
          } finally {
            probe.close();
          }
        }
        const current = lstatSync(options.path);
        if (
          current.isSymbolicLink() ||
          current.ino !== info.ino ||
          current.dev !== info.dev
        ) {
          throw new Error('Event store file changed');
        }
        fchmodSync(fd, 0o600);
      } finally {
        closeSync(fd);
      }
    }
    this.db = new DatabaseSync(options.path);
    try {
      this.db.exec(
        'PRAGMA busy_timeout=3000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS world_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), group_id TEXT NOT NULL);',
      );
      this.db
        .prepare('INSERT OR IGNORE INTO world_identity VALUES(1,?)')
        .run(this.groupId);
      const identity = this.db
        .prepare('SELECT group_id FROM world_identity WHERE singleton=1')
        .get() as { group_id?: string } | undefined;
      if (identity?.group_id !== this.groupId) {
        throw new Error('Event store group mismatch');
      }
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS world_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, type TEXT NOT NULL, group_id TEXT NOT NULL, occurred_at REAL, observed_at REAL NOT NULL, actor_id TEXT, subject_kind TEXT, subject_id TEXT, payload TEXT NOT NULL, source TEXT NOT NULL, verified INTEGER NOT NULL, dedup_key TEXT UNIQUE);
        CREATE INDEX IF NOT EXISTS world_events_type_seq ON world_events(type, sequence);
        CREATE INDEX IF NOT EXISTS world_events_observed ON world_events(observed_at);
        CREATE TABLE IF NOT EXISTS world_messages (message_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, entry TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS world_observers (consumer TEXT PRIMARY KEY, sequence INTEGER NOT NULL); COMMIT;`);
      this.prune();
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      this.db.close();
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Event store is closed');
    }
  }

  private cutoff(now = nowSeconds()): number {
    return now - this.retentionDays * 86400;
  }

  prune(now = nowSeconds()): number {
    this.ensureOpen();
    if (!finiteTime(now)) {
      throw new Error('Invalid prune time');
    }
    return immediate(this.db, () => {
      this.db
        .prepare(
          'DELETE FROM world_messages WHERE sequence IN (SELECT sequence FROM world_events WHERE observed_at < ?)',
        )
        .run(this.cutoff(now));
      const result = this.db
        .prepare('DELETE FROM world_events WHERE observed_at < ?')
        .run(this.cutoff(now));
      return Number(result.changes);
    });
  }

  append(input: WorldEventInput): WorldEvent {
    this.ensureOpen();
    safeJson(input);
    if (
      !isPlainObject(input) ||
      (input.groupId !== undefined && input.groupId !== this.groupId) ||
      !allowedTypes.has(input.type) ||
      !validatePayload(input.type, input.payload) ||
      !isPlainObject(input.provenance) ||
      Object.keys(input.provenance).some(
        (key) => !['source', 'verified'].includes(key),
      ) ||
      !['onebot', 'tool', 'migration'].includes(input.provenance.source)
    ) {
      throw new Error('Invalid world event');
    }
    if (
      !text(input.provenance.source, 16) ||
      typeof input.provenance.verified !== 'boolean' ||
      !finiteTime(input.observedAt) ||
      (input.occurredAt !== undefined && !finiteTime(input.occurredAt)) ||
      (input.actorId !== undefined && !text(input.actorId)) ||
      (input.subject !== undefined &&
        (!isPlainObject(input.subject) ||
          !text(input.subject.kind, 64) ||
          !text(input.subject.id)))
    ) {
      throw new Error('Invalid world event');
    }
    const eventId = input.eventId ?? `we_${randomUUID().replaceAll('-', '')}`;
    if (!text(eventId)) {
      throw new Error('Invalid event id');
    }
    const dedup =
      input.dedupKey ??
      (input.type === 'message.created'
        ? `message:${(input.payload as MessageCreatedPayload).message.messageId}`
        : undefined);
    if (dedup !== undefined && !text(dedup)) {
      throw new Error('Invalid dedup key');
    }
    const subject = subjectFor(input, this.groupId);
    if (
      input.subject &&
      (input.subject.kind !== subject.kind || input.subject.id !== subject.id)
    ) {
      throw new Error('Invalid event subject');
    }
    if (
      [
        'member.joined',
        'member.left',
        'group.ban_changed',
        'file.uploaded',
        'group.name_changed',
      ].includes(input.type)
    ) {
      const p = input.payload;
      const expectedActor =
        p.kind === 'file_uploaded'
          ? p.user_id
          : p.kind === 'member_joined' ||
              p.kind === 'member_left' ||
              p.kind === 'group_ban'
            ? p.operator_id
            : undefined;
      if (input.actorId !== undefined && input.actorId !== expectedActor) {
        throw new Error('Invalid event actor');
      }
    }
    const actorId =
      input.actorId ??
      (input.type === 'message.created'
        ? (input.payload as MessageCreatedPayload).message.userId
        : undefined);
    const payload = safeJson(input.payload);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing =
        ((input.type === 'message.created'
          ? this.db
              .prepare(
                'SELECT world_events.* FROM world_events JOIN world_messages USING(sequence) WHERE world_messages.message_id=?',
              )
              .get((input.payload as MessageCreatedPayload).message.messageId)
          : undefined) as StoredRow | undefined) ??
        (dedup
          ? (this.db
              .prepare('SELECT * FROM world_events WHERE dedup_key=?')
              .get(dedup) as StoredRow | undefined)
          : undefined);
      if (existing) {
        this.db.exec('COMMIT');
        return eventFrom(existing);
      }
      this.db
        .prepare(
          'INSERT INTO world_events(event_id,type,group_id,occurred_at,observed_at,actor_id,subject_kind,subject_id,payload,source,verified,dedup_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          eventId,
          input.type,
          this.groupId,
          input.occurredAt ?? null,
          input.observedAt,
          actorId ?? null,
          subject.kind,
          subject.id,
          payload,
          input.provenance.source,
          input.provenance.verified ? 1 : 0,
          dedup ?? null,
        );
      const row = this.db
        .prepare('SELECT * FROM world_events WHERE event_id=?')
        .get(eventId) as StoredRow;
      if (input.type === 'message.created') {
        this.db
          .prepare(
            'INSERT OR IGNORE INTO world_messages(message_id,sequence,entry) VALUES(?,?,?)',
          )
          .run(
            (input.payload as MessageCreatedPayload).message.messageId,
            row.sequence,
            JSON.stringify((input.payload as MessageCreatedPayload).message),
          );
      }
      this.db.exec('COMMIT');
      return eventFrom(row);
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }

  appendMessage(
    entry: TimelineEntry,
    options: {
      source: EventSource;
      observedAt?: number;
      occurredAt?: number;
      actorId?: string;
      verified?: boolean;
    } = { source: 'onebot' },
  ): WorldEvent {
    safeJson(entry);
    safeJson(options);
    if (!validateMessage(entry)) {
      throw new Error('Invalid message');
    }
    return this.append({
      type: 'message.created',
      observedAt: options.observedAt ?? nowSeconds(),
      occurredAt: options.occurredAt ?? entry.time,
      actorId: options.actorId ?? entry.userId,
      payload: { kind: 'message', message: structuredClone(entry) },
      provenance: {
        source: options.source,
        verified: options.verified ?? options.source !== 'migration',
      },
    });
  }

  appendRecall(
    messageId: string,
    options: {
      observedAt?: number;
      occurredAt?: number;
      actorId?: string;
      recalledBy?: string;
      verified?: boolean;
    } = {},
  ): WorldEvent {
    if (!text(messageId)) {
      throw new Error('Invalid message id');
    }
    return this.append({
      type: 'message.recalled',
      observedAt: options.observedAt ?? nowSeconds(),
      ...(options.occurredAt !== undefined
        ? { occurredAt: options.occurredAt }
        : {}),
      ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
      subject: { kind: 'message', id: messageId },
      payload: {
        kind: 'message_recalled',
        message_id: messageId,
        ...(options.recalledBy !== undefined
          ? { recalled_by: options.recalledBy }
          : {}),
      },
      provenance: { source: 'onebot', verified: options.verified ?? false },
      dedupKey: `recall:${messageId}:${options.recalledBy ?? ''}`,
    });
  }

  private latestSequence(): number {
    return Number(
      this.db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name='world_events'")
        .get()?.seq ?? 0,
    );
  }

  private where(
    input: ReadEventsInput,
    highWater: number,
  ): { sql: string; params: (string | number)[] } {
    if (
      !isPlainObject(input) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0
    ) {
      throw new Error('Invalid event limit');
    }
    if (
      Object.keys(input).some(
        (key) =>
          ![
            'limit',
            'after',
            'before',
            'highWater',
            'direction',
            'types',
            'actorId',
            'since',
            'until',
          ].includes(key),
      )
    ) {
      throw new Error('Invalid query field');
    }
    if (
      input.direction !== undefined &&
      !['forward', 'backward'].includes(input.direction)
    ) {
      throw new Error('Invalid direction');
    }
    for (const key of ['after', 'before', 'highWater'] as const) {
      if (
        input[key] !== undefined &&
        (!Number.isSafeInteger(input[key]) || input[key]! < 0)
      ) {
        throw new Error('Invalid cursor');
      }
    }
    if (
      input.highWater !== undefined &&
      input.highWater > this.latestSequence()
    ) {
      throw new Error('Invalid high water');
    }
    if (input.since !== undefined && !finiteTime(input.since)) {
      throw new Error('Invalid since');
    }
    if (input.until !== undefined && !finiteTime(input.until)) {
      throw new Error('Invalid until');
    }
    if (
      input.since !== undefined &&
      input.until !== undefined &&
      input.since > input.until
    ) {
      throw new Error('Invalid time range');
    }
    const conditions = ['group_id=?', 'sequence<=?'];
    const params: (string | number)[] = [this.groupId, highWater];
    if (input.after !== undefined) {
      conditions.push('sequence>?');
      params.push(input.after);
    }
    if (input.before !== undefined) {
      conditions.push('sequence<?');
      params.push(input.before);
    }
    if (input.types !== undefined) {
      if (
        !Array.isArray(input.types) ||
        input.types.length < 1 ||
        input.types.length > allowedTypes.size ||
        !input.types.every((type) => allowedTypes.has(type))
      ) {
        throw new Error('Invalid event types');
      }
      conditions.push(`type IN (${input.types.map(() => '?').join(',')})`);
      params.push(...input.types);
    }
    if (input.actorId !== undefined) {
      if (!text(input.actorId)) {
        throw new Error('Invalid actor');
      }
      conditions.push('actor_id=?');
      params.push(input.actorId);
    }
    if (input.since !== undefined) {
      conditions.push('observed_at>=?');
      params.push(input.since);
    }
    if (input.until !== undefined) {
      conditions.push('observed_at<=?');
      params.push(input.until);
    }
    return {
      sql: `SELECT * FROM world_events WHERE ${conditions.join(' AND ')} ORDER BY sequence ${input.direction === 'backward' ? 'DESC' : 'ASC'} LIMIT ?`,
      params: [
        ...params,
        input.limit < Number.MAX_SAFE_INTEGER ? input.limit + 1 : input.limit,
      ],
    };
  }

  /** sequence游标是受信任的内部值；公开工具必须把不透明游标与范围、过滤条件和方向绑定。 */
  readEvents(input: ReadEventsInput, maxBytes = 24_000): EventPage {
    return this.readPage(input, maxBytes, false) as EventPage;
  }

  /** Latest unread rows at a fixed cutoff; no read-position mutation. Newest first. */
  readUnreadEvents(
    limit: number,
    consumer: string,
    maxBytes = 12_000,
  ): EventPage & { unread: number } {
    return this.readPage(
      { limit, direction: 'backward' },
      maxBytes,
      false,
      consumer,
    ) as EventPage & { unread: number };
  }

  /** Group-scoped event anchor; never resolve an ID from another store/group. */
  findEventSequence(eventId: string): number | undefined {
    this.ensureOpen();
    if (!text(eventId)) {
      return undefined;
    }
    const row = this.db
      .prepare(
        'SELECT sequence FROM world_events WHERE event_id=? AND group_id=?',
      )
      .get(eventId, this.groupId);
    return row ? Number(row.sequence) : undefined;
  }

  readMessages(input: ReadEventsInput, maxBytes = 24_000): MessagePage {
    if (
      !isPlainObject(input) ||
      (input.types !== undefined &&
        (input.types.length !== 1 || input.types[0] !== 'message.created'))
    ) {
      throw new Error('Invalid message query');
    }
    return this.readPage(
      { ...input, types: ['message.created'] },
      maxBytes,
      true,
    ) as MessagePage;
  }

  private messageView(entry: TimelineEntry, highWater: number): MessageView {
    const view: MessageView = structuredClone(entry);
    const recall = this.db
      .prepare(
        "SELECT observed_at,occurred_at,payload FROM world_events WHERE type='message.recalled' AND subject_kind='message' AND subject_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(entry.messageId, highWater) as
      | { observed_at: number; occurred_at: number | null; payload: string }
      | undefined;
    if (recall) {
      const payload = JSON.parse(recall.payload) as MessageRecalledPayload;
      view.recalled = true;
      view.recalledAt = recall.occurred_at ?? recall.observed_at;
      if (payload.recalled_by !== undefined) {
        view.recalledBy = payload.recalled_by;
      }
    }
    return view;
  }

  private readPage(
    input: ReadEventsInput,
    maxBytes: number,
    messages: boolean,
    unreadConsumer?: string,
  ): EventPage | MessagePage {
    this.ensureOpen();
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 2048 ||
      maxBytes > 24_000
    ) {
      throw new Error('Invalid event output limit');
    }
    // 用一个短读事务让行数据、撤回投影和high water保持一致；
    // 之后的调用重新开始，除非调用方显式传入上一次的highWater。
    this.db.exec('BEGIN');
    try {
      const queriedAt = nowSeconds();
      const unreadState =
        unreadConsumer !== undefined
          ? this.getState(unreadConsumer)
          : undefined;
      if (unreadState) {
        input = {
          ...input,
          after: unreadState.observationWatermark,
          highWater: unreadState.latestSequence,
        };
      }
      const highWater = input?.highWater ?? this.latestSequence();
      const { sql, params } = this.where(input, highWater);
      const items: (ProjectedWorldEvent | MessageView)[] = [];
      let lastSequence: number | undefined,
        reason: 'output_limit' | 'limit' | undefined,
        hasMore = false;
      const frame = (values = items) => ({
        [messages ? 'messages' : 'events']: values,
        requested: input.limit,
        returned: values.length,
        truncated: true,
        reason: 'output_limit',
        nextCursor: Number.MAX_SAFE_INTEGER,
        lastSequence: Number.MAX_SAFE_INTEGER,
        highWater,
        queriedAt,
      });
      const fits = (item: ProjectedWorldEvent | MessageView) =>
        Buffer.byteLength(JSON.stringify(frame([...items, item])), 'utf8') <=
        maxBytes;
      for (const row of this.db
        .prepare(sql)
        .iterate(...params) as Iterable<StoredRow>) {
        if (items.length === input.limit) {
          hasMore = true;
          reason ??= 'limit';
          break;
        }
        const event = eventFrom(row);
        let item: ProjectedWorldEvent | MessageView = messages
          ? this.messageView(
              (event.payload as MessageCreatedPayload).message,
              highWater,
            )
          : event;
        if (!fits(item)) {
          if (items.length) {
            hasMore = true;
            reason = 'output_limit';
            break;
          }
          if (messages) {
            const view = item as MessageView;
            item = {
              messageId: view.messageId,
              userId: view.userId,
              nickname: view.nickname,
              time: view.time,
              text: '',
              content_truncated: true,
              payload_omitted: true,
              omission_reason: 'output_limit',
              ...(view.recalled
                ? {
                    recalled: true,
                    recalledAt: view.recalledAt,
                    ...(view.recalledBy ? { recalledBy: view.recalledBy } : {}),
                  }
                : {}),
            };
          } else {
            item = {
              ...event,
              payload: null,
              payload_omitted: true,
              omission_reason: 'output_limit',
            };
          }
          if (!fits(item)) {
            throw new Error('Event metadata exceeds output limit');
          }
          reason = 'output_limit';
        }
        items.push(item);
        lastSequence = row.sequence;
      }
      const metadata = {
        ...(unreadState ? { unread: unreadState.unreadEvents } : {}),
        requested: input.limit,
        returned: items.length,
        truncated: reason !== undefined,
        ...(reason ? { reason } : {}),
        ...(hasMore && lastSequence !== undefined
          ? { nextCursor: lastSequence }
          : {}),
        ...(lastSequence !== undefined ? { lastSequence } : {}),
        highWater,
        queriedAt,
      };
      const page = messages
        ? { ...metadata, messages: items as MessageView[] }
        : { ...metadata, events: items as ProjectedWorldEvent[] };
      this.db.exec('COMMIT');
      return page;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  findMessage(messageId: string, highWater?: number): MessageView | undefined {
    this.ensureOpen();
    if (!text(messageId)) {
      return undefined;
    }
    const watermark = highWater ?? this.latestSequence();
    if (!Number.isSafeInteger(watermark) || watermark < 0) {
      throw new Error('Invalid high water');
    }
    const row = this.db
      .prepare(
        'SELECT entry FROM world_messages WHERE message_id=? AND sequence<=?',
      )
      .get(messageId, watermark);
    return row
      ? this.messageView(
          JSON.parse(row.entry as string) as TimelineEntry,
          watermark,
        )
      : undefined;
  }

  /** 内部便捷视图，输出资源上限与readMessages相同（24KB）。 */
  recentMessages(limit: number): MessageView[] {
    return this.readMessages({
      limit,
      direction: 'backward',
    }).messages.reverse();
  }

  getState(consumer = 'default'): WorldState {
    this.ensureOpen();
    if (!text(consumer, 128)) {
      throw new Error('Invalid consumer');
    }
    const latestSequence = this.latestSequence();
    const watermark = Number(
      this.db
        .prepare('SELECT sequence FROM world_observers WHERE consumer=?')
        .get(consumer)?.sequence ?? 0,
    );
    const unreadEvents = Number(
      this.db
        .prepare('SELECT COUNT(*) AS value FROM world_events WHERE sequence>?')
        .get(watermark)!.value,
    );
    const counts: Partial<Record<WorldEventType, number>> = {};
    for (const row of this.db
      .prepare(
        'SELECT type,COUNT(*) AS count FROM world_events WHERE sequence>? GROUP BY type',
      )
      .iterate(watermark)) {
      counts[row.type as WorldEventType] = Number(row.count);
    }
    return {
      groupId: this.groupId,
      latestSequence,
      unreadEvents,
      observationWatermark: watermark,
      unreadByType: counts,
    };
  }

  /** 只有调用方显式确认才推进观察水位；带过滤的读取绝不推进水位。 */
  ack(consumer: string, throughSequence: number): number {
    this.ensureOpen();
    if (
      !text(consumer, 128) ||
      !Number.isSafeInteger(throughSequence) ||
      throughSequence < 0
    ) {
      throw new Error('Invalid observation cursor');
    }
    if (throughSequence > this.latestSequence()) {
      throw new Error('Observation cursor ahead');
    }
    this.db
      .prepare(
        'INSERT INTO world_observers(consumer,sequence) VALUES(?,?) ON CONFLICT(consumer) DO UPDATE SET sequence=MAX(world_observers.sequence,excluded.sequence)',
      )
      .run(consumer, throughSequence);
    return Number(
      this.db
        .prepare('SELECT sequence FROM world_observers WHERE consumer=?')
        .get(consumer)!.sequence,
    );
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
