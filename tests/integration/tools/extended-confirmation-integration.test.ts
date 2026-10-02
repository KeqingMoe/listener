import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import { buildToolDefinitions } from '../../../src/agent/tool-definitions.ts';
import { OWNER_ID } from '../../../src/contracts/identity.ts';
import { type Api } from '../../../src/contracts/onebot.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';
import {
  type ChatMessage,
  type Completion,
  type Model,
} from '../../../src/contracts/model.ts';
import { type JsonObject } from '../../../src/contracts/json.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import type { ExtendedToolsConfig } from '../../../src/config/extended-tools.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const GROUP = '123456',
  SELF = '999',
  ACTOR = '111',
  TARGET = '222';

class Mem implements Memory {
  rows: TimelineEntry[] = [];
  append(row: TimelineEntry) {
    if (this.find(row.messageId)) {
      return false;
    }
    this.rows.push(structuredClone(row));
    return true;
  }

  recent() {
    return this.rows;
  }

  find(id: string) {
    return this.rows.find((row) => row.messageId === id);
  }

  context() {
    return JSON.stringify(this.rows);
  }

  async compact() {}
  clear() {
    this.rows = [];
  }

  close() {}
}

const call = (name: string, args: unknown = {}) => ({
  id: name + Math.random(),
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const response = (...calls: ReturnType<typeof call>[]): Completion => ({
  content: null,
  tool_calls: calls,
});

function event(
  id = '1',
  actor = ACTOR,
  text = '请处理',
  mention = true,
  extra: JsonObject = {},
) {
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
    ...extra,
  };
}

const results = (messages: ChatMessage[]) =>
  messages
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(String(m.content)) as JsonObject);

function setup(
  extended: ExtendedToolsConfig,
  respond: (index: number, messages: ChatMessage[]) => Completion,
  hook?: (action: string, params: JsonObject) => Promise<unknown> | unknown,
  overrides: Partial<ListenerConfig> = {},
) {
  const calls: { action: string; params: JsonObject }[] = [],
    requests: ChatMessage[][] = [],
    memory = new Mem();
  let role = 'admin';
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params: structuredClone(params) });
      const override = hook?.(action, params);
      if (override !== undefined) {
        return await override;
      }
      if (action === 'get_login_info') {
        return { user_id: SELF };
      }
      if (action === 'get_group_member_info') {
        return {
          group_id: GROUP,
          user_id: params.user_id,
          role: params.user_id === SELF ? role : 'member',
        };
      }
      if (action === 'get_msg') {
        return {
          message_type: 'group',
          group_id: GROUP,
          message_id: params.message_id,
          user_id: ACTOR,
          sender: { user_id: ACTOR },
          message: [{ type: 'text', data: { text: 'fixture' } }],
        };
      }
      if (action === 'send_group_msg') {
        return { message_id: String(900 + calls.length) };
      }
      if (
        ['set_group_kick', 'set_group_admin', 'set_group_name'].includes(action)
      ) {
        return null;
      }
      if (action === 'get_group_root_files') {
        return {
          files: [
            {
              group_id: GROUP,
              file_id: 'PROVIDER-PRIVATE-FILE',
              file_name: 'note.txt',
              file_size: 10,
              uploader: SELF,
            },
          ],
          folders: [
            {
              group_id: GROUP,
              folder_id: 'PROVIDER-PRIVATE-FOLDER',
              folder_name: '资料',
              creator: SELF,
              total_file_count: 1,
            },
          ],
        };
      }
      if (action === 'delete_group_folder') {
        return { retCode: 0 };
      }
      if (action === 'delete_group_file') {
        return null;
      }
      assert.fail('unexpected fixture API ' + action);
    },
  };
  const model: Model = {
    async complete(messages) {
      requests.push(structuredClone(messages));
      return respond(requests.length - 1, messages);
    },
  };
  const config: ListenerConfig = {
    groupId: GROUP,
    ownerId: OWNER_ID,
    enabled: true,
    debounceMs: 1,
    cooldownMs: 0,
    retentionDays: 7,
    randomReplyProbability: 0,
    toolPermissions: toolPermissions({
      ...MEMBER_TOOLS,
      react_message: 'direct',
      get_reaction_users: 'direct',
      mute_member: { mode: 'off', maxSeconds: 600 },
      ...extended,
    }),
    observeReactions: true,
    confirmationTtlSeconds: 60,
    ...overrides,
  };
  const bot = new Listener(
    api,
    model,
    memory,
    config,
    () => 0,
    undefined,
    undefined,
    sessionRuntime(config.groupId).runtime,
  );
  return {
    bot,
    calls,
    requests,
    memory,
    config,
    role: (value: string) => {
      role = value;
    },
    receive: (raw = event()) => bot.receive(raw, SELF),
  };
}

