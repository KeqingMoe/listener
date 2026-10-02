import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import { buildToolDefinitions } from '../../../src/agent/tool-definitions.ts';
import { buildSystemPrompt } from '../../../src/agent/prompts/index.ts';
import {
  applyToolPolicies,
  toListenerConfig,
} from '../../../src/config/runtime.ts';
import {
  TOOL_NAMES,
  TOOL_CAPABILITIES,
  type ResolvedToolPolicies,
  type ToolPolicy,
} from '../../../src/config/tool-policy.ts';
import type {
  AppConfig,
  ResolvedGroupConfig,
  ToolSchemaMode,
} from '../../../src/config/app.ts';
import { GroupTools } from '../../../src/tools/messaging/tools.ts';
import { ImageTools } from '../../../src/tools/images/tools.ts';
import { WorldEventStore } from '../../../src/world/events.ts';
import { ModelSession } from '../../../src/agent/session/store.ts';
import type { Api } from '../../../src/contracts/onebot.ts';
import type { Memory, TimelineEntry } from '../../../src/contracts/messages.ts';
import type { Model, ChatMessage } from '../../../src/contracts/model.ts';
import type { JsonObject } from '../../../src/contracts/json.ts';
import type { ToolDefinition } from '../../../src/contracts/tools.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const GROUP = '334455',
  OWNER = '778899',
  SELF = '990011',
  MEMBER = '123456';

function policies(
  overrides: Partial<ResolvedToolPolicies> = {},
): ResolvedToolPolicies {
  return Object.fromEntries(
    TOOL_NAMES.map((name) => [
      name,
      {
        mode: 'off',
        ...Object.fromEntries(
          Object.values(TOOL_CAPABILITIES[name].options).map((o) => [
            o.field,
            o.default,
          ]),
        ),
        ...overrides[name],
      },
    ]),
  ) as ResolvedToolPolicies;
}

function fixture(
  overrides: Partial<ResolvedToolPolicies> = {},
  observe = false,
  toolSchema: ToolSchemaMode = 'json',
) {
  const group: ResolvedGroupConfig = {
    groupId: GROUP,
    enabled: true,
    model: 'main',
    personaPath: '/fixture/persona.md',
    persona: 'Complete replacement persona',
    reply: {
      mention: true,
      quoteBot: true,
      delayMs: [0, 0],
      cooldownMs: 0,
      random: false,
    },
    session: { eventWindowSize: 20, maxTranscriptBytes: 524288 },
    execution: { maxToolCallsPerWake: 96, wakeTimeoutMs: 90000 },
    messages: { mentions: false },
    observation: { reactions: observe },
    confirmation: { ttlSeconds: 37 },
    history: { retentionDays: 7 },
    storage: { databasePath: ':memory:' },
    tools: policies(overrides),
  };
  const app: AppConfig = {
    configPath: '/fixture/config.toml',
    identity: { name: 'Fixture', ownerId: OWNER },
    onebot: {
      url: 'ws://localhost:1',
      token: 'fixture',
      apiTimeoutMs: 1000,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      heartbeatMs: 1000,
    },
    models: new Map([
      [
        'main',
        {
          name: 'main',
          transport: { type: 'responses', incremental: true },
          baseUrl: 'https://model.invalid/v1',
          apiKey: 'fixture-private-key',
          model: 'fixture-model',
          timeoutMs: 1000,
          maxTokens: 8192,
          opencodeHeaders: false,
          toolSchema,
        },
      ],
    ]),
    web: { search: { type: 'searxng', url: 'http://127.0.0.1:8888' } },
    runtime: { maxConcurrentTurns: 2 },
    storage: {
      directory: '/fixture/data',
      telemetryPath: '/fixture/data/telemetry.sqlite',
      registryPath: '/fixture/data/registry.json',
      customFaceDirectory: '/fixture/data/custom-face-originals',
      napcatCustomFaceDirectory: '/fixture/data/custom-face-originals',
      artifactDirectory: '/fixture/data/artifacts',
      napcatArtifactDirectory: '/fixture/data/artifacts',
    },
    logging: {
      level: 'info',
      console: false,
      file: false,
      directory: '/fixture/logs',
      retentionDays: 7,
      maxFileMb: 20,
      maxTotalMb: 200,
    },
    defaultsEnabled: false,
    configuredGroupIds: [GROUP],
    resolveGroup: () => group,
  };
  return { app, group, config: toListenerConfig(app, group) };
}

