import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { OneBotClient } from '../../../src/onebot/client.ts';
import { ArtifactStore } from '../../../src/artifacts/store.ts';
import { Listener } from '../../../src/agent/listener.ts';
import { ModelSession } from '../../../src/agent/session/store.ts';
import { WorldEventStore } from '../../../src/world/events.ts';
import { configureLogging } from '../../../src/observability/logger.ts';
import { OWNER_ID } from '../../../src/contracts/identity.ts';
import {
  type ChatMessage,
  type Completion,
} from '../../../src/contracts/model.ts';
import { type JsonObject } from '../../../src/contracts/json.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import type { ExtendedToolsConfig } from '../../../src/config/extended-tools.ts';
import { toolPermissions } from '../../support/tool-permissions.ts';

const GROUP = '123456',
  SELF = '999',
  ACTOR = '111',
  OTHER = '222';
const call = (
  id: string,
  name: string,
  args: JsonObject = name === 'finish' ? { mode: 'hard' } : {},
) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const response = (...tool_calls: Completion['tool_calls']): Completion => ({
  content: null,
  tool_calls,
});
const event = (id = '1', actor = ACTOR, text = '执行测试', mention = true) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: GROUP,
  self_id: SELF,
  user_id: actor,
  message_id: id,
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: 'fixture' },
  message: [
    ...(mention ? [{ type: 'at', data: { qq: SELF } }] : []),
    { type: 'text', data: { text } },
  ],
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

type Native = { action: string; params: JsonObject; at: number };
type Envelope = { status: string; retcode: number; data?: unknown };
const ok = (data?: unknown): Envelope => ({ status: 'ok', retcode: 0, data });

interface Options {
  extended: ExtendedToolsConfig;
  respond: (round: number, messages: ChatMessage[]) => Completion;
  native?: (
    call: Native,
    h: Harness,
  ) => Envelope | undefined | Promise<Envelope | undefined>;
  reactions?: boolean;
  artifacts?: ArtifactStore;
}

interface Harness {
  listener: Listener;
  session: ModelSession;
  world: WorldEventStore;
  memory: Memory;
  calls: Native[];
  requests: ChatMessage[][];
  run(rounds?: number): Promise<void>;
  command(text: string): Promise<void>;
  settle(rounds?: number): Promise<void>;
  results(): Record<string, JsonObject>;
  logs(): Promise<JsonObject[]>;
}

