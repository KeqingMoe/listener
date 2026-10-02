import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { Listener } from '../../../../src/agent/listener.ts';
import type { CustomFaceRuntime } from '../../../../src/agent/runtime-types.ts';
import { ModelSession } from '../../../../src/agent/session/store.ts';
import { ResponsesModel } from '../../../../src/model/responses.ts';
import { SQLiteMemory } from '../../../../src/agent/memory.ts';
import { WorldEventStore } from '../../../../src/world/events.ts';
import { CustomFaceStore } from '../../../../src/tools/custom-faces/store.ts';
import { CustomFaceCoordinator } from '../../../../src/tools/custom-faces/coordinator.ts';
import { CUSTOM_FACE_TOOL_NAMES } from '../../../../src/tools/custom-faces/tools.ts';
import {
  buildExtendedToolDefinitions,
  createExtendedTools,
} from '../../../../src/tools/extended.ts';
import {
  prepareImage,
  validateOriginalImage,
  type OriginalImageDownloader,
} from '../../../../src/tools/images/download.ts';
import type { ListenerConfig } from '../../../../src/config/listener.ts';
import type { ExtendedToolsConfig } from '../../../../src/config/extended-tools.ts';
import type { Api } from '../../../../src/contracts/onebot.ts';
import type {
  ChatMessage,
  Completion,
  Model,
} from '../../../../src/contracts/model.ts';
import type { JsonObject } from '../../../../src/contracts/json.ts';
import type { Memory } from '../../../../src/contracts/messages.ts';
import type {
  ToolCall,
  ToolDefinition,
} from '../../../../src/contracts/tools.ts';
import { LISTENER_GROUP } from '../../../../src/contracts/identity.ts';
import { toolPermissions } from '../../../support/tool-permissions.ts';

const SELF = '100000001',
  OWNER = '100000002',
  ACTOR = '100000003',
  GROUP = '123456789',
  OTHER_GROUP = '123456788';
const SECRET = 'SYNTHETIC_NATIVE_MEDIA_SECRET';
const frames = Buffer.alloc(2 * 4 * 3);
frames.fill(255, 0, 12);
frames.fill(90, 12);
const GIF = await sharp(frames, {
  raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
})
  .gif({ loop: 0, delay: [100, 100] })
  .toBuffer();
const MD5 = createHash('md5').update(GIF).digest('hex');
const SHA = createHash('sha256').update(GIF).digest('hex');
const URL = `https://gchat.qpic.cn/gchatpic_new/0/0-0-${MD5.toUpperCase()}/0?token=${SECRET}`;
const direct = Object.fromEntries(
  CUSTOM_FACE_TOOL_NAMES.map((name) => [name, 'direct']),
) as ExtendedToolsConfig;
const call = (
  id: string,
  name: string,
  args: unknown = name === 'finish' ? { mode: 'hard' } : {},
): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const completion = (...tool_calls: ToolCall[]): Completion => ({
  content: null,
  tool_calls,
});
const finish = () => completion(call('finish', 'finish'));

function result(messages: ChatMessage[], id: string): JsonObject {
  const found = messages.find((message) => message.tool_call_id === id);
  assert.ok(found, `missing tool result ${id}`);
  return JSON.parse(String(found.content)) as JsonObject;
}

function ref(messages: ChatMessage[], id = 'list'): string {
  const response = result(messages, id);
  assert.equal(response.status, 'ok');
  const value = (response.items as JsonObject[])[0]?.face_ref;
  assert.equal(typeof value, 'string');
  return value as string;
}

function images(messages: ChatMessage[]): string[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === 'image_url' ? [part.image_url.url] : [],
        )
      : [],
  );
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function until(check: () => boolean, message = 'fixture did not settle') {
  for (let i = 0; i < 1000; i++) {
    if (check()) {
      return;
    }
    await delay(5);
  }
  assert.fail(message);
}

const defaultFavorite = () => ({
  resId: 'SYNTHETIC_RESOURCE_ID',
  emoId: 0,
  md5: MD5,
  desc: 'two-tone animated GIF',
  url: URL,
  eId: 'not-the-numeric-favorite-id',
  epId: '123',
  emoOriginalPath: '/private/QQ/cache.gif',
  isExist: false,
});

interface ProviderState {
  favorites: ReturnType<typeof defaultFavorite>[];
  fileName: string;
}

interface FixtureOptions {
  groupId?: string;
  shared?: Pick<CustomFaceRuntime, 'store' | 'coordinator'>;
  provider?: ProviderState;
  imagesEnabled?: boolean;
  extended?: ExtendedToolsConfig;
  protocol?: 'chat' | 'responses';
  original?: OriginalImageDownloader;
  apiHook?: (action: string, params: JsonObject) => unknown | Promise<unknown>;
  respond(
    messages: ChatMessage[],
    round: number,
  ): Completion | Promise<Completion>;
}