class Cache implements Memory {
  entries: TimelineEntry[] = [];
  summaryCalls = 0;
  append(e: TimelineEntry) {
    if (this.find(e.messageId)) {
      return false;
    }
    this.entries.push(e);
    return true;
  }

  recent() {
    return this.entries;
  }

  find(id: string) {
    return this.entries.find((e) => e.messageId === id);
  }

  context() {
    return JSON.stringify({ messages: this.entries });
  }

  async compact() {
    this.summaryCalls++;
    throw new Error('obsolete_summary');
  }

  clear() {
    this.entries = [];
  }

  close() {}
}

const tool = (name: string, args: unknown, id = name) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

function incoming(id = '1', actor = MEMBER, text = 'fixture', mention = true) {
  return {
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
  };
}

async function until(fn: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (fn()) {
      return;
    }
    await delay(5);
  }
  assert.fail('policy fixture timeout');
}

function transport() {
  const calls: { action: string; params: JsonObject }[] = [];
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params });
      if (action === 'get_login_info') {
        return { user_id: SELF };
      }
      if (action === 'get_group_member_info') {
        return {
          group_id: GROUP,
          user_id: params.user_id,
          role: params.user_id === SELF ? 'owner' : 'member',
          nickname: 'fixture',
        };
      }
      if (action === 'get_group_member_list') {
        return [
          {
            group_id: GROUP,
            user_id: MEMBER,
            role: 'member',
            nickname: 'fixture',
          },
        ];
      }
      if (action === 'get_msg') {
        return {
          message_id: String(params.message_id),
          message_type: 'group',
          group_id: GROUP,
          user_id: MEMBER,
          sender: { user_id: MEMBER },
          message: [],
          emoji_likes_list: [],
        };
      }
      if (action === 'fetch_emoji_like') {
        return {
          result: 0,
          emojiLikesList: [],
          isFirstPage: true,
          isLastPage: true,
          cookie: '',
        };
      }
      if (
        [
          'set_msg_emoji_like',
          'set_group_ban',
          'set_group_special_title',
        ].includes(action)
      ) {
        return null;
      }
      if (action === 'send_group_msg') {
        return { message_id: String(1000 + calls.length) };
      }
      throw new Error('unexpected API ' + action);
    },
  };
  return { api, calls };
}

async function run(
  overrides: Partial<ResolvedToolPolicies>,
  calls: ReturnType<typeof tool>[],
  observe = false,
) {
  const f = fixture(overrides, observe),
    memory = new Cache(),
    rpc = transport();
  let results: Map<string, JsonObject> | undefined;
  const systemPrompts: string[] = [];
  const world = new WorldEventStore({
    path: ':memory:',
    groupId: GROUP,
    retentionDays: 7,
  });
  const session = new ModelSession({
    model: 'main',
    path: ':memory:',
    groupId: GROUP,
  });
  const model: Model = {
    async complete(messages: ChatMessage[]) {
      systemPrompts.push(
        String(messages.find((m) => m.role === 'system')?.content),
      );
      const rows = messages.filter((m) => m.role === 'tool');
      if (!rows.length) {
        return { content: null, tool_calls: calls };
      }
      results = new Map(
        rows.map((m) => [
          m.tool_call_id!,
          JSON.parse(String(m.content)) as JsonObject,
        ]),
      );
      return { content: null, tool_calls: [tool('finish', { mode: 'hard' })] };
    },
  };
  const bot = new Listener(
    rpc.api,
    model,
    memory,
    f.config,
    undefined,
    undefined,
    undefined,
    { world, session },
  );
  try {
    await bot.receive(incoming(), SELF);
    await until(() => !!results);
    await delay(5);
    return {
      results: results!,
      calls: rpc.calls,
      summaryCalls: memory.summaryCalls,
      systemPrompts,
      basePrompt: buildSystemPrompt(f.config),
    };
  } finally {
    await bot.stop();
  }
}

