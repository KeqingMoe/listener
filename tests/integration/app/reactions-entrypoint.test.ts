import test from 'node:test';
import { sendChatStream } from '../../support/model-sse.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, type WebSocket } from 'ws';
import { LISTENER_GROUP } from '../../../src/contracts/identity.ts';

const A = LISTENER_GROUP,
  B = '22',
  SELF = '99999';

function event(group: string, id: string, body: string) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: group,
    user_id: group === A ? '111' : '222',
    self_id: SELF,
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: group === A ? 'user-A' : 'user-B' },
    message: [
      { type: 'at', data: { qq: SELF } },
      { type: 'text', data: { text: body } },
    ],
  };
}

const tool = (name: string, args: unknown = {}) => ({
  id: `fixture_${name}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const react = (id: string, emoji = '76', action: 'add' | 'remove' = 'add') =>
  tool('react_message', { message_id: id, emoji_id: emoji, action });
const send = (body: string) =>
  tool('send_message', { segments: [{ type: 'text', text: body }] });

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error('fixture operation timed out')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  'real entrypoint performs isolated reactions, exposes only local ledger state, and cancels an in-flight mutation on SIGTERM',
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'listener-reactions-entrypoint-'));
    const changed = new EventEmitter();
    let failure: unknown,
      output = '',
      child: ChildProcess | undefined,
      childExited:
        | Promise<{ code: number | null; signal: NodeJS.Signals | null }>
        | undefined;
    const notify = () => changed.emit('change'),
      fail = (error: unknown) => {
        failure = error;
        notify();
      };
    const sockets = new Set<Socket>(),
      peers = new Set<WebSocket>();
    let connectionCount = 0,
      peer: WebSocket | undefined,
      heldMutation = false;
    const events = new Map<string, ReturnType<typeof event>>(),
      verified = new Map<string, number>(),
      sentIds = new Map<string, string[]>();
    const verificationFloors = new Map<string, number[]>(),
      consumedVerification = new Map<string, number>();
    const calls: Array<{ action: string; params: Record<string, unknown> }> =
        [],
      requests: Array<{
        group: string;
        round: number;
        body: any;
        payload: any;
      }> = [],
      rounds = new Map<string, number>(),
      steps = new Map<string, number>(),
      wakeIds = new Map<string, string>();
    const http = createServer((req, res) => {
      void (async () => {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/v1/chat/completions');
        assert.equal(req.headers.authorization, 'Bearer fixture-model-key');
        let source = '';
        for await (const chunk of req) {
          source += chunk.toString();
          assert.ok(source.length < 1024 * 1024);
        }
        const body = JSON.parse(source);
        assert.equal(body.model, 'fixture-reactions-model');
        const group = /本轮只服务群 (\d+)/.exec(body.messages[0].content)?.[1];
        assert.ok(group === A || group === B);
        assert.ok(
          body.tools.some((t: any) => t.function.name === 'react_message'),
        );
        const payload = JSON.parse(
          body.messages.findLast(
            (m: any) => m.role === 'user' && JSON.parse(m.content).wake,
          ).content,
        );
        const wakeId = JSON.stringify(payload);
        if (wakeIds.get(group) !== wakeId) {
          wakeIds.set(group, wakeId);
          rounds.set(group, (rounds.get(group) ?? 0) + 1);
          steps.set(group, 0);
        }
        const round = rounds.get(group)!;
        const step = steps.get(group)!;
        steps.set(group, step + 1);
        if (step === 3) {
          requests.push({ group, round, body, payload });
        }
        if (step === 0) {
          assert.equal(payload.wake.group_id, group);
          assert.equal(Object.hasOwn(payload, 'reaction_state'), false);
          assert.ok(!JSON.stringify(payload.wake).includes('only-'));
        }
        let operations;
        if (step < 3) {
          operations = [
            tool(
              step === 0
                ? 'read_events'
                : step === 1
                  ? 'read_events'
                  : 'read_message',
              step === 0 || step === 1
                ? { limit: 100 }
                : {
                    message_id:
                      group === A ? String(100 + round) : String(200 + round),
                  },
            ),
          ];
        } else if (group === A && round === 1) {
          operations = [
            send('only-A-reaction-reply'),
            react('101'),
            tool('finish', { mode: 'hard' }),
          ];
        } else if (group === B && round === 1) {
          operations = [
            react('201', '128077'),
            tool('finish', { mode: 'hard' }),
          ];
        } else if (group === A && round === 2) {
          operations = [
            react('201'),
            react('101', '76', 'remove'),
            tool('finish', { mode: 'hard' }),
          ];
        } else if (group === B && round === 2) {
          operations = [
            send('only-B-reaction-reply'),
            react('202'),
            tool('finish', { mode: 'hard' }),
          ];
        } else if (group === A && round === 3) {
          operations = [tool('finish', { mode: 'hard' })];
        } else if (group === B && round === 3) {
          operations = [
            react('203'),
            send('must-not-send-after-cancel'),
            react('201', '128077', 'remove'),
            tool('finish', { mode: 'hard' }),
          ];
        } else {
          throw new Error('unexpected fixture model request');
        }
        for (const op of operations) {
          if (op.function.name !== 'react_message') {
            continue;
          }
          const args = JSON.parse(op.function.arguments),
            original = events.get(args.message_id);
          if (original?.group_id !== group) {
            continue;
          }
          const floors = verificationFloors.get(args.message_id) ?? [];
          floors.push(verified.get(args.message_id) ?? 0);
          verificationFloors.set(args.message_id, floors);
        }
        sendChatStream(res, {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: operations.map((op, i) => ({
                  ...op,
                  id: `${op.id}_${group}_${round}_${i}`,
                })),
              },
            },
          ],
        });
        notify();
      })().catch((error) => {
        fail(error);
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });
    });
    http.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
        notify();
      });
    });
    http.on('error', fail);
    const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    ws.on('error', fail);
    ws.on('connection', (socket, request) => {
      connectionCount++;
      peer = socket;
      peers.add(socket);
      socket.once('close', () => {
        peers.delete(socket);
        notify();
      });
      socket.on('error', fail);
      try {
        assert.equal(
          request.headers.authorization,
          'Bearer fixture-onebot-token',
        );
      } catch (error) {
        fail(error);
      }
      socket.on('message', (raw) => {
        try {
          const call = JSON.parse(raw.toString());
          calls.push(call);
          let data: unknown;
          if (call.action === 'get_login_info') {
            data = { user_id: SELF, nickname: 'fixture Listener' };
          } else if (call.action === 'get_group_list') {
            data = [A, B].map((group_id) => ({ group_id }));
          } else if (call.action === 'get_msg') {
            assert.deepEqual(Object.keys(call.params), ['message_id']);
            const id = String(call.params.message_id),
              original = events.get(id);
            assert.ok(original, 'only known fixture messages may be fetched');
            verified.set(id, (verified.get(id) ?? 0) + 1);
            data = {
              message_type: 'group',
              group_id: original.group_id,
              message_id: id,
              sender: { user_id: original.user_id },
              time: original.time,
              message: original.message,
              emoji_likes_list: [
                {
                  emoji_id: '76',
                  emoji_type: '1',
                  likes_cnt: original.group_id === A ? '3' : '4',
                },
              ],
            };
          } else if (call.action === 'set_msg_emoji_like') {
            assert.deepEqual(Object.keys(call.params).sort(), [
              'emoji_id',
              'message_id',
              'set',
            ]);
            assert.equal(typeof call.params.set, 'boolean');
            assert.ok(['76', '128077'].includes(call.params.emoji_id));
            const id = String(call.params.message_id);
            assert.ok(events.has(id));
            const floor = verificationFloors.get(id)?.shift();
            assert.notEqual(
              floor,
              undefined,
              'only planned same-group reactions may dispatch',
            );
            assert.ok(
              (verified.get(id) ?? 0) >
                Math.max(floor!, consumedVerification.get(id) ?? 0),
              'each mutation needs new peer verification after the model decision, not a prefetched observation',
            );
            consumedVerification.set(id, verified.get(id)!);
            if (id === '203') {
              heldMutation = true;
              notify();
              return;
            }
            data = { result: 0 };
          } else if (call.action === 'send_group_msg') {
            assert.ok(call.params.group_id === A || call.params.group_id === B);
            const id = String(80000 + calls.length),
              ids = sentIds.get(call.params.group_id) ?? [];
            ids.push(id);
            sentIds.set(call.params.group_id, ids);
            const own = event(call.params.group_id, id, 'own fixture message');
            own.user_id = SELF;
            own.message = call.params.message;
            events.set(id, own);
            data = { message_id: id };
          } else {
            throw new Error(`unexpected OneBot action ${call.action}`);
          }
          socket.send(
            JSON.stringify({ status: 'ok', retcode: 0, data, echo: call.echo }),
          );
          notify();
        } catch (error) {
          fail(error);
        }
      });
      notify();
    });
    const wait = (
      predicate: () => boolean,
      label: string,
      timeout = 8000,
    ): Promise<void> =>
      new Promise((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const finish = (error?: unknown) => {
          clearTimeout(timer);
          changed.off('change', check);
          error ? reject(error) : resolve();
        };
        const check = () => {
          if (failure) {
            finish(failure);
            return;
          }
          try {
            if (predicate()) {
              finish();
            }
          } catch (error) {
            finish(error);
          }
        };
        changed.on('change', check);
        timer = setTimeout(
          () =>
            finish(
              Error(
                `${label} timed out; child log tail: ${output.slice(-5000)}`,
              ),
            ),
          timeout,
        );
        check();
      });
    const mutations = () =>
        calls.filter((c) => c.action === 'set_msg_emoji_like'),
      sends = () => calls.filter((c) => c.action === 'send_group_msg');
    const ended = () => [...output.matchAll(/\bturn\.end\b/g)].length;
    const emit = (group: string, id: string, body: string) => {
      const value = event(group, id, body);
      events.set(id, value);
      peer!.send(JSON.stringify(value));
    };
    try {
      const wsListening = ws.address()
        ? Promise.resolve()
        : once(ws, 'listening');
      http.listen(0, '127.0.0.1');
      await Promise.all([once(http, 'listening'), wsListening]);
      const wsPort = (ws.address() as AddressInfo).port,
        httpPort = (http.address() as AddressInfo).port;
      mkdirSync(join(dir, 'prompts'));
      writeFileSync(
        join(dir, 'prompts/listener.md'),
        'Local reaction fixture, no external provider or QQ connection.',
      );
      writeFileSync(
        join(dir, '.env'),
        'FIXTURE_ONEBOT_TOKEN=fixture-onebot-token\nFIXTURE_MODEL_KEY=fixture-model-key\n',
        { mode: 0o600 },
      );
      writeFileSync(
        join(dir, 'config.toml'),
        `[bot]
owner_id = "778899"
[onebot]
url = "ws://127.0.0.1:${wsPort}"
token_env = "FIXTURE_ONEBOT_TOKEN"
[models.main]
tool_schema = "json"
base_url = "http://127.0.0.1:${httpPort}/v1"
model = "fixture-reactions-model"
api_key_env = "FIXTURE_MODEL_KEY"
timeout_ms = 10000
[runtime]
max_concurrent_turns = 2
[storage]
directory = "data"
telemetry_path = "data/listener.sqlite.telemetry.sqlite"
[defaults]
enabled = false
persona = "prompts/listener.md"
reply = { delay_ms = [100,100], cooldown_ms = 1000, random = false }
observation.reactions = true
tools = { react_message = "direct", get_reaction_users = "direct" }
[logging]
level = "debug"
console = true
file = false
[groups."${A}"]
enabled = true
[groups."${B}"]
enabled = true
`,
      );
      child = spawn(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          fileURLToPath(new URL('../../../src/app/bot.ts', import.meta.url)),
        ],
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: dir,
            NODE_NO_WARNINGS: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      childExited = new Promise((resolve, reject) => {
        child!.once('error', (error) => {
          fail(error);
          reject(error);
        });
        child!.once('close', (code, signal) => {
          resolve({ code, signal });
          notify();
        });
      });
      void childExited.catch(() => {});
      for (const stream of [child.stdout!, child.stderr!]) {
        stream.on('data', (chunk) => {
          output = (output + chunk.toString()).slice(-128 * 1024);
          notify();
        });
      }
      await wait(() => output.includes('onebot.ready'), 'ready');
      assert.ok(peer);
      assert.doesNotMatch(
        output,
        /app\.group_ready/,
        'membership discovery must not eagerly open group runtimes',
      );
      peer.send(
        JSON.stringify({
          post_type: 'notice',
          notice_type: 'group_msg_emoji_like',
          group_id: A,
          self_id: SELF,
          user_id: '111',
          message_id: '101',
        }),
      );
      emit(A, '101', 'only-A-reaction-body');
      emit(B, '201', 'only-B-reaction-body');
      await wait(
        () => ended() >= 2 && mutations().length === 2,
        'first reaction turns',
      );
      assert.match(
        output,
        /app\.reactions_ready/,
        'reaction catalog is prepared when the first trusted group event opens its runtime',
      );
      assert.equal(connectionCount, 1);
      assert.equal(
        calls.filter((c) => c.action === 'get_login_info').length,
        1,
      );
      assert.equal(sends().length, 1);
      assert.equal(sends()[0]!.params.group_id, A);
      assert.deepEqual(
        new Set(
          mutations().map(
            (c) =>
              `${c.params.message_id}:${c.params.emoji_id}:${c.params.set}`,
          ),
        ),
        new Set(['101:76:true', '201:128077:true']),
      );
      for (const first of requests) {
        const annotation = JSON.parse(
          first.body.messages.filter((m: any) => m.role === 'tool').at(-1)
            .content,
        ).message.reactions;
        assert.equal(annotation.status, 'observed');
        assert.equal(annotation.items[0].count, first.group === A ? 3 : 4);
        assert.ok(!Object.hasOwn(annotation, 'contains_bot'));
      }
      const foreignLookupsBefore = verified.get('201');
      emit(A, '102', 'only-A-followup');
      await wait(
        () => ended() >= 3 && mutations().length === 3,
        'A second reaction turn',
      );
      assert.equal(
        verified.get('201'),
        foreignLookupsBefore,
        'A foreign ID is blocked before any peer lookup, including automatic reads',
      );
      emit(B, '202', 'only-B-followup');
      await wait(
        () => ended() >= 4 && mutations().length === 4,
        'B second reaction turn',
      );
      for (const group of [A, B]) {
        const request = requests.find(
          (r) => r.group === group && r.round === 2,
        )!;
        assert.ok(request);
        assert.equal(Object.hasOwn(request.payload, 'reaction_state'), false);
        const reactionResults = request.body.messages
          .filter(
            (m: any) =>
              m.role === 'tool' &&
              m.tool_call_id.startsWith('fixture_react_message'),
          )
          .map((m: any) => JSON.parse(m.content));
        assert.equal(reactionResults.length, 1);
        assert.equal(
          reactionResults[0].message_id,
          group === A ? '101' : '201',
        );
        assert.equal(reactionResults[0].status, 'ok');
        const messages = JSON.stringify(request.body.messages);
        assert.ok(
          messages.includes(
            group === A ? 'only-A-reaction-body' : 'only-B-reaction-body',
          ),
        );
        assert.ok(
          !messages.includes(
            group === A ? 'only-B-reaction-body' : 'only-A-reaction-body',
          ),
        );
      }
      assert.equal(
        mutations().filter((c) => c.params.message_id === '201').length,
        1,
        'A cannot react to B existing ID',
      );
      assert.deepEqual(
        mutations()
          .filter((c) => c.params.message_id === '101')
          .map((c) => c.params.set),
        [true, false],
      );
      emit(A, '103', 'only-A-error-report');
      await wait(() => ended() >= 5, 'error reported next turn');
      const a3 = requests.find((r) => r.group === A && r.round === 3)!;
      const aResults = a3.body.messages
        .filter(
          (m: any) =>
            m.role === 'tool' &&
            m.tool_call_id.startsWith('fixture_react_message'),
        )
        .map((m: any) => JSON.parse(m.content));
      assert.equal(aResults.filter((r: any) => r.status === 'ok').length, 2);
      assert.deepEqual(
        aResults
          .filter((r: any) => r.status === 'error')
          .map((r: any) => r.error),
        ['message_not_in_context'],
      );
      assert.deepEqual(
        aResults
          .filter((r: any) => r.status === 'ok')
          .map((r: any) => [r.message_id, r.action, r.status]),
        [
          ['101', 'add', 'ok'],
          ['101', 'remove', 'ok'],
        ],
      );
      emit(B, '203', 'only-B-held-reaction');
      await wait(() => heldMutation, 'in-flight native reaction');
      assert.equal(child.kill('SIGTERM'), true);
      assert.deepEqual(await bounded(childExited, 5000), {
        code: 0,
        signal: null,
      });
      assert.ok(output.includes('app.stopped'));
      await wait(
        () => peers.size === 0 && sockets.size === 0,
        'all child network resources closed',
      );
      assert.equal(connectionCount, 1);
      assert.equal(requests.length, 6);
      assert.equal(mutations().length, 5);
      assert.equal(sends().length, 2);
      assert.ok(
        !JSON.stringify(sends()).includes('must-not-send-after-cancel'),
      );
      assert.equal(
        mutations().filter((c) => c.params.message_id === '201').length,
        1,
      );
      for (const [group, path, inputs] of [
        [
          A,
          join(dir, `data/groups/${A}/listener.sqlite`),
          ['101', '102', '103'],
        ],
        [B, join(dir, 'data/groups/22/listener.sqlite'), ['201', '202', '203']],
      ] as const) {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          assert.equal(
            db
              .prepare(
                'SELECT group_id FROM listener_identity WHERE singleton=1',
              )
              .get()!.group_id,
            group,
          );
          const entries = db
            .prepare('SELECT entry FROM listener_messages ORDER BY seq')
            .all()
            .map((row) => JSON.parse(row.entry as string));
          assert.deepEqual(
            new Set(entries.map((e) => e.messageId)),
            new Set([...inputs, ...sentIds.get(group)!]),
          );
          assert.equal(entries.length, 4);
          assert.equal(entries.filter((e) => e.bot).length, 1);
          const data = JSON.stringify(entries);
          assert.ok(!data.includes(group === A ? 'only-B-' : 'only-A-'));
          assert.ok(!data.includes('emoji_id'));
          assert.ok(!data.includes('reaction_state'));
          assert.ok(!data.includes('must-not-send-after-cancel'));
        } finally {
          db.close();
        }
      }
      assert.ok(!output.includes('fixture-model-key'));
      assert.ok(!output.includes('fixture-onebot-token'));
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        try {
          if (childExited) {
            await bounded(childExited, 3000);
          }
        } catch {
          child.kill('SIGKILL');
          if (childExited) {
            await bounded(childExited, 3000).catch(() => {});
          }
        }
      }
      for (const socket of peers) {
        socket.terminate();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all([
        bounded(
          new Promise<void>((resolve) => ws.close(() => resolve())),
          3000,
        ).catch(() => {}),
        bounded(
          new Promise<void>((resolve) => http.close(() => resolve())),
          3000,
        ).catch(() => {}),
      ]);
      rmSync(dir, { recursive: true, force: true });
      changed.removeAllListeners();
    }
  },
);
