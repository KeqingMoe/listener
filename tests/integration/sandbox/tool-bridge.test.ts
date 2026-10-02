import test from 'node:test';
import assert from 'node:assert/strict';
import { Listener } from '../../../src/agent/listener.ts';
import {
  SideEffectPacer,
  SIDE_EFFECT_PACING,
} from '../../../src/agent/pacing.ts';
import { SandboxService } from '../../../src/sandbox/service.ts';
import { SandboxJobStore } from '../../../src/sandbox/store.ts';
import { startExecution } from '../../../src/sandbox/executor.ts';
import { ModelSession } from '../../../src/agent/session/store.ts';
import { WorldEventStore } from '../../../src/world/events.ts';
import type { Memory, TimelineEntry } from '../../../src/contracts/messages.ts';
import type { Model } from '../../../src/contracts/model.ts';
import type {
  ListenerConfig,
  ProjectedListenerConfig,
} from '../../../src/config/listener.ts';
import type { ToolMode, ToolName } from '../../../src/config/tool-policy.ts';
import type { JsonObject } from '../../../src/contracts/json.ts';
import { OWNER_ID } from '../../../src/contracts/identity.ts';
import {
  MEMBER_TOOLS,
  toolPermissions,
} from '../../support/tool-permissions.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';

const group = '123456',
  self = '999',
  actor = '42';
const config = (
  extended: Partial<Record<ToolName, ToolMode>> = {},
): ListenerConfig => ({
  ownerId: OWNER_ID,
  groupId: group,
  enabled: true,
  debounceMs: 1,
  cooldownMs: 0,
  retentionDays: 7,
  randomReplyProbability: 0,
  toolPermissions: toolPermissions({
    ...MEMBER_TOOLS,
    execute_javascript: 'direct',
    get_group_info: 'direct',
    ...extended,
  }),
});

function memory(): Memory & { rows: TimelineEntry[] } {
  const rows: TimelineEntry[] = [];
  return {
    rows,
    append: (e) => {
      rows.push(e);
      return true;
    },
    recent: () => rows,
    find: (id) => rows.find((e) => e.messageId === id),
    context: () => '',
    async compact() {},
    clear() {},
    close() {},
  };
}

const virtualPacer = () => {
  let now = 0;
  const pacer = new SideEffectPacer({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  return { pacer, now: () => now };
};

function host(
  cfg = config(),
  model: Model = {
    async complete() {
      return { content: null, tool_calls: [] };
    },
  },
) {
  const calls: { action: string; params: JsonObject }[] = [];
  let next = 5000;
  const api = {
    async call(action: string, params: JsonObject = {}) {
      calls.push({ action, params });
      if (action === 'send_group_msg') {
        return { message_id: next++ };
      }
      if (action === 'get_login_info') {
        return { user_id: Number(self) };
      }
      if (action === 'get_group_member_info') {
        return {
          group_id: Number(group),
          user_id: Number(params.user_id),
          nickname: 'M',
          role: 'member',
        };
      }
      return {};
    },
  };
  const mem = memory(),
    session = new ModelSession({
      model: 'main',
      path: ':memory:',
      groupId: group,
    }),
    world = new WorldEventStore({ path: ':memory:', groupId: group });
  const { pacer } = virtualPacer();
  const bot = new Listener(
    api,
    model,
    mem,
    cfg,
    Math.random,
    undefined,
    undefined,
    { session, world, pacer },
  );
  bot.setConnected(true);
  const store = new SandboxJobStore({ path: ':memory:' });
  const service = new SandboxService({ store, limits: { timeoutMs: 10000 } });
  service.setToolBridge({
    names: () => bot.hostToolNames(),
    call: (scope, name, args, signal) =>
      bot.executeHostTool(
        name,
        args,
        {
          groupId: scope.groupId,
          selfId: scope.selfId,
          actorId: scope.actorId,
          messageId: scope.messageId,
        },
        signal,
      ),
  });
  const run = (code: string, scope = { selfId: self, groupId: group }) =>
    service.execute(
      {
        ...scope,
        description: 'bridge test',
        code,
        mode: 'sync',
        waitMs: 20000,
      },
      undefined,
      { actorId: actor, messageId: '1' },
    );
  return {
    bot,
    api,
    calls,
    mem,
    world,
    service,
    store,
    run,
    async close() {
      await service.stop();
      await bot.stop();
      store.close();
      world.close();
      session.close();
    },
  };
}

test('pacer allows a 20-call burst, then one per second, never closer than 100ms, FIFO', async () => {
  const { pacer, now } = virtualPacer();
  const times: number[] = [];
  const signal = new AbortController().signal;
  for (let i = 0; i < 60; i++) {
    await pacer.take(signal);
    times.push(now());
  }
  assert.equal(SIDE_EFFECT_PACING.capacity, 20);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i]! - times[i - 1]! >= 100, `gap ${i}`);
  }
  assert.ok(times[19]! <= 1900 + 1);
  assert.ok(
    Math.abs((times[59]! - times[40]!) / 19 - 1000) <= 1,
    'sustained one per second',
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(pacer.take(aborted.signal));
});

