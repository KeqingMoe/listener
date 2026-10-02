import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { OneBotClient } from '../../../src/onebot/client.ts';
import { Listener } from '../../../src/agent/listener.ts';
import { ModelSession } from '../../../src/agent/session/store.ts';
import { WorldEventStore } from '../../../src/world/events.ts';
import { recordToolMessage } from '../../../src/world/ingest.ts';
import {
  GroupMediaTools,
  type SendReceiptSnapshot,
} from '../../../src/tools/media/tools.ts';
import { DuplicateMessageAckError } from '../../../src/onebot/operation-result.ts';
import { configureLogging } from '../../../src/observability/logger.ts';
import { OWNER_ID } from '../../../src/contracts/identity.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';
import { type TurnContext } from '../../../src/contracts/tools.ts';
import { type JsonObject } from '../../../src/contracts/json.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';

const GROUP = '123456',
  SELF = '999',
  OTHER = '111';
const context: TurnContext = {
  groupId: GROUP,
  selfId: SELF,
  actorId: OTHER,
  messageId: '1',
};
const entry = (messageId: string, userId = SELF): TimelineEntry => ({
  messageId,
  userId,
  nickname: 'fixture',
  text: 'sent',
  time: Math.floor(Date.now() / 1000),
  bot: userId === SELF,
});
const event = (messageId: string, userId = SELF) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: GROUP,
  self_id: SELF,
  user_id: userId,
  message_id: messageId,
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: 'fixture' },
  message: [{ type: 'text', data: { text: 'sent' } }],
});

function memory(): Memory {
  const rows: TimelineEntry[] = [];
  return {
    recent: () => rows,
    find: (id) => rows.find((row) => row.messageId === id),
    append(row) {
      if (rows.some((r) => r.messageId === row.messageId)) {
        return false;
      }
      rows.push(row);
      return true;
    },
    context: () => '',
    async compact() {
      throw new Error('unexpected compaction');
    },
    clear() {
      rows.length = 0;
    },
    close() {},
  };
}

