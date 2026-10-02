import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { OneBotClient } from '../../../../src/onebot/client.ts';
import { Listener } from '../../../../src/agent/listener.ts';
import { ModelSession } from '../../../../src/agent/session/store.ts';
import { WorldEventStore } from '../../../../src/world/events.ts';
import type { ListenerConfig } from '../../../../src/config/listener.ts';
import type {
  ChatMessage,
  Completion,
} from '../../../../src/contracts/model.ts';
import type { JsonObject } from '../../../../src/contracts/json.ts';
import type {
  Memory,
  TimelineEntry,
} from '../../../../src/contracts/messages.ts';
import { OWNER_ID } from '../../../../src/contracts/identity.ts';
import { toolPermissions } from '../../../support/tool-permissions.ts';

const GROUP = '123456',
  SELF = '999',
  ACTOR = '111';
const tool = (
  id: string,
  name: string,
  args: JsonObject = name === 'finish' ? { mode: 'hard' } : {},
) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const completion = (...tool_calls: Completion['tool_calls']): Completion => ({
  content: null,
  tool_calls,
});

function memory(): Memory {
  const rows: TimelineEntry[] = [];
  return {
    recent: () => rows,
    find: (id) => rows.find((row) => row.messageId === id),
    append: (row) => {
      rows.push(row);
      return true;
    },
    context: () => '',
    async compact() {
      throw new Error('unexpected legacy compaction');
    },
    clear() {
      rows.length = 0;
    },
    close() {},
  };
}