test('guest tools mirror results, carry Uint8Array both ways and throw only for invalid calls', async () => {
  const seen: unknown[] = [];
  const r = await startExecution({
    timeoutMs: 5000,
    tools: ['echo'],
    callTool: async (_n, args) => {
      seen.push(args);
      return {
        status: 'ok',
        bytes: new Uint8Array([7, 8, 9]),
        args: args as JsonObject,
      };
    },
    code: `
  const r=await tools.echo({data:new Uint8Array([1,2,3,4]).subarray(1,3),n:1});
  const errors=[];
  for(const bad of [()=>tools.echo({f(){}}),()=>tools.echo({x:new Float32Array(1)}),()=>tools.echo({$bytes:0}),()=>tools.echo({x:NaN}),()=>tools.missing({})]){try{bad();errors.push('none')}catch(e){errors.push(e.name)}}
  return JSON.stringify({ok:r.status,bytes:Array.from(r.bytes),isU8:r.bytes instanceof Uint8Array,errors,frozen:Object.isFrozen(tools)});`,
  }).result;
  assert.equal(r.status, 'completed');
  assert.deepEqual(JSON.parse((r as { value: string }).value), {
    ok: 'ok',
    bytes: [7, 8, 9],
    isU8: true,
    errors: ['TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError'],
    frozen: true,
  });
  assert.deepEqual(seen, [{ data: Buffer.from([2, 3]), n: 1 }]);
});

test('JS exposes reply_to while internal messages and OneBot replies retain their formats', async () => {
  const h = host();
  try {
    h.world.appendMessage({
      messageId: '1',
      userId: actor,
      nickname: 'member',
      text: 'body',
      time: Date.now() / 1000,
      replyTo: '2',
      segments: [
        { type: 'reply', message_id: '2' },
        { type: 'text', text: 'body' },
      ],
    });
    const r =
      await h.run(`const before = await tools.read_message({message_id:'1'});
      const sent = await tools.send_message({reply_to:'1',segments:[{type:'text',text:'ok'}]});
      const after = await tools.read_message({message_id:sent.message_id});
      return JSON.stringify([before.message, after.message]);`);
    assert.equal(r.status, 'completed');
    const messages = JSON.parse((r as { value: string }).value);
    assert.deepEqual(
      messages.map((m: any) => m.reply_to),
      ['2', '1'],
    );
    for (const message of messages) {
      assert.equal(Object.hasOwn(message, 'replyTo'), false);
      assert.ok(message.segments.every((s: any) => s.type !== 'reply'));
    }
    assert.equal(h.mem.find('5000')!.replyTo, '1');
    assert.deepEqual(
      (
        h.calls.find((c) => c.action === 'send_group_msg')!.params
          .message as any[]
      )[0],
      { type: 'reply', data: { id: '1' } },
    );
  } finally {
    await h.close();
  }
});