async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  options: FixtureOptions,
) {
  const directory = mkdtempSync(join(tmpdir(), 'custom-face-integration-'));
  const group = options.groupId ?? GROUP;
  const paths = {
    memory: join(directory, 'memory.sqlite'),
    world: join(directory, 'world.sqlite'),
    session: join(directory, 'session.sqlite'),
  };
  const memory = new SQLiteMemory({
    groupId: LISTENER_GROUP,
    path: paths.memory,
    retentionDays: 7,
    maxContextChars: 40000,
  });
  const world = new WorldEventStore({ path: paths.world, groupId: group });
  const session = new ModelSession({
    model: 'main',
    path: paths.session,
    groupId: group,
    maxTranscriptBytes: 512 * 1024,
  });
  const store =
    options.shared?.store ??
    new CustomFaceStore({ path: join(directory, 'faces.sqlite') });
  const coordinator =
    options.shared?.coordinator ??
    new CustomFaceCoordinator({ path: join(directory, 'operations.sqlite') });
  const state = options.provider ?? {
    favorites: [defaultFavorite()],
    fileName: `${MD5}.gif`,
  };
  const native: Array<{ action: string; params: JsonObject; at: number }> = [];
  const requests: ChatMessage[][] = [],
    schemas: string[][] = [],
    wire: JsonObject[] = [],
    failures: unknown[] = [];
  const originalCalls: Array<{
    url: string;
    maxBytes: number;
    signal?: AbortSignal;
  }> = [];
  const stages: Buffer[] = [],
    normalImageDownloads: string[] = [];
  const sourceSegments = () => [
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: 'SYNTHETIC_TRIGGER' } },
    {
      type: 'image',
      data: { file: state.fileName, file_size: String(GIF.length), url: URL },
    },
  ];
  const event = (id = '1', actor = ACTOR, command?: string) => ({
    post_type: 'message',
    message_type: 'group',
    group_id: group,
    self_id: SELF,
    user_id: actor,
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'fixture' },
    message: command
      ? [{ type: 'text', data: { text: command } }]
      : sourceSegments(),
  });
  const api: Api = {
    async call(action, params = {}) {
      native.push({ action, params: structuredClone(params), at: Date.now() });
      const override = await options.apiHook?.(action, params);
      if (override !== undefined) {
        return override;
      }
      if (action === 'get_login_info') {
        return { user_id: SELF };
      }
      if (action === 'fetch_custom_face_detail') {
        return structuredClone(state.favorites);
      }
      if (action === 'get_msg') {
        return {
          message_type: 'group',
          group_id: group,
          message_id: params.message_id,
          user_id: ACTOR,
          sender: { user_id: ACTOR, nickname: 'fixture' },
          time: 42,
          message: sourceSegments(),
        };
      }
      if (action === 'get_group_member_info') {
        return {
          group_id: group,
          user_id: params.user_id,
          role: params.user_id === OWNER ? 'owner' : 'admin',
          nickname: 'fixture',
        };
      }
      if (action === 'send_group_msg') {
        return { message_id: String(1000 + native.length) };
      }
      if (action === 'add_custom_face') {
        state.favorites.push({ ...defaultFavorite(), desc: '' });
        return null;
      }
      if (action === 'set_custom_face_desc') {
        assert.equal(
          params.emoji_id,
          0,
          'must use real favorite emoId including zero, not marketplace eId',
        );
        const target = state.favorites.find(
          (item) => item.resId === params.res_id,
        );
        assert.ok(target);
        target.desc = String(params.desc);
        return null;
      }
      if (action === 'delete_custom_face') {
        state.favorites = state.favorites.filter(
          (item) => item.resId !== params.res_id,
        );
        return null;
      }
      assert.fail(`unexpected fixture API ${action}`);
    },
  };
  const choose = async (messages: ChatMessage[], tools?: ToolDefinition[]) => {
    requests.push(structuredClone(messages));
    schemas.push(tools?.map((tool) => tool.function.name) ?? []);
    try {
      return await options.respond(messages, requests.length);
    } catch (error) {
      failures.push(error);
      throw error;
    }
  };
  let server: ReturnType<typeof createServer> | undefined;
  let model: Model = { complete: choose };
  if (options.protocol === 'responses') {
    const prepared: Completion[] = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      wire.push(
        JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject,
      );
      const next = prepared.shift();
      response.setHeader('Content-Type', 'text/event-stream');
      const output = (next?.tool_calls ?? []).map((tool) => ({
        id: `fc_${tool.id}`,
        type: 'function_call',
        call_id: tool.id,
        name: tool.function.name,
        arguments: tool.function.arguments,
      }));
      for (const [output_index, item] of output.entries()) {
        response.write(
          `data: ${JSON.stringify({ type: 'response.output_item.added', output_index, item: { ...item, arguments: '' } })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', output_index, delta: item.arguments })}\n\n`,
        );
      }
      response.end(
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: `response_${wire.length}`, status: 'completed', output } })}\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    class CapturingResponsesModel extends ResponsesModel {
      override async complete(
        messages: ChatMessage[],
        tools?: ToolDefinition[],
        signal?: AbortSignal,
      ): Promise<Completion> {
        prepared.push(await choose(messages, tools));
        return super.complete(messages, tools, signal);
      }
    }
    model = new CapturingResponsesModel({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'SYNTHETIC_KEY',
      model: 'fixture',
      sessionId: `fixture-${group}`,
      timeoutMs: 5000,
      maxTokens: 256,
    });
  }
  const config: ListenerConfig = {
    groupId: group,
    ownerId: OWNER,
    enabled: true,
    debounceMs: 1,
    cooldownMs: 0,
    retentionDays: 7,
    randomReplyProbability: 0,
    toolPermissions: toolPermissions({
      ...(options.extended ?? direct),
      mute_member: { mode: 'off', maxSeconds: 600 },
      view_images: {
        mode: (options.imagesEnabled ?? true) ? 'direct' : 'off',
        maxDownloadMb: 2,
      },
    }),
    messageMentions: false,
    confirmationTtlSeconds: 60,
  };
  const listener = new Listener(
    api,
    model,
    memory,
    config,
    () => 0,
    async (url, maxBytes, signal) => {
      normalImageDownloads.push(url);
      assert.equal(maxBytes, 2 * 1024 * 1024);
      return prepareImage(GIF, signal);
    },
    undefined,
    {
      world,
      session,
      modelRequestId: () => `request-${requests.length}`,
      customFaces: {
        store,
        coordinator,
        originalDownloader: async (url, maxBytes, signal) => {
          originalCalls.push({ url, maxBytes, signal });
          return options.original
            ? options.original(url, maxBytes, signal)
            : validateOriginalImage(GIF, signal);
        },
        staging: {
          async stage(bytes, format) {
            assert.equal(format, 'gif');
            assert.deepEqual(bytes, GIF);
            stages.push(Buffer.from(bytes));
            return {
              providerPath: `/synthetic/qqbot-cache/${SHA}.gif`,
              digest: SHA,
            };
          },
        },
      },
    },
  );
  const sql = (which: keyof typeof paths, query: string) => {
    const db = new DatabaseSync(paths[which], { readOnly: true });
    try {
      return db.prepare(query).all();
    } finally {
      db.close();
    }
  };
  const persisted = () =>
    Object.keys(paths).map((which) => {
      const db = new DatabaseSync(paths[which as keyof typeof paths], {
        readOnly: true,
      });
      try {
        return db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) =>
            db
              .prepare(
                `SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`,
              )
              .all(),
          );
      } finally {
        db.close();
      }
    });
  const settled = async () => {
    await until(
      () =>
        requests.length > 0 &&
        session.state().wakeId === undefined &&
        !(listener as unknown as { running: boolean }).running,
    );
    if (failures.length) {
      throw failures[0];
    }
  };
  t.after(async () => {
    await listener.stop();
    if (!options.shared) {
      coordinator.close();
      store.close();
    }
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    listener,
    world,
    memory,
    native,
    requests,
    schemas,
    wire,
    originalCalls,
    stages,
    normalImageDownloads,
    state,
    event,
    sql,
    persisted,
    settled,
    store,
    coordinator,
    async run() {
      await listener.receive(event(), SELF);
      await settled();
    },
    imageSends: () =>
      native.filter(
        (item) =>
          item.action === 'send_group_msg' &&
          (item.params.message as JsonObject[]).some(
            (segment) => segment.type === 'image',
          ),
      ),
    writeCalls: () =>
      native.filter((item) =>
        [
          'add_custom_face',
          'delete_custom_face',
          'set_custom_face_desc',
        ].includes(item.action),
      ),
    notices: () =>
      native
        .filter((item) => item.action === 'send_group_msg')
        .map((item) =>
          (item.params.message as Array<{ data: { text?: string } }>)
            .map((segment) => segment.data.text ?? '')
            .join(''),
        ),
  };
}

