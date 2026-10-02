import test from 'node:test';
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
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import { sendChatStream } from '../../support/model-sse.ts';

const GROUP = LISTENER_GROUP,
  SELF = '99999',
  TARGET = '9001';

function message(id: string, body: string, user = OWNER_ID) {
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
      { type: 'text', data: { text: body } },
    ],
  };
}

async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
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
  'real entrypoint queries reaction users on demand, keeps pagination opaque, and shows verified target membership',
  { timeout: 20000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reaction-users-entrypoint-')),
      changed = new EventEmitter();
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
      sent = 0,
      pages = 0,
      proofAfter = 0;
    const stored = new Map<string, ReturnType<typeof message>>(),
      calls: Array<{ action: string; params: Record<string, unknown> }> = [],
      requests: any[] = [];
    const op = (name: string, args: unknown) => ({
      id: `op_${requests.length}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
    const query = (cursor?: string) =>
      op('get_reaction_users', {
        message_id: TARGET,
        emoji_id: '76',
        emoji_type: '1',
        user_id: OWNER_ID,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
    const send = (body: string) =>
      op('send_message', { segments: [{ type: 'text', text: body }] });
    const finish = () => op('finish', { mode: 'hard' });
    const http = createServer((req, res) => {
      void (async () => {
        let source = '';
        for await (const chunk of req) {
          source += chunk.toString();
        }
        const body = JSON.parse(source);
        assert.equal(req.headers.authorization, 'Bearer fixture-key');
        assert.equal(body.model, 'fixture-reaction-users');
        requests.push(body);
        assert.ok(
          body.tools.some((t: any) => t.function.name === 'get_reaction_users'),
        );
        assert.ok(!source.includes('avatar-secret.invalid'));
        assert.ok(!source.includes('native-cookie-never-to-model'));
        assert.ok(!source.includes('native-second-cookie'));
        let next: ReturnType<typeof op>;
        if (requests.length === 1) {
          assert.equal(pages, 0);
          assert.ok(source.includes('fixture initial request'));
          assert.equal(
            Object.hasOwn(
              JSON.parse(
                body.messages.findLast((m: any) => m.role === 'user').content,
              ),
              'reaction_state',
            ),
            false,
          );
          next = op('read_events', { limit: 100 });
        } else if (requests.length === 2) {
          assert.ok(source.includes('fixture initial request'));
          next = send('initial bot reply');
        } else if (requests.length === 3) {
          assert.equal(pages, 0);
          const wake = body.messages.findLast((m: any) => m.role === 'user');
          assert.ok(wake.content.includes('我给你点了赞'));
          next = op('read_events', { limit: 100 });
        } else if (requests.length === 4) {
          assert.ok(source.includes('我给你点了赞'));
          assert.equal(
            pages,
            0,
            'event and message reads do not fetch user lists',
          );
          proofAfter = calls.length;
          next = query();
        } else {
          const result = JSON.parse(
            body.messages.filter((m: any) => m.role === 'tool').at(-1).content,
          );
          assert.equal(result.status, requests.length === 7 ? 'ok' : 'partial');
          assert.equal(result.target_user_id, OWNER_ID);
          if (requests.length === 5) {
            assert.equal(result.target_found, null);
            assert.equal(result.complete, false);
            assert.equal(result.has_more, true);
            assert.equal(typeof result.next_cursor, 'string');
            assert.notEqual(result.next_cursor, 'native-cookie-never-to-model');
            proofAfter = calls.length;
            next = query(result.next_cursor);
          } else if (requests.length === 6) {
            assert.equal(result.target_found, true);
            assert.equal(result.complete, false);
            assert.equal(result.has_more, true);
            assert.ok(
              result.users.some(
                (u: any) =>
                  u.user_id === OWNER_ID && u.nickname === 'fixture owner',
              ),
            );
            proofAfter = calls.length;
            next = query(result.next_cursor);
          } else {
            assert.equal(requests.length, 7);
            assert.equal(
              result.target_found,
              true,
              'finding the target on an earlier page survives a final empty EOF page',
            );
            assert.equal(result.complete, true);
            assert.equal(result.has_more, false);
            next = send('verified reaction membership');
          }
        }
        sendChatStream(res, {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls:
                  next.function.name === 'send_message'
                    ? [next, { ...finish(), id: `finish_${requests.length}` }]
                    : [next],
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
            data = [{ group_id: GROUP }];
          } else if (call.action === 'send_group_msg') {
            assert.equal(call.params.group_id, GROUP);
            const id = String(9001 + sent++),
              own = message(id, 'fixture bot', SELF);
            own.message = call.params.message;
            stored.set(id, own);
            data = { message_id: id };
          } else if (call.action === 'get_msg') {
            const id = String(call.params.message_id),
              original = stored.get(id);
            assert.ok(
              original,
              'only known local group message IDs may be queried',
            );
            data = {
              message_type: 'group',
              group_id: GROUP,
              message_id: id,
              sender: { user_id: original.user_id },
              user_id: original.user_id,
              time: original.time,
              message: original.message,
              emoji_likes_list:
                id === TARGET
                  ? [{ emoji_id: '76', emoji_type: '1', likes_cnt: '2' }]
                  : [],
            };
          } else if (call.action === 'fetch_emoji_like') {
            assert.equal(call.params.message_id, TARGET);
            assert.equal(call.params.emojiId, '76');
            assert.equal(call.params.emojiType, '1');
            assert.equal(call.params.count, 20);
            assert.equal(Object.hasOwn(call.params, 'group_id'), false);
            assert.equal(Object.hasOwn(call.params, 'user_id'), false);
            const previous = calls[calls.length - 2];
            assert.ok(
              calls.length - 2 >= proofAfter,
              'fresh group proof is required after the model requests each page',
            );
            assert.equal(previous?.action, 'get_msg');
            assert.equal(previous?.params.message_id, TARGET);
            pages++;
            assert.ok(pages <= 3);
            assert.equal(
              call.params.cookie,
              pages === 1
                ? ''
                : pages === 2
                  ? 'native-cookie-never-to-model'
                  : 'native-second-cookie',
            );
            data = {
              result: 0,
              emojiLikesList:
                pages === 3
                  ? []
                  : [
                      {
                        tinyId: pages === 1 ? '222' : OWNER_ID,
                        nickName:
                          pages === 1 ? 'other member' : 'fixture owner',
                        headUrl: 'https://avatar-secret.invalid/private',
                      },
                    ],
              cookie:
                pages === 1
                  ? 'native-cookie-never-to-model'
                  : pages === 2
                    ? 'native-second-cookie'
                    : '',
              isLastPage: pages === 3,
              isFirstPage: pages === 1,
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
    const emit = (id: string) => {
      const value = message(
        id,
        id === '101' ? 'fixture initial request' : '我给你点了赞，能确认名单吗',
      );
      stored.set(id, value);
      peer!.send(JSON.stringify(value));
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
        'Isolated reaction-user listing fixture.',
      );
      writeFileSync(
        join(dir, '.env'),
        'FIXTURE_TOKEN=fixture-token\nFIXTURE_KEY=fixture-key\n',
        { mode: 0o600 },
      );
      writeFileSync(
        join(dir, 'config.toml'),
        `[bot]
owner_id = "${OWNER_ID}"
[onebot]
url = "ws://127.0.0.1:${wsPort}"
token_env = "FIXTURE_TOKEN"
[models.main]
base_url = "http://127.0.0.1:${httpPort}/v1"
model = "fixture-reaction-users"
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
tools = {
  get_group_members = "off",
  get_member_info = "off",
  react_message = "direct",
  get_reaction_users = "direct",
}
[logging]
level = "debug"
console = true
file = false
[groups."${GROUP}"]
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
      emit('101');
      await wait(() => ended() === 1, 'initial reply');
      assert.equal(sent, 1);
      assert.equal(pages, 0);
      emit('102');
      await wait(() => ended() === 2, 'paginated actor query answered');
      assert.equal(pages, 3);
      assert.equal(sent, 2);
      assert.equal(requests.length, 7);
      assert.ok(!output.includes('avatar-secret.invalid'));
      assert.ok(!output.includes('native-cookie-never-to-model'));
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
          .map((r) => JSON.parse(r.entry as string));
        assert.equal(rows.length, 4);
        assert.equal(rows.filter((r) => r.bot).length, 2);
        assert.ok(!JSON.stringify(rows).includes('avatar-secret.invalid'));
        assert.ok(!JSON.stringify(rows).includes('target_found'));
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