async function fixture(
  options: Options,
  check: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-outcomes-')),
    logDir = join(dir, 'logs');
  const logging = configureLogging({
    level: 'debug',
    console: false,
    file: true,
    directory: logDir,
    retentionDays: 1,
    maxFileMb: 1,
    maxTotalMb: 10,
  });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const peers = new Set<WebSocket>(),
    calls: Native[] = [],
    requests: ChatMessage[][] = [],
    failures: unknown[] = [];
  const session = new ModelSession({
      model: 'main',
      path: join(dir, 'session.sqlite'),
      groupId: GROUP,
    }),
    world = new WorldEventStore({
      path: join(dir, 'world.sqlite'),
      groupId: GROUP,
    }),
    mem = memory();
  let listener: Listener | undefined,
    client: OneBotClient | undefined,
    h: Harness;
  let listing = 0,
    sent = 0;
  server.on('connection', (peer) => {
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    peer.on('message', (raw) => {
      void (async () => {
        const packet = JSON.parse(raw.toString()) as {
          action: string;
          params: JsonObject;
          echo: string;
        };
        const entry = {
          action: packet.action,
          params: packet.params,
          at: Date.now(),
        };
        calls.push(entry);
        let envelope = await options.native?.(entry, h);
        if (!envelope) {
          let data: unknown;
          switch (entry.action) {
            case 'get_login_info':
              data = { user_id: SELF };
              break;
            case 'get_group_member_info':
              assert.equal(entry.params.group_id, GROUP);
              data = {
                group_id: GROUP,
                user_id: entry.params.user_id,
                role: entry.params.user_id === SELF ? 'owner' : 'member',
              };
              break;
            case 'get_msg':
              data = {
                message_id: String(entry.params.message_id),
                message_type: 'group',
                group_id: GROUP,
                user_id: ACTOR,
                sender: { user_id: ACTOR },
                message: [{ type: 'text', data: { text: 'source' } }],
                emoji_likes_list: [],
              };
              break;
            case '_get_group_notice':
              data = [
                {
                  group_id: GROUP,
                  notice_id: 'notice-1',
                  sender_id: ACTOR,
                  message: { text: 'notice' },
                },
              ];
              break;
            case 'get_ai_characters':
              data = [
                {
                  type: '常用',
                  characters: [
                    {
                      character_id: 'voice_0',
                      character_name: '声线',
                      preview_url: 'https://fixture.invalid/private',
                    },
                  ],
                },
              ];
              break;
            case 'get_group_info':
              data = {
                group_id: GROUP,
                group_name: 'fixture',
                member_count: 3,
                max_member_count: 100,
              };
              break;
            case 'send_group_msg':
              data = { message_id: String(9000 + ++sent) };
              break;
            case 'get_group_root_files':
              data = {
                files: [
                  {
                    group_id: GROUP,
                    file_id: `PROVIDER-TOKEN-${++listing}`,
                    file_name: 'report.txt',
                    file_size: 3,
                    uploader: SELF,
                    upload_time: 1000,
                  },
                ],
                folders: [],
              };
              break;
            case 'get_group_system_msg':
              data = {
                join_requests: [
                  {
                    request_id: 1780000000000001,
                    group_id: Number(GROUP),
                    invitor_uin: Number(OTHER),
                    message: 'hello',
                    checked: false,
                    actor: 0,
                  },
                ],
                invited_requests: [],
              };
              break;
            case 'group_poke':
              data = null;
              break;
            default:
              throw new Error(`Unexpected synthetic action ${entry.action}`);
          }
          envelope = ok(data);
        }
        const wire = JSON.stringify({ ...envelope, echo: packet.echo });
        if (envelope.data === undefined) {
          assert.equal(Object.hasOwn(JSON.parse(wire), 'data'), false);
        }
        peer.send(wire);
      })().catch((error) => {
        failures.push(error);
        peer.terminate();
      });
    });
  });
  try {
    await once(server, 'listening');
    client = new OneBotClient({
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: 'fixture',
      apiTimeoutMs: 2000,
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
        ...options.extended,
        react_message: options.reactions ? 'direct' : 'off',
        get_reaction_users: options.reactions ? 'direct' : 'off',
        mute_member: { mode: 'off', maxSeconds: 600 },
      }),
      ...(options.reactions ? { observeReactions: true } : {}),
      messageMentions: false,
      confirmationTtlSeconds: 60,
    };
    listener = new Listener(
      client,
      {
        async complete(messages) {
          requests.push(structuredClone(messages));
          try {
            return options.respond(requests.length, messages);
          } catch (error) {
            failures.push(error);
            throw error;
          }
        },
      },
      mem,
      config,
      () => 0,
      undefined,
      undefined,
      {
        session,
        world,
        artifacts: options.artifacts,
        modelRequestId: () => `request-${requests.length}`,
      },
    );
    h = {
      listener,
      session,
      world,
      memory: mem,
      calls,
      requests,
      async settle(rounds = 2) {
        for (let i = 0; i < 1600; i++) {
          if (failures.length) {
            throw failures[0];
          }
          if (requests.length >= rounds && !session.state().wakeId) {
            return;
          }
          await delay(5);
        }
        assert.fail('synthetic wake did not settle');
      },
      async run(rounds = 2) {
        peers.values().next().value!.send(JSON.stringify(event()));
        await h.settle(rounds);
      },
      async command(text) {
        await listener!.receive(event('2', OWNER_ID, text, false), SELF);
        if (failures.length) {
          throw failures[0];
        }
      },
      results() {
        return Object.fromEntries(
          session
            .messages()
            .filter((m) => m.role === 'tool')
            .map((m) => [
              m.tool_call_id!,
              JSON.parse(String(m.content)) as JsonObject,
            ]),
        );
      },
      async logs() {
        await logging.flush();
        return readdirSync(logDir)
          .filter((name) => name.endsWith('.jsonl'))
          .flatMap((name) =>
            readFileSync(join(logDir, name), 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line) as JsonObject),
          );
      },
    };
    const ready = once(client, 'ready');
    client.start();
    const [identity] = await ready;
    assert.deepEqual(identity, { user_id: SELF });
    client.on('message', (packet) => {
      void listener!
        .receive(packet, SELF)
        .catch((error) => failures.push(error));
    });
    await check(h);
    assert.deepEqual(failures, []);
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
    await logging.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function submitted(result: JsonObject | undefined) {
  assert.ok(result);
  assert.equal(result.status, 'ok');
  assert.equal(result.submitted, true);
  assert.equal(result.delivery_confirmed, false);
  assert.equal(result.error, undefined);
}

