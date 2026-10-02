import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadAppConfig } from '../../../src/config/loader.ts';
import { inspectGroupConfig } from '../../../src/config/inspect.ts';
import { toListenerConfig } from '../../../src/config/runtime.ts';
import {
  TOOL_NAMES,
  TOOL_CAPABILITIES,
} from '../../../src/config/tool-policy.ts';
import { Listener } from '../../../src/agent/listener.ts';
import { buildToolDefinitions } from '../../../src/agent/tool-definitions.ts';
import { buildSystemPrompt } from '../../../src/agent/prompts/index.ts';
import type { Api } from '../../../src/contracts/onebot.ts';
import type { JsonObject } from '../../../src/contracts/json.ts';
import type { Memory, TimelineEntry } from '../../../src/contracts/messages.ts';
import type { Model } from '../../../src/contracts/model.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const GROUP = '123456789',
  OWNER = '100000001',
  SELF = '100000002',
  MEMBER = '100000003';
// 显式的产品约定，与实现中默认模式的计算方式无关。
const DIRECT = [
  'get_group_members',
  'get_member_info',
  'get_group_info',
  'get_group_honor',
  'get_group_mutes',
  'read_group_notices',
  'read_group_essence',
  'get_group_ai_voices',
  'get_group_file_space',
  'list_group_files',
  'read_group_text_file',
  'list_group_requests',
  'transcribe_voice',
  'create_reminder',
  'list_reminders',
  'update_reminder',
  'cancel_reminder',
  'execute_javascript',
  'query_javascript_jobs',
  'cancel_javascript_job',
  'web_search',
  'web_fetch',
  'create_artifact',
  'create_image',
  'list_artifacts',
  'react_message',
  'get_reaction_users',
  'view_images',
  'read_forward',
  'manage_attention',
  'poke_member',
  'group_sign',
  'send_group_image',
  'forward_message',
  'send_group_forward',
  'send_group_ai_voice',
  'list_custom_faces',
  'view_custom_face',
  'send_custom_face',
  'add_custom_face',
  'delete_custom_face',
  'set_custom_face_description',
];
const CONFIRM = [
  'mute_member',
  'unmute_member',
  'recall_message',
  'set_member_card',
  'set_group_name',
  'set_group_title',
  'set_group_whole_mute',
  'kick_member',
  'set_group_admin',
  'set_group_essence',
  'remove_group_essence',
  'publish_group_notice',
  'delete_group_notice',
  'respond_group_request',
  'upload_group_file',
  'create_group_folder',
  'delete_group_file',
  'delete_group_folder',
];

function fixture(t: { after(fn: () => void): void }, policies = '') {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-default-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'persona.md'), 'Fixture persona');
  writeFileSync(
    join(root, '.env'),
    'ONEBOT_ACCESS_TOKEN=fixture-token\nOPENAI_API_KEY=fixture-key\n',
  );
  writeFileSync(
    join(root, 'config.toml'),
    `[bot]\nowner_id="${OWNER}"\n[models.main]\napi_key_env="OPENAI_API_KEY"\nmodel="fixture"\n[logging]\nfile=false\n[defaults]\npersona="persona.md"\n${policies}\n`,
  );
  return loadAppConfig({ configPath: join(root, 'config.toml'), env: {} });
}