const emptyMemory: Memory = {
  append: () => false,
  recent: () => [],
  find: () => undefined,
  context: () => '',
  async compact() {},
  clear() {},
  close() {},
};

test('custom-face schemas expose each direct/off capability and confirm only mutations without touching providers', async () => {
  let apiCalls = 0,
    confirmations = 0;
  const api: Api = {
    async call() {
      apiCalls++;
      throw new Error('unexpected provider call');
    },
  };
  for (const name of CUSTOM_FACE_TOOL_NAMES) {
    assert.equal(
      buildExtendedToolDefinitions(GROUP, { [name]: 'off' }).length,
      0,
    );
    const directSchema = buildExtendedToolDefinitions(GROUP, {
      [name]: 'direct',
    });
    assert.deepEqual(
      directSchema.map((item) => item.function.name),
      [name],
    );
    if (name === 'list_custom_faces' || name === 'view_custom_face') {
      assert.throws(
        () => buildExtendedToolDefinitions(GROUP, { [name]: 'confirm' }),
        /Read-only/,
      );
    } else {
      const registry = createExtendedTools(
        api,
        emptyMemory,
        GROUP,
        { [name]: 'confirm' },
        {
          async requestConfirmation() {
            confirmations++;
            return { status: 'confirmation_required' };
          },
        },
      );
      assert.deepEqual(
        registry.definitions()[0]!.function.parameters,
        directSchema[0]!.function.parameters,
      );
      assert.match(registry.definitions()[0]!.function.description, /confirm/);
      assert.equal(
        (
          await registry.execute(
            name,
            {},
            { groupId: GROUP, selfId: SELF, actorId: ACTOR, messageId: '1' },
          )
        ).status,
        'confirmation_required',
      );
    }
    const disabled = createExtendedTools(api, emptyMemory, GROUP, {
      [name]: 'off',
    });
    assert.equal(
      (
        await disabled.execute(
          name,
          {},
          { groupId: GROUP, selfId: SELF, actorId: ACTOR, messageId: '1' },
        )
      ).error,
      'tool_disabled',
    );
  }
  assert.equal(confirmations, 4);
  assert.equal(apiCalls, 0);
});