const scenarios = [
  {
    name: 'success with omitted data submits ten independent pokes',
    status: 'ok',
    retcode: 0,
    data: undefined,
    count: 10,
    accepted: true,
  },
  {
    name: 'success with explicit null retains submission semantics',
    status: 'ok',
    retcode: 0,
    data: null,
    count: 1,
    accepted: true,
  },
  {
    name: 'failed envelope with retcode 1200 and omitted data never submits or retries',
    status: 'failed',
    retcode: 1200,
    data: undefined,
    count: 10,
    accepted: false,
  },
  {
    name: 'ok status with nonzero retcode and omitted data never submits or retries',
    status: 'ok',
    retcode: 1200,
    data: undefined,
    count: 10,
    accepted: false,
  },
  {
    name: 'failed status with zero retcode and omitted data never submits or retries',
    status: 'failed',
    retcode: 0,
    data: undefined,
    count: 10,
    accepted: false,
  },
];
for (const scenario of scenarios) {
  test(
    `real OneBot websocket: ${scenario.name}`,
    { timeout: 10000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'poke-websocket-'));
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      const peers = new Set<WebSocket>();
      const native: { action: string; params: JsonObject }[] = [],
        wireReplies: string[] = [],
        requests: ChatMessage[][] = [],
        failures: unknown[] = [];
      let listener: Listener | undefined, client: OneBotClient | undefined;
      const session = new ModelSession({
        model: 'main',
        path: join(dir, 'session.sqlite'),
        groupId: GROUP,
      });
      const world = new WorldEventStore({
        path: join(dir, 'world.sqlite'),
        groupId: GROUP,
      });
      server.on('connection', (peer) => {
        peers.add(peer);
        peer.on('close', () => peers.delete(peer));
        peer.on('message', (raw) => {
          try {
            const packet = JSON.parse(raw.toString()) as {
              action: string;
              params: JsonObject;
              echo: string;
            };
            native.push({ action: packet.action, params: packet.params });
            let data: unknown;
            if (packet.action === 'get_login_info') {
              data = { user_id: SELF };
            } else if (packet.action === 'get_group_member_info') {
              assert.equal(packet.params.group_id, GROUP);
              assert.ok([SELF, ACTOR].includes(String(packet.params.user_id)));
              assert.equal(packet.params.no_cache, true);
              data = {
                group_id: GROUP,
                user_id: packet.params.user_id,
                role: packet.params.user_id === SELF ? 'admin' : 'member',
              };
            } else if (packet.action === 'group_poke') {
              assert.deepEqual(packet.params, {
                group_id: GROUP,
                user_id: ACTOR,
              });
              // 与NapCat的OB11Response.ok(void)一致：JSON序列化时完全省略data。
              const wire = JSON.stringify({
                status: scenario.status,
                retcode: scenario.retcode,
                data: scenario.data,
                echo: packet.echo,
              });
              assert.equal(
                Object.hasOwn(JSON.parse(wire), 'data'),
                scenario.data !== undefined,
              );
              wireReplies.push(wire);
              peer.send(wire);
              return;
            } else {
              throw new Error('unexpected native action ' + packet.action);
            }
            peer.send(
              JSON.stringify({
                status: 'ok',
                retcode: 0,
                data,
                echo: packet.echo,
              }),
            );
          } catch (error) {
            failures.push(error);
            peer.terminate();
          }
        });
      });
      try {
        await once(server, 'listening');
        const port = (server.address() as AddressInfo).port;
        client = new OneBotClient({
          url: `ws://127.0.0.1:${port}`,
          token: 'fixture',
          apiTimeoutMs: 1000,
          reconnectBaseMs: 100,
          reconnectMaxMs: 100,
          heartbeatMs: 10000,
        });
        const config: ListenerConfig = {
          ownerId: OWNER_ID,
          groupId: GROUP,
          enabled: true,
          debounceMs: 1,
          cooldownMs: 0,
          retentionDays: 7,
          randomReplyProbability: 0,
          maxToolCallsPerWake: 96,
          toolPermissions: toolPermissions({
            poke_member: 'direct',
            mute_member: { mode: 'off', maxSeconds: 600 },
          }),
          messageMentions: false,
          confirmationTtlSeconds: 60,
        };
        listener = new Listener(
          client,
          {
            async complete(messages) {
              requests.push(structuredClone(messages));
              if (requests.length === 1) {
                return completion(
                  ...Array.from({ length: scenario.count }, (_, i) =>
                    tool(`poke-${i}`, 'poke_member', { user_id: ACTOR }),
                  ),
                );
              }
              if (requests.length === 2) {
                return scenario.accepted
                  ? completion(tool('done', 'finish'))
                  : completion(
                      tool('not-a-new-intent', 'poke_member', {
                        user_id: ACTOR,
                      }),
                      tool('done', 'finish'),
                    );
              }
              throw new Error('unexpected additional model request');
            },
          },
          memory(),
          config,
          () => 0,
          undefined,
          undefined,
          {
            session,
            world,
            modelRequestId: () => `request-${requests.length}`,
          },
        );
        const ready = once(client, 'ready');
        client.start();
        const [identity] = await ready;
        assert.deepEqual(identity, { user_id: SELF });
        client.on('message', (packet) => {
          void listener!
            .receive(packet, SELF)
            .catch((error) => failures.push(error));
        });
        assert.equal(peers.size, 1);
        peers
          .values()
          .next()
          .value!.send(
            JSON.stringify({
              post_type: 'message',
              message_type: 'group',
              group_id: GROUP,
              self_id: SELF,
              user_id: ACTOR,
              message_id: '1',
              time: Math.floor(Date.now() / 1000),
              sender: { nickname: 'fixture' },
              message: [
                { type: 'at', data: { qq: SELF } },
                { type: 'text', data: { text: '请戳我十下' } },
              ],
            }),
          );
        for (let i = 0; i < 1000; i++) {
          if (failures.length) {
            throw failures[0];
          }
          if (requests.length >= 2 && !session.state().wakeId) {
            break;
          }
          await delay(5);
        }
        assert.equal(
          requests.length,
          2,
          'model reaches result review and finish normally',
        );
        assert.equal(session.state().wakeId, undefined, 'wake must finish');
        assert.deepEqual(failures, []);
        const pokes = native.filter((call) => call.action === 'group_poke');
        assert.equal(
          pokes.length,
          scenario.accepted ? scenario.count : 1,
          'only independent accepted pokes continue; uncertain request is not replayed',
        );
        assert.equal(wireReplies.length, pokes.length);
        assert.equal(
          native.filter((call) => call.action === 'get_login_info').length,
          1 + pokes.length,
          'handshake and each fresh identity verification cross the real socket',
        );
        assert.equal(
          native.filter((call) => call.action === 'get_group_member_info')
            .length,
          2 * pokes.length,
        );
        const results = requests[1]!
          .filter((message) => message.role === 'tool')
          .map((message) => JSON.parse(String(message.content)) as JsonObject);
        assert.equal(results.length, scenario.count);
        if (scenario.accepted) {
          for (const result of results) {
            assert.equal(result.status, 'ok');
            assert.equal(result.submitted, true);
            assert.equal(result.delivery_confirmed, false);
            assert.equal(result.cached, undefined);
            assert.equal(result.error, undefined);
          }
        } else {
          assert.equal(results[0]!.status, 'unknown');
          assert.notEqual(results[0]!.submitted, true);
          for (const result of results.slice(1)) {
            assert.equal(result.status, 'error');
            assert.equal(result.error, 'management_result_review_required');
            assert.notEqual(result.submitted, true);
          }
        }
        assert.equal(
          session.summarizeTools({ since: 0, until: Date.now() }).pending,
          0,
        );
      } finally {
        await listener?.stop();
        await client?.stop();
        for (const peer of peers) {
          peer.terminate();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (!listener) {
          session.close();
          world.close();
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
