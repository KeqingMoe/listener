import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../../src/agent/listener.ts';
import { ModelSession } from '../../../../src/agent/session/store.ts';
import { WorldEventStore } from '../../../../src/world/events.ts';
import { SQLiteMemory } from '../../../../src/agent/memory.ts';
import {
  LISTENER_GROUP,
  OWNER_ID,
} from '../../../../src/contracts/identity.ts';
import { type Api } from '../../../../src/contracts/onebot.ts';
import {
  type ChatMessage,
  type Completion,
} from '../../../../src/contracts/model.ts';
import { type JsonObject } from '../../../../src/contracts/json.ts';
import { type TimelineEntry } from '../../../../src/contracts/messages.ts';
import type { ListenerConfig } from '../../../../src/config/listener.ts';
import type { ExtendedToolsConfig } from '../../../../src/config/extended-tools.ts';
import { toolPermissions } from '../../../support/tool-permissions.ts';

const GROUP = LISTENER_GROUP,
  SELF = '900000001',
  ACTOR = '12345';
const SECRET = 'PRIVATE_NATIVE_URL_AND_RESOURCE_TOKEN';
const DATA = 'data:image/png;base64,aGVsbG8=';
const imageArgs = { image_id: 'img_1_2' },
  forwardArgs = { message_id: '1' },
  mergeArgs = { message_ids: ['1'] },
  voiceArgs = { character_id: 'voice_fixture', text: 'fixture voice' };
const direct: ExtendedToolsConfig = {
  send_group_image: 'direct',
  forward_message: 'direct',
  send_group_forward: 'direct',
  send_group_ai_voice: 'direct',
};
const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const completion = (...tool_calls: Completion['tool_calls']): Completion => ({
  content: null,
  tool_calls,
});

function result(messages: ChatMessage[], id: string): JsonObject {
  const message = messages.find((m) => m.tool_call_id === id);
  assert.ok(message, `missing result ${id}`);
  return JSON.parse(String(message.content)) as JsonObject;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

function segments() {
  return [
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: 'SYNTHETIC_TRIGGER' } },
    {
      type: 'image',
      data: { url: `https://gchat.qpic.cn/${SECRET}`, file: SECRET },
    },
    { type: 'forward', data: { id: SECRET } },
  ];
}

function event(group = GROUP) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: group,
    self_id: SELF,
    user_id: ACTOR,
    message_id: '1',
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'fixture' },
    message: segments(),
  };
}

function source(id: string): JsonObject {
  return {
    message_id: id,
    message_type: 'group',
    group_id: GROUP,
    user_id: id === '1' ? ACTOR : SELF,
    sender: { user_id: id === '1' ? ACTOR : SELF, nickname: 'fixture' },
    time: Math.floor(Date.now() / 1000),
    message:
      id === '1'
        ? segments()
        : [{ type: 'image', data: { url: `https://gchat.qpic.cn/${SECRET}` } }],
  };
}

interface Ledger {
  call_id: string;
  name: string;
  state: string;
  result: JsonObject;
}

