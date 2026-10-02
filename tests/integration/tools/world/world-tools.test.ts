import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldEventStore } from '../../../../src/world/events.ts';
import {
  WorldTools,
  buildWorldTools,
  chatConsumer,
  projectWorldEvent,
  projectWorldMessage,
} from '../../../../src/tools/world/tools.ts';
import type { JsonObject } from '../../../../src/contracts/json.ts';
import type { TimelineEntry } from '../../../../src/contracts/messages.ts';

const groupId = '22',
  selfId = '999';
const consumer = chatConsumer(selfId);
const context = { groupId, selfId, actorId: '111', messageId: '1' };

function setup() {
  let now = Date.now() / 1000;
  const store = new WorldEventStore({ path: ':memory:', groupId });
  const tools = new WorldTools({
    store,
    groupId,
    selfId,
    clock: () => now,
    wake: () => ({
      wakeId: 'wake_1',
      trigger: { type: 'direct', body: 'PRIVATE_TRIGGER' },
    }),
    currentBudget: () => ({
      remaining_tool_calls: 80,
      secret: 'PRIVATE_BUDGET',
    }),
  });
  const add = (n: number, extra: Partial<TimelineEntry> = {}) =>
    store.appendMessage(
      {
        messageId: String(n),
        userId: n % 2 ? '111' : '222',
        nickname: 'member',
        text: `message ${n}`,
        time: now,
        segments: [{ type: 'text', text: `message ${n}` }],
        ...extra,
      },
      { source: 'onebot', observedAt: now },
    );
  return {
    store,
    tools,
    add,
    run: (
      name: string,
      args: unknown = {},
      ctx = context,
      signal?: AbortSignal,
    ) => tools.execute(name, args, ctx, signal),
    tick: (s: number) => {
      now += s;
    },
    get now() {
      return now;
    },
  };
}

const sequences = (result: JsonObject) =>
  (result.events as JsonObject[]).map((e) => e.sequence);

test('catalog removes old model tools; counts and bounded metadata do not read or acknowledge', async () => {
  const definitions = buildWorldTools();
  assert.deepEqual(
    definitions.map((t) => t.function.name),
    ['get_wake_state', 'get_time', 'read_events'],
  );
  assert.deepEqual(definitions[2]!.function.parameters.required, ['limit']);
  (definitions[0]!.function.parameters.properties as JsonObject).evil = true;
  assert.deepEqual(buildWorldTools()[0]!.function.parameters.properties, {});
  const s = setup();
  try {
    s.add(1);
    s.add(2);
    const wake = await s.run('get_wake_state');
    assert.equal(wake.unread_count, 2);
    assert.equal(wake.read_through, 0);
    assert.equal(wake.observed_through, undefined);
    assert.equal(wake.latest_available, 2);
    assert.ok(!JSON.stringify(wake).includes('PRIVATE'));
    assert.ok(!JSON.stringify(wake).includes('message 1'));
    const time = await s.run('get_time');
    assert.equal(time.unix_seconds, s.now);
    assert.equal(time.utc, new Date(s.now * 1000).toISOString());
    assert.equal(time.timezone, 'Asia/Shanghai');
    for (const name of ['read_messages', 'ack_events']) {
      assert.equal((await s.run(name, { limit: 1 })).error, 'unknown_tool');
    }
    assert.equal(s.store.getState(consumer).observationWatermark, 0);
  } finally {
    s.store.close();
  }
});

test('default backward queries see arrivals; opaque page chains fix snapshot and filters', async () => {
  const s = setup();
  try {
    s.add(1);
    s.add(2);
    const first = await s.run('read_events', { limit: 1 });
    assert.deepEqual(sequences(first), [2]);
    assert.equal(first.high_water, 2);
    assert.match(String(first.next_cursor), /^wc_[0-9a-f]{48}$/);
    assert.equal(first.ack_cursor, undefined);
    s.add(3);
    for (const filters of [
      { direction: 'backward' },
      { actor_id: '111' },
      { before_event_id: 'x' },
      { types: ['message.created'] },
      { since: 0 },
    ]) {
      const rejected = await s.run('read_events', {
        limit: 1,
        cursor: first.next_cursor,
        ...filters,
      });
      assert.equal(rejected.reason_code, 'cursor_with_filters');
      assert.match(String(rejected.hint), /只能传cursor和limit/);
    }
    const second = await s.run('read_events', {
      limit: 10,
      cursor: first.next_cursor,
    });
    assert.deepEqual(sequences(second), [1]);
    assert.equal(second.high_water, 2);
    assert.equal(second.latest_available, 3);
    assert.deepEqual(
      sequences(await s.run('read_events', { limit: 10 })),
      [3, 2, 1],
    );
    const filtered = await s.run('read_events', {
      limit: 1,
      actor_id: '111',
      types: ['message.created'],
    });
    assert.deepEqual(sequences(filtered), [3]);
    assert.deepEqual(
      sequences(
        await s.run('read_events', { limit: 2, cursor: filtered.next_cursor }),
      ),
      [1],
    );
    const other = new WorldTools({ store: s.store, groupId, selfId });
    assert.equal(
      (
        await other.execute('read_events', {
          limit: 1,
          cursor: first.next_cursor,
        })
      ).error,
      'invalid_cursor',
    );
    s.tick(86400);
    assert.equal(
      (await s.run('read_events', { limit: 1, cursor: first.next_cursor }))
        .error,
      'invalid_cursor',
    );
    assert.equal(s.store.getState(consumer).observationWatermark, 0);
  } finally {
    s.store.close();
  }
});