type Harness = ReturnType<typeof setup>;

async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail('listener fixture did not settle');
}

async function settled(h: Harness, count = 2) {
  await until(
    () =>
      h.requests.length >= count &&
      !(h.bot as unknown as { running: boolean }).running &&
      !(h.bot as unknown as { pending: unknown }).pending,
  );
}

function notices(h: Harness) {
  return h.calls
    .filter((c) => c.action === 'send_group_msg')
    .map((c) =>
      (c.params.message as { data: { text?: string } }[])
        .map((s) => s.data.text ?? '')
        .join(''),
    );
}

function code(h: Harness) {
  const proposal = notices(h).find((text) => text.includes('/confirm '));
  assert.ok(proposal);
  const found = /\/confirm ([a-f0-9]+)/.exec(proposal);
  assert.ok(found);
  return found[1]!;
}

function writes(h: Harness, action = 'set_group_kick') {
  return h.calls.filter((c) => c.action === action);
}

const proposeKick = (i: number) =>
  i === 0
    ? response(
        call('kick_member', { user_id: TARGET, reject_add_request: false }),
      )
    : response(call('finish', { mode: 'hard' }));

test('confirmed poke submission never turns into a fabricated delivery acknowledgement', async () => {
  const h = setup(
    { poke_member: 'confirm' },
    (i) =>
      i === 0
        ? response(call('poke_member', { user_id: TARGET }))
        : response(call('finish', { mode: 'hard' })),
    (action) => (action === 'group_poke' ? null : undefined),
  );
  try {
    await h.receive();
    await settled(h);
    assert.equal(writes(h, 'group_poke').length, 0);
    await h.receive(event('2', OWNER_ID, `/confirm ${code(h)}`, false));
    assert.equal(writes(h, 'group_poke').length, 1);
    assert.match(notices(h).at(-1)!, /已正常提交.*未单独核验/);
    assert.doesNotMatch(notices(h).at(-1)!, /已执行确认|未能确认执行成功/);
  } finally {
    h.bot.stop();
  }
});

test('a nonowner can propose but only current-group owner confirms after wake finishes through fresh API', async () => {
  const h = setup({ kick_member: 'confirm' }, proposeKick);
  try {
    assert.ok(
      buildToolDefinitions(h.config).some(
        (d) => d.function.name === 'kick_member',
      ),
    );
    await h.receive();
    await settled(h);
    assert.equal(writes(h).length, 0);
    const token = code(h);
    const notice = notices(h)[0]!;
    assert.match(notice, /踢出成员，不禁止再次申请/);
    assert.ok(notice.includes(TARGET));
    assert.match(notice, /提案尚未执行/);
    const proposal = results(h.requests[1]!)[0]!;
    assert.equal(proposal.status, 'confirmation_required');
    assert.equal(proposal.code, undefined);
    assert.equal(proposal.description, undefined);
    assert.ok(!JSON.stringify(proposal).includes(token));
    await h.receive(event('2', ACTOR, '/confirm ' + token, false));
    await h.receive(
      event('3', OWNER_ID, '/confirm ' + token, false, { group_id: '888' }),
    );
    await h.receive(
      event('4', OWNER_ID, '/confirm ' + token, false, { self_id: '888' }),
    );
    assert.equal(writes(h).length, 0);
    const before = h.calls.length;
    await h.receive(event('5', OWNER_ID, '/confirm ' + token, false));
    assert.equal(writes(h).length, 1);
    assert.deepEqual(writes(h)[0]!.params, {
      group_id: GROUP,
      user_id: TARGET,
      reject_add_request: false,
    });
    assert.ok(h.calls.slice(before).some((c) => c.action === 'get_login_info'));
    assert.ok(
      h.calls
        .slice(before)
        .some(
          (c) =>
            c.action === 'get_group_member_info' && c.params.user_id === SELF,
        ),
    );
    assert.match(notices(h).at(-1)!, /已正常提交/);
    assert.doesNotMatch(notices(h).at(-1)!, /已执行确认|未能确认执行成功/);
    assert.equal(h.requests.length, 2);
  } finally {
    await h.bot.stop();
  }
});

