import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import type { Api } from '../../../src/contracts/onebot.ts';
import type {
  ChatMessage,
  Completion,
  Model,
} from '../../../src/contracts/model.ts';
import type { Memory, TimelineEntry } from '../../../src/contracts/messages.ts';
import type { ToolCall } from '../../../src/contracts/tools.ts';
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const self = '900000001',
  actor = '12345';
const voice = {
  type: 'record',
  data: { file: 'PRIVATE_TOKEN', url: 'https://private.invalid/voice' },
};
const cfg: ListenerConfig = {
  ownerId: OWNER_ID,
  groupId: LISTENER_GROUP,
  enabled: true,
  debounceMs: 1,
  delayMaxMs: 1,
  cooldownMs: 0,
  retentionDays: 7,
  randomReplyProbability: 0,
  maxToolCallsPerWake: 10,
  toolPermissions: toolPermissions({
    ...MEMBER_TOOLS,
    transcribe_voice: 'direct',
  }),
};

class Mem implements Memory {
  entries: TimelineEntry[] = [];
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
    return JSON.stringify(this.entries);
  }

  async compact() {}
  clear() {
    this.entries = [];
  }

  close() {}
}

const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const transcribe = (id = '1') =>
  call('transcribe', 'transcribe_voice', { message_id: id });
const finish = () => call('finish', 'finish', { mode: 'hard' });
const send = () =>
  call('send', 'send_message', {
    segments: [{ type: 'text', text: '收到，明天见。' }],
  });
const complete = (...tool_calls: ToolCall[]): Completion => ({
  content: null,
  tool_calls,
});
const event = (
  message: unknown[] = [{ type: 'at', data: { qq: self } }, voice],
  messageId = '1',
) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: LISTENER_GROUP,
  self_id: self,
  user_id: actor,
  message_id: messageId,
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: 'Alice' },
  message,
});

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail('listener did not settle');
}

function setup(
  responses: Completion[],
  options: {
    off?: boolean;
    foreign?: boolean;
    recognize?: () => Promise<unknown>;
  } = {},
) {
  const memory = new Mem(),
    requests: ChatMessage[][] = [],
    schemas: string[][] = [],
    calls: Array<{ action: string; params: any }> = [];
  const api: Api = {
    async call(action, params) {
      calls.push({ action, params });
      if (action === 'get_login_info') {
        return { user_id: self };
      }
      if (action === 'get_msg') {
        return {
          message_id: params?.message_id,
          message_type: 'group',
          group_id: options.foreign ? '999999' : LISTENER_GROUP,
          sender: { user_id: actor },
          message: [voice],
        };
      }
      if (action === 'fetch_ptt_text') {
        return options.recognize ? options.recognize() : { text: '明天见。' };
      }
      if (action === 'send_group_msg') {
        return { message_id: String(100 + calls.length) };
      }
      throw new Error('unexpected RPC');
    },
  };
  const model: Model = {
    async complete(messages, tools) {
      requests.push(structuredClone(messages));
      schemas.push(tools?.map((t) => t.function.name) ?? []);
      return responses.shift() ?? complete(finish());
    },
  };
  const bot = new Listener(
    api,
    model,
    memory,
    {
      ...cfg,
      toolPermissions: toolPermissions({
        ...MEMBER_TOOLS,
        transcribe_voice: options.off ? 'off' : 'direct',
      }),
    },
    () => 1,
    undefined,
    undefined,
    sessionRuntime(
      {
        ...cfg,
        toolPermissions: toolPermissions({
          ...MEMBER_TOOLS,
          transcribe_voice: options.off ? 'off' : 'direct',
        }),
      }.groupId,
    ).runtime,
  );
  return { bot, memory, requests, schemas, calls };
}

const result = (messages: ChatMessage[]) =>
  JSON.parse(
    messages.find((m) => m.role === 'tool' && m.tool_call_id === 'transcribe')!
      .content as string,
  );

for (const quoted of [false, true]) {
  test(`QQ voice transcription reaches the next model round before reply; quoted=${quoted}`, async () => {
    const target = quoted ? '2' : '1',
      s = setup([complete(transcribe(target)), complete(send(), finish())]);
    try {
      await s.bot.receive(
        event(
          quoted
            ? [
                { type: 'at', data: { qq: self } },
                { type: 'reply', data: { id: '2' } },
                { type: 'text', data: { text: '他说什么？' } },
              ]
            : undefined,
        ),
        self,
      );
      await until(() => s.calls.some((c) => c.action === 'send_group_msg'));
      assert.equal(s.requests.length, 2);
      assert.ok(s.schemas.every((x) => x.includes('transcribe_voice')));
      assert.equal(result(s.requests[1]!).text, '明天见。');
      assert.equal(result(s.requests[1]!).untrusted, true);
      assert.deepEqual(
        s.calls
          .filter((c) => c.action === 'fetch_ptt_text')
          .map((c) => c.params),
        [{ message_id: target }],
      );
      assert.doesNotMatch(
        JSON.stringify(s.requests),
        /PRIVATE_TOKEN|private\.invalid/,
      );
      assert.doesNotMatch(s.memory.context(), /PRIVATE_TOKEN|private\.invalid/);
    } finally {
      await s.bot.stop();
    }
  });
}