test('unique adapter combines app credentials and group policy without leaking shared settings into group', () => {
  const { app, group, config } = fixture({
    view_images: { mode: 'direct', maxDownloadMb: 4 },
    mute_member: { mode: 'confirm', maxSeconds: 45 },
    manage_attention: { mode: 'direct', maxPlans: 5 },
  });
  assert.equal('apiKey' in config, false);
  assert.equal(config.ownerId, OWNER);
  assert.equal(config.persona, group.persona);
  const projected = applyToolPolicies(config);
  assert.equal(projected.tools.moderation.maxMuteSeconds, 45);
  assert.equal(projected.tools.moderation.confirmationTtlSeconds, 37);
  assert.deepEqual(projected.images, { enabled: true, maxDownloadMb: 4 });
  assert.deepEqual(projected.attention, { enabled: true, maxPlans: 5 });
  assert.equal('apiKey' in group, false);
  group.tools.mute_member.mode = 'off';
  assert.equal(config.toolPermissions?.mute_member.mode, 'confirm');
  assert.equal(config.enabled, true);
  group.enabled = false;
  assert.equal(toListenerConfig(app, group).enabled, false);
  const prompt = buildSystemPrompt(config);
  assert.doesNotMatch(
    prompt,
    /tools\.extended|tools\.moderation|fixture-private-key/,
  );
});

test('every optional tool exposes only its explicit policy; required tools stay available', () => {
  for (const name of TOOL_NAMES) {
    for (const mode of [
      'direct',
      ...(TOOL_CAPABILITIES[name].confirm ? ['confirm'] : []),
    ] as const) {
      const { config } = fixture({ [name]: { mode } as ToolPolicy });
      const defs = buildToolDefinitions(config).map((t) => t.function.name);
      assert.deepEqual(
        TOOL_NAMES.filter((n) => defs.includes(n)),
        [name],
        `${name}:${mode}`,
      );
      for (const core of [
        'read_message',
        'send_message',
        'finish',
        'read_events',
      ]) {
        assert.ok(defs.includes(core));
      }
    }
  }
  const { config } = fixture();
  // 混入的旧版模块字段不能绕过toolPermissions打开任何工具。
  Object.assign(config, {
    tools: {
      members: true,
      mention: true,
      reactions: true,
      moderation: {
        mute: 'direct',
        unmute: 'direct',
        recall: 'direct',
        memberCard: 'direct',
        confirmationTtlSeconds: 60,
        maxMuteSeconds: 600,
      },
      extended: { kick_member: 'direct' },
    },
    images: { enabled: true, maxDownloadMb: 10 },
    attention: { enabled: true, maxPlans: 16 },
  });
  assert.deepEqual(
    TOOL_NAMES.filter((n) =>
      buildToolDefinitions(config).some((t) => t.function.name === n),
    ),
    [],
  );
});

test('forged disabled optional tool calls never dispatch even when model asks for every tool', async () => {
  const result = await run(
    {},
    TOOL_NAMES.map((n) => tool(n, {})),
  );
  for (const name of TOOL_NAMES) {
    assert.equal(result.results.get(name)?.error, 'tool_disabled', name);
  }
  assert.equal(result.calls.length, 0);
  assert.equal(result.summaryCalls, 0);
});

test('member listing and individual member reads are independently authorized in actual Listener dispatch', async () => {
  for (const list of [false, true]) {
    for (const member of [false, true]) {
      const out = await run(
        {
          get_group_members: { mode: list ? 'direct' : 'off' },
          get_member_info: { mode: member ? 'direct' : 'off' },
        },
        [
          tool('get_group_members', { limit: 10 }),
          tool('get_member_info', { user_id: MEMBER }),
        ],
      );
      assert.equal(
        out.results.get('get_group_members')?.status,
        list ? 'ok' : 'error',
      );
      assert.equal(
        out.results.get('get_member_info')?.status,
        member ? 'ok' : 'error',
      );
      assert.equal(
        out.calls.filter((c) => c.action === 'get_group_member_list').length,
        list ? 1 : 0,
      );
      assert.equal(
        out.calls.filter((c) => c.action === 'get_group_member_info').length,
        member ? 1 : 0,
      );
    }
  }
});