for (const protocol of ['chat', 'responses'] as const) {
  test(`${protocol}: list → actual visual input next round → original GIF send, with clean persistence and associated tool results`, async (t) => {
    const h = await fixture(t, {
      protocol,
      async respond(messages, round) {
        if (round === 1) {
          return completion(call('list', 'list_custom_faces'));
        }
        if (round === 2) {
          assert.deepEqual(images(messages), []);
          return completion(
            call('view', 'view_custom_face', { face_ref: ref(messages) }),
            call('clock', 'get_time'),
          );
        }
        if (round === 3) {
          assert.equal(result(messages, 'view').visual_content_provided, true);
          assert.equal(result(messages, 'view').first_frame_only, true);
          assert.equal(result(messages, 'clock').status, 'ok');
          const actual = images(messages);
          assert.equal(actual.length, 1);
          assert.match(actual[0]!, /^data:image\/jpeg;base64,/);
          assert.equal(
            (
              await sharp(
                Buffer.from(actual[0]!.split(',')[1]!, 'base64'),
              ).metadata()
            ).width,
            2,
          );
          const imageIndex = messages.findIndex(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === 'image_url'),
          );
          assert.ok(
            imageIndex >
              messages.findIndex((message) => message.tool_call_id === 'view'),
          );
          assert.ok(
            imageIndex >
              messages.findIndex((message) => message.tool_call_id === 'clock'),
          );
          return completion(
            call('send', 'send_custom_face', { face_ref: ref(messages) }),
          );
        }
        assert.equal(result(messages, 'send').status, 'executed');
        return finish();
      },
    });
    await h.run();
    assert.equal(h.requests.length, 4);
    assert.equal(h.imageSends().length, 1);
    assert.ok(
      CUSTOM_FACE_TOOL_NAMES.every((name) => h.schemas[0]!.includes(name)),
    );
    const sent = h.imageSends()[0]!.params.message as Array<{
      type: string;
      data: { file: string };
    }>;
    assert.deepEqual(
      Buffer.from(sent[0]!.data.file.slice('base64://'.length), 'base64'),
      GIF,
    );
    assert.ok(
      h.originalCalls.every((item) => item.maxBytes === 2 * 1024 * 1024),
    );
    const saved = JSON.stringify(h.persisted());
    assert.doesNotMatch(saved, /data:image\/|base64:\/\//);
    assert.doesNotMatch(saved, new RegExp(SECRET));
    assert.equal(
      h.sql('world', 'SELECT count(*) AS n FROM world_messages')[0]?.n,
      2,
    );
    const ledger = h.sql(
      'session',
      'SELECT call_id,name,state FROM model_tool_ledger',
    );
    assert.ok(
      ledger.some(
        (row) =>
          row.call_id === 'send' &&
          row.name === 'send_custom_face' &&
          row.state === 'finished',
      ),
    );
    if (protocol === 'responses') {
      const body = h.wire[2]!;
      assert.equal(body.previous_response_id, 'response_2');
      const input = body.input as JsonObject[];
      const img = input.findIndex(
        (item) =>
          item.role === 'user' &&
          Array.isArray(item.content) &&
          (item.content as JsonObject[]).some(
            (part) => part.type === 'input_image',
          ),
      );
      assert.ok(img >= 0);
      assert.ok(
        img >
          input.findIndex(
            (item) =>
              item.type === 'function_call_output' && item.call_id === 'view',
          ),
      );
      assert.ok(
        img >
          input.findIndex(
            (item) =>
              item.type === 'function_call_output' && item.call_id === 'clock',
          ),
      );
    }
  });
}

test('an off-mode listener hides all six tools and forged calls cannot reach the provider', async (t) => {
  const off = Object.fromEntries(
    CUSTOM_FACE_TOOL_NAMES.map((name) => [name, 'off']),
  ) as ExtendedToolsConfig;
  const h = await fixture(t, {
    extended: off,
    respond(messages, round) {
      if (round === 1) {
        return completion(
          ...CUSTOM_FACE_TOOL_NAMES.map((name, index) =>
            call(`off-${index}`, name),
          ),
        );
      }
      for (let index = 0; index < CUSTOM_FACE_TOOL_NAMES.length; index++) {
        assert.equal(result(messages, `off-${index}`).error, 'tool_disabled');
      }
      return finish();
    },
  });
  await h.run();
  assert.ok(
    h.schemas.every((names) =>
      CUSTOM_FACE_TOOL_NAMES.every((name) => !names.includes(name)),
    ),
  );
  assert.equal(h.native.length, 0);
  assert.equal(h.originalCalls.length, 0);
  assert.equal(h.stages.length, 0);
});