for (const kind of ['events'] as const) {
  test(`JS read_${kind} retains cursors across calls and jobs without relaxing scope or filters`, async () => {
    const h = host();
    try {
      for (const id of ['1', '2', '3']) {
        h.world.appendMessage({
          messageId: id,
          userId: actor,
          nickname: 'member',
          text: `body-${id}`,
          time: Date.now() / 1000,
        });
      }
      const first = await h.run(`
        const first = await tools.read_${kind}({limit:1,direction:'forward'});
        const second = await tools.read_${kind}({limit:1,cursor:first.next_cursor});
        return JSON.stringify({first,second});`);
      assert.equal(first.status, 'completed', JSON.stringify(first));
      const { first: page1, second: page2 } = JSON.parse(
        (first as { value: string }).value,
      );
      const ids = (page: any) =>
        page.events.map((item: any) => item.payload.message.messageId);
      assert.equal(page1.status, 'ok');
      assert.equal(page2.status, 'ok');
      assert.deepEqual(ids(page1), ['1']);
      assert.deepEqual(ids(page2), ['2']);
      assert.match(page2.next_cursor, /^wc_/);
      const cursor = JSON.stringify(page2.next_cursor);
      const next = await h.run(`
        const page = await tools.read_${kind}({limit:1,cursor:${cursor}});
        const filters = await tools.read_${kind}({limit:1,cursor:${cursor},direction:'forward'});
        const removed = [typeof tools.read_messages, typeof tools.ack_events];
        return JSON.stringify({page,filters,removed});`);
      assert.equal(next.status, 'completed', JSON.stringify(next));
      const { page, filters, removed } = JSON.parse(
        (next as { value: string }).value,
      );
      assert.equal(page.status, 'ok');
      assert.deepEqual(ids(page), ['3']);
      assert.equal(page.next_cursor, undefined);
      assert.equal(filters.error, 'invalid_arguments');
      assert.equal(filters.reason_code, 'cursor_with_filters');
      assert.deepEqual(removed, ['undefined', 'undefined']);
      for (const [scope, error] of [
        [{ selfId: self, groupId: '654321' }, 'host_unavailable'],
        [{ selfId: '888', groupId: group }, 'forbidden_group'],
      ] as const) {
        const result = await h.run(
          `return JSON.stringify(await tools.read_${kind}({limit:1,cursor:${cursor}}));`,
          scope,
        );
        assert.equal(result.status, 'completed', JSON.stringify(result));
        assert.deepEqual(JSON.parse((result as { value: string }).value), {
          status: 'error',
          error,
        });
      }
      await h.bot.receive(
        {
          post_type: 'message',
          message_type: 'group',
          group_id: group,
          self_id: self,
          user_id: OWNER_ID,
          message_id: '99',
          time: Date.now() / 1000,
          sender: { nickname: 'owner' },
          message: [{ type: 'text', data: { text: '/reset' } }],
        },
        self,
      );
      const reset = await h.run(
        `return JSON.stringify(await tools.read_${kind}({limit:1,cursor:${cursor}}));`,
      );
      assert.equal(reset.status, 'completed', JSON.stringify(reset));
      assert.deepEqual(JSON.parse((reset as { value: string }).value), {
        status: 'error',
        error: 'invalid_cursor',
      });
    } finally {
      await h.close();
    }
  });
}

test(
  'JS-initialized world tools also serve the direct model path with live wake callbacks',
  { timeout: 10000 },
  async () => {
    let cursor: string;
    let turn = 0;
    let resolve!: (results: any[]) => void;
    const observed = new Promise<any[]>((done) => {
      resolve = done;
    });
    const h = host(config(), {
      async complete(messages) {
        if (turn++ === 0) {
          return {
            content: null,
            tool_calls: [
              ['read_events', { limit: 1, cursor }],
              ['get_wake_state', {}],
            ].map(([name, args], i) => ({
              id: `direct_${i}`,
              type: 'function' as const,
              function: {
                name: name as string,
                arguments: JSON.stringify(args),
              },
            })),
          };
        }
        resolve(
          messages
            .filter((m) => m.role === 'tool')
            .map((m) => JSON.parse(m.content as string)),
        );
        return {
          content: null,
          tool_calls: [
            {
              id: 'done',
              type: 'function',
              function: { name: 'finish', arguments: '{"mode":"hard"}' },
            },
          ],
        };
      },
    });
    try {
      for (const id of ['1', '2']) {
        h.world.appendMessage({
          messageId: id,
          userId: actor,
          nickname: 'member',
          text: id,
          time: Date.now() / 1000,
        });
      }
      const first = await h.run(`return JSON.stringify(
        await tools.read_events({limit:1,direction:'forward'})
      );`);
      assert.equal(first.status, 'completed', JSON.stringify(first));
      const events = JSON.parse((first as { value: string }).value);
      cursor = events.next_cursor;
      assert.match(cursor, /^wc_/);
      assert.equal(events.ack_cursor, undefined);
      await h.bot.receive(
        {
          post_type: 'message',
          message_type: 'group',
          group_id: group,
          self_id: self,
          user_id: actor,
          message_id: '3',
          time: Date.now() / 1000,
          sender: { nickname: 'member' },
          message: [
            { type: 'at', data: { qq: self } },
            { type: 'text', data: { text: 'continue' } },
          ],
        },
        self,
      );
      const [page, wake] = await observed;
      assert.equal(page.status, 'ok');
      assert.deepEqual(
        page.events.map((e: any) => e.payload.message.messageId),
        ['2'],
      );
      assert.ok(wake.read_through > events.high_water);
      assert.equal(wake.unread_count, 0);
      assert.equal(wake.status, 'ok');
      assert.ok(wake.wake_budget.remaining_tool_calls > 0);
      assert.ok(wake.trigger);
    } finally {
      await h.close();
    }
  },
);