const actions: [string, string, JsonObject][] = [
  ['group_sign', 'set_group_sign', {}],
  [
    'set_group_title',
    'set_group_special_title',
    { user_id: ACTOR, title: '头衔' },
  ],
  [
    'kick_member',
    'set_group_kick',
    { user_id: ACTOR, reject_add_request: false },
  ],
  ['set_group_admin', 'set_group_admin', { user_id: ACTOR, enable: false }],
  ['delete_group_notice', '_del_group_notice', { notice_id: 'notice-1' }],
  ['leave_group', 'set_group_leave', {}],
];
for (const [name, native, args] of actions) {
  for (const data of [undefined, null]) {
    test(
      `wire ${name} ${data === null ? 'null' : 'omitted'} is submission not unknown`,
      { timeout: 12000 },
      async () => {
        await fixture(
          {
            extended: { [name]: 'direct', poke_member: 'direct' },
            native: (c) => (c.action === native ? ok(data) : undefined),
            respond: (r) =>
              r === 1
                ? response(
                    call('action', name, args),
                    ...(name === 'leave_group'
                      ? []
                      : [
                          call('independent', 'poke_member', {
                            user_id: OTHER,
                          }),
                        ]),
                  )
                : response(call('done', 'finish')),
          },
          async (h) => {
            await h.run();
            submitted(h.results().action);
            assert.equal(h.calls.filter((c) => c.action === native).length, 1);
            if (name !== 'leave_group') {
              submitted(h.results().independent);
              assert.equal(
                h.calls.filter((c) => c.action === 'group_poke').length,
                1,
              );
            }
            assert.equal(
              h.session.summarizeTools({ since: 0, until: Date.now() }).pending,
              0,
            );
          },
        );
      },
    );
  }
}
for (const [name, native] of [
  ['set_group_essence', 'set_essence_msg'],
  ['remove_group_essence', 'delete_essence_msg'],
]) {
  for (const data of [
    null,
    { result: { unknown: true }, private: 'PRIVATE_NATIVE_BODY' },
  ]) {
    test(`wire ${name} ${data === null ? 'null' : 'Any object'} remains submitted`, async () => {
      await fixture(
        {
          extended: { [name!]: 'direct' },
          native: (c) => (c.action === native ? ok(data) : undefined),
          respond: (r) =>
            r === 1
              ? response(call('action', name!, { message_id: '1' }))
              : response(call('done', 'finish')),
        },
        async (h) => {
          await h.run();
          submitted(h.results().action);
          assert.doesNotMatch(
            JSON.stringify(h.results()),
            /PRIVATE_NATIVE_BODY/,
          );
        },
      );
    });
  }
}
for (const [name, native, args] of [
  ['set_group_name', 'set_group_name', { name: 'renamed' }],
  ['set_group_whole_mute', 'set_group_whole_ban', { enable: false }],
  ['publish_group_notice', '_send_group_notice', { text: 'notice' }],
  ['forward_message', 'forward_group_single_msg', { message_id: '1' }],
] as [string, string, JsonObject][]) {
  test(`wire ${name} retains verified business acknowledgement`, async () => {
    await fixture(
      {
        extended: { [name]: 'direct' },
        native: (c) => (c.action === native ? ok() : undefined),
        respond: (r) =>
          r === 1
            ? response(call('action', name, args))
            : response(call('done', 'finish')),
      },
      async (h) => {
        await h.run();
        assert.equal(h.results().action!.status, 'executed');
        assert.notEqual(h.results().action!.submitted, true);
        assert.equal(h.world.findMessage('0'), undefined);
      },
    );
  });
}