test('equivalent JSON argument formatting shares one proposal and never exposes its code to the model', async () => {
  const first = call('kick_member', {
    user_id: TARGET,
    reject_add_request: false,
  });
  const second = call('kick_member', {});
  second.function.arguments = ` { "reject_add_request" : false, "user_id" : "${TARGET}" } `;
  const h = setup({ kick_member: 'confirm' }, (i) =>
    i === 0
      ? response(first, second)
      : response(call('finish', { mode: 'hard' })),
  );
  try {
    await h.receive();
    await settled(h);
    assert.equal(notices(h).length, 1);
    assert.equal(writes(h).length, 0);
    const token = code(h);
    const list = results(h.requests[1]!);
    assert.equal(list.length, 2);
    assert.equal(list[1]!.cached, true);
    for (const item of list) {
      assert.equal(item.status, 'confirmation_required');
      assert.equal(item.code, undefined);
      assert.equal(item.description, undefined);
      assert.ok(!JSON.stringify(item).includes(token));
    }
  } finally {
    await h.bot.stop();
  }
});

test('insufficient current QQ rights reject the proposal before emitting any owner code', async () => {
  const h = setup({ kick_member: 'confirm' }, proposeKick);
  h.role('member');
  try {
    await h.receive();
    await settled(h);
    assert.equal(writes(h).length, 0);
    assert.equal(notices(h).length, 0);
    assert.equal(results(h.requests[1]!)[0]!.status, 'error');
  } finally {
    await h.bot.stop();
  }
});

test('current QQ role revocation after proposal prevents the approved mutation', async () => {
  const h = setup({ kick_member: 'confirm' }, proposeKick);
  try {
    await h.receive();
    await settled(h);
    const token = code(h);
    h.role('member');
    await h.receive(event('2', OWNER_ID, '/confirm ' + token, false));
    assert.equal(writes(h).length, 0);
    assert.match(notices(h).at(-1)!, /未能确认执行成功/);
  } finally {
    await h.bot.stop();
  }
});

test('failed confirmation notification revokes the owner code and hides it from model tool results', async () => {
  let rejectNotice = true;
  const h = setup({ kick_member: 'confirm' }, proposeKick, (action) => {
    if (action === 'send_group_msg' && rejectNotice) {
      rejectNotice = false;
      throw new Error('fixture network failure');
    }
  });
  try {
    await h.receive();
    await settled(h);
    const token = code(h);
    const outcome = results(h.requests[1]!)[0]!;
    assert.equal(outcome.status, 'unknown');
    assert.equal(outcome.proposal_cancelled, true);
    assert.ok(!JSON.stringify(outcome).includes(token));
    await h.receive(event('2', OWNER_ID, '/confirm ' + token, false));
    assert.equal(writes(h).length, 0);
    assert.match(notices(h).at(-1)!, /未能确认执行成功/);
  } finally {
    await h.bot.stop();
  }
});

test('a notification ACK arriving after disconnect cannot revive its confirmation code', async () => {
  let release!: (value: unknown) => void,
    entered = false;
  const pending = new Promise<unknown>((r) => {
    release = r;
  });
  let first = true;
  const h = setup({ kick_member: 'confirm' }, proposeKick, (action) => {
    if (action === 'send_group_msg' && first) {
      first = false;
      entered = true;
      return pending;
    }
  });
  try {
    await h.receive();
    await until(() => entered);
    const token = code(h);
    h.bot.setConnected(false);
    release({ message_id: '9000' });
    await until(() => !(h.bot as unknown as { running: boolean }).running);
    h.bot.setConnected(true);
    await h.receive(event('2', OWNER_ID, '/confirm ' + token, false));
    assert.equal(writes(h).length, 0);
    assert.match(notices(h).at(-1)!, /未能确认执行成功/);
  } finally {
    release?.({ message_id: '9000' });
    await h.bot.stop();
  }
});

test('a late notification after the wake deadline revokes its code without needing disconnect or reset', async () => {
  let release!: (value: unknown) => void,
    entered = false;
  const pending = new Promise<unknown>((r) => {
    release = r;
  });
  let first = true;
  const h = setup(
    { kick_member: 'confirm' },
    proposeKick,
    (action) => {
      if (action === 'send_group_msg' && first) {
        first = false;
        entered = true;
        return pending;
      }
    },
    { wakeTimeoutMs: 1000 },
  );
  try {
    await h.receive();
    await until(() => entered);
    const token = code(h);
    await until(
      () =>
        (h.bot as unknown as { active?: AbortController }).active?.signal
          .aborted === true,
    );
    release({ message_id: '9001' });
    await until(() => !(h.bot as unknown as { running: boolean }).running);
    await h.receive(event('2', OWNER_ID, '/confirm ' + token, false));
    assert.equal(writes(h).length, 0);
    assert.match(notices(h).at(-1)!, /未能确认执行成功/);
  } finally {
    release?.({ message_id: '9001' });
    await h.bot.stop();
  }
});