test('sandbox code sends messages through the same path, records calls and returns a forced summary', async () => {
  const h = host();
  try {
    const r =
      await h.run(`const out=[];for(let i=0;i<3;i++)out.push(await tools.send_message({segments:[{type:'text',text:'第'+i+'条'}]}));
   const bad=await tools.send_message({segments:'nope'});const off=await tools.mute_member?.({user_id:'1',seconds:60});
   return JSON.stringify({ids:out.map(r=>r.message_id),bad:bad.status,mute:typeof tools.mute_member,finish:typeof tools.finish,js:typeof tools.execute_javascript});`);
    assert.equal(r.status, 'completed');
    const value = JSON.parse((r as { value: string }).value);
    assert.deepEqual(value, {
      ids: ['5000', '5001', '5002'],
      bad: 'error',
      mute: 'undefined',
      finish: 'undefined',
      js: 'undefined',
    });
    assert.equal(
      h.calls.filter((c) => c.action === 'send_group_msg').length,
      3,
    );
    assert.equal(h.mem.rows.filter((e) => e.bot).length, 3);
    const summary = (r as { tool_calls?: JsonObject }).tool_calls as {
      counts: JsonObject;
      abnormal: JsonObject[];
      abnormal_omitted: number;
    };
    assert.deepEqual(summary.counts, { send_message: { error: 1, ok: 3 } });
    assert.deepEqual(summary.abnormal, [
      {
        seq: 4,
        tool: 'send_message',
        status: 'error',
        error: 'invalid_arguments',
      },
    ]);
    const page = h.service.calls(
      { selfId: self, groupId: group },
      (r as { job_id: string }).job_id,
    );
    assert.equal(page.calls.length, 4);
    assert.equal(page.calls[0]!.ids.message_id, '5000');
    assert.match(page.calls[0]!.argsHash, /^[a-f0-9]{64}$/);
  } finally {
    await h.close();
  }
});

test('policy is evaluated per call, not at job creation', async () => {
  const h = host();
  try {
    (
      h.bot as unknown as { config: ProjectedListenerConfig }
    ).config.tools.extended!.poke_member = 'off';
    const r = await h.run(
      `return JSON.stringify(await tools.get_group_info({}));`,
    );
    assert.equal(r.status, 'completed');
    const stopped = h.bot.stop();
    await stopped;
    assert.deepEqual(
      await h.bot.executeHostTool(
        'send_message',
        { segments: [{ type: 'text', text: 'x' }] },
        { groupId: group, selfId: self, actorId: actor, messageId: '1' },
        new AbortController().signal,
      ),
      { status: 'error', error: 'host_unavailable' },
    );
    assert.deepEqual(h.bot.hostToolNames(), []);
  } finally {
    await h.close();
  }
});

test('view_images inside the sandbox returns RGBA pixels instead of model-visible content', async () => {
  const sharp = (await import('sharp')).default;
  const png = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 128]), {
    raw: { width: 2, height: 1, channels: 4 },
  })
    .png()
    .toBuffer();
  const api = {
    async call(action: string, params: JsonObject = {}) {
      if (action === 'get_msg') {
        return {
          message_type: 'group',
          group_id: Number(group),
          message_id: params.message_id,
          sender: { user_id: 7, nickname: 'A' },
          time: 1,
          message: [
            {
              type: 'image',
              data: { url: 'https://example.invalid/a.png', file: 'a.png' },
            },
          ],
        };
      }
      if (action === 'get_login_info') {
        return { user_id: Number(self) };
      }
      return {};
    },
  };
  const mem = memory();
  const entry = {
    messageId: '77',
    userId: '7',
    nickname: 'A',
    time: 1,
    text: '[图片]',
    images: [{ id: 'img_77_0', index: 0 }] as never,
  };
  mem.append(entry);
  const cfg = config({ view_images: 'direct' });
  cfg.toolPermissions.view_images.maxDownloadMb = 1;
  const runtime = sessionRuntime(cfg.groupId).runtime;
  // 会话模式下图片来源从本群world核验。
  runtime.world.appendMessage(entry, { source: 'onebot' });
  const bot = new Listener(
    api,
    undefined,
    mem,
    cfg,
    Math.random,
    async () => ({
      dataUrl: 'data:image/png;base64,' + png.toString('base64'),
      width: 2,
      height: 1,
      firstFrameOnly: false,
    }),
    undefined,
    { ...runtime, pacer: virtualPacer().pacer },
  );
  bot.setConnected(true);
  try {
    assert.ok(bot.hostToolNames().includes('view_images'));
    const r = await bot.executeHostTool(
      'view_images',
      { image_ids: ['img_77_0'] },
      { groupId: group, selfId: self, actorId: actor, messageId: '1' },
      new AbortController().signal,
    );
    assert.equal(r.status, 'ok');
    const images = r.images as unknown as {
      image_id: string;
      width: number;
      height: number;
      pixels: Uint8Array;
    }[];
    assert.equal(images.length, 1);
    assert.equal(images[0]!.image_id, 'img_77_0');
    assert.equal(images[0]!.width, 2);
    assert.equal(images[0]!.height, 1);
    assert.deepEqual(
      Array.from(images[0]!.pixels),
      [255, 0, 0, 255, 0, 0, 255, 128],
    );
  } finally {
    await bot.stop();
  }
});

