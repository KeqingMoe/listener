#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Loop, tools } from '@listener/agent';
import { modelsFromConfig, parse, Scheduler } from '@listener/app';
import { Chat, napcat, groupId as toGroupId, UserId } from '@listener/chat';
import { NCWebsocket } from 'node-napcat-ts';

const path = process.argv[2] ?? 'config.toml';
const configPath = isAbsolute(path) ? path : resolve(path);
const configDir = dirname(configPath);
try {
  process.loadEnvFile(resolve(configDir, '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw error;
  }
}

const config = parse(readFileSync(configPath, 'utf8'));

const token = process.env[config.onebot.tokenEnv];
if (token === undefined || token === '') {
  throw new Error('缺少 OneBot 密钥环境变量');
}

const providers: string[] = [];
for (const group of Object.values(config.groups)) {
  if (group === false) {
    continue;
  }
  const slash = group.model.indexOf('/');
  if (slash <= 0) {
    continue;
  }
  const name = group.model.slice(0, slash);
  if (!providers.includes(name)) {
    providers.push(name);
  }
}

const models = modelsFromConfig(config.providers, providers);
const streamFn = models.streamSimple.bind(models);

const ws = new NCWebsocket({
  baseUrl: config.onebot.url,
  accessToken: token,
  reconnection: { enable: true },
});
const client = napcat(ws);

await ws.connect();
const login = await ws.get_login_info();
const selfId = UserId(String(login.user_id));
if (selfId === undefined) {
  throw new Error('get_login_info');
}

const abort = new AbortController();
const schedulers: Scheduler[] = [];
const loops = new Set<Loop>();

const groupList = await ws.get_group_list();
for (const group of groupList) {
  const id = toGroupId(group.group_id);
  if (id === undefined) {
    continue;
  }

  const policy = config.groups[id] ?? config.groups.default;
  if (policy === false) {
    continue;
  }

  const slash = policy.model.indexOf('/');
  if (slash <= 0 || slash === policy.model.length - 1) {
    throw new Error('找不到这个模型');
  }
  const model = models.getModel(
    policy.model.slice(0, slash),
    policy.model.slice(slash + 1),
  );
  if (model === undefined) {
    throw new Error('找不到这个模型');
  }

  let systemPrompt = '';
  if (policy.persona.length > 0) {
    const abs = isAbsolute(policy.persona)
      ? policy.persona
      : resolve(configDir, policy.persona);
    systemPrompt = readFileSync(abs, 'utf8').trim();
  }

  const chat = new Chat({ selfId, groupId: id }, client);
  const loop = new Loop(chat, policy.open.window, {
    model,
    streamFn,
    tools: tools(chat),
    sessionId: `listener-${id}`,
    systemPrompt,
    signal: abort.signal,
  });
  loops.add(loop);
  schedulers.push(new Scheduler(chat, loop, policy.open, abort.signal));
}

function shutdown(): void {
  abort.abort();
  for (const scheduler of schedulers) {
    scheduler.dispose();
  }
  for (const loop of loops) {
    loop.dispose();
    loop.chat.dispose();
  }
  client.dispose();
  void ws.disconnect();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

console.log(`已连接 ${selfId}`);

await Promise.all(schedulers.map(scheduler => scheduler.open()));