test('a send placed before the viewer in the same response is also blocked', async (t) => {
  const h = await fixture(t, {
    respond(messages, round) {
      if (round === 1) {
        return completion(call('list', 'list_custom_faces'));
      }
      if (round === 2) {
        return completion(
          call('early-send', 'send_custom_face', { face_ref: ref(messages) }),
          call('late-view', 'view_custom_face', { face_ref: ref(messages) }),
        );
      }
      assert.equal(result(messages, 'early-send').status, 'error');
      assert.match(String(result(messages, 'early-send').error), /下一轮/);
      assert.equal(result(messages, 'late-view').status, 'ok');
      assert.equal(images(messages).length, 1);
      return finish();
    },
  });
  await h.run();
  assert.equal(h.imageSends().length, 0);
});

test('finish before a viewer remains terminal and neither the viewer nor a following send executes', async (t) => {
  const h = await fixture(t, {
    respond(messages, round) {
      if (round === 1) {
        return completion(call('list', 'list_custom_faces'));
      }
      assert.equal(round, 2);
      return completion(
        call('terminal', 'finish'),
        call('unreachable-view', 'view_custom_face', {
          face_ref: ref(messages),
        }),
        call('unreachable-send', 'send_custom_face', {
          face_ref: ref(messages),
        }),
      );
    },
  });
  await h.run();
  assert.equal(h.requests.length, 2);
  assert.equal(h.originalCalls.length, 0);
  assert.equal(h.imageSends().length, 0);
  const rows = h.sql(
    'session',
    "SELECT call_id,state FROM model_tool_ledger WHERE call_id LIKE 'unreachable-%'",
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.state === 'skipped'));
});

test('view_custom_face works independently with ordinary view_images disabled', async (t) => {
  const h = await fixture(t, {
    imagesEnabled: false,
    respond(messages, round) {
      if (round === 1) {
        return completion(call('list', 'list_custom_faces'));
      }
      if (round === 2) {
        return completion(
          call('view', 'view_custom_face', { face_ref: ref(messages) }),
        );
      }
      assert.equal(images(messages).length, 1);
      assert.equal(result(messages, 'view').status, 'ok');
      return finish();
    },
  });
  await h.run();
  assert.ok(
    h.schemas.every(
      (names) =>
        names.includes('view_custom_face') && !names.includes('view_images'),
    ),
  );
  assert.equal(h.normalImageDownloads.length, 0);
});

for (const customFirst of [true, false]) {
  test(`both viewers load independently without a shared image count quota: customFirst=${customFirst}`, async (t) => {
    const h = await fixture(t, {
      respond(messages, round) {
        if (round === 1) {
          return completion(call('list', 'list_custom_faces'));
        }
        if (round === 2) {
          const custom = call('custom-view', 'view_custom_face', {
              face_ref: ref(messages),
            }),
            normal = call('normal-view', 'view_images', {
              image_ids: ['img_1_2'],
            });
          return completion(
            ...(customFirst ? [custom, normal] : [normal, custom]),
          );
        }
        assert.equal(
          result(messages, customFirst ? 'custom-view' : 'normal-view').status,
          'ok',
        );
        assert.equal(
          result(messages, customFirst ? 'normal-view' : 'custom-view').status,
          'ok',
        );
        assert.equal(images(messages).length, 2);
        return finish();
      },
    });
    await h.run();
    assert.equal(h.originalCalls.length + h.normalImageDownloads.length, 2);
  });
}

for (const blocked of [
  'send_custom_face',
  'add_custom_face',
  'delete_custom_face',
  'set_custom_face_description',
  'finish',
]) {
  test(`same-response view barrier blocks ${blocked} until the actual image has reached the model`, async (t) => {
    const h = await fixture(t, {
      respond(messages, round) {
        if (round === 1) {
          return completion(call('list', 'list_custom_faces'));
        }
        if (round === 2) {
          const face_ref = ref(messages);
          const args =
            blocked === 'finish'
              ? { mode: 'hard' }
              : blocked === 'add_custom_face'
                ? { image_id: 'img_1_2', description: 'fixture annotation' }
                : blocked === 'set_custom_face_description'
                  ? { face_ref, description: 'fixture annotation' }
                  : { face_ref };
          return completion(
            call('view', 'view_custom_face', { face_ref }),
            call('blocked', blocked, args),
          );
        }
        assert.equal(result(messages, 'blocked').status, 'error');
        assert.match(String(result(messages, 'blocked').error), /下一轮/);
        assert.equal(images(messages).length, 1);
        return finish();
      },
    });
    await h.run();
    assert.equal(h.imageSends().length, 0);
    assert.equal(h.writeCalls().length, 0);
    assert.equal(h.stages.length, 0);
  });
}