function fixture(options: {
  extended?: ExtendedToolsConfig;
  images?: boolean;
  forward?: boolean;
  respond: (
    messages: ChatMessage[],
    round: number,
  ) => Completion | Promise<Completion>;
  apiHook?: (action: string, params: JsonObject) => unknown | Promise<unknown>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'media-real-integration-'));
  const paths = {
    session: join(dir, 'session.sqlite'),
    world: join(dir, 'world.sqlite'),
    memory: join(dir, 'memory.sqlite'),
  };
  const session = new ModelSession({
      model: 'main',
      path: paths.session,
      groupId: GROUP,
    }),
    world = new WorldEventStore({ path: paths.world, groupId: GROUP }),
    memory = new SQLiteMemory({
      path: paths.memory,
      groupId: GROUP,
      maxContextChars: 8000,
      retentionDays: 7,
    });
  const native: Array<{ action: string; params: JsonObject; at: number }> = [],
    requests: ChatMessage[][] = [],
    failures: unknown[] = [];
  let downloads = 0,
    nextId = 9001;
  const api: Api = {
    async call(action, params = {}) {
      native.push({
        action,
        params: structuredClone(params),
        at: performance.now(),
      });
      if (options.apiHook) {
        const response = await options.apiHook(action, params);
        if (response !== undefined) {
          return response;
        }
      }
      if (action === 'get_login_info') {
        return { user_id: SELF };
      }
      if (action === 'get_group_member_info') {
        return {
          group_id: GROUP,
          user_id: params.user_id,
          role: params.user_id === SELF ? 'owner' : 'member',
        };
      }
      if (action === 'get_msg') {
        return source(String(params.message_id));
      }
      if (action === 'get_forward_msg') {
        return {
          messages: [
            {
              sender: { user_id: ACTOR, nickname: 'quoted' },
              time: 1,
              content: [
                { type: 'text', data: { text: 'SYNTHETIC_QUOTED_TEXT' } },
              ],
            },
          ],
        };
      }
      if (action === 'get_ai_characters') {
        return [
          {
            type: 'fixture',
            characters: [
              {
                character_id: 'voice_fixture',
                character_name: 'fixture',
                preview_url: `https://example.invalid/${SECRET}`,
              },
            ],
          },
        ];
      }
      if (action === 'send_group_msg' || action === 'send_group_forward_msg') {
        return { message_id: String(nextId++), res_id: SECRET };
      }
      if (action === 'forward_group_single_msg') {
        return null;
      }
      if (action === 'send_group_ai_record') {
        return { message_id: 0 };
      }
      throw new Error('Unexpected fixture API ' + action);
    },
  };
  const config: ListenerConfig = {
    ownerId: OWNER_ID,
    enabled: true,
    groupId: GROUP,
    debounceMs: 1,
    cooldownMs: 1,
    retentionDays: 7,
    randomReplyProbability: 0,
    toolPermissions: toolPermissions({
      ...options.extended,
      mute_member: { mode: 'off', maxSeconds: 600 },
      view_images: {
        mode: options.images ? 'direct' : 'off',
        maxDownloadMb: 10,
      },
      read_forward: options.forward ? 'direct' : 'off',
    }),
    messageMentions: false,
    confirmationTtlSeconds: 60,
  };
  const listener = new Listener(
    api,
    {
      async complete(messages) {
        requests.push(structuredClone(messages));
        try {
          return await options.respond(messages, requests.length);
        } catch (error) {
          failures.push(error);
          throw error;
        }
      },
    },
    memory,
    config,
    () => 0,
    async (url, maxBytes) => {
      assert.equal(url, `https://gchat.qpic.cn/${SECRET}`);
      assert.equal(maxBytes, 10 * 1024 * 1024);
      downloads++;
      return { dataUrl: DATA, width: 1, height: 1, firstFrameOnly: false };
    },
    undefined,
    { session, world, modelRequestId: () => `fixture-${requests.length}` },
  );
  function rows(which: keyof typeof paths, sql: string) {
    const db = new DatabaseSync(paths[which], { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  }
  async function settled() {
    for (let i = 0; i < 1000; i++) {
      if (
        requests.length &&
        rows('session', 'SELECT wake_id FROM model_session_meta')[0]
          ?.wake_id === null
      ) {
        if (failures.length) {
          throw failures[0];
        }
        return;
      }
      await delay(5);
    }
    assert.fail('media integration did not settle');
  }
  return {
    listener,
    session,
    world,
    memory,
    native,
    requests,
    get downloads() {
      return downloads;
    },
    rows,
    settled,
    writes: () =>
      native.filter((c) =>
        [
          'send_group_msg',
          'send_group_forward_msg',
          'forward_group_single_msg',
          'send_group_ai_record',
        ].includes(c.action),
      ),
    async run() {
      await listener.receive(event(), SELF);
      await settled();
    },
    ledger: (): Ledger[] =>
      rows(
        'session',
        'SELECT call_id,name,state,result FROM model_tool_ledger ORDER BY ordinal',
      ).map((r) => ({
        call_id: String(r.call_id),
        name: String(r.name),
        state: String(r.state),
        result: JSON.parse(String(r.result)) as JsonObject,
      })),
    worldEntries: (): TimelineEntry[] =>
      rows('world', 'SELECT entry FROM world_messages ORDER BY sequence').map(
        (r) => JSON.parse(String(r.entry)) as TimelineEntry,
      ),
    memoryEntries: (): TimelineEntry[] =>
      rows('memory', 'SELECT entry FROM listener_messages ORDER BY seq').map(
        (r) => JSON.parse(String(r.entry)) as TimelineEntry,
      ),
    finishReason: () =>
      JSON.parse(
        String(
          rows(
            'session',
            "SELECT payload FROM model_session_journal WHERE kind='wake_finish' ORDER BY seq DESC LIMIT 1",
          )[0]?.payload,
        ),
      ).reason,
    async close() {
      await listener.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function terminalLedger(f: ReturnType<typeof fixture>) {
  const rows = f.ledger();
  assert.ok(rows.length);
  assert.ok(
    rows.every((r) => !['pending', 'started'].includes(r.state)),
    JSON.stringify(rows),
  );
  return rows;
}

test('real Listener sends normalized image and can read/forward its actual self ID within one persisted wake', async () => {
  const f = fixture({
    extended: { send_group_image: 'direct', forward_message: 'direct' },
    respond(messages, round) {
      if (round === 1) {
        return completion(call('image', 'send_group_image', imageArgs));
      }
      if (round === 2) {
        assert.equal(result(messages, 'image').message_id, '9001');
        return completion(
          call('read-self', 'read_message', { message_id: '9001' }),
          call('forward-self', 'forward_message', { message_id: '9001' }),
        );
      }
      assert.equal(round, 3);
      assert.equal(result(messages, 'read-self').status, 'ok');
      assert.match(JSON.stringify(result(messages, 'read-self')), /img_9001_0/);
      assert.equal(result(messages, 'forward-self').status, 'executed');
      return completion(
        call('done', 'finish', { mode: 'hard' }),
        call('never', 'send_group_image', imageArgs),
      );
    },
  });
  try {
    await f.run();
    assert.equal(f.requests.length, 3);
    assert.equal(f.downloads, 1);
    assert.deepEqual(
      f.writes().map((c) => c.action),
      ['send_group_msg', 'forward_group_single_msg'],
    );
    assert.deepEqual(f.writes()[0]!.params, {
      group_id: GROUP,
      message: [{ type: 'image', data: { file: 'base64://aGVsbG8=' } }],
    });
    assert.deepEqual(f.writes()[1]!.params, {
      group_id: GROUP,
      message_id: '9001',
    });
    assert.ok(
      f.writes()[1]!.at - f.writes()[0]!.at >= 430,
      'shared send pacing must survive model round boundary',
    );
    assert.ok(
      f.native.some(
        (c) => c.action === 'get_msg' && c.params.message_id === '9001',
      ),
    );
    for (const entries of [f.worldEntries(), f.memoryEntries()]) {
      const sent = entries.find((e) => e.messageId === '9001');
      assert.ok(sent);
      assert.deepEqual(sent.images, [{ id: 'img_9001_0', index: 0 }]);
      assert.deepEqual(sent.segments, [
        { type: 'image', image_id: 'img_9001_0', content_status: 'not_viewed' },
      ]);
      assert.doesNotMatch(
        JSON.stringify(entries),
        /PRIVATE_NATIVE_URL_AND_RESOURCE_TOKEN|base64:|https:/,
      );
    }
    const ledger = terminalLedger(f);
    assert.equal(
      ledger.find((r) => r.call_id === 'image')!.result.status,
      'executed',
    );
    assert.equal(
      ledger.find((r) => r.call_id === 'never')!.result.status,
      'skipped',
    );
    assert.equal(f.finishReason(), 'replied');
    assert.equal(
      f.session.summarizeTools({ since: 0, until: Date.now() }).pending,
      0,
    );
  } finally {
    await f.close();
  }
});

test('merged ACK persists stable forward reference, not its native resource token', async () => {
  const f = fixture({
    extended: { send_group_forward: 'direct' },
    respond: () =>
      completion(
        call('merged', 'send_group_forward', { message_ids: ['1', '1'] }),
        call('done', 'finish', { mode: 'hard' }),
      ),
  });
  try {
    await f.run();
    assert.deepEqual(f.writes()[0]!.params, {
      group_id: GROUP,
      messages: [
        { type: 'node', data: { id: '1' } },
        { type: 'node', data: { id: '1' } },
      ],
    });
    for (const entries of [f.worldEntries(), f.memoryEntries()]) {
      const sent = entries.find((e) => e.messageId === '9001');
      assert.ok(sent);
      assert.deepEqual(sent.forwards, [{ id: 'fwd_9001_0', index: 0 }]);
      assert.deepEqual(sent.segments, [
        {
          type: 'forward',
          forward_id: 'fwd_9001_0',
          content_status: 'not_read',
        },
      ]);
      assert.doesNotMatch(
        JSON.stringify(entries),
        /PRIVATE_NATIVE_URL_AND_RESOURCE_TOKEN|res_id/,
      );
    }
    assert.equal(terminalLedger(f)[0]!.result.status, 'executed');
    assert.equal(f.finishReason(), 'replied');
  } finally {
    await f.close();
  }
});

test('single native forward null counts as replied but never creates an invented world/memory message', async () => {
  const f = fixture({
    extended: { forward_message: 'direct' },
    respond: () =>
      completion(
        call('single', 'forward_message', forwardArgs),
        call('done', 'finish', { mode: 'hard' }),
      ),
  });
  try {
    await f.run();
    assert.equal(f.writes().length, 1);
    assert.equal(f.writes()[0]!.action, 'forward_group_single_msg');
    assert.deepEqual(
      f.worldEntries().map((e) => e.messageId),
      ['1'],
    );
    assert.deepEqual(
      f.memoryEntries().map((e) => e.messageId),
      ['1'],
    );
    const ledger = terminalLedger(f);
    assert.equal(ledger[0]!.result.status, 'executed');
    assert.equal(ledger[0]!.result.message_id, null);
    assert.equal(f.finishReason(), 'replied');
    assert.equal(
      f.session
        .summarizeTools({ since: 0, until: Date.now() })
        .byTool.find((t) => t.name === 'forward_message')!.successes,
      1,
    );
  } finally {
    await f.close();
  }
});

for (const interruption of ['disconnect', 'stop'] as const) {
  test(`late image ACK after ${interruption} remains a world fact without memory resurrection or subsequent API work`, async () => {
    const entered = gate(),
      ack = gate();
    const f = fixture({
      extended: direct,
      apiHook: async (action) => {
        if (action === 'send_group_msg') {
          entered.release();
          await ack.promise;
          return { message_id: '9001', res_id: SECRET };
        }
      },
      respond: () =>
        completion(
          call('late', 'send_group_image', imageArgs),
          call('never', 'send_group_forward', mergeArgs),
          call('done', 'finish', { mode: 'hard' }),
        ),
    });
    try {
      await f.listener.receive(event(), SELF);
      await entered.promise;
      const before = f.native.length;
      let stopped: Promise<void> | undefined;
      if (interruption === 'stop') {
        stopped = f.listener.stop();
      } else {
        f.listener.setConnected(false);
      }
      f.memory.clear();
      ack.release();
      if (stopped) {
        await stopped;
      }
      await f.settled();
      assert.equal(f.requests.length, 1);
      assert.equal(f.native.length, before);
      assert.equal(f.writes().length, 1);
      const fact = f.worldEntries().find((e) => e.messageId === '9001');
      assert.ok(fact);
      assert.deepEqual(fact.images, [{ id: 'img_9001_0', index: 0 }]);
      assert.deepEqual(f.memoryEntries(), []);
      const ledger = terminalLedger(f);
      assert.equal(
        ledger.find((r) => r.call_id === 'late')!.result.status,
        'executed',
      );
      assert.equal(
        ledger.find((r) => r.call_id === 'late')!.result
          .cancelled_after_dispatch,
        true,
      );
      assert.equal(
        ledger.find((r) => r.call_id === 'never')!.result.status,
        'skipped',
      );
      assert.equal(
        ledger.find((r) => r.call_id === 'done')!.result.status,
        'skipped',
      );
      assert.doesNotMatch(
        JSON.stringify([f.worldEntries(), ledger]),
        /PRIVATE_NATIVE_URL_AND_RESOURCE_TOKEN|base64:/,
      );
    } finally {
      ack.release();
      await f.close();
    }
  });
}

for (const reading of ['view_images', 'read_forward'] as const) {
  test(`same-batch ${reading} prevents every media/voice write until the next model round`, async () => {
    const readingArgs =
      reading === 'view_images'
        ? { image_ids: ['img_1_2'] }
        : { forward_id: 'fwd_1_3', start: 1, limit: 1 };
    const actions = [
      ['image', 'send_group_image', imageArgs],
      ['single', 'forward_message', forwardArgs],
      ['merged', 'send_group_forward', mergeArgs],
      ['voice', 'send_group_ai_voice', voiceArgs],
    ] as const;
    const f = fixture({
      extended: direct,
      images: true,
      forward: true,
      respond(messages, round) {
        if (round === 1) {
          return completion(
            ...actions.map(([id, name, args]) =>
              call(`blocked-${id}`, name, args),
            ),
            call('reading', reading, readingArgs),
          );
        }
        assert.equal(round, 2);
        assert.equal(result(messages, 'reading').status, 'ok');
        assert.equal(f.writes().length, 0);
        for (const [id] of actions) {
          const blocked = result(messages, `blocked-${id}`);
          assert.equal(blocked.status, 'error');
          assert.match(String(blocked.error), /下一轮/);
        }
        return completion(
          ...actions.map(([id, name, args]) =>
            call(`reviewed-${id}`, name, args),
          ),
          call('done', 'finish', { mode: 'hard' }),
        );
      },
    });
    try {
      await f.run();
      assert.equal(f.requests.length, 2);
      assert.deepEqual(
        f.writes().map((c) => c.action),
        [
          'send_group_msg',
          'forward_group_single_msg',
          'send_group_forward_msg',
          'send_group_ai_record',
        ],
      );
      const ledger = terminalLedger(f);
      for (const [id] of actions) {
        assert.equal(
          ledger.find((r) => r.call_id === `blocked-${id}`)!.result.status,
          'error',
        );
      }
      for (const id of ['image', 'single', 'merged']) {
        assert.equal(
          ledger.find((r) => r.call_id === `reviewed-${id}`)!.result.status,
          'executed',
        );
      }
      assert.equal(
        ledger.find((r) => r.call_id === 'reviewed-voice')!.result.status,
        'ok',
      );
      const voiceResult = ledger.find(
        (r) => r.call_id === 'reviewed-voice',
      )!.result;
      assert.equal(voiceResult.submitted, true);
      assert.equal(voiceResult.effect_confirmed, false);
      assert.equal(voiceResult.message_id, null);
      assert.equal(f.worldEntries().filter((e) => e.userId === SELF).length, 2);
      assert.equal(f.finishReason(), 'replied');
    } finally {
      await f.close();
    }
  });
}

test('default-off capabilities and foreign native origins never dispatch media writes', async () => {
  for (const mode of ['off', 'foreign', 'invalid'] as const) {
    const f = fixture({
      extended: mode === 'off' ? undefined : direct,
      apiHook: (action) =>
        action === 'get_msg'
          ? mode === 'foreign'
            ? { ...source('1'), group_id: '999999' }
            : mode === 'invalid'
              ? { message_id: '1' }
              : undefined
          : undefined,
      respond: () =>
        completion(
          call('image', 'send_group_image', imageArgs),
          call('single', 'forward_message', forwardArgs),
          call('merged', 'send_group_forward', mergeArgs),
          call('done', 'finish', { mode: 'hard' }),
        ),
    });
    try {
      await f.run();
      assert.equal(f.writes().length, 0);
      assert.equal(f.downloads, 0);
      assert.deepEqual(
        f.worldEntries().map((e) => e.messageId),
        ['1'],
      );
      assert.ok(
        terminalLedger(f)
          .filter((r) => r.name !== 'finish')
          .every((r) => r.result.status === 'error'),
      );
      if (mode === 'off') {
        assert.equal(f.native.length, 0);
      }
    } finally {
      await f.close();
    }
  }
  const foreign = fixture({
    extended: direct,
    respond: () => {
      assert.fail('foreign group must not wake model');
    },
  });
  try {
    await foreign.listener.receive(event('999999'), SELF);
    await delay(20);
    assert.equal(foreign.requests.length, 0);
    assert.equal(foreign.native.length, 0);
    assert.deepEqual(foreign.worldEntries(), []);
  } finally {
    await foreign.close();
  }
});

test('uncertain media result and duplicate remain unknown in persisted tool ledger without replay', async () => {
  const f = fixture({
    extended: { send_group_forward: 'direct' },
    apiHook: (action) => {
      if (action === 'send_group_forward_msg') {
        throw new Error(SECRET);
      }
    },
    respond(messages, round) {
      if (round === 1) {
        return completion(call('first', 'send_group_forward', mergeArgs));
      }
      assert.equal(round, 2);
      assert.equal(result(messages, 'first').status, 'unknown');
      return completion(
        call('duplicate', 'send_group_forward', mergeArgs),
        call('done', 'finish', { mode: 'hard' }),
      );
    },
  });
  try {
    await f.run();
    assert.equal(f.writes().length, 1);
    assert.deepEqual(
      f.worldEntries().map((e) => e.messageId),
      ['1'],
    );
    assert.deepEqual(
      f.memoryEntries().map((e) => e.messageId),
      ['1'],
    );
    const ledger = terminalLedger(f);
    assert.equal(ledger[0]!.result.status, 'unknown');
    assert.equal(ledger[1]!.result.status, 'unknown');
    assert.equal(ledger[1]!.result.cached, true);
    assert.doesNotMatch(
      JSON.stringify(ledger),
      /PRIVATE_NATIVE_URL_AND_RESOURCE_TOKEN/,
    );
    assert.equal(
      f.session.summarizeTools({ since: 0, until: Date.now() }).unknown,
      2,
    );
  } finally {
    await f.close();
  }
});
