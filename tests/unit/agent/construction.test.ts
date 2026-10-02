import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safetyRules,
  buildSystemPrompt,
} from '../../../src/agent/prompts/index.ts';
import {
  CHAT_TOOLS,
  buildToolDefinitions,
} from '../../../src/agent/tool-definitions.ts';
import type {
  ListenerConfig,
  ModerationPolicy,
} from '../../../src/config/listener.ts';
import {
  TOOL_NAMES,
  TOOL_CAPABILITIES,
  type ResolvedToolPolicies,
  type ToolName,
  type ToolPolicy,
} from '../../../src/config/tool-policy.ts';
import type { ToolDefinition } from '../../../src/contracts/tools.ts';
import { VIEW_IMAGES_TOOL } from '../../../src/tools/images/tools.ts';
import { READ_FORWARD_TOOL } from '../../../src/tools/forwards/tools.ts';
import { GET_REACTION_USERS_TOOL } from '../../../src/tools/reactions/users.ts';
import { MANAGE_ATTENTION_TOOL } from '../../../src/agent/attention.ts';
import { buildModerationTools } from '../../../src/tools/management/moderation.ts';
import { buildExtendedToolDefinitions } from '../../../src/tools/extended.ts';
import { buildWorldTools } from '../../../src/tools/world/tools.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

const offModeration: ModerationPolicy = {
  mute: 'off',
  unmute: 'off',
  recall: 'off',
  memberCard: 'off',
  confirmationTtlSeconds: 30,
  maxMuteSeconds: 120,
};

function config(overrides: Partial<ListenerConfig> = {}): ListenerConfig {
  return {
    groupId: '7654321',
    ownerId: '8765432',
    enabled: true,
    debounceMs: 1,
    cooldownMs: 0,
    retentionDays: 7,
    toolPermissions: permissions(),
    confirmationTtlSeconds: 30,
    ...overrides,
  };
}

/** 成员查询默认开启、禁言上限120秒，其余工具关闭。 */
function permissions(
  overrides: Parameters<typeof toolPermissions>[0] = {},
): ResolvedToolPolicies {
  return toolPermissions({
    ...MEMBER_TOOLS,
    mute_member: { mode: 'off', maxSeconds: 120 },
    ...overrides,
  });
}

function policies(
  overrides: Partial<Record<ToolName, ToolPolicy>> = {},
): ResolvedToolPolicies {
  return Object.fromEntries(
    TOOL_NAMES.map((name) => [
      name,
      {
        mode: 'off',
        ...Object.fromEntries(
          Object.values(TOOL_CAPABILITIES[name].options).map((option) => [
            option.field,
            option.default,
          ]),
        ),
        ...overrides[name],
      },
    ]),
  ) as ResolvedToolPolicies;
}

const names = (tools: ToolDefinition[]) =>
  tools.map((tool) => tool.function.name);

function get(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((tool) => tool.function.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

function segmentKinds(tools: ToolDefinition[]): string[] {
  const parameters = get(tools, 'send_message').function.parameters as any;
  return parameters.properties.segments.items.oneOf.map(
    (branch: any) => branch.properties.type.const,
  );
}

function pollute(value: unknown): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') {
      pollute(child);
    } else {
      (value as Record<string, unknown>)[key] =
        typeof child === 'number' ? -123 : 'CONSTRUCTION_POLLUTION';
    }
  }
}

for (let mask = 0; mask < 8; mask++) {
  const mention = Boolean(mask & 1),
    images = Boolean(mask & 2),
    forward = Boolean(mask & 4);
  test(`construction independently selects mention=${mention}, images=${images}, forward=${forward}`, () => {
    const input = freeze(
      config({
        toolPermissions: permissions({
          view_images: { mode: images ? 'direct' : 'off', maxDownloadMb: 1 },
          read_forward: forward ? 'direct' : 'off',
        }),
        messageMentions: mention,
      }),
    );
    const before = structuredClone(input),
      tools = buildToolDefinitions(input);
    assert.deepEqual(names(tools), [
      ...names(CHAT_TOOLS),
      ...(images ? ['view_images'] : []),
      ...(forward ? ['read_forward'] : []),
      ...names(buildWorldTools()),
    ]);
    assert.equal(segmentKinds(tools).includes('at'), mention);
    assert.ok(segmentKinds(tools).includes('text'));
    assert.ok(segmentKinds(tools).includes('face'));
    if (images) {
      const expected = structuredClone(VIEW_IMAGES_TOOL);
      assert.deepEqual(get(tools, 'view_images'), expected);
    }
    if (forward) {
      assert.deepEqual(get(tools, 'read_forward'), READ_FORWARD_TOOL);
    }
    buildSystemPrompt(input);
    assert.deepEqual(input, before);
  });
}