for (const cancellation of ['reset', 'disconnect']) {
  test(`${cancellation}: a late custom-face download cannot resurrect visual input or a reply`, async (t) => {
    const pending = gate();
    t.after(async () => {
      pending.release();
    });
    let observedSignal: AbortSignal | undefined;
    const h = await fixture(t, {
      original: async (_url, _max, signal) => {
        observedSignal = signal;
        await pending.promise;
        return validateOriginalImage(GIF);
      },
      respond(messages, round) {
        if (round === 1) {
          return completion(call('list', 'list_custom_faces'));
        }
        if (round === 2) {
          return completion(
            call('view', 'view_custom_face', { face_ref: ref(messages) }),
          );
        }
        return completion(
          call('bad-send', 'send_custom_face', { face_ref: ref(messages) }),
        );
      },
    });
    await h.listener.receive(h.event(), SELF);
    await until(() => h.originalCalls.length === 1);
    if (cancellation === 'reset') {
      await h.listener.receive(h.event('2', OWNER, '/reset'), SELF);
    } else {
      h.listener.setConnected(false);
    }
    assert.equal(observedSignal?.aborted, true);
    pending.release();
    await until(() => !(h.listener as unknown as { running: boolean }).running);
    assert.equal(h.requests.length, 2);
    assert.ok(h.requests.every((messages) => images(messages).length === 0));
    assert.equal(h.imageSends().length, 0);
    assert.doesNotMatch(
      JSON.stringify(h.persisted()),
      /data:image\/|base64:\/\//,
    );
  });
}

for (const targetChanged of [false, true]) {
  test(`confirmed add uses fresh source/account checks without proposal-time staging; changed=${targetChanged}`, async (t) => {
    const h = await fixture(t, {
      provider: { favorites: [], fileName: `${MD5}.gif` },
      extended: { ...direct, add_custom_face: 'confirm' },
      respond(_messages, round) {
        return round === 1
          ? completion(
              call('propose', 'add_custom_face', {
                image_id: 'img_1_2',
                description: 'owner requested annotation',
                tags: ['fixture'],
              }),
            )
          : finish();
      },
    });
    await h.run();
    assert.equal(h.stages.length, 0);
    assert.equal(h.originalCalls.length, 0);
    assert.equal(h.writeCalls().length, 0);
    assert.equal(
      result(h.requests[1]!, 'propose').status,
      'confirmation_required',
    );
    const token = /\/confirm ([a-f0-9]+)/.exec(h.notices().join('\n'))?.[1];
    assert.ok(token);
    const sourceReads = h.native.filter(
      (item) => item.action === 'get_msg',
    ).length;
    const loginReads = h.native.filter(
      (item) => item.action === 'get_login_info',
    ).length;
    if (targetChanged) {
      h.state.fileName = 'different-source.gif';
    }
    await h.listener.receive(h.event('2', OWNER, `/confirm ${token}`), SELF);
    assert.ok(
      h.native.filter((item) => item.action === 'get_msg').length > sourceReads,
    );
    assert.ok(
      h.native.filter((item) => item.action === 'get_login_info').length >
        loginReads,
    );
    assert.equal(
      h.requests.length,
      2,
      'owner confirmation executes after the original model wake, not through its stale turn API',
    );
    if (targetChanged) {
      assert.equal(h.stages.length, 0);
      assert.equal(h.writeCalls().length, 0);
      assert.match(h.notices().at(-1)!, /目标核验失败/);
    } else {
      assert.equal(h.stages.length, 1);
      assert.equal(
        h.native.filter((item) => item.action === 'add_custom_face').length,
        1,
      );
      assert.equal(
        h.native.filter((item) => item.action === 'set_custom_face_desc')
          .length,
        1,
      );
      assert.equal(h.state.favorites[0]?.desc, 'owner requested annotation');
      assert.ok(h.originalCalls.length > 0);
      assert.ok(
        h.originalCalls.every((item) => item.maxBytes === 2 * 1024 * 1024),
        'owner confirmation must retain this group’s configured original-download bound',
      );
    }
  });
}