test('confirm-mode tools from the sandbox post the normal confirmation and report confirmation_required', async () => {
  const h = host(config({ poke_member: 'confirm' }));
  try {
    const r = await h.run(
      `return JSON.stringify(await tools.poke_member({user_id:'7'}));`,
    );
    assert.equal(r.status, 'completed');
    const value = JSON.parse((r as { value: string }).value);
    assert.equal(value.status, 'confirmation_required', JSON.stringify(value));
    assert.match(String(value.notification_message_id), /^\d+$/);
    const notice = h.calls.find((c) => c.action === 'send_group_msg');
    assert.match(JSON.stringify(notice?.params), /\/confirm [a-f0-9]+/);
    assert.equal(
      (r as { tool_calls: { abnormal: JsonObject[] } }).tool_calls.abnormal[0]!
        .status,
      'confirmation_required',
    );
  } finally {
    await h.close();
  }
});

test('sandbox code creates image artifacts from Uint8Array pixels', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ArtifactStore } = await import('../../../src/artifacts/store.ts');
  const root = mkdtempSync(join(tmpdir(), 'bridge-art-'));
  const artifacts = new ArtifactStore({
    path: join(root, 'a.sqlite'),
    directory: join(root, 'files'),
    providerDirectory: '/napcat/art',
  });
  const cfg = config({ create_image: 'direct', list_artifacts: 'direct' });
  const mem = memory(),
    session = new ModelSession({
      model: 'main',
      path: ':memory:',
      groupId: group,
    }),
    world = new WorldEventStore({ path: ':memory:', groupId: group });
  const bot = new Listener(
    {
      async call() {
        return {};
      },
    },
    undefined,
    mem,
    cfg,
    Math.random,
    undefined,
    undefined,
    { session, world, artifacts, pacer: virtualPacer().pacer },
  );
  bot.setConnected(true);
  const store = new SandboxJobStore({ path: ':memory:' }),
    service = new SandboxService({ store, limits: { timeoutMs: 10000 } });
  service.setToolBridge({
    names: () => bot.hostToolNames(),
    call: (s, n, a, sig) =>
      bot.executeHostTool(
        n,
        a,
        {
          groupId: s.groupId,
          selfId: s.selfId,
          actorId: s.actorId,
          messageId: s.messageId,
        },
        sig,
      ),
  });
  try {
    const r = await service.execute(
      {
        selfId: self,
        groupId: group,
        description: 'img',
        mode: 'sync',
        waitMs: 20000,
        code: `
   const w=64,h=32,p=new Uint8Array(w*h*4);for(let i=0;i<w*h;i++){p[i*4]=i%256;p[i*4+3]=255;}
   const img=await tools.create_image({name:'grad.png',description:'渐变',ttl_ms:60000,width:w,height:h,pixels:p,format:'png'});
   const list=await tools.list_artifacts({});return JSON.stringify({status:img.status,type:img.media_type,count:list.artifacts.length});`,
      },
      undefined,
      { actorId: actor, messageId: '1' },
    );
    assert.equal(r.status, 'completed', JSON.stringify(r));
    assert.deepEqual(JSON.parse((r as { value: string }).value), {
      status: 'ok',
      type: 'image/png',
      count: 1,
    });
  } finally {
    await service.stop();
    await bot.stop();
    store.close();
    artifacts.close();
    world.close();
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
