import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolRegistry } from '../../../src/tools/registry.ts';
import { loadAppConfig } from '../../../src/config/loader.ts';
import {
  applyToolPolicies,
  toListenerConfig,
} from '../../../src/config/runtime.ts';
import {
  createExtendedTools,
  buildExtendedToolDefinitions,
} from '../../../src/tools/extended.ts';
import {
  EXTENDED_TOOL_NAMES,
  enabledExtendedTools,
  type ExtendedToolsConfig,
} from '../../../src/config/extended-tools.ts';
import { GROUP_ACTION_TOOL_NAMES } from '../../../src/tools/actions/tools.ts';
import { GROUP_OBSERVATION_TOOL_NAMES } from '../../../src/tools/observation/tools.ts';
import { Listener } from '../../../src/agent/listener.ts';
import { buildToolDefinitions } from '../../../src/agent/tool-definitions.ts';
import { ModelSession } from '../../../src/agent/session/store.ts';
import { WorldEventStore } from '../../../src/world/events.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import { type Api } from '../../../src/contracts/onebot.ts';
import {
  type ChatMessage,
  type Completion,
} from '../../../src/contracts/model.ts';
import { type JsonObject } from '../../../src/contracts/json.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';
import {
  type ToolDefinition,
  type TurnContext,
} from '../../../src/contracts/tools.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';

const self = '900000001',
  actor = '12345',
  groupId = LISTENER_GROUP;
const context: TurnContext = {
  groupId,
  selfId: self,
  actorId: actor,
  messageId: '1',
};
const base: ListenerConfig = {
  toolPermissions: toolPermissions(MEMBER_TOOLS),
  groupId: LISTENER_GROUP,
  ownerId: OWNER_ID,
  enabled: true,
  debounceMs: 1,
  cooldownMs: 1,
  retentionDays: 7,
  randomReplyProbability: 0,
};
const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const completion = (...calls: Completion['tool_calls']): Completion => ({
  content: null,
  tool_calls: calls,
});

function memory(): Memory {
  const rows: TimelineEntry[] = [];
  return {
    recent: () => rows,
    find: (id) => rows.find((r) => r.messageId === id),
    append(row) {
      rows.push(row);
      return true;
    },
    context: () => '',
    async compact() {
      throw new Error('Unexpected legacy compaction');
    },
    clear() {
      rows.length = 0;
    },
    close() {},
  };
}

function config(extended?: ExtendedToolsConfig): ListenerConfig {
  return {
    ...base,
    toolPermissions: toolPermissions({
      ...extended,
      mute_member: { mode: 'off', maxSeconds: 600 },
    }),
    messageMentions: false,
    confirmationTtlSeconds: 60,
  };
}

const definition = (name: string): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description: 'fixture',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
});

function event() {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    self_id: self,
    user_id: actor,
    message_id: '1',
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'fixture' },
    message: [
      { type: 'at', data: { qq: self } },
      { type: 'text', data: { text: 'PRIVATE_TRIGGER' } },
    ],
  };
}

function result(messages: ChatMessage[], id: string): JsonObject {
  const item = messages.find((m) => m.tool_call_id === id);
  assert.ok(item, `missing result ${id}`);
  return JSON.parse(String(item.content)) as JsonObject;
}