for (const incompletePhase of ['binding', 'description'] as const) {
  test(`submitted add with incomplete ${incompletePhase} requires model review before same-response success text, writes or finish`, async (t) => {
    const misleading = '全好了，收藏和描述都已完成。';
    const truthful = '收藏已提交，描述尚未确认。';
    const h = await fixture(t, {
      provider: { favorites: [], fileName: `${MD5}.gif` },
      apiHook(action) {
        // 正常的submitted返回不代表已可见或标注已完成。
        if (incompletePhase === 'binding' && action === 'add_custom_face') {
          return null;
        }
        if (
          incompletePhase === 'description' &&
          action === 'set_custom_face_desc'
        ) {
          return null;
        }
      },
      respond(messages, round) {
        if (round === 1) {
          return completion(
            call('partial-add', 'add_custom_face', {
              image_id: 'img_1_2',
              description: 'fixture annotation',
            }),
            call('premature-success', 'send_message', {
              segments: [{ type: 'text', text: misleading }],
            }),
            call('premature-write', 'delete_custom_face', {
              face_ref: 'unverified-reference',
            }),
            call('premature-finish', 'finish'),
          );
        }
        assert.equal(round, 2);
        const added = result(messages, 'partial-add');
        assert.equal(
          added.status,
          'ok',
          'preserve a normal submitted phase instead of relabeling it a failed write',
        );
        assert.equal(added.submitted, true);
        assert.equal(added.collection_submitted, true);
        assert.notEqual(added.description_confirmed, true);
        assert.equal(
          added.collection_binding_confirmed,
          incompletePhase === 'description',
        );
        assert.equal(
          added.description_submitted,
          incompletePhase === 'description',
        );
        if (incompletePhase === 'binding') {
          assert.equal(added.error, 'collection_not_uniquely_verified');
        } else {
          assert.equal(
            (added.description_result as JsonObject).readback,
            'not_confirmed',
          );
        }
        for (const id of [
          'premature-success',
          'premature-write',
          'premature-finish',
        ]) {
          assert.equal(result(messages, id).status, 'error');
          assert.equal(
            result(messages, id).error,
            'management_result_review_required',
          );
        }
        // 查看暂存结果后，下一次模型响应可以停止或给出准确的发言。
        return incompletePhase === 'binding'
          ? finish()
          : completion(
              call('truthful-reply', 'send_message', {
                segments: [{ type: 'text', text: truthful }],
              }),
              call('reviewed-finish', 'finish'),
            );
      },
    });
    await h.run();
    assert.equal(h.requests.length, 2);
    assert.equal(h.stages.length, 1);
    assert.equal(
      h.native.filter((item) => item.action === 'add_custom_face').length,
      1,
    );
    assert.equal(
      h.native.filter((item) => item.action === 'set_custom_face_desc').length,
      incompletePhase === 'description' ? 1 : 0,
    );
    assert.equal(
      h.native.filter((item) => item.action === 'delete_custom_face').length,
      0,
    );
    assert.ok(h.notices().every((text) => !text.includes(misleading)));
    assert.deepEqual(
      h.notices(),
      incompletePhase === 'description' ? [truthful] : [],
    );
    const terminal = h.sql(
      'session',
      "SELECT result FROM model_tool_ledger WHERE call_id IN ('finish','reviewed-finish')",
    );
    assert.equal(terminal.length, 1);
    assert.equal(JSON.parse(String(terminal[0]!.result)).status, 'ok');
  });
}

test('fully readback-confirmed add permits its same-response success text and finish without an extra review round', async (t) => {
  const success = '收藏和描述已核验完成。';
  const h = await fixture(t, {
    provider: { favorites: [], fileName: `${MD5}.gif` },
    respond(_messages, round) {
      assert.equal(
        round,
        1,
        'a confirmed description does not require an artificial extra round',
      );
      return completion(
        call('complete-add', 'add_custom_face', {
          image_id: 'img_1_2',
          description: 'fixture annotation',
        }),
        call('success-text', 'send_message', {
          segments: [{ type: 'text', text: success }],
        }),
        call('complete-finish', 'finish'),
      );
    },
  });
  await h.run();
  const rows = h.sql('session', 'SELECT call_id,result FROM model_tool_ledger');
  const added = JSON.parse(
    String(rows.find((row) => row.call_id === 'complete-add')!.result),
  );
  assert.equal(added.collection_submitted, true);
  assert.equal(added.collection_binding_confirmed, true);
  assert.equal(added.description_confirmed, true);
  assert.equal(
    JSON.parse(
      String(rows.find((row) => row.call_id === 'complete-finish')!.result),
    ).status,
    'ok',
  );
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.notices(), [success]);
  assert.equal(h.stages.length, 1);
  assert.equal(
    h.native.filter((item) => item.action === 'add_custom_face').length,
    1,
  );
});