test('reaction mutation, explicit responder query and passive observation have independent execution permissions', async () => {
  for (const observe of [false, true]) {
    for (const react of [false, true]) {
      for (const query of [false, true]) {
        const out = await run(
          {
            react_message: { mode: react ? 'direct' : 'off' },
            get_reaction_users: { mode: query ? 'direct' : 'off' },
          },
          [
            tool('read_message', { message_id: '1' }),
            tool('get_reaction_users', {
              message_id: '1',
              emoji_id: '76',
              emoji_type: '1',
              limit: 20,
            }),
            tool('react_message', {
              message_id: '1',
              emoji_id: '76',
              action: 'add',
            }),
          ],
          observe,
        );
        assert.equal(
          out.results.get('get_reaction_users')?.status,
          query ? 'ok' : 'error',
          JSON.stringify({ observe, react, query }),
        );
        assert.equal(
          out.calls.filter((c) => c.action === 'fetch_emoji_like').length,
          query ? 1 : 0,
        );
        assert.equal(
          out.calls.filter((c) => c.action === 'set_msg_emoji_like').length,
          react ? 1 : 0,
        );
        assert.equal(
          out.results.get('react_message')?.status,
          react ? 'ok' : 'error',
        );
        if (!react && !query) {
          assert.equal(
            out.calls.filter((c) => c.action === 'get_msg').length,
            observe ? 1 : 0,
          );
        }
        for (const prompt of [out.basePrompt, ...out.systemPrompts]) {
          assert.equal(
            prompt.includes('消息表情回应：react_message 给'),
            react,
          );
          assert.equal(prompt.includes('回应者查询：要回答'), query);
          assert.equal(
            prompt.includes('反应观察：消息对象旁的reactions'),
            observe,
          );
          assert.equal(
            prompt.includes('需要时可read_message读取并刷新该消息'),
            observe,
          );
          assert.equal(
            prompt.includes('使用get_reaction_users按消息和表情查询实际回应者'),
            query,
          );
          assert.equal(
            prompt.includes('read_message不会额外获取反应快照'),
            query && !observe,
          );
          assert.equal(
            prompt.includes('缺少快照时先read_message核验'),
            query && observe,
          );
        }
        for (const prompt of [out.basePrompt, ...out.systemPrompts]) {
          assert.ok(!prompt.includes('程序自动采集的QQ反应快照'));
          assert.equal(
            prompt.includes('reactions仅在你调用读取工具后作为查询结果提供'),
            observe,
          );
        }
      }
    }
  }
});

test('explicit reaction query cache invalidates after mutation with background observation disabled', async () => {
  const args = { message_id: '1', emoji_id: '76', emoji_type: '1', limit: 20 };
  const out = await run(
    {
      react_message: { mode: 'direct' },
      get_reaction_users: { mode: 'direct' },
    },
    [
      tool('get_reaction_users', args, 'before'),
      tool('react_message', { message_id: '1', emoji_id: '76', action: 'add' }),
      tool('get_reaction_users', args, 'after'),
    ],
    false,
  );
  assert.equal(out.results.get('before')?.status, 'ok');
  assert.equal(out.results.get('after')?.status, 'ok');
  assert.equal(
    out.calls.filter((c) => c.action === 'fetch_emoji_like').length,
    2,
  );
});

test('resolved view_images options enforce only the per-image downloader byte budget', async () => {
  const { config } = fixture({
      view_images: { mode: 'direct', maxDownloadMb: 4 },
    }),
    memory = new Cache(),
    limits: number[] = [];
  memory.append({
    messageId: '1',
    userId: MEMBER,
    nickname: 'fixture',
    text: '[图片]',
    time: Date.now() / 1000,
    images: [0, 1, 2].map((index) => ({ id: `img_1_${index}`, index })),
  });
  const api: Api = {
    async call() {
      return {
        message_id: '1',
        message_type: 'group',
        group_id: GROUP,
        sender: { user_id: MEMBER },
        message: [0, 1, 2].map((i) => ({
          type: 'image',
          data: { url: `https://images.example.test/${i}.png` },
        })),
      };
    },
  };
  const images = new ImageTools(
    api,
    memory,
    applyToolPolicies(config).images,
    async (_url, limit) => {
      limits.push(limit);
      return {
        dataUrl: 'data:image/png;base64,AA==',
        width: 1,
        height: 1,
        firstFrameOnly: false,
      };
    },
    GROUP,
  );
  const result = await images.view(
    { image_ids: ['img_1_0', 'img_1_1', 'img_1_2'] },
    { groupId: GROUP, actorId: MEMBER, selfId: SELF, messageId: '1' },
    images.createTurn(),
  );
  assert.deepEqual(limits, [4 * 1024 * 1024, 4 * 1024 * 1024, 4 * 1024 * 1024]);
  assert.deepEqual(result.result.loaded_ids, ['img_1_0', 'img_1_1', 'img_1_2']);
  assert.deepEqual(result.result.failed_ids, []);
});