test('submitted intent cache prevents blind repeat without inventing uncertainty or double-counting submissions', async () => {
  await fixture(
    {
      extended: { group_sign: 'direct', poke_member: 'direct' },
      native: (c) => (c.action === 'set_group_sign' ? ok() : undefined),
      respond: (r) =>
        r === 1
          ? response(
              call('action', 'group_sign'),
              call('duplicate', 'group_sign'),
              call('independent', 'poke_member', { user_id: OTHER }),
            )
          : response(call('done', 'finish')),
    },
    async (h) => {
      await h.run();
      submitted(h.results().action);
      submitted(h.results().duplicate);
      assert.equal(h.results().duplicate!.cached, true);
      submitted(h.results().independent);
      assert.equal(
        h.calls.filter((c) => c.action === 'set_group_sign').length,
        1,
      );
      assert.equal(h.calls.filter((c) => c.action === 'group_poke').length, 1);
      const end = (await h.logs()).find((log) => log.event === 'turn.end')!;
      assert.equal(end.management_submitted, 2);
    },
  );
});

test('title confirmation after finish reports normal submission rather than execution or failure', async () => {
  await fixture(
    {
      extended: { set_group_title: 'confirm' },
      native: (c) =>
        c.action === 'set_group_special_title' ? ok() : undefined,
      respond: (r) =>
        r === 1
          ? response(
              call('action', 'set_group_title', {
                user_id: ACTOR,
                title: '头衔',
              }),
            )
          : response(call('done', 'finish')),
    },
    async (h) => {
      await h.run();
      assert.equal(
        h.calls.filter((c) => c.action === 'set_group_special_title').length,
        0,
      );
      const notification = h.calls.find((c) => c.action === 'send_group_msg')!;
      const text = (
        notification.params.message as { data: { text?: string } }[]
      )
        .map((s) => s.data.text ?? '')
        .join('');
      const code = /\/confirm ([a-f0-9]+)/.exec(text)![1]!;
      await h.command(`/confirm ${code}`);
      assert.equal(
        h.calls.filter((c) => c.action === 'set_group_special_title').length,
        1,
      );
      const last = h.calls.filter((c) => c.action === 'send_group_msg').at(-1)!;
      assert.match(JSON.stringify(last.params), /已正常提交/);
      assert.doesNotMatch(
        JSON.stringify(last.params),
        /未能确认执行成功|已执行确认/,
      );
    },
  );
});

for (const retcode of [1200, 1400]) {
  test(`wire provider error ${retcode} never masquerades as submission or replays`, async () => {
    await fixture(
      {
        extended: { set_group_title: 'direct', poke_member: 'direct' },
        native: (c) =>
          c.action === 'set_group_special_title'
            ? { status: 'failed', retcode }
            : undefined,
        respond: (r) =>
          r === 1
            ? response(
                call('action', 'set_group_title', {
                  user_id: ACTOR,
                  title: '头衔',
                }),
                call('blocked', 'poke_member', { user_id: OTHER }),
              )
            : retcode === 1200
              ? response(
                  call('replay', 'set_group_title', {
                    user_id: ACTOR,
                    title: '头衔',
                  }),
                  call('done', 'finish'),
                )
              : response(call('done', 'finish')),
      },
      async (h) => {
        await h.run();
        const result = h.results().action!;
        assert.equal(result.status, retcode === 1200 ? 'unknown' : 'error');
        assert.notEqual(result.submitted, true);
        if (retcode === 1200) {
          assert.equal(result.provider_reported_failure, true);
        } else {
          assert.equal(result.dispatched, false);
        }
        assert.equal(
          h.calls.filter((c) => c.action === 'set_group_special_title').length,
          1,
        );
        assert.equal(
          h.calls.filter((c) => c.action === 'group_poke').length,
          0,
        );
      },
    );
  });
}

