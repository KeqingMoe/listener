import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenAIModel } from '../../../src/model/chat.ts';
import { Listener } from '../../../src/agent/listener.ts';
import { LISTENER_GROUP, OWNER_ID } from '../../../src/contracts/identity.ts';
import { sendChatStream } from '../../support/model-sse.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const self = '999',
  actor = '123';
const tool = (id: string, name: string, args: string) => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});

class Mem implements Memory {
  rows: TimelineEntry[] = [];
  append(row: TimelineEntry) {
    this.rows.push(row);
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

const incoming = {
  post_type: 'message',
  message_type: 'group',
  group_id: LISTENER_GROUP,
  self_id: self,
  user_id: actor,
  message_id: '1',
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: 'member' },
  message: [
    { type: 'at', data: { qq: self } },
    { type: 'text', data: { text: 'test' } },
  ],
};

async function run(maxToolCallsPerWake: number) {
  const requests: any[] = [];
  const native: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const calls =
        requests.length === 1
          ? [
              tool('invalid-json', 'read_message', '{'),
              tool('unknown', 'invented_tool', '{}'),
              tool('disabled', 'mute_member', '{"user_id":"456","seconds":3}'),
            ]
          : [tool('finish', 'finish', '{"mode":"hard"}')];
      sendChatStream(res, {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { role: 'assistant', content: null, tool_calls: calls },
          },
        ],
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config: ListenerConfig = {
    toolPermissions: toolPermissions(MEMBER_TOOLS),
    groupId: LISTENER_GROUP,
    ownerId: OWNER_ID,
    enabled: true,
    debounceMs: 1,
    delayMaxMs: 1,
    cooldownMs: 0,
    retentionDays: 7,
    randomReplyProbability: 0,
    maxToolCallsPerWake,
    wakeTimeoutMs: 3000,
  };
  const bot = new Listener(
    {
      async call(action) {
        native.push(action);
        assert.fail('semantic rejects must not call QQ');
      },
    },
    new OpenAIModel({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test',
      model: 'test',
      timeoutMs: 2000,
      maxTokens: 128,
    }),
    new Mem(),
    config,
    undefined,
    undefined,
    undefined,
    sessionRuntime(config.groupId).runtime,
  );
  try {
    await bot.receive(incoming, self);
    for (let i = 0; i < 1500; i++) {
      if (requests.length && !(bot as any).running && !(bot as any).pending) {
        break;
      }
      await delay(2);
    }
    assert.equal((bot as any).running, false);
    return { requests, native };
  } finally {
    await bot.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('actual HTTP tool semantic errors reach Listener and consume the common wake budget', async () => {
  const { requests, native } = await run(4);
  assert.equal(requests.length, 2);
  assert.deepEqual(native, []);
  const results = requests[1].messages
    .filter((m: any) => m.role === 'tool')
    .map((m: any) => ({ id: m.tool_call_id, ...JSON.parse(m.content) }));
  assert.deepEqual(
    results.map((r: any) => r.id),
    ['invalid-json', 'unknown', 'disabled'],
  );
  assert.ok(results.every((r: any) => r.status === 'error'));
  assert.equal(results[0].error, 'invalid_arguments');
  assert.equal(results[1].error, 'invalid_arguments');
  assert.equal(results[2].error, 'tool_disabled');
  assert.deepEqual(
    requests[1].messages.slice(0, requests[0].messages.length),
    requests[0].messages,
  );
  const budget = results.at(-1).wake_budget;
  assert.equal(budget.used_tool_calls, 3);
  assert.equal(budget.remaining_tool_calls, 1);
});

test('actual HTTP semantic-error calls exhaust budget without an extra model request', async () => {
  const { requests, native } = await run(2);
  assert.equal(requests.length, 1);
  assert.deepEqual(native, []);
});