async function fixture(options: {
  extended?: ExtendedToolsConfig;
  budget?: number;
  respond: (
    messages: ChatMessage[],
    round: number,
  ) => Completion | Promise<Completion>;
  apiHook?: (
    action: string,
    params: JsonObject,
    listener: Listener,
  ) => unknown | Promise<unknown>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'extended-integration-'));
  const session = new ModelSession({
      model: 'main',
      path: join(dir, 'session.sqlite'),
      groupId,
    }),
    world = new WorldEventStore({ path: join(dir, 'world.sqlite'), groupId });
  const native: Array<{ action: string; params: JsonObject }> = [],
    requests: ChatMessage[][] = [],
    failures: unknown[] = [];
  let listener: Listener;
  const api: Api = {
    async call(action, params = {}) {
      native.push({ action, params });
      if (options.apiHook) {
        const value = await options.apiHook(action, params, listener);
        if (value !== undefined) {
          return value;
        }
      }
      if (action === 'get_login_info') {
        return { user_id: self };
      }
      if (action === 'get_group_member_info') {
        return {
          group_id: groupId,
          user_id: params.user_id,
          role: params.user_id === self ? 'owner' : 'member',
        };
      }
      if (action === 'get_group_info') {
        return {
          group_id: groupId,
          group_name: 'Fixture group',
          member_count: 5,
          max_member_count: 200,
        };
      }
      if (action === 'send_group_msg') {
        return { message_id: '9001' };
      }
      if (
        [
          'group_poke',
          'set_group_name',
          'set_group_whole_ban',
          'set_group_sign',
        ].includes(action)
      ) {
        return null;
      }
      throw new Error('Unexpected API ' + action);
    },
  };
  listener = new Listener(
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
    memory(),
    {
      ...config(options.extended),
      ...(options.budget
        ? {
            groupId: LISTENER_GROUP,
            ownerId: OWNER_ID,
            maxToolCallsPerWake: options.budget,
          }
        : { groupId: LISTENER_GROUP, ownerId: OWNER_ID }),
    },
    () => 0,
    undefined,
    undefined,
    { session, world, modelRequestId: () => `request-${requests.length}` },
  );
  return {
    listener,
    session,
    world,
    native,
    requests,
    async run() {
      await listener.receive(event(), self);
      for (let i = 0; i < 400; i++) {
        if (requests.length && !session.state().wakeId) {
          if (failures.length) {
            throw failures[0];
          }
          return;
        }
        await delay(5);
      }
      assert.fail('extended fixture did not settle');
    },
    async close() {
      await listener.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('registry definitions and dispatch share an immutable unique registration', async () => {
  const registry = new ToolRegistry(),
    d = definition('read_fixture');
  let executions = 0;
  registry.register({
    definition: d,
    sideEffect: false,
    async execute() {
      executions++;
      return { status: 'ok' };
    },
  });
  d.function.name = 'mutated';
  registry.definitions()[0]!.function.parameters.required = ['mutated'];
  assert.equal(registry.has('read_fixture'), true);
  assert.equal(registry.has('mutated'), false);
  assert.deepEqual(registry.definitions()[0]!.function.parameters.required, []);
  assert.throws(
    () =>
      registry.register({
        definition: definition('read_fixture'),
        sideEffect: true,
        async execute() {
          return {};
        },
      }),
    /duplicate/,
  );
  assert.throws(() =>
    registry.register({
      definition: definition('../invalid'),
      sideEffect: false,
      async execute() {
        return {};
      },
    }),
  );
  assert.equal(
    (await registry.execute('missing', {}, context)).error,
    'tool_disabled',
  );
  assert.equal(executions, 0);
  assert.equal(
    (await registry.execute('read_fixture', {}, context)).status,
    'ok',
  );
  assert.equal(executions, 1);
});

test('registry sanitizes thrown read and write failures, checks early cancellation, preserves late ACK', async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  for (const sideEffect of [false, true]) {
    registry.register({
      definition: definition(sideEffect ? 'write_fixture' : 'read_fixture'),
      sideEffect,
      async execute() {
        calls++;
        throw new Error('SECRET_PRIVATE_ERROR_URL');
      },
    });
  }
  assert.deepEqual(await registry.execute('read_fixture', {}, context), {
    status: 'error',
    error: 'tool_failed',
  });
  assert.deepEqual(await registry.execute('write_fixture', {}, context), {
    status: 'unknown',
    error: 'tool_result_unknown',
  });
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(
    await registry.execute('write_fixture', {}, context, aborted.signal),
    { status: 'error', error: 'cancelled' },
  );
  assert.equal(calls, 2);
  const late = new AbortController();
  registry.register({
    definition: definition('late_ack'),
    sideEffect: true,
    async execute() {
      late.abort();
      return { status: 'executed' };
    },
  });
  assert.deepEqual(
    await registry.execute('late_ack', {}, context, late.signal),
    { status: 'executed' },
  );
});

test('extended capabilities default off and raw model calls cannot bypass absent registration', async () => {
  let native = 0;
  const api: Api = {
    async call() {
      native++;
      throw new Error('must not call native');
    },
  };
  assert.deepEqual(enabledExtendedTools(), []);
  assert.deepEqual(buildExtendedToolDefinitions(groupId), []);
  for (const setting of [
    undefined,
    Object.fromEntries(
      EXTENDED_TOOL_NAMES.map((name) => [name, 'off']),
    ) as ExtendedToolsConfig,
  ]) {
    const registry = createExtendedTools(api, memory(), groupId, setting);
    assert.deepEqual(registry.definitions(), []);
    for (const name of EXTENDED_TOOL_NAMES) {
      assert.equal(registry.has(name), false);
      assert.equal(
        (await registry.execute(name, {}, context)).error,
        'tool_disabled',
      );
    }
    assert.equal(
      buildToolDefinitions(config(setting)).some((d) =>
        (EXTENDED_TOOL_NAMES as readonly string[]).includes(d.function.name),
      ),
      false,
    );
  }
  assert.equal(native, 0);
});

test('loaded TOML is the source of per-group registration without capability leakage', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'extended-config-registry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts/listener.md'), 'Fixture persona');
  const path = join(dir, 'config.toml');
  writeFileSync(
    path,
    '[bot]\nowner_id="778899"\n[models.main]\napi_key_env="OPENAI_API_KEY"\nmodel="fixture-model"\n[defaults.tools]\n' +
      EXTENDED_TOOL_NAMES.map((name) => `${name}="off"`).join('\n') +
      '\n[groups."111"]\nenabled=true\ntools.get_group_info="direct"\n[groups."222"]\nenabled=true\ntools.get_group_info="off"\n',
  );
  const loaded = loadAppConfig({
    configPath: path,
    env: { ONEBOT_ACCESS_TOKEN: 'fixture', OPENAI_API_KEY: 'fixture-key' },
  });
  assert.deepEqual(
    enabledExtendedTools(
      applyToolPolicies(toListenerConfig(loaded, loaded.resolveGroup('333')))
        .tools.extended,
    ),
    [],
  );
  assert.equal(loaded.resolveGroup('333').enabled, false);
  let calls = 0;
  const api: Api = {
    async call() {
      calls++;
      throw new Error('unexpected API');
    },
  };
  for (const id of loaded.configuredGroupIds) {
    const group = toListenerConfig(loaded, loaded.resolveGroup(id));
    const registry = createExtendedTools(
      api,
      memory(),
      group.groupId!,
      applyToolPolicies(group).tools.extended,
    );
    assert.deepEqual(
      registry.definitions().map((d) => d.function.name),
      group.groupId === '111' ? ['get_group_info'] : [],
    );
    assert.deepEqual(
      buildToolDefinitions(group).filter((d) =>
        (EXTENDED_TOOL_NAMES as readonly string[]).includes(d.function.name),
      ),
      registry.definitions(),
    );
    if (group.groupId === '222') {
      assert.equal(
        (
          await registry.execute(
            'get_group_info',
            {},
            { ...context, groupId: '222' },
          )
        ).error,
        'tool_disabled',
      );
    }
  }
  assert.equal(calls, 0);
});