for (let mask = 0; mask < 8; mask++) {
  const react = Boolean(mask & 1),
    query = Boolean(mask & 2),
    observe = Boolean(mask & 4);
  test(`resolved reaction construction keeps react=${react}, query=${query}, observe=${observe} independent`, () => {
    const input = freeze(
      config({
        toolPermissions: policies({
          react_message: { mode: react ? 'direct' : 'off' },
          get_reaction_users: { mode: query ? 'direct' : 'off' },
        }),
        observeReactions: observe,
      }),
    );
    const before = structuredClone(input),
      tools = buildToolDefinitions(input),
      prompt = buildSystemPrompt(input);
    const base = names(CHAT_TOOLS).filter(
      (name) => !['get_group_members', 'get_member_info'].includes(name),
    );
    assert.deepEqual(names(tools), [
      ...base,
      ...(react ? ['react_message'] : []),
      ...(query ? ['get_reaction_users'] : []),
      ...names(buildWorldTools()),
    ]);
    assert.equal(prompt.includes('\n消息表情回应：'), react);
    assert.equal(prompt.includes('\n回应者查询：'), query);
    assert.equal(prompt.includes('\n反应观察：'), observe);
    assert.equal(prompt.includes('\n反应事实边界：'), observe || query);
    if (query) {
      assert.deepEqual(
        get(tools, 'get_reaction_users'),
        GET_REACTION_USERS_TOOL,
      );
      assert.equal(
        prompt.includes('本轮未启用反应观察，read_message不会额外获取反应快照'),
        !observe,
      );
    }
    assert.deepEqual(input, before);
  });
}

test('resolved react permission alone neither exposes reaction query nor enables observation', () => {
  const resolved = freeze(
    config({
      toolPermissions: policies({ react_message: { mode: 'direct' } }),
    }),
  );
  assert.ok(names(buildToolDefinitions(resolved)).includes('react_message'));
  assert.ok(
    !names(buildToolDefinitions(resolved)).includes('get_reaction_users'),
  );
  assert.ok(!buildSystemPrompt(resolved).includes('\n反应观察：'));
});

test('resolved off permissions ignore stray enabled legacy module fields without altering frozen input', () => {
  // 旧版模块字段已不属于ListenerConfig；即使未经类型检查混入也不能打开工具。
  const stray = {
    tools: {
      members: true,
      mention: true,
      reactions: true,
      moderation: { ...offModeration, mute: 'direct' },
      extended: { poke_member: 'direct', list_custom_faces: 'direct' },
    },
    images: { enabled: true, maxDownloadMb: 10 },
    forward: { enabled: true },
    attention: { enabled: true, maxPlans: 16 },
  } as Partial<ListenerConfig>;
  const input = freeze(
    config({
      ...stray,
      toolPermissions: policies(),
      messageMentions: false,
    }),
  );
  const before = structuredClone(input),
    tools = buildToolDefinitions(input),
    prompt = buildSystemPrompt(input);
  assert.deepEqual(names(tools), [
    ...names(CHAT_TOOLS).filter(
      (name) => !['get_group_members', 'get_member_info'].includes(name),
    ),
    ...names(buildWorldTools()),
  ]);
  assert.ok(!segmentKinds(tools).includes('at'));
  assert.ok(!prompt.includes('\n关注计划：'));
  assert.ok(!prompt.includes('\n收藏表情：'));
  assert.deepEqual(input, before);
});

test('resolved selections preserve shared schema ordering and limits', () => {
  const input = freeze(
    config({
      messageMentions: true,
      confirmationTtlSeconds: 17,
      toolPermissions: policies({
        get_member_info: { mode: 'direct' },
        view_images: { mode: 'direct', maxDownloadMb: 2 },
        read_forward: { mode: 'direct' },
        react_message: { mode: 'direct' },
        get_reaction_users: { mode: 'direct' },
        manage_attention: { mode: 'direct', maxPlans: 3 },
        mute_member: { mode: 'confirm', maxSeconds: 41 },
        unmute_member: { mode: 'direct' },
        poke_member: { mode: 'confirm' },
        list_custom_faces: { mode: 'direct' },
        send_custom_face: { mode: 'direct' },
      }),
    }),
  );
  const before = structuredClone(input),
    tools = buildToolDefinitions(input);
  const moderation = buildModerationTools({
    ...offModeration,
    mute: 'confirm',
    unmute: 'direct',
    maxMuteSeconds: 41,
    confirmationTtlSeconds: 17,
  });
  const extended = buildExtendedToolDefinitions(input.groupId!, {
    poke_member: 'confirm',
    list_custom_faces: 'direct',
    send_custom_face: 'direct',
  });
  assert.deepEqual(names(tools), [
    ...names(CHAT_TOOLS).filter((name) => name !== 'get_group_members'),
    'view_images',
    'read_forward',
    'react_message',
    'get_reaction_users',
    'manage_attention',
    ...names(buildWorldTools()),
    ...names(moderation),
    ...names(extended),
  ]);
  assert.equal(new Set(names(tools)).size, tools.length);
  assert.ok(segmentKinds(tools).includes('at'));
  assert.equal(
    (get(tools, 'view_images').function.parameters as any).properties.image_ids
      .maxItems,
    undefined,
  );
  assert.deepEqual(get(tools, 'manage_attention'), MANAGE_ATTENTION_TOOL);
  for (const expected of [...buildWorldTools(), ...moderation, ...extended]) {
    assert.deepEqual(get(tools, expected.function.name), expected);
  }
  const prompt = buildSystemPrompt(input);
  assert.ok(prompt.includes('\n关注计划：'));
  assert.ok(prompt.includes('\n收藏表情：'));
  const limits = JSON.parse(
    prompt.split('\n本轮配置限制：')[1]!.split('\n')[0]!,
  );
  assert.deepEqual(limits.tools, input.toolPermissions);
  assert.deepEqual(limits.messages, { mentions: true });
  assert.deepEqual(limits.observation, { reactions: false });
  assert.deepEqual(limits.confirmation, { ttl_seconds: 17 });
  assert.deepEqual(input, before);
});

