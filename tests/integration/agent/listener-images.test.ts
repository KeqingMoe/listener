import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import type { ImageDownloader } from '../../../src/tools/images/download.ts';
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import { type Api } from '../../../src/contracts/onebot.ts';
import {
  type ChatMessage,
  type Completion,
  type Model,
} from '../../../src/contracts/model.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';
import { type ToolCall } from '../../../src/contracts/tools.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const self = '900000001';
const transportUrl = 'https://example.invalid/image?private-key=secret';
const bytes = 'data:image/png;base64,YQ==';
const attachment = {
  type: 'image',
  data: { url: transportUrl, file: '/private/image.png' },
};
const cfg: ListenerConfig = {
  groupId: LISTENER_GROUP,
  ownerId: OWNER_ID,
  enabled: true,
  debounceMs: 5,
  cooldownMs: 5,
  retentionDays: 7,
  toolPermissions: toolPermissions({
    ...MEMBER_TOOLS,
    view_images: { mode: 'direct', maxDownloadMb: 10 },
  }),
};

class MockMemory implements Memory {
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

  async compact() {}
  clear() {
    this.entries = [];
  }

  close() {}
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: LISTENER_GROUP,
    self_id: self,
    user_id: '12345',
    message_id: '1',
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'Alice' },
    message: [{ type: 'at', data: { qq: self } }, attachment],
    ...overrides,
  };
}

function call(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

const view = (ids = ['img_1_1'], id = 'view') =>
  call(id, 'view_images', { image_ids: ids });
const send = (text = 'after seeing image') =>
  call('send', 'send_message', { segments: [{ type: 'text', text }] });
const completion = (...tool_calls: ToolCall[]): Completion => ({
  content: null,
  tool_calls,
});

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail('timed out');
}

function setup(
  responses: Completion[],
  settings: Partial<ListenerConfig> = {},
  downloader?: ImageDownloader,
) {
  const memory = new MockMemory();
  const requests: ChatMessage[][] = [],
    schemas: string[][] = [],
    apiCalls: Array<{ action: string; params: any }> = [],
    downloads: string[] = [];
  let onComplete: ((round: number) => void) | undefined;
  const api: Api = {
    async call(action, params) {
      apiCalls.push({ action, params });
      if (action === 'get_msg') {
        return {
          message_type: 'group',
          group_id: LISTENER_GROUP,
          message_id: params?.message_id,
          sender: { user_id: '12345', nickname: 'Alice' },
          time: 42,
          message: [
            { type: 'text', data: { text: 'caption' } },
            attachment,
            attachment,
            attachment,
          ],
        };
      }
      if (action === 'send_group_msg') {
        return { message_id: String(100 + apiCalls.length) };
      }
      throw new Error('unexpected API');
    },
  };
  const model: Model = {
    async complete(messages, tools) {
      requests.push(structuredClone(messages));
      schemas.push(tools?.map((t) => t.function.name) ?? []);
      onComplete?.(requests.length);
      return (
        responses.shift() ??
        completion(call('silent', 'finish', { mode: 'hard' }))
      );
    },
  };
  const bot = new Listener(
    api,
    model,
    memory,
    { ...cfg, ...settings },
    () => 1,
    async (...args) => {
      downloads.push(args[0]);
      return downloader
        ? downloader(...args)
        : { dataUrl: bytes, width: 1, height: 1, firstFrameOnly: false };
    },
    undefined,
    sessionRuntime({ ...cfg, ...settings }.groupId).runtime,
  );
  return {
    bot,
    memory,
    requests,
    schemas,
    apiCalls,
    downloads,
    setOnComplete(fn: typeof onComplete) {
      onComplete = fn;
    },
  };
}