test('resolved mute and attention resource options reach actual execution guards', async () => {
  const mute = await run({ mute_member: { mode: 'direct', maxSeconds: 45 } }, [
    tool('mute_member', { user_id: MEMBER, seconds: 46 }, 'too_long'),
    tool('mute_member', { user_id: MEMBER, seconds: 30 }, 'allowed'),
  ]);
  assert.equal(mute.results.get('too_long')?.status, 'error');
  assert.equal(mute.results.get('allowed')?.status, 'executed');
  assert.equal(
    mute.calls.filter((c) => c.action === 'set_group_ban').length,
    1,
  );
  const create = {
    operation: 'create',
    any_of: [{ type: 'next_message' }],
    expires_in_seconds: 60,
  };
  const attention = await run(
    { manage_attention: { mode: 'direct', maxPlans: 1 } },
    [
      tool('manage_attention', create, 'first'),
      tool('manage_attention', create, 'second'),
    ],
  );
  assert.equal(attention.results.get('first')?.status, 'staged');
  assert.equal(attention.results.get('second')?.error, 'plan_limit');
});

test('resolved confirm policies share TTL and require the configured owner once for native dispatch', async () => {
  const { config } = fixture({
      mute_member: { mode: 'confirm', maxSeconds: 45 },
      set_group_title: { mode: 'confirm' },
    }),
    rpc = transport(),
    memory = new Cache();
  let captured: JsonObject[] = [];
  const model: Model = {
    async complete(messages) {
      const outputs = messages.filter((m) => m.role === 'tool');
      if (!outputs.length) {
        return {
          content: null,
          tool_calls: [
            tool('mute_member', { user_id: MEMBER, seconds: 30 }),
            tool('set_group_title', { user_id: MEMBER, title: 'fixture' }),
          ],
        };
      }
      captured = outputs.map((m) => JSON.parse(String(m.content)));
      return { content: null, tool_calls: [tool('finish', { mode: 'hard' })] };
    },
  };
  const bot = new Listener(
    rpc.api,
    model,
    memory,
    config,
    undefined,
    undefined,
    undefined,
    sessionRuntime(config.groupId).runtime,
  );
  try {
    await bot.receive(incoming(), SELF);
    await until(() => captured.length === 2);
    assert.ok(captured.every((r) => r.status === 'confirmation_required'));
    const notices = rpc.calls
      .filter((c) => c.action === 'send_group_msg')
      .map((c) => JSON.stringify(c.params.message));
    assert.equal(notices.length, 2);
    assert.ok(notices.every((s) => s.includes('37秒')));
    const codes = notices.map((s) => /\/confirm ([a-f0-9]{32})/.exec(s)![1]!);
    const writes = () =>
      rpc.calls.filter((c) =>
        ['set_group_ban', 'set_group_special_title'].includes(c.action),
      );
    assert.equal(writes().length, 0);
    await bot.receive(
      incoming('2', MEMBER, `/confirm ${codes[0]}`, false),
      SELF,
    );
    assert.equal(writes().length, 0);
    await bot.receive(
      {
        ...incoming('3', OWNER, `/confirm ${codes[0]}`, false),
        group_id: '445566',
      },
      SELF,
    );
    assert.equal(writes().length, 0);
    await bot.receive(
      incoming('4', OWNER, `/confirm ${codes[0]}`, false),
      SELF,
    );
    assert.equal(writes().length, 1);
    await delay(2100);
    await bot.receive(
      incoming('5', OWNER, `/confirm ${codes[1]}`, false),
      SELF,
    );
    assert.equal(writes().length, 2);
    await delay(2100);
    await bot.receive(
      incoming('6', OWNER, `/confirm ${codes[0]}`, false),
      SELF,
    );
    assert.equal(writes().length, 2);
  } finally {
    await bot.stop();
  }
});