test('all 61 optional tools have the approved defaults; opening tools never opens group routing', (t) => {
  const app = fixture(t),
    group = app.resolveGroup(GROUP);
  assert.equal(app.defaultsEnabled, false);
  assert.equal(group.enabled, false);
  assert.equal(group.reply.random, false);
  assert.equal(group.observation.reactions, true);
  assert.deepEqual(
    [...DIRECT, ...CONFIRM, 'leave_group'].sort(),
    [...TOOL_NAMES].sort(),
  );
  assert.equal(TOOL_NAMES.length, 61);
  assert.equal(DIRECT.length, 42);
  assert.equal(CONFIRM.length, 18);
  const inspection = inspectGroupConfig(app, GROUP);
  const values = inspection.values as Record<string, unknown>;
  const diagnosedTools = values.tools as Record<
    string,
    string | { mode: string }
  >;
  const sources = inspection.sources as Record<string, string>;
  assert.equal((values.observation as { reactions: boolean }).reactions, true);
  assert.equal(sources['observation.reactions'], 'program_default');
  for (const name of TOOL_NAMES) {
    const expected =
      name === 'leave_group'
        ? 'off'
        : DIRECT.includes(name)
          ? 'direct'
          : 'confirm';
    assert.equal(TOOL_CAPABILITIES[name].defaultMode, expected, name);
    assert.equal(group.tools[name].mode, expected, name);
    const diagnosed = diagnosedTools[name]!;
    assert.equal(
      typeof diagnosed === 'string' ? diagnosed : diagnosed.mode,
      expected,
      name,
    );
    assert.equal(sources[`tools.${name}`], 'program_default', name);
    if (expected === 'confirm') {
      assert.equal(TOOL_CAPABILITIES[name].confirm, true, name);
    }
  }
  const definitions = buildToolDefinitions(toListenerConfig(app, group)).map(
    (t) => t.function.name,
  );
  // 未配置[web].search时，默认直接可用的web_search没有后端，因此不提供。
  assert.deepEqual(
    TOOL_NAMES.filter((n) => definitions.includes(n)).sort(),
    [...DIRECT, ...CONFIRM].filter((n) => n !== 'web_search').sort(),
  );
  assert.equal(definitions.includes('leave_group'), false);
  for (const name of [
    'send_message',
    'read_message',
    'finish',
    'get_wake_state',
    'get_time',
    'read_events',
  ]) {
    assert.ok(definitions.includes(name), name);
  }
  assert.doesNotMatch(
    buildSystemPrompt(toListenerConfig(app, group)),
    /默认\s*off|默认关闭/,
  );
});