test('each explicit capability appears identically in schema generation Listener and runtime lookup', async () => {
  let native = 0;
  const api: Api = {
    async call() {
      native++;
      throw new Error('must not call native');
    },
  };
  for (const name of EXTENDED_TOOL_NAMES) {
    const setting: ExtendedToolsConfig = { [name]: 'direct' },
      registry = createExtendedTools(api, memory(), groupId, setting),
      defs = registry.definitions();
    assert.deepEqual(
      defs.map((d) => d.function.name),
      [name],
    );
    assert.equal(registry.has(name), true);
    assert.deepEqual(buildExtendedToolDefinitions(groupId, setting), defs);
    const listenerDefs = buildToolDefinitions({
      ...config(setting),
      webSearch: { type: 'searxng', url: 'http://127.0.0.1:8888' },
    }).filter((d) =>
      (EXTENDED_TOOL_NAMES as readonly string[]).includes(d.function.name),
    );
    assert.deepEqual(listenerDefs, defs);
    if ((GROUP_ACTION_TOOL_NAMES as readonly string[]).includes(name)) {
      assert.equal(registry.isSideEffect(name), true);
    }
    if ((GROUP_OBSERVATION_TOOL_NAMES as readonly string[]).includes(name)) {
      assert.equal(registry.isSideEffect(name), false);
    }
    assert.notEqual(
      (await registry.execute(name, { unexpected: true }, context)).error,
      'tool_disabled',
    );
  }
  assert.equal(native, 0);
});