test('ts mode sends declarations to the model while confirm proposals still validate the full schema', async () => {
  const { config } = fixture(
      { mute_member: { mode: 'confirm', maxSeconds: 45 } },
      false,
      'ts',
    ),
    rpc = transport(),
    memory = new Cache();
  let captured: JsonObject[] = [];
  let sent: { system: string; tools: ToolDefinition[] } | undefined;
  const model: Model = {
    async complete(messages, tools = []) {
      sent ??= {
        system: String(messages.find((m) => m.role === 'system')?.content),
        tools,
      };
      const outputs = messages.filter((m) => m.role === 'tool');
      if (!outputs.length) {
        return {
          content: null,
          tool_calls: [
            tool('mute_member', { user_id: MEMBER, seconds: 46 }, 'over'),
            tool('mute_member', { user_id: MEMBER, seconds: 'x' }, 'bad'),
            tool('mute_member', { user_id: MEMBER, seconds: 30 }, 'ok'),
            tool(
              'mute_member',
              { params: { user_id: MEMBER, seconds: 30 } },
              'wrapped',
            ),
            tool('get_time', { _: {} }, 'wrapped_empty'),
          ],
        };
      }
      captured = outputs.map((m) => JSON.parse(String(m.content)));
      return { content: null, tool_calls: [tool('finish', { mode: 'hard' })] };
    },
  };
  const bot = new Listener(
    rpc.api,
    model,
    memory,
    config,
    undefined,
    undefined,
    undefined,
    sessionRuntime(config.groupId).runtime,
  );
  try {
    await bot.receive(incoming(), SELF);
    await until(() => captured.length === 5);
    const mute = sent!.tools.find((t) => t.function.name === 'mute_member')!;
    assert.deepEqual(mute.function.parameters, {
      type: 'object',
      additionalProperties: true,
    });
    assert.match(sent!.system, /function mute_member\(_: /);
    assert.match(sent!.system, /1 到 45/);
    assert.deepEqual(
      captured.map((r) => r.status),
      ['error', 'error', 'confirmation_required', 'error', 'error'],
    );
    assert.deepEqual(
      captured.slice(3).map((r) => [r.reason_code, r.hint]),
      [
        ['wrapped_arguments', 'arguments 应直接是参数对象，去掉外层的 params'],
        ['wrapped_arguments', 'arguments 应直接是参数对象，去掉外层的 _'],
      ],
    );
    assert.doesNotMatch(sent!.system, /\(params/);
    assert.equal(
      rpc.calls.filter((c) => c.action === 'send_group_msg').length,
      1,
    );
  } finally {
    await bot.stop();
  }
});

test('mention format permission is independent of both member read tools', async () => {
  const memory = new Cache(),
    rpc = transport(),
    ctx = { groupId: GROUP, actorId: MEMBER, selfId: SELF, messageId: '1' };
  for (const key of ['getGroupMembers', 'getMemberInfo']) {
    for (const value of [null, undefined, 1, 'true']) {
      assert.throws(
        () =>
          new GroupTools(rpc.api, memory, {
            groupId: GROUP,
            [key]: value,
          } as never),
      );
    }
  }
  const disabled = new GroupTools(rpc.api, memory, {
    groupId: GROUP,
    getGroupMembers: true,
    getMemberInfo: true,
    mention: false,
  });
  await assert.rejects(() =>
    disabled.prepareMessage(
      { segments: [{ type: 'at', user_id: MEMBER }] },
      ctx,
    ),
  );
  assert.equal(rpc.calls.length, 0);
  const allowed = new GroupTools(rpc.api, memory, {
    groupId: GROUP,
    getGroupMembers: false,
    getMemberInfo: false,
    mention: true,
  });
  const message = await allowed.prepareMessage(
    { segments: [{ type: 'at', user_id: MEMBER }] },
    ctx,
  );
  assert.equal(message.segments[0]?.type, 'at');
  assert.equal(
    (await allowed.execute('get_member_info', { user_id: MEMBER }, ctx)).error,
    'tool_disabled',
  );
});