test('event anchors are exclusive, direction explicit and wrong-group IDs fail closed', async () => {
  const s = setup(),
    foreign = new WorldEventStore({ path: ':memory:', groupId: '33' });
  try {
    const a = s.add(1);
    const b = s.add(2);
    s.add(3);
    const foreignEvent = foreign.appendRecall('99');
    assert.deepEqual(
      sequences(
        await s.run('read_events', { limit: 5, before_event_id: b.eventId }),
      ),
      [1],
    );
    assert.deepEqual(
      sequences(
        await s.run('read_events', {
          limit: 5,
          direction: 'forward',
          after_event_id: a.eventId,
        }),
      ),
      [2, 3],
    );
    assert.deepEqual(
      sequences(await s.run('read_events', { limit: 5, direction: 'forward' })),
      [1, 2, 3],
    );
    for (const args of [
      { before_event_id: foreignEvent.eventId },
      { direction: 'forward', after_event_id: foreignEvent.eventId },
      { before_event_id: 'missing' },
      { before_event_id: b.eventId, direction: 'forward' },
      { after_event_id: a.eventId },
      { after_event_id: a.eventId, direction: 'backward' },
      { before_event_id: b.eventId, after_event_id: a.eventId },
      { before_event_id: null },
    ]) {
      assert.equal(
        (await s.run('read_events', { limit: 5, ...args })).error,
        'invalid_arguments',
      );
    }
  } finally {
    s.store.close();
    foreign.close();
  }
});

test('validation rejects invalid limits, filters, scope and fabricated cursors without leaking errors', async () => {
  const s = setup();
  try {
    for (const limit of [
      undefined,
      0,
      -1,
      1.2,
      NaN,
      Infinity,
      '3',
      true,
      null,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.equal(
        (await s.run('read_events', { limit })).error,
        'invalid_arguments',
      );
    }
    for (const args of [
      {},
      { limit: 1, after: 0 },
      { limit: 1, group_id: '33' },
      { limit: 1, direction: 'sideways' },
      { limit: 1, actor_id: '01' },
      { limit: 1, since: '1' },
      { limit: 1, since: 2, until: 1 },
      { limit: 1, types: [] },
      { limit: 1, types: ['bogus'] },
      { limit: 1, types: ['message.created', 'message.created'] },
    ]) {
      assert.equal(
        (await s.run('read_events', args)).error,
        'invalid_arguments',
      );
    }
    for (const cursor of [1, 'wc_' + 'a'.repeat(48)]) {
      assert.equal(
        (await s.run('read_events', { limit: 1, cursor })).error,
        'invalid_cursor',
      );
    }
    for (const ctx of [
      { ...context, groupId: '33' },
      { ...context, selfId: '777' },
    ]) {
      assert.equal(
        (await s.run('read_events', { limit: 1 }, ctx)).error,
        'forbidden_group',
      );
    }
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (await s.run('get_time', {}, context, controller.signal)).error,
      'cancelled',
    );
    assert.equal(
      (await s.run('get_time', { limit: 1 })).error,
      'invalid_arguments',
    );
    assert.equal(
      (
        await s.run(
          'read_events',
          Object.defineProperty({ limit: 1 }, 'cursor', {
            enumerable: true,
            get() {
              throw new Error('PRIVATE');
            },
          }),
        )
      ).error,
      'invalid_arguments',
    );
    assert.throws(
      () => new WorldTools({ store: s.store, groupId: '33', selfId }),
    );
    assert.throws(
      () => new WorldTools({ store: s.store, groupId, selfId: 'all' }),
    );
    assert.throws(
      () =>
        new WorldTools({
          store: s.store,
          groupId,
          selfId,
          timezone: 'SECRET/INVALID',
        }),
    );
    s.store.close();
    assert.deepEqual(await s.run('get_wake_state'), {
      status: 'error',
      error: 'tool_failed',
    });
  } finally {
    s.store.close();
  }
});