test('disabled transcription is absent from schema and forged calls never dispatch', async () => {
  const s = setup([complete(transcribe()), complete(finish())], { off: true });
  try {
    await s.bot.receive(event(), self);
    await until(() => s.requests.length === 2);
    assert.ok(s.schemas.every((x) => !x.includes('transcribe_voice')));
    assert.equal(s.calls.length, 0);
    assert.equal(result(s.requests[1]!).status, 'error');
  } finally {
    await s.bot.stop();
  }
});

test('foreign voice source is rejected before QQ recognition', async () => {
  const s = setup([complete(transcribe()), complete(finish())], {
    foreign: true,
  });
  try {
    await s.bot.receive(event(), self);
    await until(() => s.requests.length === 2);
    assert.equal(result(s.requests[1]!).status, 'error');
    assert.equal(
      s.calls.filter((c) => c.action === 'fetch_ptt_text').length,
      0,
    );
  } finally {
    await s.bot.stop();
  }
});

test('recognition failure remains an explicit tool error, not an empty transcript', async () => {
  const s = setup([complete(transcribe()), complete(finish())], {
    recognize: async () => {
      throw new Error('PRIVATE_UPSTREAM_ERROR');
    },
  });
  try {
    await s.bot.receive(event(), self);
    await until(() => s.requests.length === 2);
    const r = result(s.requests[1]!);
    assert.equal(r.status, 'error');
    assert.equal(r.text, undefined);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE_UPSTREAM_ERROR/);
  } finally {
    await s.bot.stop();
  }
});

test('disconnect during recognition suppresses the late transcript and subsequent reply', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const s = setup([complete(transcribe()), complete(send(), finish())], {
    recognize: () => pending,
  });
  try {
    await s.bot.receive(event(), self);
    await until(() => s.calls.some((c) => c.action === 'fetch_ptt_text'));
    s.bot.setConnected(false);
    release({ text: 'late transcript' });
    await delay(30);
    assert.equal(s.requests.length, 1);
    assert.equal(
      s.calls.filter((c) => c.action === 'send_group_msg').length,
      0,
    );
  } finally {
    release({ text: 'late' });
    await s.bot.stop();
  }
});

for (const sendFirst of [false, true]) {
  test(`transcription barrier prevents prewritten replies until result review; sendFirst=${sendFirst}`, async () => {
    const s = setup([
      complete(
        ...(sendFirst
          ? [send(), transcribe(), finish()]
          : [transcribe(), send(), finish()]),
      ),
      complete(send(), finish()),
    ]);
    try {
      await s.bot.receive(event(), self);
      await until(() => s.calls.some((c) => c.action === 'send_group_msg'));
      assert.equal(s.requests.length, 2);
      const blocked = s.requests[1]!.filter(
        (m) => m.role === 'tool' && m.tool_call_id === 'send',
      ).map((m) => JSON.parse(m.content as string));
      assert.equal(blocked[0].error, 'transcription_first');
      assert.equal(
        s.calls.filter((c) => c.action === 'send_group_msg').length,
        1,
      );
      assert.equal(result(s.requests[1]!).text, '明天见。');
    } finally {
      await s.bot.stop();
    }
  });
}

test('finish before transcription is terminal and never calls recognition', async () => {
  const s = setup([complete(finish(), transcribe(), send())]);
  try {
    await s.bot.receive(event(), self);
    await until(() => s.requests.length === 1);
    await delay(20);
    assert.equal(s.calls.length, 0);
    assert.equal(s.requests.length, 1);
  } finally {
    await s.bot.stop();
  }
});

test('ordinary voice does not add an automatic wake trigger', async () => {
  const s = setup([complete(transcribe()), complete(finish())]);
  try {
    await s.bot.receive(event([voice]), self);
    await delay(30);
    assert.equal(s.requests.length, 0);
    assert.equal(s.calls.length, 0);
    assert.ok(s.memory.find('1'));
  } finally {
    await s.bot.stop();
  }
});