test('off cannot produce proposals while direct remains immediate without an owner notice', async () => {
  for (const mode of ['off', 'direct'] as const) {
    const h = setup({ kick_member: mode }, proposeKick);
    try {
      await h.receive();
      await settled(h);
      assert.equal(writes(h).length, mode === 'direct' ? 1 : 0);
      assert.equal(notices(h).length, 0);
      assert.equal(
        results(h.requests[1]!)[0]!.status,
        mode === 'direct' ? 'ok' : 'error',
      );
      if (mode === 'direct') {
        assert.equal(results(h.requests[1]!)[0]!.submitted, true);
        assert.equal(results(h.requests[1]!)[0]!.effect_confirmed, false);
      }
    } finally {
      await h.bot.stop();
    }
  }
});

function fileModel(name: 'delete_group_file' | 'delete_group_folder') {
  return (i: number, messages: ChatMessage[]): Completion => {
    if (i === 0) {
      return response(call('list_group_files', { limit: 10 }));
    }
    if (i === 1) {
      const listed = results(messages).find((x) => Array.isArray(x.items))!;
      const kind = name === 'delete_group_file' ? 'file' : 'folder';
      const target = (listed.items as JsonObject[]).find(
        (x) => x.kind === kind,
      )!;
      const field = kind + '_handle';
      return response(call(name, { [field]: target[field] }));
    }
    return response(call('finish', { mode: 'hard' }));
  };
}

test('file and folder confirm display resolved target metadata and defer every destructive API', async () => {
  for (const name of ['delete_group_file', 'delete_group_folder'] as const) {
    const h = setup(
      { list_group_files: 'direct', [name]: 'confirm' },
      fileModel(name),
    );
    try {
      assert.ok(
        buildToolDefinitions(h.config).some((d) => d.function.name === name),
      );
      await h.receive();
      await settled(h, 3);
      const token = code(h);
      const notice = notices(h)[0]!;
      assert.equal(writes(h, name).length, 0);
      assert.match(notice, name === 'delete_group_file' ? /note\.txt/ : /资料/);
      assert.ok(!notice.includes('PROVIDER-PRIVATE'));
      const proposal = results(h.requests[2]!).at(-1)!;
      assert.equal(proposal.status, 'confirmation_required');
      assert.equal(proposal.description, undefined);
      assert.equal(proposal.code, undefined);
      await h.receive(event('2', OWNER_ID, '/confirm ' + token, false));
      assert.equal(writes(h, name).length, 1);
      if (name === 'delete_group_folder') {
        assert.equal(notices(h).at(-1), '已执行确认的管理操作。');
      } else {
        assert.match(notices(h).at(-1)!, /未能确认执行成功/);
      }
    } finally {
      await h.bot.stop();
    }
  }
});

test('resolved file target changing after display prevents confirmation rather than approving a different target', async () => {
  let changed = false;
  const h = setup(
    { list_group_files: 'direct', delete_group_file: 'confirm' },
    fileModel('delete_group_file'),
    (action) => {
      if (action === 'get_group_root_files' && changed) {
        return {
          files: [
            {
              group_id: GROUP,
              file_id: 'PROVIDER-PRIVATE-FILE',
              file_name: 'different.txt',
              file_size: 11,
              uploader: TARGET,
            },
          ],
          folders: [],
        };
      }
    },
  );
  try {
    await h.receive();
    await settled(h, 3);
    const token = code(h);
    changed = true;
    await h.receive(event('2', OWNER_ID, '/confirm ' + token, false));
    assert.equal(writes(h, 'delete_group_file').length, 0);
    assert.match(notices(h).at(-1)!, /未能确认执行成功/);
  } finally {
    await h.bot.stop();
  }
});

test('set_group_admin confirmation rechecks owner-only rights after a valid proposal', async () => {
  const h = setup({ set_group_admin: 'confirm' }, (i) =>
    i === 0
      ? response(call('set_group_admin', { user_id: TARGET, enable: false }))
      : response(call('finish', { mode: 'hard' })),
  );
  try {
    assert.ok(
      buildToolDefinitions(h.config).some(
        (d) => d.function.name === 'set_group_admin',
      ),
    );
    h.role('owner');
    await h.receive();
    await settled(h);
    const token = code(h);
    assert.equal(writes(h, 'set_group_admin').length, 0);
    h.role('admin');
    await h.receive(event('2', OWNER_ID, '/confirm ' + token, false));
    assert.equal(writes(h, 'set_group_admin').length, 0);
  } finally {
    await h.bot.stop();
  }
});
