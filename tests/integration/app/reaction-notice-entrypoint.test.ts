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

const GROUP = LISTENER_GROUP,
  OTHER = '22',
  SELF = '99999',
  BOT_MESSAGE = '9001';

function message(id: string, text: string, user = '111') {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP,
    user_id: user,
    self_id: SELF,
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: user, nickname: 'fixture' },
    message: [
      { type: 'at', data: { qq: SELF } },
      { type: 'text', data: { text } },
    ],
  };
}

async function bounded<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('fixture timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  'real entrypoint receives wire reaction notices and refreshes the bot message next turn without waking on notices',
  { timeout: 20000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reaction-notice-entrypoint-'));
    const changed = new EventEmitter();
    let failure: unknown,
      output = '',
      child: ChildProcess | undefined,
      exit:
        | Promise<{ code: number | null; signal: NodeJS.Signals | null }>
        | undefined;
    const notify = () => changed.emit('change'),
      fail = (error: unknown) => {
        failure = error;
        notify();
      };
    const peers = new Set<WebSocket>(),
      sockets = new Set<Socket>();
    let peer: WebSocket | undefined,
      botCount = 1;
    const stored = new Map<string, ReturnType<typeof message>>(),
      calls: Array<{ action: string; params: Record<string, unknown> }> = [],
      payloads: any[] = [];
    let wakeNumber = 0,
      wakeStep = 0;
    const aggregates: any[] = [];
    const http = createServer((req, res) => {
      void (async () => {
        let source = '';
        for await (const chunk of req) {
          source += chunk.toString();
        }
        const body = JSON.parse(source);
        assert.equal(req.headers.authorization, 'Bearer fixture-key');
        assert.equal(body.model, 'fixture-notice-model');
        const wakeIndex = body.messages.findLastIndex(
          (m: any) =>
            m.role === 'user' &&
            typeof m.content === 'string' &&
            JSON.parse(m.content).wake,
        );
        const wake = JSON.parse(body.messages[wakeIndex].content).wake,
          current = body.messages.slice(wakeIndex + 1);
        assert.equal(wake.group_id, GROUP);
        assert.equal(Object.hasOwn(wake, 'reaction_state'), false);
        if (!payloads.length || payloads.at(-1).wake_id !== wake.wake_id) {
          wakeNumber++;
          wakeStep = 0;
          payloads.push(wake);
          assert.doesNotMatch(
            JSON.stringify(wake),
            /fixture normal turn|reactions|current_batch/,
          );
        }
        if (wakeStep === 1) {
          const result = JSON.parse(
            current.filter((m: any) => m.role === 'tool').at(-1).content,
          );
          assert.equal(result.status, 'ok');
          assert.ok(
            JSON.stringify(result).includes(
              `fixture normal turn ${100 + wakeNumber}`,
            ),
          );
          if (wakeNumber === 4) {
            const hint = result.events.find(
              (entry: any) => entry.type === 'reaction.changed',
            );
            assert.ok(hint);
            assert.equal(Object.hasOwn(hint, 'actor_id'), false);
            assert.equal(Object.hasOwn(hint.payload, 'action'), false);
            assert.equal(Object.hasOwn(hint.payload, 'count'), false);
          }
        }
        if (wakeStep === 3 && wakeNumber > 1) {
          const last = current.filter((m: any) => m.role === 'tool').at(-1);
          const aggregate = JSON.parse(last.content);
          assert.equal(aggregate.status, 'ok');
          assert.equal(aggregate.message.messageId, BOT_MESSAGE);
          assert.equal(
            aggregate.message.reactions.items[0].count,
            wakeNumber === 4 ? 9 : 1,
          );
          aggregates.push(aggregate.message);
        }
        const step = wakeStep++;
        const op =
          step === 0
            ? { name: 'read_events', arguments: '{"limit":100}' }
            : step === 1
              ? { name: 'read_events', arguments: '{"limit":100}' }
              : step === 2
                ? wakeNumber === 1
                  ? {
                      name: 'send_message',
                      arguments: JSON.stringify({
                        segments: [
                          {
                            type: 'text',
                            text: 'bot message to receive reaction',
                          },
                        ],
                      }),
                    }
                  : {
                      name: 'read_message',
                      arguments: JSON.stringify({ message_id: BOT_MESSAGE }),
                    }
                : { name: 'finish', arguments: '{"mode":"hard"}' };
        sendChatStream(res, {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `op_${wakeNumber}_${wakeStep}`,
                    type: 'function',
                    function: op,
                  },
                  ...(op.name === 'send_message'
                    ? [
                        {
                          id: `finish_${payloads.length}`,
                          type: 'function',
                          function: {
                            name: 'finish',
                            arguments: '{"mode":"hard"}',
                          },
                        },
                      ]
                    : []),
                ],
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
    ws.on('connection', (socket) => {
      peer = socket;
      peers.add(socket);
      socket.once('close', () => {
        peers.delete(socket);
        notify();
      });
      socket.on('error', fail);
      socket.on('message', (raw) => {
        try {
          const call = JSON.parse(raw.toString());
          calls.push(call);
          let data: unknown;
          if (call.action === 'get_login_info') {
            data = { user_id: SELF };
          } else if (call.action === 'get_group_list') {
            data = [GROUP, OTHER].map((group_id) => ({ group_id }));
          } else if (call.action === 'send_group_msg') {
            assert.equal(call.params.group_id, GROUP);
            const own = message(
              BOT_MESSAGE,
              'bot message to receive reaction',
              SELF,
            );
            own.message = call.params.message;
            stored.set(BOT_MESSAGE, own);
            data = { message_id: BOT_MESSAGE };
          } else if (call.action === 'get_msg') {
            const id = String(call.params.message_id),
              original = stored.get(id);
            assert.ok(original, 'no arbitrary message lookup');
            data = {
              message_type: 'group',
              group_id: GROUP,
              message_id: id,
              sender: { user_id: original.user_id },
              user_id: original.user_id,
              time: original.time,
              message: original.message,
              emoji_likes_list:
                id === BOT_MESSAGE
                  ? [
                      {
                        emoji_id: '76',
                        emoji_type: '1',
                        likes_cnt: String(botCount),
                      },
                    ]
                  : [],
            };
          } else {
            throw new Error(`unexpected action: ${call.action}`);
          }
          socket.send(
            JSON.stringify({ status: 'ok', retcode: 0, echo: call.echo, data }),
          );
          notify();
        } catch (error) {
          fail(error);
        }
      });
      notify();
    });
    const wait = (predicate: () => boolean, label: string): Promise<void> =>
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
          () => finish(Error(`${label}: ${output.slice(-3000)}`)),
          6000,
        );
        check();
      });
    const ended = () => [...output.matchAll(/\bturn\.end\b/g)].length;
    const emitMessage = (id: string) => {
      const event = message(id, `fixture normal turn ${id}`);
      stored.set(id, event);
      peer!.send(JSON.stringify(event));
    };
    const botReads = () =>
      calls.filter(
        (c) => c.action === 'get_msg' && c.params.message_id === BOT_MESSAGE,
      ).length;
    // 聚合快照只能通过显式的read_message调用观察到。
    // WebSocket保序，因此pong是之前所有notice帧之后的确定性屏障。
    const barrier = async () => {
      const pong = once(peer!, 'pong');
      peer!.ping();
      await bounded(pong);
    };
    try {
      const listening = ws.address()
        ? Promise.resolve()
        : once(ws, 'listening');
      http.listen(0, '127.0.0.1');
      await Promise.all([listening, once(http, 'listening')]);
      const wsPort = (ws.address() as AddressInfo).port,
        httpPort = (http.address() as AddressInfo).port;
      mkdirSync(join(dir, 'prompts'));
      writeFileSync(
        join(dir, 'prompts/listener.md'),
        'Isolated fake reaction-notice integration test.',
      );
      writeFileSync(
        join(dir, '.env'),
        'FIXTURE_TOKEN=fixture-token\nFIXTURE_KEY=fixture-key\n',
        { mode: 0o600 },
      );
      writeFileSync(
        join(dir, 'config.toml'),
        `[bot]
owner_id = "778899"
[onebot]
url = "ws://127.0.0.1:${wsPort}"
token_env = "FIXTURE_TOKEN"
[models.main]
base_url = "http://127.0.0.1:${httpPort}/v1"
model = "fixture-notice-model"
api_key_env = "FIXTURE_KEY"
timeout_ms = 10000
[storage]
directory = "data"
telemetry_path = "data/listener.sqlite.telemetry.sqlite"
[defaults]
enabled = false
persona = "prompts/listener.md"
reply = { delay_ms = [100,100], cooldown_ms = 1000, random = false }
observation.reactions = true
tools = { react_message = "direct", get_reaction_users = "direct", manage_attention = "direct" }
[logging]
level = "debug"
console = true
file = false
[groups."${GROUP}"]
enabled = true
[groups."${OTHER}"]
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
      exit = new Promise((resolve, reject) => {
        child!.once('error', (error) => {
          fail(error);
          reject(error);
        });
        child!.once('close', (code, signal) => {
          resolve({ code, signal });
          notify();
        });
      });
      void exit.catch(() => {});
      for (const stream of [child.stdout!, child.stderr!]) {
        stream.on('data', (chunk) => {
          output = (output + chunk.toString()).slice(-128 * 1024);
          notify();
        });
      }
      await wait(() => output.includes('onebot.ready'), 'startup');
      emitMessage('101');
      await wait(() => ended() === 1, 'first turn sends bot message');
      assert.equal(stored.get(BOT_MESSAGE)?.user_id, SELF);
      emitMessage('102');
      await wait(
        () => ended() === 2,
        'explicit observation reads reaction target',
      );
      assert.equal(botReads(), 1);
      assert.equal(payloads[1].group_id, GROUP);
      assert.equal(
        JSON.stringify(payloads[1]).includes('fixture normal turn'),
        false,
      );
      const initialBotReads = botReads(),
        initialCalls = calls.length;
      botCount = 3;
      const notice = {
        post_type: 'notice',
        self_id: SELF,
        notice_type: 'group_msg_emoji_like',
        group_id: GROUP,
        message_id: BOT_MESSAGE,
        likes: [{ emoji_id: '76', count: 9000 }],
        is_add: true,
        user_id: '111',
      };
      for (const event of [
        { ...notice, group_id: '888' },
        { ...notice, group_id: OTHER },
        { ...notice, notice_type: 'friend_msg_emoji_like' },
        { ...notice, post_type: 'message', message_type: 'private' },
      ]) {
        peer!.send(JSON.stringify(event));
      }
      await barrier();
      assert.equal(payloads.length, 2);
      assert.equal(
        calls.length,
        initialCalls,
        'irrelevant notice packets do not fetch or send',
      );
      emitMessage('103');
      await wait(
        () => ended() === 3,
        'foreign notifications did not dirty target',
      );
      assert.equal(
        botReads(),
        initialBotReads,
        'foreign notices cannot invalidate the fresh own-group aggregate cache',
      );
      botCount = 9;
      const beforeNotice = calls.length;
      peer!.send(JSON.stringify(notice));
      await barrier();
      assert.equal(
        payloads.length,
        3,
        'the real notice transport must not independently invoke the model',
      );
      assert.equal(
        calls.length,
        beforeNotice,
        'notice is a cache hint, not an immediate API query/send',
      );
      emitMessage('104');
      await wait(() => ended() === 4, 'reaction notice refreshed bot target');
      assert.equal(
        botReads(),
        initialBotReads + 1,
        'own-group notice invalidates aggregate cache only when explicitly read',
      );
      assert.deepEqual(
        aggregates.map((value) => value.reactions.items[0].count),
        [1, 1, 9],
      );
      assert.equal(payloads[3].group_id, GROUP);
      assert.equal(wakeNumber, 4);
      assert.equal(
        calls.filter((c) => c.action === 'send_group_msg').length,
        1,
      );
      assert.equal(
        calls.filter((c) => c.action === 'set_msg_emoji_like').length,
        0,
      );
      assert.equal(child.kill('SIGTERM'), true);
      assert.deepEqual(await bounded(exit), { code: 0, signal: null });
      assert.ok(output.includes('app.stopped'));
      const db = new DatabaseSync(
        join(dir, `data/groups/${GROUP}/listener.sqlite`),
        { readOnly: true },
      );
      try {
        const rows = db
          .prepare('SELECT entry FROM listener_messages')
          .all()
          .map((row) => JSON.parse(row.entry as string));
        assert.equal(rows.length, 5, 'notices never create chat-memory rows');
        assert.equal(rows.filter((row) => row.bot).length, 1);
      } finally {
        db.close();
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        try {
          if (exit) {
            await bounded(exit);
          }
        } catch {
          child.kill('SIGKILL');
          if (exit) {
            await bounded(exit).catch(() => {});
          }
        }
      }
      for (const peer of peers) {
        peer.terminate();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all([
        bounded(
          new Promise<void>((resolve) => ws.close(() => resolve())),
        ).catch(() => {}),
        bounded(
          new Promise<void>((resolve) => http.close(() => resolve())),
        ).catch(() => {}),
      ]);
      rmSync(dir, { recursive: true, force: true });
      changed.removeAllListeners();
    }
  },
);