test('voice message_id zero submits once, creates no fake message, and participates in outgoing pacing and counters', async () => {
  await fixture(
    {
      extended: { send_group_ai_voice: 'direct' },
      native: (c) =>
        c.action === 'send_group_ai_record' ? ok({ message_id: 0 }) : undefined,
      respond: (r) =>
        r === 1
          ? response(
              call('voice', 'send_group_ai_voice', {
                character_id: 'voice_0',
                text: 'hello',
              }),
              call('text', 'send_message', {
                segments: [{ type: 'text', text: '请求已提交' }],
              }),
            )
          : response(call('done', 'finish')),
    },
    async (h) => {
      await h.run();
      submitted(h.results().voice);
      assert.equal(h.world.findMessage('0'), undefined);
      assert.equal(h.memory.find('0'), undefined);
      assert.equal(h.world.recentMessages(20).length, 2);
      assert.equal(
        h.world.recentMessages(20).filter((message) => message.userId === SELF)
          .length,
        1,
      );
      const voice = h.calls.find((c) => c.action === 'send_group_ai_record')!,
        text = h.calls.find((c) => c.action === 'send_group_msg')!;
      assert.ok(
        text.at - voice.at >= 440,
        `outgoing spacing was ${text.at - voice.at}ms`,
      );
      const end = (await h.logs()).find((log) => log.event === 'turn.end')!;
      assert.equal(end.sent_submissions, 1);
      assert.equal(end.sent_messages, 1);
    },
  );
});

test('late real send ACK survives cancellation without resurrecting cleared memory', async () => {
  await fixture(
    {
      extended: {},
      native: (c, h) => {
        if (c.action === 'send_group_msg') {
          h.listener.setConnected(false);
          h.memory.clear();
          return ok({ message_id: '777' });
        }
        return undefined;
      },
      respond: () =>
        response(
          call('text', 'send_message', {
            segments: [{ type: 'text', text: 'late acknowledgement' }],
          }),
          call('done', 'finish'),
        ),
    },
    async (h) => {
      await h.run(1); // 取消操作有意阻止第二轮模型round。
      const result = h.results().text!;
      assert.equal(result.status, 'ok');
      assert.equal(result.message_id, '777');
      assert.equal(result.cancelled_after_dispatch, true);
      assert.equal(h.memory.recent().length, 0);
      assert.ok(h.world.findMessage('777'));
      assert.equal(
        h.calls.filter((c) => c.action === 'send_group_msg').length,
        1,
      );
    },
  );
});

test('late merged-forward message ACK remains executed with a world fact but no restored memory', async () => {
  await fixture(
    {
      extended: { send_group_forward: 'direct' },
      native: (c, h) => {
        if (c.action === 'send_group_forward_msg') {
          h.listener.setConnected(false);
          h.memory.clear();
          return ok({ message_id: '778' });
        }
        return undefined;
      },
      respond: () =>
        response(
          call('forward', 'send_group_forward', { message_ids: ['1'] }),
          call('done', 'finish'),
        ),
    },
    async (h) => {
      await h.run(1);
      const result = h.results().forward!;
      assert.equal(result.status, 'executed');
      assert.equal(result.message_id, '778');
      assert.equal(result.cancelled_after_dispatch, true);
      assert.equal(h.memory.recent().length, 0);
      assert.ok(h.world.findMessage('778'));
      assert.equal(
        h.calls.filter((c) => c.action === 'send_group_forward_msg').length,
        1,
      );
    },
  );
});

test('reaction Any submission is not promoted to a confirmed reaction or observed world fact', async () => {
  await fixture(
    {
      extended: {},
      reactions: true,
      native: (c) =>
        c.action === 'set_msg_emoji_like' ? ok({ result: true }) : undefined,
      respond: (r) =>
        r === 1
          ? response(
              call('reaction', 'react_message', {
                message_id: '1',
                emoji_id: '76',
                action: 'add',
              }),
            )
          : r === 2
            ? response(call('state', 'get_wake_state'))
            : response(call('done', 'finish')),
    },
    async (h) => {
      await h.run();
      submitted(h.results().reaction);
      const end = (await h.logs()).find((log) => log.event === 'turn.end')!;
      assert.equal(end.reaction_submitted, 1);
      assert.equal(end.reactions, 0);
      assert.equal(h.world.recentMessages(20).length, 1);
      assert.equal(
        h.world.readEvents({ limit: 100, types: ['reaction.changed'] })
          .returned,
        0,
      );
      assert.equal(Object.hasOwn(h.results().state!, 'reaction_state'), false);
    },
  );
});