type SenderInternals = {
  captureSendReceipt(): SendReceiptSnapshot;
  claimMessageAck(entry: TimelineEntry, receipt: SendReceiptSnapshot): void;
  dispatchMessage(
    part: { text: string; segments: unknown[] },
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<
    TimelineEntry & {
      cancelled_after_dispatch?: boolean;
      local_projection_failed?: boolean;
    }
  >;
};

type Internals = SenderInternals & {
  command(text: string, context: TurnContext): Promise<void>;
};

// 发送相关方法在GroupSender上，命令仍在Listener上。
const internal = (listener: Listener): Internals => {
  const raw = listener as unknown as {
    sender: SenderInternals;
    command: Internals['command'];
  };
  return {
    captureSendReceipt: () => raw.sender.captureSendReceipt(),
    claimMessageAck: (entry, receipt) =>
      raw.sender.claimMessageAck(entry, receipt),
    dispatchMessage: (part, context, signal) =>
      raw.sender.dispatchMessage(part, context, signal),
    command: (text, context) => raw.command.call(listener, text, context),
  };
};
const send = (listener: Listener) =>
  internal(listener).dispatchMessage(
    { text: 'sent', segments: [{ type: 'text', data: { text: 'sent' } }] },
    context,
  );

type Packet = {
  action: string;
  params: JsonObject;
  echo: string;
  peer: WebSocket;
};

async function until(check: () => boolean, description: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail(`Timed out: ${description}`);
}

// 真实的本地OneBot连接，写操作的ACK由各测试自行控制。
async function fixture(
  check: (h: {
    listener: Listener;
    client: OneBotClient;
    world: WorldEventStore;
    memory: Memory;
    session: ModelSession;
    writes: Packet[];
    ack(p: Packet, id: string): void;
    logs(): Promise<JsonObject[]>;
    newListener(): Listener;
  }) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'ack-identity-'));
  const logging = configureLogging({
    level: 'debug',
    console: false,
    file: true,
    directory: join(dir, 'logs'),
    retentionDays: 1,
    maxFileMb: 1,
    maxTotalMb: 10,
  });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const peers = new Set<WebSocket>(),
    writes: Packet[] = [];
  const world = new WorldEventStore({
    path: join(dir, 'world.sqlite'),
    groupId: GROUP,
  });
  const session = new ModelSession({
    model: 'main',
    path: join(dir, 'session.sqlite'),
    groupId: GROUP,
  });
  const mem = memory();
  let client: OneBotClient | undefined;
  const listeners: Listener[] = [];
  server.on('connection', (peer) => {
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    peer.on('message', (raw) => {
      const p = { ...JSON.parse(raw.toString()), peer } as Packet;
      if (
        p.action === 'send_group_msg' ||
        p.action === 'send_group_forward_msg'
      ) {
        writes.push(p);
        return;
      }
      const data =
        p.action === 'get_login_info'
          ? { user_id: SELF }
          : p.action === 'get_msg'
            ? {
                message_id: p.params.message_id,
                message_type: 'group',
                group_id: GROUP,
                user_id: OTHER,
                sender: { user_id: OTHER },
                message: [],
              }
            : {};
      peer.send(
        JSON.stringify({ echo: p.echo, status: 'ok', retcode: 0, data }),
      );
    });
  });
  try {
    await once(server, 'listening');
    client = new OneBotClient({
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: 'fixture',
      apiTimeoutMs: 2000,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
      heartbeatMs: 10000,
    });
    const config: ListenerConfig = {
      toolPermissions: toolPermissions(MEMBER_TOOLS),
      ownerId: OWNER_ID,
      groupId: GROUP,
      enabled: true,
      debounceMs: 1,
      cooldownMs: 0,
      retentionDays: 7,
      randomReplyProbability: 0,
      maxToolCallsPerWake: 8,
    };
    let rounds = 0;
    const newListener = () => {
      const listener = new Listener(
        client!,
        {
          async complete() {
            return {
              content: null,
              tool_calls: [
                {
                  id: `call-${++rounds}`,
                  type: 'function',
                  function:
                    rounds % 2
                      ? {
                          name: 'send_message',
                          arguments: JSON.stringify({
                            segments: [{ type: 'text', text: 'new send' }],
                          }),
                        }
                      : { name: 'finish', arguments: '{"mode":"hard"}' },
                },
              ],
            };
          },
        },
        mem,
        config,
        () => 0,
        undefined,
        undefined,
        { world, session },
      );
      listeners.push(listener);
      return listener;
    };
    const listener = newListener();
    const ready = once(client, 'ready');
    client.start();
    await ready;
    await check({
      listener,
      client,
      world,
      memory: mem,
      session,
      writes,
      newListener,
      ack(p, id) {
        p.peer.send(
          JSON.stringify({
            echo: p.echo,
            status: 'ok',
            retcode: 0,
            data: { message_id: id },
          }),
        );
      },
      async logs() {
        await logging.flush();
        return readdirSync(join(dir, 'logs'))
          .filter((n) => n.endsWith('.jsonl'))
          .flatMap((n) =>
            readFileSync(join(dir, 'logs', n), 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((s) => JSON.parse(s)),
          );
      },
    });
  } finally {
    for (const listener of listeners) {
      await listener.stop();
    }
    await client?.stop();
    for (const peer of peers) {
      peer.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    world.close();
    session.close();
    await logging.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  'late ACK after reset survives as identity, but reconnect reuse is unknown and adds no sent count or memory',
  { timeout: 12000 },
  async () => {
    await fixture(async (h) => {
      const late = send(h.listener);
      await until(() => h.writes.length === 1, 'first send dispatched');
      const reset = internal(h.listener).command('/reset', {
        ...context,
        actorId: OWNER_ID,
      });
      await until(
        () => h.writes.length === 2,
        'reset acknowledgement dispatched',
      );
      h.ack(h.writes[1]!, '888');
      await reset;
      h.ack(h.writes[0]!, '777');
      assert.equal((await late).cancelled_after_dispatch, true);
      assert.equal(
        h.memory.find('777'),
        undefined,
        'late ACK must not restore reset memory',
      );
      h.listener.setConnected(false);
      const ready = once(h.client, 'ready');
      h.writes[0]!.peer.terminate();
      await ready;
      h.listener.setConnected(true);
      await h.listener.receive(
        {
          ...event('2', OTHER),
          message: [
            { type: 'at', data: { qq: SELF } },
            { type: 'text', data: { text: 'send again' } },
          ],
        },
        SELF,
      );
      await until(() => h.writes.length === 3, 'post-reconnect wake send');
      h.ack(h.writes[2]!, '777');
      await until(
        () =>
          h.session.messages().some((m) => m.role === 'tool') &&
          !h.session.state().wakeId,
        'wake finished',
      );
      const results = h.session
        .messages()
        .filter((m) => m.role === 'tool')
        .map((m) => JSON.parse(String(m.content)));
      assert.ok(
        results.some((r) => r.status === 'unknown'),
        JSON.stringify(results),
      );
      assert.equal(h.memory.find('777'), undefined);
      const ends = (await h.logs()).filter((row) => row.event === 'turn.end');
      assert.ok(ends.length, 'wake must emit turn.end');
      assert.equal(ends.at(-1)!.sent_messages, 0);
    });
  },
);

test('old world ID is rejected across Listener instances with empty memory', async () => {
  await fixture(async (h) => {
    const first = internal(h.listener);
    first.claimMessageAck(entry('777'), first.captureSendReceipt());
    recordToolMessage(h.world, entry('777'));
    h.memory.clear();
    const second = internal(h.newListener());
    assert.throws(
      () => second.claimMessageAck(entry('777'), second.captureSendReceipt()),
      DuplicateMessageAckError,
    );
    assert.equal(h.memory.find('777'), undefined);
  });
});

for (const sender of [SELF, OTHER]) {
  test(`wire dispatch-time echo from ${sender === SELF ? 'self is legal' : 'another sender is not ownership'}`, async () => {
    await fixture(async (h) => {
      const pending = send(h.listener);
      // 先挂上rejection处理函数，再放行ACK。
      const outcome = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await until(() => h.writes.length === 1, 'dispatch');
      await h.listener.receive(event('777', sender), SELF);
      h.ack(h.writes[0]!, '777');
      const result = await outcome;
      if (sender === SELF) {
        assert.ok('value' in result);
        assert.equal(result.value.messageId, '777');
      } else {
        assert.ok('error' in result);
        assert.ok(result.error instanceof DuplicateMessageAckError);
        assert.equal(h.memory.find('777')?.userId, OTHER);
      }
    });
  });
}

test('memory-only pre-dispatch ID cannot become a fresh self echo', async () => {
  await fixture(async (h) => {
    h.memory.append(entry('777'));
    const receipt = internal(h.listener).captureSendReceipt();
    h.memory.clear();
    assert.throws(
      () => internal(h.listener).claimMessageAck(entry('777'), receipt),
      DuplicateMessageAckError,
    );
  });
});

test('wire projection failure preserves strong ACK but consumes its identity', async () => {
  await fixture(async (h) => {
    const original = h.world.append;
    h.world.append = () => {
      throw new Error('injected projection failure');
    };
    const pending = send(h.listener);
    await until(() => h.writes.length === 1, 'dispatch');
    h.ack(h.writes[0]!, '777');
    const result = await pending;
    assert.equal(result.messageId, '777');
    assert.equal(result.local_projection_failed, true);
    h.world.append = original;
    assert.throws(
      () =>
        internal(h.listener).claimMessageAck(
          entry('777'),
          internal(h.listener).captureSendReceipt(),
        ),
      DuplicateMessageAckError,
    );
  });
});

test('two inflight receipts cannot both claim the same dispatch-time self echo', async () => {
  await fixture(async (h) => {
    const a = send(h.listener),
      b = send(h.listener);
    const outcomes = Promise.allSettled([a, b]);
    await until(() => h.writes.length === 2, 'two writes in flight');
    await h.listener.receive(event('777'), SELF);
    h.ack(h.writes[1]!, '777');
    h.ack(h.writes[0]!, '777');
    const results = await outcomes;
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.ok(
      rejected?.status === 'rejected' &&
        rejected.reason instanceof DuplicateMessageAckError,
    );
  });
});

test('media captures receipt before wire dispatch, accepts self echo, and cannot reclaim after projection failure', async () => {
  await fixture(async (h) => {
    h.memory.append(entry('1', OTHER));
    const receipts: SendReceiptSnapshot[] = [];
    const tools = new GroupMediaTools(
      h.client,
      GROUP,
      ['send_group_forward'],
      h.memory,
      {
        beforeSend() {
          const receipt = internal(h.listener).captureSendReceipt();
          receipts.push(receipt);
          return receipt;
        },
        onSent(sent, receipt) {
          assert.equal(receipt, receipts.at(-1));
          assert.ok(receipt);
          internal(h.listener).claimMessageAck(sent, receipt);
          throw new Error('injected local projection failure');
        },
      },
    );
    const first = tools.execute(
      'send_group_forward',
      { message_ids: ['1'] },
      context,
    );
    await until(() => h.writes.length === 1, 'media dispatch');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.memoryIds.has('777'), false);
    await h.listener.receive(event('777'), SELF);
    h.ack(h.writes[0]!, '777');
    const result = await first;
    assert.equal(result.status, 'executed');
    assert.equal(result.message_id, '777');
    assert.equal(result.local_projection_failed, true);
    const second = tools.execute(
      'send_group_forward',
      { message_ids: ['1'] },
      context,
    );
    await until(() => h.writes.length === 2, 'second media dispatch');
    h.ack(h.writes[1]!, '777');
    const duplicate = await second;
    assert.equal(duplicate.status, 'unknown');
    assert.equal(duplicate.error, 'duplicate_message_ack');
    assert.equal(duplicate.message_id, null);
  });
});
