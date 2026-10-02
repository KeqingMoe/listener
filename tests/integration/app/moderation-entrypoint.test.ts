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
import { OWNER_ID } from '../../../src/contracts/identity.ts';
import { setTimeout as delay } from 'node:timers/promises';

const A = '111111',
  B = '222222',
  SELF = '99999',
  MEMBER = '123',
  TARGET = '456',
  LOCAL_OWNER = '778899';
const BODY = '普通群聊上下文，不是主人提出的管理指令';

function event(
  group: string,
  messageId: string,
  actor = MEMBER,
  command?: string,
) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: group,
    self_id: SELF,
    user_id: actor,
    message_id: messageId,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: actor, nickname: 'fixture member' },
    message: command
      ? [{ type: 'text', data: { text: command } }]
      : [
          { type: 'at', data: { qq: SELF } },
          { type: 'text', data: { text: BODY } },
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

function payload(body: any): any {
  const message = body.messages
    .filter(
      (m: any) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        JSON.parse(m.content).wake,
    )
    .at(-1);
  assert.ok(message);
  return JSON.parse(message.content).wake;
}

test(
  'real entrypoint uses the configured nondefault owner for confirmation and reset, not the fallback owner',
  { timeout: 20000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moderation-entrypoint-')),
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
      notificationCode = '';
    const calls: Array<{ action: string; params: Record<string, any> }> = [],
      requests: any[] = [],
      sends: Array<{ group: string; text: string }> = [];
    const mutations = () => calls.filter((c) => c.action === 'set_group_ban');
    const op = (name: string, args: unknown) => ({
      id: `op_${requests.length}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
    const http = createServer((req, res) => {
      void (async () => {
        let source = '';
        for await (const chunk of req) {
          source += chunk.toString();
        }
        const body = JSON.parse(source);
        requests.push(body);
        assert.equal(req.headers.authorization, 'Bearer fixture-key');
        assert.equal(req.url, '/v1/chat/completions');
        assert.equal(body.model, 'fixture-moderation');
        const input = payload(body),
          group = input.group_id;
        assert.ok(group === A || group === B);
        assert.equal(Object.hasOwn(input, 'trusted_actor_id'), false);
        assert.equal(Object.hasOwn(input, 'trusted_moderation_allowed'), false);
        assert.ok(!JSON.stringify(input).includes(BODY));
        assert.ok(
          !body.tools.some((t: any) =>
            ['read_messages', 'ack_events'].includes(t.function.name),
          ),
        );
        assert.ok(
          body.tools.some((t: any) => t.function.name === 'read_events'),
        );
        const management = body.tools.filter((t: any) =>
          [
            'mute_member',
            'unmute_member',
            'recall_message',
            'set_member_card',
          ].includes(t.function.name),
        );
        assert.equal(management.length, 1);
        assert.equal(management[0].function.name, 'mute_member');
        assert.match(management[0].function.description, /autonomously/);
        assert.equal(
          management[0].function.parameters.properties.seconds.minimum,
          1,
        );
        assert.ok(
          !JSON.stringify(body.messages).includes(
            'Only the owner in Listener may propose',
          ),
        );
        if (group === A) {
          assert.match(
            management[0].function.description,
            /execute immediately without approval/,
          );
          assert.doesNotMatch(
            management[0].function.description,
            /Requires owner/,
          );
        } else {
          assert.match(
            management[0].function.description,
            /Requires owner \/confirm/,
          );
        }
        let next: ReturnType<typeof op>;
        const toolMessages = body.messages.filter(
          (m: any) => m.role === 'tool',
        );
        if (toolMessages.length === 0) {
          assert.ok(JSON.stringify(body.messages).includes(BODY));
          next = op('read_events', { limit: 100 });
        } else if (toolMessages.length === 1) {
          const result = JSON.parse(toolMessages[0].content);
          assert.equal(result.status, 'ok');
          assert.equal(
            result.events.map((event: any) => event.payload.message).length,
            1,
          );
          assert.equal(
            result.events.map((event: any) => event.payload.message)[0]
              .messageId,
            group === A ? '101' : '201',
          );
          assert.equal(
            result.events.map((event: any) => event.payload.message)[0].userId,
            MEMBER,
          );
          assert.ok(
            JSON.stringify(
              result.events.map((event: any) => event.payload.message)[0],
            ).includes(BODY),
          );
          next = op('mute_member', { user_id: TARGET, seconds: 120 });
        } else {
          assert.equal(group, A);
          assert.equal(toolMessages.length, 2);
          const { wake_budget, ...result } = JSON.parse(
            toolMessages.at(-1).content,
          );
          assert.deepEqual(result, { status: 'executed' });
          assert.equal(wake_budget.used_tool_calls, 2);
          assert.deepEqual(
            mutations().map((c) => c.params),
            [{ group_id: A, user_id: TARGET, duration: 120 }],
          );
          assert.equal(sends.length, 0);
          next = op('finish', { mode: 'hard' });
        }
        sendChatStream(res, {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  next,
                  ...(group === B && next.function.name === 'mute_member'
                    ? [{ ...op('finish', { mode: 'hard' }), id: 'finish_B' }]
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
    ws.on('connection', (socket, req) => {
      try {
        assert.equal(req.headers.authorization, 'Bearer fixture-token');
      } catch (error) {
        fail(error);
      }
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
            data = [A, B].map((group_id) => ({ group_id }));
          } else if (call.action === 'get_group_member_info') {
            assert.ok([A, B].includes(call.params.group_id));
            assert.equal(call.params.no_cache, true);
            assert.ok([SELF, TARGET].includes(call.params.user_id));
            data = {
              group_id: call.params.group_id,
              user_id: call.params.user_id,
              role: call.params.user_id === SELF ? 'admin' : 'member',
            };
          } else if (call.action === 'set_group_ban') {
            assert.ok([A, B].includes(call.params.group_id));
            assert.equal(call.params.user_id, TARGET);
            assert.equal(call.params.duration, 120);
            data = call.params.group_id === A ? undefined : null; // 与真实handler一致返回void/null，而非虚构的空对象ACK。
          } else if (call.action === 'send_group_msg') {
            assert.ok(Array.isArray(call.params.message));
            assert.ok(call.params.message.every((s: any) => s.type === 'text'));
            const text = call.params.message
              .map((s: any) => s.data.text)
              .join('');
            if (sends.length === 0) {
              assert.equal(call.params.group_id, B);
              assert.match(text, /待主人确认/);
              assert.match(text, /禁言 QQ 456 120 秒/);
              notificationCode =
                text.match(/\/confirm ([a-f0-9]{32})/)?.[1] ?? '';
              assert.equal(notificationCode.length, 32);
              assert.equal(mutations().length, 1);
            } else if (sends.length === 1) {
              assert.equal(call.params.group_id, A);
              assert.match(text, /未能确认执行成功/);
              assert.equal(mutations().length, 1);
            } else if (sends.length === 2) {
              assert.equal(call.params.group_id, B);
              assert.equal(text, '已执行确认的管理操作。');
              assert.equal(mutations().length, 2);
            } else {
              assert.equal(sends.length, 3);
              assert.equal(call.params.group_id, A);
              assert.equal(text, '本群对话记忆已清空。');
              assert.equal(mutations().length, 2);
            }
            sends.push({ group: call.params.group_id, text });
            data = { message_id: String(9000 + sends.length) };
          } else {
            throw new Error(`unexpected fixture API: ${call.action}`);
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
    const ended = () => [...output.matchAll(/\bturn\.end\b/g)].length,
      commandsEnded = () => [...output.matchAll(/\bcommand\.end\b/g)].length;
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
        'Isolated autonomous moderation fixture.',
      );
      writeFileSync(
        join(dir, '.env'),
        'FIXTURE_TOKEN=fixture-token\nFIXTURE_KEY=fixture-key\n',
        { mode: 0o600 },
      );
      writeFileSync(
        join(dir, 'config.toml'),
        `[bot]
owner_id = "${LOCAL_OWNER}"
[onebot]
url = "ws://127.0.0.1:${wsPort}"
token_env = "FIXTURE_TOKEN"
[models.main]
tool_schema = "json"
base_url = "http://127.0.0.1:${httpPort}/v1"
model = "fixture-moderation"
api_key_env = "FIXTURE_KEY"
timeout_ms = 10000
[storage]
directory = "data"
telemetry_path = "data/listener.sqlite.telemetry.sqlite"
[defaults]
enabled = false
persona = "prompts/listener.md"
reply = { delay_ms = [100,100], cooldown_ms = 1000, random = false }
messages.mentions = false
observation.reactions = false
tools = {
  get_group_members = "off",
  get_member_info = "off",
  react_message = "off",
  mute_member = "off",
  unmute_member = "off",
  recall_message = "off",
  set_member_card = "off",
}
[logging]
level = "debug"
console = true
file = false
[groups."${A}"]
enabled = true
tools.mute_member = "direct"
[groups."${B}"]
enabled = true
tools.mute_member = "confirm"
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
      peer!.send(JSON.stringify(event(A, '101')));
      await wait(() => ended() === 1, 'autonomous direct action and silence');
      assert.equal(requests.length, 3);
      assert.equal(mutations().length, 1);
      assert.equal(sends.length, 0);
      assert.deepEqual(
        calls.map((c) => c.action),
        [
          'get_login_info',
          'get_group_list',
          'get_login_info',
          'get_group_member_info',
          'get_group_member_info',
          'set_group_ban',
        ],
      );
      const beforeProposal = calls.length;
      peer!.send(JSON.stringify(event(B, '201')));
      await wait(() => ended() === 2, 'autonomous confirmation proposal');
      assert.equal(requests.length, 5);
      assert.equal(mutations().length, 1);
      assert.equal(sends.length, 1);
      assert.deepEqual(
        calls.slice(beforeProposal).map((c) => c.action),
        [
          'get_login_info',
          'get_group_member_info',
          'get_group_member_info',
          'send_group_msg',
        ],
      );
      const beforeUnauthorized = calls.length;
      peer!.send(
        JSON.stringify(
          event(B, '202', OWNER_ID, `/confirm ${notificationCode}`),
        ),
      );
      await wait(
        () => output.includes('command.denied'),
        'nonowner confirmation denial',
      );
      assert.equal(calls.length, beforeUnauthorized);
      peer!.send(
        JSON.stringify(
          event(A, '102', LOCAL_OWNER, `/confirm ${notificationCode}`),
        ),
      );
      await wait(
        () => commandsEnded() === 1,
        'wrong-group owner confirmation denial',
      );
      assert.equal(sends.length, 2);
      assert.equal(calls.length, beforeUnauthorized + 1);
      assert.equal(mutations().length, 1);
      const beforeConfirmation = calls.length;
      peer!.send(
        JSON.stringify(
          event(B, '203', LOCAL_OWNER, `/confirm ${notificationCode}`),
        ),
      );
      await wait(
        () => commandsEnded() === 2,
        'owner confirms in original group',
      );
      assert.deepEqual(
        calls.slice(beforeConfirmation).map((c) => c.action),
        [
          'get_login_info',
          'get_group_member_info',
          'get_group_member_info',
          'set_group_ban',
          'send_group_msg',
        ],
      );
      assert.deepEqual(
        mutations().map((c) => c.params),
        [
          { group_id: A, user_id: TARGET, duration: 120 },
          { group_id: B, user_id: TARGET, duration: 120 },
        ],
      );
      assert.equal(sends.length, 3);
      assert.equal(requests.length, 5);
      const denied = () => [...output.matchAll(/\bcommand\.denied\b/g)].length;
      const beforeReset = calls.length;
      peer!.send(JSON.stringify(event(B, '204', OWNER_ID, '/reset')));
      peer!.send(JSON.stringify(event(B, '205', MEMBER, '/reset')));
      await wait(
        () => denied() === 3,
        'fallback owner and ordinary member cannot reset',
      );
      assert.equal(calls.length, beforeReset);
      await delay(2100);
      peer!.send(JSON.stringify(event(A, '103', LOCAL_OWNER, '/reset')));
      await wait(
        () => commandsEnded() === 3,
        'local owner resets only group A',
      );
      assert.equal(sends.length, 4);
      assert.equal(requests.length, 5);
      assert.ok(!output.includes(BODY));
      assert.ok(!output.includes(notificationCode));
      assert.equal(child.kill('SIGTERM'), true);
      assert.deepEqual(await bounded(exit), { code: 0, signal: null });
      assert.ok(output.includes('app.stopped'));
      for (const [group, input, other] of [
        [A, '101', '201'],
        [B, '201', '101'],
      ]) {
        const db = new DatabaseSync(
          join(dir, `data/groups/${group}/listener.sqlite`),
          { readOnly: true },
        );
        try {
          const rows = db
            .prepare('SELECT entry FROM listener_messages ORDER BY seq')
            .all()
            .map((row) => JSON.parse(row.entry as string));
          assert.deepEqual(
            rows.map((row) => row.messageId),
            group === A
              ? ['9004']
              : ['201', '9001', '202', '203', '9003', '204', '205'],
          );
          assert.equal(
            rows.filter((row) => !row.bot).length,
            group === A ? 0 : 5,
          );
          assert.equal(
            rows.some((row) => row.messageId === input),
            group === B,
          );
          assert.ok(!rows.some((row) => row.messageId === other));
          assert.equal(
            rows.filter((row) => row.bot).length,
            group === A ? 1 : 2,
          );
          assert.equal(
            db.prepare('SELECT COUNT(*) AS n FROM listener_summary').get()!.n,
            0,
          );
        } finally {
          db.close();
        }
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