test('ACK identity read failure is unknown and quarantines retries, even for a historical self ACK outside legacy memory', async (t) => {
  let dispatched = false;
  const h = await fixture(t, {
    apiHook(action) {
      if (action === 'send_group_msg') {
        dispatched = true;
        return { message_id: '77' };
      }
    },
    respond(messages, round) {
      if (round === 1) {
        return completion(call('list', 'list_custom_faces'));
      }
      if (round === 2) {
        return completion(
          call('first-send', 'send_custom_face', { face_ref: ref(messages) }),
        );
      }
      if (round === 3) {
        return completion(
          call('retry', 'send_custom_face', { face_ref: ref(messages) }),
        );
      }
      const first = result(messages, 'first-send');
      assert.equal(first.status, 'unknown');
      assert.equal(first.error, 'message_ack_unverified');
      assert.equal(first.retry_allowed, false);
      assert.equal(first.effect_unknown, true);
      assert.equal(first.message_id, null);
      assert.equal(first.local_projection_failed, undefined);
      assert.equal(result(messages, 'retry').status, 'unknown');
      assert.equal(
        result(messages, 'retry').error,
        'previous_operation_unresolved',
      );
      return finish();
    },
  });
  for (let index = 1; index <= 9; index++) {
    const messageId = index === 3 ? '77' : String(200 + index);
    h.world.appendMessage({
      messageId,
      userId: SELF,
      nickname: 'fixture',
      text: 'historical self message',
      time: Math.floor(Date.now() / 1000),
      bot: true,
    });
  }
  assert.equal(
    h.sql(
      'world',
      "SELECT sequence FROM world_messages WHERE message_id='77'",
    )[0]?.sequence,
    3,
  );
  assert.equal(h.memory.find('77'), undefined);
  const find = h.world.findMessage.bind(h.world);
  h.world.findMessage = (id, highWater) => {
    if (dispatched && id === '77') {
      throw new Error('SYNTHETIC_WORLD_READ_FAILURE');
    }
    return find(id, highWater);
  };
  const getState = h.world.getState.bind(h.world);
  let capturedTen = false;
  h.world.getState = (consumer) => {
    const state = getState(consumer);
    if (!dispatched && state.latestSequence === 10) {
      capturedTen = true;
    }
    return state;
  };
  await h.run();
  assert.equal(capturedTen, true);
  assert.equal(h.imageSends().length, 1);
  assert.equal(
    h.sql(
      'world',
      "SELECT sequence FROM world_messages WHERE message_id='77'",
    )[0]?.sequence,
    3,
  );
});

test('post-claim world projection failure stays executed, preserves the ACK claim, and custom sends obey outgoing throttle', async (t) => {
  const h = await fixture(t, {
    apiHook(action) {
      if (action === 'send_group_msg') {
        return { message_id: '77' };
      }
    },
    respond(messages, round) {
      if (round === 1) {
        return completion(call('list', 'list_custom_faces'));
      }
      if (round === 2) {
        return completion(
          call('first-send', 'send_custom_face', { face_ref: ref(messages) }),
        );
      }
      if (round === 3) {
        assert.equal(result(messages, 'first-send').status, 'executed');
        assert.equal(
          result(messages, 'first-send').local_projection_failed,
          true,
        );
        return completion(
          call('duplicate-ack', 'send_custom_face', {
            face_ref: ref(messages),
          }),
        );
      }
      assert.equal(result(messages, 'duplicate-ack').status, 'unknown');
      assert.equal(
        result(messages, 'duplicate-ack').error,
        'duplicate_message_ack',
      );
      return finish();
    },
  });
  const append = h.world.appendMessage.bind(h.world);
  h.world.appendMessage = (entry, options) => {
    if (entry.messageId === '77') {
      throw new Error('SYNTHETIC_WORLD_PROJECTION_FAILURE');
    }
    return append(entry, options);
  };
  await h.run();
  const sends = h.imageSends();
  assert.equal(sends.length, 2);
  assert.ok(
    sends[1]!.at - sends[0]!.at >= 400,
    'custom-face sends must use the same minimum spacing as other outgoing messages',
  );
  assert.equal(h.world.findMessage('77'), undefined);
  assert.equal(h.memory.find('77'), undefined);
});

test('two listeners share account index but reject a face_ref issued for another group', async (t) => {
  const shared = {
    store: new CustomFaceStore(),
    coordinator: new CustomFaceCoordinator(),
  };
  const provider = { favorites: [defaultFavorite()], fileName: `${MD5}.gif` };
  let firstRef = '',
    secondRef = '';
  const a = await fixture(t, {
    shared,
    provider,
    respond(messages, round) {
      if (round === 1) {
        return completion(call('list', 'list_custom_faces'));
      }
      firstRef = ref(messages);
      return finish();
    },
  });
  const b = await fixture(t, {
    shared,
    provider,
    groupId: OTHER_GROUP,
    respond(messages, round) {
      if (round === 1) {
        return completion(
          call('foreign', 'view_custom_face', { face_ref: firstRef }),
        );
      }
      if (round === 2) {
        assert.equal(result(messages, 'foreign').error, 'invalid_face_ref');
        return completion(call('list', 'list_custom_faces'));
      }
      if (round === 3) {
        secondRef = ref(messages);
        return completion(
          call('own', 'view_custom_face', { face_ref: secondRef }),
        );
      }
      assert.equal(result(messages, 'own').status, 'ok');
      return finish();
    },
  });
  t.after(async () => {
    shared.coordinator.close();
    shared.store.close();
  });
  await a.run();
  await b.run();
  assert.notEqual(firstRef, secondRef);
  assert.equal(b.originalCalls.length, 1);
  assert.equal(shared.store.list(SELF, GROUP, {}).items.length, 1);
  assert.equal(shared.store.list(SELF, OTHER_GROUP, {}).items.length, 1);
  assert.equal(shared.store.resolve(secondRef, SELF, GROUP), undefined);
  assert.ok(
    b.native
      .filter((item) => item.action === 'get_msg')
      .every(
        (item) => String(item.params.group_id ?? OTHER_GROUP) === OTHER_GROUP,
      ),
  );
});