test('Listener rejects raw disabled names and checkpoints the result without native API calls', async () => {
  const f = await fixture({
    respond: () =>
      completion(
        call('disabled', 'set_group_name', { name: 'must not apply' }),
        call('done', 'finish', { mode: 'hard' }),
      ),
  });
  try {
    await f.run();
    assert.equal(f.native.length, 0);
    assert.equal(
      result(f.session.messages(), 'disabled').error,
      'tool_disabled',
    );
    assert.equal(result(f.session.messages(), 'done').status, 'ok');
    assert.equal(
      f.session.summarizeTools({ since: 0, until: Date.now() }).pending,
      0,
    );
  } finally {
    await f.close();
  }
});

test('readonly extension can complete with send and finish without creating a management review gate', async () => {
  const f = await fixture({
    extended: { get_group_info: 'direct' },
    respond: () =>
      completion(
        call('info', 'get_group_info'),
        call('send', 'send_message', {
          segments: [{ type: 'text', text: 'reply after read' }],
        }),
        call('done', 'finish', { mode: 'hard' }),
      ),
  });
  try {
    await f.run();
    assert.equal(f.requests.length, 1);
    assert.equal(result(f.session.messages(), 'info').status, 'ok');
    assert.equal(result(f.session.messages(), 'send').status, 'ok');
    assert.equal(
      f.native.filter((c) => c.action === 'send_group_msg').length,
      1,
    );
    assert.equal(
      f.session.summarizeTools({ since: 0, until: Date.now() }).pending,
      0,
    );
  } finally {
    await f.close();
  }
});

test('readonly native failure stays sanitized and does not impose the write review gate', async () => {
  const f = await fixture({
    extended: { get_group_info: 'direct' },
    apiHook: (action) => {
      if (action === 'get_group_info') {
        throw new Error('SECRET_PRIVATE_NATIVE_ERROR');
      }
    },
    respond: () =>
      completion(
        call('failed-read', 'get_group_info'),
        call('send', 'send_message', {
          segments: [{ type: 'text', text: 'read was unavailable' }],
        }),
        call('done', 'finish', { mode: 'hard' }),
      ),
  });
  try {
    await f.run();
    const value = result(f.session.messages(), 'failed-read');
    assert.equal(value.status, 'error');
    assert.doesNotMatch(JSON.stringify(value), /SECRET|PRIVATE|NATIVE/);
    assert.equal(result(f.session.messages(), 'send').status, 'ok');
    assert.equal(
      f.native.filter((c) => c.action === 'send_group_msg').length,
      1,
    );
    assert.equal(
      f.session.summarizeTools({ since: 0, until: Date.now() }).unknown,
      0,
    );
  } finally {
    await f.close();
  }
});

for (const budget of [96, 5]) {
  test(`explicit ten pokes remain independent submissions under shared budget ${budget}`, async () => {
    const f = await fixture({
      extended: { poke_member: 'direct' },
      budget,
      respond: (messages, round) => {
        if (round === 1) {
          return completion(
            ...Array.from({ length: 10 }, (_, i) =>
              call(`poke${i}`, 'poke_member', { user_id: actor }),
            ),
          );
        }
        assert.equal(budget, 96);
        assert.equal(round, 2);
        for (let i = 0; i < 10; i++) {
          const r = result(messages, `poke${i}`);
          assert.equal(r.status, 'ok');
          assert.equal(r.submitted, true);
          assert.equal(r.delivery_confirmed, false);
          assert.equal(r.cached, undefined);
        }
        return completion(call('done', 'finish', { mode: 'hard' }));
      },
    });
    try {
      await f.run();
      assert.equal(
        f.native.filter((c) => c.action === 'group_poke').length,
        Math.min(10, budget),
      );
      assert.equal(
        f.session.summarizeTools({ since: 0, until: Date.now() }).pending,
        0,
      );
    } finally {
      await f.close();
    }
  });
}