for (const [name, native, args, data] of [
  [
    'create_group_folder',
    'create_group_file_folder',
    { name: 'new-folder' },
    { result: {}, groupItem: {} },
  ],
  [
    'upload_group_file',
    'upload_group_file',
    { artifact_id: '' },
    { file_id: null },
  ],
] as [string, string, JsonObject, unknown][]) {
  test(`wire ${name} accepts official optional result fields without false unknown`, async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), 'napcat-artifacts-'));
    const artifacts = new ArtifactStore({
      path: join(artifactDir, 'a.sqlite'),
      directory: join(artifactDir, 'files'),
      providerDirectory: '/napcat/artifacts',
    });
    try {
      if (Object.hasOwn(args, 'artifact_id')) {
        args.artifact_id = (
          await artifacts.create({
            selfId: SELF,
            groupId: GROUP,
            name: 'hello.txt',
            description: '测试产物',
            mediaType: 'text/plain',
            ttlMs: 60000,
            bytes: Buffer.from('hello'),
          })
        ).artifactId;
      }
      await fixture(
        {
          artifacts,
          extended: { [name]: 'direct', poke_member: 'direct' },
          native: (c) => (c.action === native ? ok(data) : undefined),
          respond: (r) =>
            r === 1
              ? response(
                  call('action', name, args),
                  call('independent', 'poke_member', { user_id: OTHER }),
                )
              : response(call('done', 'finish')),
        },
        async (h) => {
          await h.run();
          assert.equal(h.results().action!.status, 'ok');
          assert.equal(h.results().action!.error, undefined);
          submitted(h.results().independent);
          const dispatched = h.calls.filter((c) => c.action === native);
          assert.equal(dispatched.length, 1);
          if (Object.hasOwn(args, 'artifact_id')) {
            assert.equal(
              dispatched[0]!.params.file,
              `/napcat/artifacts/${args.artifact_id}`,
            );
            assert.equal(dispatched[0]!.params.name, 'hello.txt');
          }
        },
      );
    } finally {
      artifacts.close();
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
}

test('file delete uses original opaque provider token despite fresh listing reissuance and accepts different returned UUID', async () => {
  await fixture(
    {
      extended: { list_group_files: 'direct', delete_group_file: 'direct' },
      native: (c) =>
        c.action === 'delete_group_file'
          ? ok({
              result: 0,
              errMsg: '',
              transGroupFileResult: {
                result: {},
                successFileIdList: ['DIFFERENT-NATIVE-UUID'],
                failFileIdList: [],
              },
            })
          : undefined,
      respond: (r, messages) => {
        if (r === 1) {
          return response(call('list', 'list_group_files', { limit: 10 }));
        }
        if (r === 2) {
          const result = JSON.parse(
            String(messages.find((m) => m.tool_call_id === 'list')!.content),
          ) as { items: JsonObject[] };
          return response(
            call('action', 'delete_group_file', {
              file_handle: result.items[0]!.file_handle,
            }),
          );
        }
        return response(call('done', 'finish'));
      },
    },
    async (h) => {
      await h.run();
      submitted(h.results().action);
      const mutation = h.calls.find((c) => c.action === 'delete_group_file');
      assert.ok(mutation);
      assert.equal(mutation.params.file_id, 'PROVIDER-TOKEN-1');
      assert.ok(
        h.calls.filter((c) => c.action === 'get_group_root_files').length >= 2,
      );
      assert.doesNotMatch(
        JSON.stringify(h.results().action),
        /PROVIDER-TOKEN|DIFFERENT-NATIVE/,
      );
    },
  );
});

test('join request normal null is submitted without exposing private flag', async () => {
  await fixture(
    {
      extended: {
        list_group_requests: 'direct',
        respond_group_request: 'direct',
      },
      native: (c) => (c.action === 'set_group_add_request' ? ok() : undefined),
      respond: (r, messages) => {
        if (r === 1) {
          return response(call('list', 'list_group_requests', { limit: 10 }));
        }
        if (r === 2) {
          const result = JSON.parse(
            String(messages.find((m) => m.tool_call_id === 'list')!.content),
          ) as { items: JsonObject[] };
          return response(
            call('action', 'respond_group_request', {
              request_handle: result.items[0]!.request_handle,
              approve: true,
              reason: '',
            }),
          );
        }
        return response(call('done', 'finish'));
      },
    },
    async (h) => {
      await h.run();
      submitted(h.results().action);
      assert.equal(
        h.calls.filter((c) => c.action === 'set_group_add_request').length,
        1,
      );
      assert.doesNotMatch(JSON.stringify(h.results()), /1780000000000001/);
    },
  );
});