function assertNativeSequence(messages: ChatMessage[], ids: string[]) {
  const assistant = messages.findIndex((m) => m.role === 'assistant');
  assert.ok(assistant >= 0);
  assert.deepEqual(
    messages[assistant]!.tool_calls?.map((c) => c.id),
    ids,
  );
  assert.deepEqual(
    messages
      .slice(assistant + 1, assistant + 1 + ids.length)
      .map((m) => [m.role, m.tool_call_id]),
    ids.map((id) => ['tool', id]),
  );
  const native = messages[assistant + 1 + ids.length]!;
  assert.equal(native.role, 'user');
  assert.ok(Array.isArray(native.content));
  assert.ok(
    native.content.some(
      (p) => p.type === 'image_url' && p.image_url.url === bytes,
    ),
  );
}

test('native image viewing uses same model then sends; memory holds only image references', async () => {
  const s = setup([
    completion(view()),
    completion(send(), call('finish', 'finish', { mode: 'hard' })),
  ]);
  try {
    await s.bot.receive(event(), self);
    await until(() => s.apiCalls.some((c) => c.action === 'send_group_msg'));
    assert.equal(s.requests.length, 2);
    assert.ok(s.schemas.every((names) => names.includes('view_images')));
    assertNativeSequence(s.requests[1]!, ['view']);
    assert.deepEqual(s.downloads, [transportUrl]);
    assert.deepEqual(s.memory.find('1')?.images, [{ id: 'img_1_1', index: 1 }]);
    const persisted = s.memory.context();
    assert.doesNotMatch(
      persisted,
      /data:image|https:|private-key|private\/image/,
    );
    assert.match(persisted, /img_1_1/);
    assert.equal(
      s.apiCalls.filter((c) => c.action === 'send_group_msg').length,
      1,
    );
  } finally {
    await s.bot.stop();
  }
});

test('mixed view/send/read batch responds to every call before image user content and defers send', async () => {
  for (const sendFirst of [false, true]) {
    const batch = sendFirst
      ? [
          send('premature'),
          view(),
          call('read', 'read_message', { message_id: '1' }),
        ]
      : [
          view(),
          send('premature'),
          call('read', 'read_message', { message_id: '1' }),
        ];
    const s = setup([
      completion(...batch),
      completion(
        send('verified reply'),
        call('finish', 'finish', { mode: 'hard' }),
      ),
    ]);
    let sentBeforeSecond = false;
    s.setOnComplete((round) => {
      if (round === 2) {
        sentBeforeSecond = s.apiCalls.some(
          (c) => c.action === 'send_group_msg',
        );
      }
    });
    try {
      await s.bot.receive(event(), self);
      await until(() => s.apiCalls.some((c) => c.action === 'send_group_msg'));
      assert.equal(sentBeforeSecond, false);
      assertNativeSequence(
        s.requests[1]!,
        batch.map((c) => c.id),
      );
      const rejected = s.requests[1]!.find(
        (m) => m.role === 'tool' && m.tool_call_id === 'send',
      )!;
      assert.equal(JSON.parse(rejected.content as string).status, 'error');
      const sends = s.apiCalls.filter((c) => c.action === 'send_group_msg');
      assert.equal(sends.length, 1);
      assert.equal(sends[0]!.params.message[0].data.text, 'verified reply');
    } finally {
      await s.bot.stop();
    }
  }
});

test('quoted image is discovered through read_message then remotely verified before viewing', async () => {
  const s = setup([
    completion(call('read', 'read_message', { message_id: '2' })),
    completion(view(['img_2_1'])),
    completion(send(), call('finish', 'finish', { mode: 'hard' })),
  ]);
  try {
    await s.bot.receive(
      event({
        message: [
          { type: 'at', data: { qq: self } },
          { type: 'reply', data: { id: '2' } },
          { type: 'text', data: { text: 'what is in that picture?' } },
        ],
      }),
      self,
    );
    await until(() => s.apiCalls.some((c) => c.action === 'send_group_msg'));
    const result = s.requests[1]!.find((m) => m.role === 'tool')!;
    const read = JSON.parse(result.content as string);
    assert.equal(read.status, 'ok');
    assert.ok(read.message.images.some((r: any) => r.id === 'img_2_1'));
    assert.doesNotMatch(
      result.content as string,
      /https:|private-key|data:image/,
    );
    assert.equal(s.downloads.length, 1);
    assert.equal(
      s.apiCalls.filter(
        (c) => c.action === 'get_msg' && c.params.message_id === '2',
      ).length,
      2,
    );
    assert.ok(
      s.requests[2]!.some((m) => m.role === 'user' && Array.isArray(m.content)),
    );
    assert.doesNotMatch(s.memory.context(), /data:image|https:|private-key/);
  } finally {
    await s.bot.stop();
  }
});