test('the public tool reference lists every capability with its actual default and confirmation support', () => {
  const reference = readFileSync(
    new URL('../../../docs/configuration.md', import.meta.url),
    'utf8',
  );
  const rows = new Map<string, { mode: string; confirm: boolean }>();
  for (const line of reference.split('\n')) {
    const match = /^\| (.+) \| (direct|confirm|off) \| (是|否) \|/.exec(line);
    if (!match) {
      continue;
    }
    const columns = line
      .split('|')
      .slice(1, -1)
      .map((value) => value.trim());
    assert.equal(
      columns.length,
      6,
      'each configurable tool documents its category and purpose',
    );
    assert.ok(columns[5]!.length > 4, 'tool purpose must not be empty');
    const names = [...match[1]!.matchAll(/`([^`]+)`/g)];
    assert.equal(names.length, 1, 'each tool gets its own explanation');
    for (const name of names) {
      const helper = [
        'view_images',
        'view_custom_face',
        'read_forward',
        'read_group_text_file',
        'manage_attention',
        'create_reminder',
        'list_reminders',
        'update_reminder',
        'cancel_reminder',
        'execute_javascript',
        'query_javascript_jobs',
        'cancel_javascript_job',
        'web_search',
        'web_fetch',
        'create_artifact',
        'create_image',
        'list_artifacts',
      ].includes(name[1]!);
      assert.equal(columns[4], helper ? 'Bot辅助' : 'QQ功能', name[1]!);
      assert.equal(
        rows.has(name[1]!),
        false,
        `duplicate documentation: ${name[1]}`,
      );
      rows.set(name[1]!, { mode: match[2]!, confirm: match[3] === '是' });
    }
  }
  assert.deepEqual([...rows.keys()].sort(), [...TOOL_NAMES].sort());
  for (const name of TOOL_NAMES) {
    assert.deepEqual(
      rows.get(name),
      {
        mode: TOOL_CAPABILITIES[name].defaultMode,
        confirm: TOOL_CAPABILITIES[name].confirm,
      },
      name,
    );
  }
  const core = [
    ...reference.matchAll(/^\| `([^`]+)` \| (QQ功能|Bot辅助) \| (.+) \|$/gm),
  ];
  assert.deepEqual(
    core.map((row) => row[1]).sort(),
    [
      'send_message',
      'read_message',
      'get_wake_state',
      'get_time',
      'read_events',
      'finish',
    ].sort(),
  );
  for (const row of core) {
    assert.equal(row[2], row[1] === 'send_message' ? 'QQ功能' : 'Bot辅助');
    assert.ok(row[3]!.length > 4);
  }
});

test('the public example needs only real model setup and uses the approved tool defaults', (t) => {
  const initial = fixture(t);
  const example = readFileSync(
    new URL('../../../config.example.toml', import.meta.url),
    'utf8',
  ).replace('prompts/listener.example.md', 'persona.md');
  writeFileSync(initial.configPath, example);
  writeFileSync(
    join(dirname(initial.configPath), '.env'),
    readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
  );
  assert.throws(
    () => loadAppConfig({ configPath: initial.configPath, env: {} }),
    /models\.main\.model/,
  );
  writeFileSync(
    initial.configPath,
    example.replace('model = ""', 'model = "fixture"'),
  );
  const app = loadAppConfig({ configPath: initial.configPath, env: {} });
  const group = app.resolveGroup('100000002');
  assert.equal(group.enabled, true);
  assert.equal(group.observation.reactions, true);
  for (const name of TOOL_NAMES) {
    assert.equal(
      group.tools[name].mode,
      TOOL_CAPABILITIES[name].defaultMode,
      name,
    );
  }
  const sources = inspectGroupConfig(app, group.groupId).sources as Record<
    string,
    string
  >;
  for (const name of [
    'get_group_info',
    'poke_member',
    'react_message',
    'send_group_ai_voice',
    'mute_member',
    'leave_group',
    'view_images',
    'read_forward',
    'manage_attention',
    'list_custom_faces',
    'view_custom_face',
    'send_custom_face',
    'add_custom_face',
    'delete_custom_face',
    'set_custom_face_description',
  ]) {
    assert.equal(
      sources[`tools.${name}`],
      'defaults',
      `example must include ${name}`,
    );
  }
});

test('explicit modes, independent observation and group overrides survive the new defaults', (t) => {
  const app = fixture(
    t,
    `observation.reactions=false\n[defaults.tools]\npoke_member="off"\nmute_member={mode="direct",max_seconds=120}\nget_reaction_users="off"\n[groups."${GROUP}"]\nenabled=true\ntools.mute_member="confirm"\ntools.poke_member="direct"\n[groups."100000004"]\nenabled=true\n`,
  );
  const group = app.resolveGroup(GROUP),
    other = app.resolveGroup('100000004');
  assert.equal(group.enabled, true);
  assert.equal(group.tools.poke_member.mode, 'direct');
  assert.equal(other.tools.poke_member.mode, 'off');
  assert.equal(group.tools.mute_member.mode, 'confirm');
  assert.equal(group.tools.mute_member.maxSeconds, 2592000);
  assert.equal(other.tools.mute_member.mode, 'direct');
  assert.equal(other.tools.mute_member.maxSeconds, 120);
  assert.equal(group.observation.reactions, false);
  assert.equal(group.tools.react_message.mode, 'direct');
  assert.equal(group.tools.get_reaction_users.mode, 'off');
  const sources = inspectGroupConfig(app, GROUP).sources as Record<
    string,
    string
  >;
  assert.equal(sources['tools.poke_member'], 'group');
  assert.equal(sources['tools.mute_member.mode'], 'group');
  assert.equal(sources['tools.mute_member.max_seconds'], 'program_default');
  assert.equal(sources['tools.get_reaction_users'], 'defaults');
  assert.equal(sources['observation.reactions'], 'defaults');
  group.tools.poke_member.mode = 'off';
  assert.equal(app.resolveGroup(GROUP).tools.poke_member.mode, 'direct');
});

test('every optional tool can still be explicitly disabled without affecting base protocol tools', (t) => {
  const app = fixture(
    t,
    `observation.reactions=false\n[defaults.tools]\n${TOOL_NAMES.map((n) => `${n}="off"`).join('\n')}`,
  );
  const definitions = buildToolDefinitions(
    toListenerConfig(app, app.resolveGroup(GROUP)),
  ).map((t) => t.function.name);
  assert.deepEqual(
    TOOL_NAMES.filter((n) => definitions.includes(n)),
    [],
  );
  assert.ok(definitions.includes('send_message'));
  assert.ok(definitions.includes('finish'));
});

class Cache implements Memory {
  entries: TimelineEntry[] = [];
  append(entry: TimelineEntry) {
    if (this.find(entry.messageId)) {
      return false;
    }
    this.entries.push(entry);
    return true;
  }

  recent() {
    return this.entries;
  }

  find(id: string) {
    return this.entries.find((e) => e.messageId === id);
  }

  context() {
    return JSON.stringify(this.entries);
  }

  async compact() {
    throw new Error('unexpected summary');
  }

  clear() {
    this.entries = [];
  }

  close() {}
}

const call = (name: string, args: unknown) => ({
  id: name,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

function incoming(id: string, actor: string, text: string, mention = false) {
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

async function until(predicate: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  assert.fail('default policy fixture timeout');
}

test('default poke dispatches directly but default daily moderation waits for the real owner', async (t) => {
  const app = fixture(
    t,
    `reply.delay_ms=[0,0]\nobservation.reactions=false\n[groups."${GROUP}"]\nenabled=true`,
  );
  const nativeCalls: { action: string; params: JsonObject }[] = [];
  const api: Api = {
    async call(action, params = {}) {
      nativeCalls.push({ action, params });
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
      if (action === 'send_group_msg') {
        return { message_id: String(1000 + nativeCalls.length) };
      }
      if (['group_poke', 'send_poke', 'set_group_ban'].includes(action)) {
        return null;
      }
      throw new Error('unexpected native call: ' + action);
    },
  };
  let results: JsonObject[] = [];
  const model: Model = {
    async complete(messages) {
      const outputs = messages.filter((m) => m.role === 'tool');
      if (!outputs.length) {
        return {
          content: null,
          tool_calls: [
            call('poke_member', { user_id: MEMBER }),
            call('mute_member', { user_id: MEMBER, seconds: 30 }),
          ],
        };
      }
      results = outputs.map((m) => JSON.parse(String(m.content)));
      return { content: null, tool_calls: [call('finish', { mode: 'hard' })] };
    },
  };
  const bot = new Listener(
    api,
    model,
    new Cache(),
    toListenerConfig(app, app.resolveGroup(GROUP)),
    undefined,
    undefined,
    undefined,
    sessionRuntime(toListenerConfig(app, app.resolveGroup(GROUP)).groupId)
      .runtime,
  );
  try {
    await bot.receive(incoming('1', MEMBER, 'fixture request', true), SELF);
    await until(() => results.length === 2);
    assert.equal(results[0]!.submitted, true);
    assert.equal(results[1]!.status, 'confirmation_required');
    assert.equal(
      nativeCalls.filter((c) => ['group_poke', 'send_poke'].includes(c.action))
        .length,
      1,
    );
    assert.equal(
      nativeCalls.filter((c) => c.action === 'set_group_ban').length,
      0,
    );
    const notice = nativeCalls.find((c) => c.action === 'send_group_msg');
    const code = /\/confirm ([a-f0-9]{32})/.exec(
      JSON.stringify(notice?.params.message),
    )?.[1];
    assert.ok(code);
    await bot.receive(incoming('2', MEMBER, `/confirm ${code}`), SELF);
    assert.equal(
      nativeCalls.filter((c) => c.action === 'set_group_ban').length,
      0,
    );
    await bot.receive(incoming('3', OWNER, `/confirm ${code}`), SELF);
    assert.equal(
      nativeCalls.filter((c) => c.action === 'set_group_ban').length,
      1,
    );
  } finally {
    await bot.stop();
  }
});