test('unknown write blocks prewritten send in same response, permits reviewed send in next model round', async () => {
  const f = await fixture({
    extended: { poke_member: 'direct' },
    apiHook: (action) => {
      if (action === 'group_poke') {
        throw new Error('synthetic transport failure');
      }
    },
    respond: (messages, round) => {
      if (round === 1) {
        assert.match(
          JSON.stringify(
            messages.filter(
              (m) =>
                m.role === 'user' &&
                typeof m.content === 'string' &&
                JSON.parse(m.content).context_update,
            ),
          ),
          /PRIVATE_TRIGGER/,
        );
        return completion(
          call('poke', 'poke_member', { user_id: actor }),
          call('prewritten', 'send_message', {
            segments: [{ type: 'text', text: 'MUST_NOT_SEND' }],
          }),
        );
      }
      assert.equal(round, 2);
      assert.equal(result(messages, 'poke').status, 'unknown');
      assert.equal(
        result(messages, 'prewritten').error,
        'management_result_review_required',
      );
      return completion(
        call('reviewed', 'send_message', {
          segments: [{ type: 'text', text: 'result remains uncertain' }],
        }),
        call('done', 'finish', { mode: 'hard' }),
      );
    },
  });
  try {
    await f.run();
    assert.equal(f.requests.length, 2);
    assert.equal(f.native.filter((c) => c.action === 'group_poke').length, 1);
    const sent = f.native.filter((c) => c.action === 'send_group_msg');
    assert.equal(sent.length, 1);
    assert.doesNotMatch(JSON.stringify(sent), /MUST_NOT_SEND/);
    assert.match(JSON.stringify(sent), /result remains uncertain/);
    const summary = f.session.summarizeTools({ since: 0, until: Date.now() });
    assert.equal(summary.pending, 0);
    assert.equal(summary.unknown, 1);
  } finally {
    await f.close();
  }
});

test('finish terminates before trailing enabled write and read extensions', async () => {
  const f = await fixture({
    extended: { set_group_name: 'direct', get_group_info: 'direct' },
    respond: () =>
      completion(
        call('done', 'finish', { mode: 'hard' }),
        call('trailing-write', 'set_group_name', { name: 'never' }),
        call('trailing-read', 'get_group_info'),
      ),
  });
  try {
    await f.run();
    assert.equal(f.native.length, 0);
    assert.equal(
      result(f.session.messages(), 'trailing-write').status,
      'skipped',
    );
    assert.equal(
      result(f.session.messages(), 'trailing-read').status,
      'skipped',
    );
    assert.equal(
      f.session.summarizeTools({ since: 0, until: Date.now() }).pending,
      0,
    );
  } finally {
    await f.close();
  }
});

test('extended tools consume the shared wake budget, not one allowance per native call', async () => {
  const f = await fixture({
    extended: { get_group_info: 'direct', set_group_name: 'direct' },
    budget: 1,
    respond: () =>
      completion(
        call('info', 'get_group_info'),
        call('tail', 'set_group_name', { name: 'never' }),
        call('done', 'finish', { mode: 'hard' }),
      ),
  });
  try {
    await f.run();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(
      f.native.map((c) => c.action),
      ['get_login_info', 'get_group_info'],
    );
    assert.equal(result(f.session.messages(), 'info').status, 'ok');
    assert.equal(result(f.session.messages(), 'tail').status, 'skipped');
    assert.equal(result(f.session.messages(), 'done').status, 'skipped');
    assert.equal(
      f.session.summarizeTools({ since: 0, until: Date.now() }).pending,
      0,
    );
  } finally {
    await f.close();
  }
});

test('cancelled wake retains late confirmed extension ACK and resolves trailing ledger entries', async () => {
  const f = await fixture({
    extended: { set_group_name: 'direct' },
    apiHook: (action, _params, listener) => {
      if (action === 'set_group_name') {
        listener.setConnected(false);
      }
    },
    respond: () =>
      completion(
        call('rename', 'set_group_name', { name: 'changed' }),
        call('tail', 'send_message', {
          segments: [{ type: 'text', text: 'never' }],
        }),
        call('done', 'finish', { mode: 'hard' }),
      ),
  });
  try {
    await f.run();
    assert.equal(
      f.native.filter((c) => c.action === 'set_group_name').length,
      1,
    );
    assert.equal(
      f.native.filter((c) => c.action === 'send_group_msg').length,
      0,
    );
    assert.equal(result(f.session.messages(), 'rename').status, 'executed');
    assert.equal(
      result(f.session.messages(), 'rename').cancelled_after_dispatch,
      true,
    );
    assert.equal(result(f.session.messages(), 'tail').status, 'skipped');
    assert.equal(
      f.session.summarizeTools({ since: 0, until: Date.now() }).pending,
      0,
    );
  } finally {
    await f.close();
  }
});