test('time filters use observed timestamps and queries ignore the read position', async () => {
  const s = setup();
  try {
    s.add(1);
    const start = s.now;
    s.tick(1);
    s.add(2);
    s.tick(1);
    s.add(3);
    s.store.ack(consumer, 3);
    assert.deepEqual(
      sequences(
        await s.run('read_events', {
          limit: 10,
          since: start + 1,
          until: start + 1,
        }),
      ),
      [2],
    );
    assert.deepEqual(
      sequences(await s.run('read_events', { limit: 10 })),
      [3, 2, 1],
    );
    assert.deepEqual(
      sequences(
        await s.run('read_events', { limit: 10, direction: 'forward' }),
      ),
      [1, 2, 3],
    );
    const wake = await s.run('get_wake_state');
    assert.equal(wake.read_through, 3);
    assert.equal(wake.unread_count, 0);
  } finally {
    s.store.close();
  }
});

test('unread latest-N adapter fixes highWater and total, leaves read advancement to host and isolates accounts', async () => {
  const s = setup();
  try {
    for (let i = 1; i <= 5; i++) {
      s.add(i);
    }
    s.store.ack('ai', 5); // retired consumer cannot affect chat
    s.store.ack(consumer, 1);
    const page = s.store.readUnreadEvents(2, consumer);
    assert.equal(page.unread, 4);
    assert.equal(page.highWater, 5);
    assert.deepEqual(
      page.events.map((e) => e.sequence),
      [5, 4],
    );
    assert.equal(s.store.getState(consumer).observationWatermark, 1);
    s.add(6);
    s.store.ack(consumer, page.highWater);
    assert.equal((await s.run('get_wake_state')).unread_count, 1);
    assert.equal(s.store.getState(chatConsumer('888')).unreadEvents, 6);
    const next = s.store.readUnreadEvents(10, consumer);
    assert.deepEqual(
      next.events.map((e) => e.sequence),
      [6],
    );
    assert.equal(next.unread, 1);
    s.store.ack(consumer, next.highWater);
    const empty = s.store.readUnreadEvents(1, consumer);
    assert.equal(empty.unread, 0);
    assert.deepEqual(empty.events, []);
    assert.equal(empty.highWater, 6);
  } finally {
    s.store.close();
  }
});

test('huge limits and delivery projections remain bounded, with explicit omission metadata', async () => {
  const s = setup();
  try {
    for (let i = 1; i <= 60; i++) {
      s.add(i, {
        text: '字'.repeat(3000),
        segments: [{ type: 'text', text: '字'.repeat(3000) }],
      });
    }
    const result = await s.run('read_events', {
      limit: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.truncated, true);
    assert.ok(result.next_cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24000);
    const page = s.store.readUnreadEvents(60, consumer);
    assert.equal(page.unread, 60);
    assert.equal(page.highWater, 60);
    assert.equal(page.reason, 'output_limit');
    assert.ok(
      Buffer.byteLength(JSON.stringify(page.events.map(projectWorldEvent))) <=
        24000,
    );
  } finally {
    s.store.close();
  }
});

test('shared projections remove private image/forward metadata and internal message views retain recall safety', async () => {
  const s = setup();
  try {
    s.add(1, {
      text: '[CQ:at,qq=all]',
      segments: [
        { type: 'text', text: '[CQ:at,qq=all]' },
        { type: 'forward', forward_id: 'fwd_1_1', content_status: 'not_read' },
        { type: 'image', image_id: 'img_1_2', content_status: 'not_viewed' },
      ],
      forwards: [
        {
          id: 'fwd_1_1',
          index: 1,
          resourceId: 'PRIVATE_RESOURCE',
          url: 'https://private.invalid/SECRET',
        } as any,
      ],
      images: [
        {
          id: 'img_1_2',
          index: 2,
          url: 'https://private.invalid/SECRET',
        } as any,
      ],
    });
    s.store.appendRecall('1', { observedAt: s.now, recalledBy: '222' });
    const result = await s.run('read_events', { limit: 10 });
    const projected = s.store
      .readUnreadEvents(10, consumer)
      .events.map(projectWorldEvent);
    assert.deepEqual(result.events, projected);
    const view = s.store.findMessage('1')!;
    assert.equal(view.recalled, true);
    assert.equal(s.store.recentMessages(1)[0]!.recalled, true);
    assert.equal(
      s.store.readMessages({ limit: 1 }).messages[0]!.recalled,
      true,
    );
    const message = projectWorldMessage(view);
    assert.equal(message.recalled, true);
    assert.equal(message.recalled_by, '222');
    assert.equal(message.representation, 'segments');
    for (const value of [result, projected, message]) {
      assert.doesNotMatch(JSON.stringify(value), /PRIVATE|private\.invalid/);
      assert.match(JSON.stringify(value), /\[CQ:at,qq=all\]/);
    }
  } finally {
    s.store.close();
  }
});