test('disabled images hide schema and reject forged view calls without API or downloader', async () => {
  const s = setup(
    [
      completion(view()),
      completion(call('silent', 'finish', { mode: 'hard' })),
    ],
    {
      toolPermissions: {
        ...cfg.toolPermissions,
        view_images: { ...cfg.toolPermissions.view_images, mode: 'off' },
      },
    },
  );
  try {
    await s.bot.receive(event(), self);
    await until(() => s.requests.length === 2);
    assert.ok(s.schemas.every((names) => !names.includes('view_images')));
    assert.equal(s.apiCalls.length, 0);
    assert.equal(s.downloads.length, 0);
    const response = s.requests[1]!.find((m) => m.role === 'tool')!;
    assert.equal(JSON.parse(response.content as string).status, 'error');
    assert.ok(!s.requests[1]!.some((m) => Array.isArray(m.content)));
  } finally {
    await s.bot.stop();
  }
});

test('image state deduplicates successful loads across model calls without a count budget', async () => {
  const s = setup([
    completion(view(['img_1_1'], 'v1')),
    completion(view(['img_1_1', 'img_1_2'], 'v2')),
    completion(view(['img_1_3'], 'v3')),
    completion(send(), call('finish', 'finish', { mode: 'hard' })),
  ]);
  try {
    await s.bot.receive(
      event({
        message: [
          { type: 'at', data: { qq: self } },
          attachment,
          attachment,
          attachment,
        ],
      }),
      self,
    );
    await until(() => s.apiCalls.some((c) => c.action === 'send_group_msg'));
    assert.equal(s.downloads.length, 3);
    assert.equal(s.apiCalls.filter((c) => c.action === 'get_msg').length, 3);
    const response = s.requests[3]!.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'v3',
    )!;
    const result = JSON.parse(response.content as string);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.loaded_ids, ['img_1_3']);
    assert.equal(
      s.requests[3]!.filter((m) => Array.isArray(m.content)).length,
      3,
    );
  } finally {
    await s.bot.stop();
  }
});

test('reset or disconnect during load suppresses image bytes and stale replies', async () => {
  for (const action of ['reset', 'disconnect']) {
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = setup(
      [completion(view()), completion(send('stale image reply'))],
      {},
      async (_url, _max, currentSignal) => {
        signal = currentSignal;
        await gate;
        return { dataUrl: bytes, width: 1, height: 1, firstFrameOnly: false };
      },
    );
    try {
      await s.bot.receive(event(), self);
      await until(() => s.downloads.length === 1);
      if (action === 'reset') {
        await s.bot.receive(
          event({
            message_id: '2',
            user_id: OWNER_ID,
            message: [{ type: 'text', data: { text: '/reset' } }],
          }),
          self,
        );
      } else {
        s.bot.setConnected(false);
      }
      assert.equal(signal?.aborted, true);
      release();
      await delay(30);
      assert.equal(s.requests.length, 1);
      assert.doesNotMatch(JSON.stringify(s.requests), /data:image/);
      assert.doesNotMatch(
        s.memory.context(),
        /data:image|https:|stale image reply/,
      );
      assert.ok(
        !s.apiCalls
          .filter((c) => c.action === 'send_group_msg')
          .some((c) => JSON.stringify(c.params).includes('stale image reply')),
      );
      if (action === 'reset') {
        assert.equal(s.memory.find('1'), undefined);
      }
    } finally {
      release();
      await s.bot.stop();
    }
  }
});
