import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import { toListenerConfig } from '../../../src/config/runtime.ts';
import {
  TOOL_NAMES,
  TOOL_CAPABILITIES,
  type ResolvedToolPolicies,
} from '../../../src/config/tool-policy.ts';
import type {
  AppConfig,
  ResolvedGroupConfig,
} from '../../../src/config/app.ts';
import { WorldEventStore } from '../../../src/world/events.ts';
import { ModelSession } from '../../../src/agent/session/store.ts';
import type { Api } from '../../../src/contracts/onebot.ts';
import type { Memory, TimelineEntry } from '../../../src/contracts/messages.ts';
import type { Model, ChatMessage } from '../../../src/contracts/model.ts';
import type { JsonObject } from '../../../src/contracts/json.ts';

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
    session: { maxTranscriptBytes: 524288, eventWindowSize: 20 },
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
          toolSchema: 'json',
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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { SandboxService } from '../../../src/sandbox/service.ts';
import { SandboxJobStore } from '../../../src/sandbox/store.ts';
import { ArtifactStore } from '../../../src/artifacts/store.ts';

// 微型光线追踪器：一个球、一个光源、Lambert着色。纯guest端计算。
const RAYTRACE = `
const w=96,h=64,p=new Uint8Array(w*h*4);
const c=[0,0,3],r=1,l=[-0.6,0.8,-0.5],ln=Math.hypot(...l),L=l.map(v=>v/ln);
for(let y=0;y<h;y++)for(let x=0;x<w;x++){
 const d=[(x-w/2)/h,-(y-h/2)/h,1],dn=Math.hypot(...d),D=d.map(v=>v/dn);
 const b=D[0]*-c[0]+D[1]*-c[1]+D[2]*-c[2],cc=c[0]*c[0]+c[1]*c[1]+c[2]*c[2]-r*r,disc=b*b-cc;
 const i=(y*w+x)*4;
 if(disc>=0){const t=-b-Math.sqrt(disc),P=D.map(v=>v*t),N=[P[0]-c[0],P[1]-c[1],P[2]-c[2]];
  const s=Math.max(0,N[0]*L[0]+N[1]*L[1]+N[2]*L[2]);p[i]=40+200*s|0;p[i+1]=60+150*s|0;p[i+2]=200*s|0;}
 else{p[i]=20;p[i+1]=24;p[i+2]=40+y;}
 p[i+3]=255;}
const img=await tools.create_image({name:'sphere.png',description:'光线追踪球体',ttl_ms:600000,width:w,height:h,pixels:p,format:'png'});
if(img.status!=='ok')return JSON.stringify(img);
const sent=await tools.send_group_image({artifact_id:img.artifact_id});
return JSON.stringify({artifact:img.artifact_id,send:sent.status,message_id:sent.message_id});`;

test('e2e: model raytraces in the sandbox, encodes with create_image and sends the artifact to the group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-raytrace-'));
  const artifacts = new ArtifactStore({
    path: join(dir, 'a.sqlite'),
    directory: join(dir, 'files'),
    providerDirectory: '/napcat/art',
  });
  const sandboxStore = new SandboxJobStore({ path: ':memory:' }),
    sandbox = new SandboxService({
      store: sandboxStore,
      limits: { timeoutMs: 20000 },
    });
  const f = fixture({
    execute_javascript: { mode: 'direct' },
    query_javascript_jobs: { mode: 'direct' },
    create_image: { mode: 'direct' },
    send_group_image: { mode: 'direct' },
  });
  const memory = new Cache(),
    rpc = transport();
  const world = new WorldEventStore({
      path: ':memory:',
      groupId: GROUP,
      retentionDays: 7,
    }),
    session = new ModelSession({
      model: 'main',
      path: ':memory:',
      groupId: GROUP,
    });
  let toolResult: JsonObject | undefined;
  const model: Model = {
    async complete(messages: ChatMessage[]) {
      const rows = messages.filter((m) => m.role === 'tool');
      if (!rows.length) {
        return {
          content: null,
          tool_calls: [
            tool(
              'execute_javascript',
              {
                description: '渲染球体并发送',
                code: RAYTRACE,
                mode: 'sync',
                wait_ms: 20000,
              },
              'js',
            ),
          ],
        };
      }
      toolResult ??= JSON.parse(
        String(rows.find((m) => m.tool_call_id === 'js')!.content),
      );
      return {
        content: null,
        tool_calls: [tool('finish', { mode: 'hard' }, 'fin' + rows.length)],
      };
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
    { world, session, sandbox, artifacts },
  );
  sandbox.setToolBridge({
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
  bot.setConnected(true);
  try {
    await bot.receive(incoming(), SELF);
    await until(() => !!toolResult);
    assert.equal(toolResult!.status, 'ok', JSON.stringify(toolResult));
    const value = JSON.parse(String(toolResult!.value));
    assert.equal(value.send, 'executed', JSON.stringify(value));
    assert.match(String(value.message_id), /^\d+$/);
    assert.deepEqual((toolResult!.tool_calls as JsonObject).counts, {
      create_image: { ok: 1 },
      send_group_image: { ok: 1 },
    });
    const send = rpc.calls.find(
      (c) =>
        c.action === 'send_group_msg' &&
        JSON.stringify(c.params).includes('/napcat/art/'),
    )!;
    assert.deepEqual(send.params, {
      group_id: GROUP,
      message: [
        { type: 'image', data: { file: `/napcat/art/${value.artifact}` } },
      ],
    });
    const stored = artifacts.get(
      { selfId: SELF, groupId: GROUP },
      value.artifact,
    )!;
    const meta = await sharp(await artifacts.read(stored)).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, 96);
    assert.equal(meta.height, 64);
    const { data } = await sharp(await artifacts.read(stored))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const centre = (32 * 96 + 48) * 4;
    assert.ok(data[centre]! > 60, 'sphere is lit');
  } finally {
    await bot.stop();
    await sandbox.stop();
    sandboxStore.close();
    artifacts.close();
    world.close();
    session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