test('returned definitions are deeply independent across repeats, option changes, and shared templates', () => {
  const input = freeze(
    config({
      toolPermissions: permissions({
        react_message: 'direct',
        get_reaction_users: 'direct',
        mute_member: { mode: 'confirm', maxSeconds: 120 },
        recall_message: 'direct',
        poke_member: 'confirm',
        list_custom_faces: 'direct',
        send_custom_face: 'direct',
        view_images: { mode: 'direct', maxDownloadMb: 1 },
        read_forward: 'direct',
        manage_attention: { mode: 'direct', maxPlans: 2 },
      }),
      observeReactions: true,
    }),
  );
  const templates = [
    CHAT_TOOLS,
    VIEW_IMAGES_TOOL,
    READ_FORWARD_TOOL,
    GET_REACTION_USERS_TOOL,
    MANAGE_ATTENTION_TOOL,
  ];
  const templateBefore = structuredClone(templates),
    before = structuredClone(input);
  const baseline = structuredClone(buildToolDefinitions(input));
  const poisoned = buildToolDefinitions(input);
  pollute(poisoned);
  assert.deepEqual(buildToolDefinitions(input), baseline);
  const reduced = freeze(
    config({
      toolPermissions: permissions({
        get_group_members: 'off',
        get_member_info: 'off',
        view_images: { mode: 'direct', maxDownloadMb: 1 },
      }),
      messageMentions: false,
    }),
  );
  assert.ok(!segmentKinds(buildToolDefinitions(reduced)).includes('at'));
  assert.deepEqual(buildToolDefinitions(input), baseline);
  assert.deepEqual(templates, templateBefore);
  assert.deepEqual(input, before);
});

test('identity and persona are scoped per prompt, preserve escaping, and never change default safety rules', () => {
  const input = freeze(
    config({
      botName: 'Name"\nentry',
      persona: 'CUSTOM_PERSONA\nLiteral text',
    }),
  );
  const before = structuredClone(input),
    prompt = buildSystemPrompt(input);
  const identity = JSON.parse(
    prompt.split('\n')[0]!.slice('身份配置：'.length),
  );
  assert.deepEqual(identity, { name: input.botName, owner_id: input.ownerId });
  assert.ok(
    prompt.includes(
      `性格与表达：\n${input.persona}\n\n${safetyRules(input.groupId)}`,
    ),
  );
  const other = buildSystemPrompt(
    freeze({ ...input, groupId: '9988776', ownerId: '8877665' }),
  );
  assert.ok(other.includes('本轮只服务群 9988776。'));
  assert.ok(prompt.includes(`本轮只服务群 ${input.groupId}。`));
  assert.equal(buildSystemPrompt(input), prompt);
  assert.deepEqual(input, before);
  assert.throws(() => safetyRules('01'));
  assert.throws(() => buildSystemPrompt(config({ ownerId: 'invalid' })));
});

test('system prompt uses observation framing and the explicit group without mutating config', () => {
  const input = freeze(
    config({
      observeReactions: true,
      toolPermissions: permissions({
        manage_attention: { mode: 'direct', maxPlans: 2 },
      }),
    }),
  );
  const before = structuredClone(input),
    prompt = buildSystemPrompt({ ...input, groupId: '6677889' });
  assert.ok(!prompt.includes('current_batch'));
  assert.ok(prompt.includes('本轮只服务群 6677889。'));
  assert.ok(
    prompt.includes(
      '唤醒会自动投递当前未读中的最新事件；后续新事件会在运行期间的安全边界继续投递。',
    ),
  );
  assert.ok(
    prompt.includes(
      '消息对象旁的reactions仅在你调用读取工具后作为查询结果提供。',
    ),
  );
  assert.ok(
    prompt.includes(
      '关注唤醒时 wake.trigger.plan_hits 给出本次命中的计划与原因',
    ),
  );
  assert.ok(prompt.includes('\n观察边界：'));
  assert.ok(prompt.includes('查询工具不推进已读位置'));
  assert.ok(prompt.includes('finish必须指定mode'));
  assert.ok(!names(buildToolDefinitions(input)).includes('read_messages'));
  assert.ok(!names(buildToolDefinitions(input)).includes('ack_events'));
  assert.ok(!prompt.includes('新到达的群友消息不加入当前范围。'));
  assert.equal(buildSystemPrompt({ ...input, groupId: '6677889' }), prompt);
  assert.deepEqual(input, before);
  assert.throws(() => buildSystemPrompt({ ...input, groupId: '0' }));
});
