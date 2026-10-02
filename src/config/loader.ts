import {
  readFileSync,
  openSync,
  readSync,
  closeSync,
  constants,
  fstatSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { parse as parseDotenv } from 'dotenv';
import type {
  AppConfig,
  ResolvedGroupConfig,
  LoggingConfig,
  LogLevel,
  ModelConfig,
  ModelTransport,
  ToolSchemaMode,
  WebSearchProviderConfig,
} from './app.ts';
import { OWNER_ID } from '../contracts/identity.ts';
import { isObject } from '../contracts/json.ts';
import { ConfigError, configFail as fail } from './errors.ts';
import { assertStoragePaths } from './storage-paths.ts';
import {
  TOOL_NAMES,
  TOOL_CAPABILITIES,
  type ResolvedToolPolicies,
  type ToolMode,
  type ToolName,
  type ToolPolicy,
} from './tool-policy.ts';

// 解析结果之外只保留配置源的指纹，不保留可能含隐私的原文。
const configSources = new WeakMap<
  AppConfig,
  { path: string; digest: string }
>();
// 仅供Dashboard使用的启动密钥，刻意不放进可序列化的AppConfig。
const dashboardPasswords = new WeakMap<AppConfig, string | undefined>();

export function dashboardPassword(config: AppConfig): string | undefined {
  return dashboardPasswords.get(config);
}

const sourceDigest = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

export function matchesConfigSource(app: AppConfig, text: string): boolean {
  const source = configSources.get(app);
  return (
    source?.path === app.configPath && source.digest === sourceDigest(text)
  );
}

type Table = Record<string, unknown>;

function table(value: unknown, path: string, keys: readonly string[]): Table {
  if (value === undefined) {
    return {};
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return fail(path, '必须是表');
  }
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    fail(path, '包含未知字段');
  }
  return value as Table;
}

const own = (t: Table, key: string) => Object.hasOwn(t, key);

function text(
  t: Table,
  key: string,
  path: string,
  fallback: string,
  empty = false,
): string {
  const value = own(t, key) ? t[key] : fallback;
  if (
    typeof value !== 'string' ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (!empty && !value.trim())
  ) {
    return fail(`${path}.${key}`, '必须是非空单行文本');
  }
  return value.trim();
}

function bool(t: Table, key: string, path: string, fallback: boolean): boolean {
  const value = own(t, key) ? t[key] : fallback;
  if (typeof value !== 'boolean') {
    return fail(`${path}.${key}`, '必须是布尔值');
  }
  return value;
}

function num(
  t: Table,
  key: string,
  path: string,
  fallback: number,
  min: number,
  max: number,
  integer = true,
): number {
  const value = own(t, key) ? t[key] : fallback;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    value < min ||
    value > max
  ) {
    return fail(`${path}.${key}`, '数值超出允许范围或类型错误');
  }
  return value;
}

function id(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,31}$/.test(value)) {
    return fail(path, '必须是规范的身份字符串');
  }
  return value;
}

function url(value: string, path: string, model = false): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(path, '网址无效');
  }
  if (
    parsed.username ||
    parsed.password ||
    value.includes('?') ||
    value.includes('#') ||
    (model
      ? !['https:', 'http:'].includes(parsed.protocol) ||
        (parsed.protocol === 'http:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
      : !['ws:', 'wss:'].includes(parsed.protocol))
  ) {
    fail(path, '网址协议或安全选项无效');
  }
  return value;
}

function filePath(value: string, base: string, path: string): string {
  if (!value || value.includes(':') || /[\u0000-\u001f\u007f]/.test(value)) {
    return fail(path, '必须是普通文件路径');
  }
  return resolve(base, value);
}

function persona(file: string, path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) {
      return fail(path, '必须是普通 UTF-8 文件');
    }
    const buffer = Buffer.alloc(16 * 1024 + 1);
    let count = 0;
    while (count < buffer.length) {
      const n = readSync(fd, buffer, count, buffer.length - count, null);
      if (!n) {
        break;
      }
      count += n;
    }
    if (count > 16 * 1024) {
      return fail(path, '文件不得超过16KiB');
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, count),
    );
    if (!content.trim()) {
      return fail(path, '文件不能为空');
    }
    return content;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    return fail(path, '无法读取 UTF-8 文件');
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function tools(
  value: unknown,
  path: string,
  defaults?: ResolvedToolPolicies,
): ResolvedToolPolicies {
  const raw = table(value, path, TOOL_NAMES);
  const result = {} as Record<ToolName, ToolPolicy>;
  for (const name of TOOL_NAMES) {
    if (!own(raw, name) && defaults) {
      result[name] = structuredClone(defaults[name]);
      continue;
    }
    const cap = TOOL_CAPABILITIES[name],
      value = own(raw, name) ? raw[name] : cap.defaultMode;
    const options =
      typeof value === 'string'
        ? {}
        : table(value, `${path}.${name}`, [
            'mode',
            ...Object.keys(cap.options),
          ]);
    const mode = typeof value === 'string' ? value : options.mode;
    if (
      !['off', 'confirm', 'direct'].includes(String(mode)) ||
      typeof mode !== 'string' ||
      (typeof value !== 'string' && mode === 'off') ||
      (mode === 'confirm' && !cap.confirm)
    ) {
      fail(`${path}.${name}`, '工具授权模式无效');
    }
    const policy: ResolvedToolPolicies[typeof name] = {
      mode: mode as ToolMode,
    };
    for (const [key, spec] of Object.entries(cap.options)) {
      policy[spec.field] = num(
        options,
        key,
        `${path}.${name}`,
        spec.default,
        spec.min,
        spec.max,
      );
    }
    result[name] = policy;
  }
  return result as ResolvedToolPolicies;
}

function modelTransport(value: unknown, path: string): ModelTransport {
  if (value === 'chat' || value === 'responses') {
    return value;
  }
  const options = table(value, `${path}.transport`, ['type', 'incremental']);
  if (options.type !== 'responses') {
    return fail(`${path}.transport.type`, '必须是responses');
  }
  if (!own(options, 'incremental')) {
    return fail(`${path}.transport.incremental`, '必须显式指定布尔值');
  }
  return {
    type: 'responses',
    incremental: bool(options, 'incremental', `${path}.transport`, false),
  };
}

const MODEL_KEYS = [
  'base_url',
  'model',
  'api_key_env',
  'timeout_ms',
  'max_output_tokens',
  'opencode_headers',
  'transport',
  'tool_schema',
] as const;

/** 解析[models.<名字>]；密钥由调用方读取，这里只校验字段。 */
function modelEntry(name: string, raw: Table, apiKey: string): ModelConfig {
  const path = `models.${name}`;
  return {
    name,
    transport: modelTransport(
      own(raw, 'transport') ? raw.transport : 'chat',
      path,
    ),
    baseUrl: url(
      text(raw, 'base_url', path, 'https://api.openai.com/v1'),
      `${path}.base_url`,
      true,
    ),
    apiKey,
    model: text(raw, 'model', path, ''),
    timeoutMs: num(raw, 'timeout_ms', path, 180000, 1000, 300000),
    maxTokens: num(
      raw,
      'max_output_tokens',
      path,
      32768,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    opencodeHeaders: bool(raw, 'opencode_headers', path, false),
    toolSchema: toolSchema(raw, path),
  };
}

function toolSchema(raw: Table, path: string): ToolSchemaMode {
  const value = own(raw, 'tool_schema') ? raw.tool_schema : 'ts';
  if (value !== 'ts' && value !== 'both' && value !== 'json') {
    return fail(`${path}.tool_schema`, '必须是"ts"、"both"或"json"');
  }
  return value;
}

function webSearch(value: unknown): WebSearchProviderConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  // 先按type区分，未知provider会报成不支持的类型，而不是多余字段。
  const tag = table(
    value,
    'web.search',
    value && typeof value === 'object' ? Object.keys(value) : [],
  );
  if (!own(tag, 'type')) {
    return fail('web.search.type', '必须显式指定搜索服务类型');
  }
  if (tag.type !== 'searxng') {
    return fail('web.search.type', '不支持的搜索服务类型');
  }
  const raw = table(value, 'web.search', ['type', 'url']);
  if (!own(raw, 'url')) {
    return fail('web.search.url', '必须显式指定SearXNG地址');
  }
  return {
    type: 'searxng',
    url: url(
      text(raw, 'url', 'web.search', ''),
      'web.search.url',
      true,
    ).replace(/\/+$/, ''),
  };
}

const POLICY_KEYS = [
  'enabled',
  'model',
  'persona',
  'reply',
  'session',
  'execution',
  'messages',
  'observation',
  'confirmation',
  'history',
  'storage',
  'tools',
] as const;

function policy(
  rawValue: unknown,
  path: string,
  base: string,
  directory: string,
  groupId: string,
  models: ReadonlySet<string>,
  defaults?: ResolvedGroupConfig,
): ResolvedGroupConfig {
  const raw = table(rawValue, path, POLICY_KEYS);
  let model: string;
  if (own(raw, 'model')) {
    model = text(raw, 'model', path, '');
    if (!models.has(model)) {
      fail(`${path}.model`, '引用了未定义的模型');
    }
  } else if (defaults) {
    model = defaults.model;
  } else if (models.size === 1) {
    model = [...models][0]!;
  } else {
    model = fail(`${path}.model`, '定义了多个模型时必须指定默认模型');
  }
  const reply = table(raw.reply, `${path}.reply`, [
    'mention',
    'quote_bot',
    'delay_ms',
    'cooldown_ms',
    'random',
  ]);
  const session = table(raw.session, `${path}.session`, [
    'event_window_size',
    'max_transcript_bytes',
  ]);
  const execution = table(raw.execution, `${path}.execution`, [
    'max_tool_calls_per_wake',
    'wake_timeout_ms',
  ]);
  const messages = table(raw.messages, `${path}.messages`, ['mentions']);
  const observation = table(raw.observation, `${path}.observation`, [
    'reactions',
  ]);
  const confirmation = table(raw.confirmation, `${path}.confirmation`, [
    'ttl_seconds',
  ]);
  const history = table(raw.history, `${path}.history`, ['retention_days']);
  const storage = table(raw.storage, `${path}.storage`, ['database']);
  let random: ResolvedGroupConfig['reply']['random'] =
    defaults?.reply.random === undefined
      ? false
      : structuredClone(defaults.reply.random);
  if (own(reply, 'random')) {
    if (reply.random === false) {
      random = false;
    } else {
      const r = table(reply.random, `${path}.reply.random`, [
        'probability',
        'cooldown_ms',
        'max_per_minute',
      ]);
      random = {
        probability: num(
          r,
          'probability',
          `${path}.reply.random`,
          0.03,
          0,
          1,
          false,
        ),
        cooldownMs: num(
          r,
          'cooldown_ms',
          `${path}.reply.random`,
          60000,
          1000,
          3600000,
        ),
        maxPerMinute: num(
          r,
          'max_per_minute',
          `${path}.reply.random`,
          2,
          1,
          10,
        ),
      };
    }
  }
  const delay = own(reply, 'delay_ms')
    ? reply.delay_ms
    : (defaults?.reply.delayMs ?? [1200, 3000]);
  if (!Array.isArray(delay) || delay.length !== 2) {
    fail(`${path}.reply.delay_ms`, '必须是两个整数的数组');
  }
  const pair = delay as unknown[],
    min = num({ min: pair[0] }, 'min', `${path}.reply.delay_ms`, 1200, 0, 5000),
    max = num(
      { max: pair[1] },
      'max',
      `${path}.reply.delay_ms`,
      3000,
      0,
      10000,
    );
  if (max < min) {
    fail(`${path}.reply.delay_ms`, '最大延迟不得小于最小延迟');
  }
  const personaPath = own(raw, 'persona')
    ? filePath(text(raw, 'persona', path, ''), base, `${path}.persona`)
    : (defaults?.personaPath ?? resolve(base, 'prompts/listener.md'));
  // defaults中显式指定的数据库路径按字面继承：多个启用的群必须各自覆盖，
  // 否则在冲突检查中失败，绝不会悄悄共用同一个数据库。
  const databasePath = own(storage, 'database')
    ? filePath(
        text(storage, 'database', `${path}.storage`, ''),
        base,
        `${path}.storage.database`,
      )
    : (defaults?.storage.databasePath ??
      resolve(directory, 'groups', groupId, 'listener.sqlite'));
  return {
    groupId,
    enabled: bool(raw, 'enabled', path, defaults?.enabled ?? false),
    model,
    personaPath,
    persona:
      own(raw, 'persona') || !defaults
        ? persona(personaPath, `${path}.persona`)
        : defaults.persona,
    reply: {
      mention: bool(
        reply,
        'mention',
        `${path}.reply`,
        defaults?.reply.mention ?? true,
      ),
      quoteBot: bool(
        reply,
        'quote_bot',
        `${path}.reply`,
        defaults?.reply.quoteBot ?? true,
      ),
      delayMs: [min, max],
      cooldownMs: num(
        reply,
        'cooldown_ms',
        `${path}.reply`,
        defaults?.reply.cooldownMs ?? 5000,
        1000,
        60000,
      ),
      random,
    },
    session: {
      eventWindowSize: num(
        session,
        'event_window_size',
        `${path}.session`,
        defaults?.session.eventWindowSize ?? 20,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      maxTranscriptBytes: num(
        session,
        'max_transcript_bytes',
        `${path}.session`,
        defaults?.session.maxTranscriptBytes ?? 524288,
        65536,
        8388608,
      ),
    },
    execution: {
      maxToolCallsPerWake: num(
        execution,
        'max_tool_calls_per_wake',
        `${path}.execution`,
        defaults?.execution.maxToolCallsPerWake ?? 96,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      wakeTimeoutMs: num(
        execution,
        'wake_timeout_ms',
        `${path}.execution`,
        defaults?.execution.wakeTimeoutMs ?? 240000,
        1000,
        600000,
      ),
    },
    messages: {
      mentions: bool(
        messages,
        'mentions',
        `${path}.messages`,
        defaults?.messages.mentions ?? true,
      ),
    },
    observation: {
      reactions: bool(
        observation,
        'reactions',
        `${path}.observation`,
        defaults?.observation.reactions ?? true,
      ),
    },
    confirmation: {
      ttlSeconds: num(
        confirmation,
        'ttl_seconds',
        `${path}.confirmation`,
        defaults?.confirmation.ttlSeconds ?? 60,
        1,
        60,
      ),
    },
    history: {
      retentionDays: num(
        history,
        'retention_days',
        `${path}.history`,
        defaults?.history.retentionDays ?? 7,
        1,
        30,
      ),
    },
    storage: { databasePath },
    tools: tools(raw.tools, `${path}.tools`, defaults?.tools),
  };
}

export function loadAppConfig(
  options: {
    configPath?: string;
    envPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): AppConfig {
  const configPath = resolve(options.configPath ?? 'config.toml'),
    base = dirname(configPath);
  let parsed: unknown, source: string;
  try {
    source = readFileSync(configPath, 'utf8');
    parsed = parseToml(source);
  } catch {
    return fail('config.toml', '无法读取或TOML格式无效');
  }
  const root = table(parsed, 'config', [
    'bot',
    'onebot',
    'models',
    'runtime',
    'web',
    'storage',
    'logging',
    'defaults',
    'groups',
  ]);
  const bot = table(root.bot, 'bot', ['name', 'owner_id']),
    one = table(root.onebot, 'onebot', [
      'url',
      'token_env',
      'api_timeout_ms',
      'reconnect_base_ms',
      'reconnect_max_ms',
      'heartbeat_ms',
    ]),
    runtime = table(root.runtime, 'runtime', ['max_concurrent_turns']),
    web = table(root.web, 'web', ['search']),
    rawStorage = table(root.storage, 'storage', [
      'directory',
      'telemetry_path',
      'registry_path',
      'custom_face_directory',
      'napcat_custom_face_directory',
      'artifact_directory',
      'napcat_artifact_directory',
    ]),
    logs = table(root.logging, 'logging', ['level', 'console', 'file']);
  const directory = filePath(
    text(rawStorage, 'directory', 'storage', 'data'),
    base,
    'storage.directory',
  );
  const customFaceDirectory = filePath(
    text(
      rawStorage,
      'custom_face_directory',
      'storage',
      resolve(directory, 'custom-face-originals'),
    ),
    base,
    'storage.custom_face_directory',
  );
  const napcatCustomFaceDirectory = text(
    rawStorage,
    'napcat_custom_face_directory',
    'storage',
    customFaceDirectory,
  );
  if (
    !napcatCustomFaceDirectory.startsWith('/') ||
    napcatCustomFaceDirectory.includes('\\') ||
    napcatCustomFaceDirectory
      .split('/')
      .some((part) => part === '.' || part === '..') ||
    napcatCustomFaceDirectory === '/'
  ) {
    fail(
      'storage.napcat_custom_face_directory',
      '必须是专用的绝对POSIX目录，不得含路径跳转',
    );
  }
  const artifactDirectory = filePath(
    text(
      rawStorage,
      'artifact_directory',
      'storage',
      resolve(directory, 'artifacts'),
    ),
    base,
    'storage.artifact_directory',
  );
  const napcatArtifactDirectory = text(
    rawStorage,
    'napcat_artifact_directory',
    'storage',
    artifactDirectory,
  );
  if (
    !napcatArtifactDirectory.startsWith('/') ||
    napcatArtifactDirectory.includes('\\') ||
    napcatArtifactDirectory
      .split('/')
      .some((part) => part === '.' || part === '..') ||
    napcatArtifactDirectory === '/'
  ) {
    fail(
      'storage.napcat_artifact_directory',
      '必须是专用的绝对POSIX目录，不得含路径跳转',
    );
  }
  const storage = {
    directory,
    telemetryPath: filePath(
      text(
        rawStorage,
        'telemetry_path',
        'storage',
        resolve(directory, 'telemetry.sqlite'),
      ),
      base,
      'storage.telemetry_path',
    ),
    registryPath: filePath(
      text(
        rawStorage,
        'registry_path',
        'storage',
        resolve(directory, 'group-registry.json'),
      ),
      base,
      'storage.registry_path',
    ),
    customFaceDirectory,
    napcatCustomFaceDirectory,
    artifactDirectory,
    napcatArtifactDirectory,
  };
  const rawModels = table(
    root.models,
    'models',
    isObject(root.models) ? Object.keys(root.models) : [],
  );
  const modelTables = new Map<string, Table>();
  for (const [name, value] of Object.entries(rawModels)) {
    if (!name.trim()) {
      fail('models', '模型名不能为空');
    }
    modelTables.set(name, table(value, `models.${name}`, MODEL_KEYS));
  }
  if (!modelTables.size) {
    fail('models', '至少需要定义一个模型');
  }
  const modelNames: ReadonlySet<string> = new Set(modelTables.keys());
  const defaultsRaw = table(root.defaults, 'defaults', POLICY_KEYS),
    defaultPolicy = policy(
      defaultsRaw,
      'defaults',
      base,
      directory,
      '1',
      modelNames,
    );
  const defaultDatabaseExplicit = own(
    table(defaultsRaw.storage, 'defaults.storage', ['database']),
    'database',
  );
  const configured = table(
    root.groups,
    'groups',
    root.groups &&
      typeof root.groups === 'object' &&
      !Array.isArray(root.groups)
      ? Object.keys(root.groups)
      : [],
  );
  const configuredGroupIds = Object.keys(configured);
  for (const groupId of configuredGroupIds) {
    id(groupId, 'groups');
  }
  const resolved = new Map<string, ResolvedGroupConfig>();
  function resolvePolicy(groupId: string): ResolvedGroupConfig {
    const inherited = structuredClone(defaultPolicy);
    if (!defaultDatabaseExplicit) {
      inherited.storage.databasePath = resolve(
        directory,
        'groups',
        groupId,
        'listener.sqlite',
      );
    }
    return policy(
      configured[groupId],
      own(configured, groupId) ? `groups.${groupId}` : 'groups',
      base,
      directory,
      groupId,
      modelNames,
      inherited,
    );
  }
  for (const groupId of configuredGroupIds) {
    resolved.set(groupId, resolvePolicy(groupId));
  }
  const enabled = [...resolved.values()].filter((group) => group.enabled),
    ownerConfigured = own(bot, 'owner_id');
  if ((defaultPolicy.enabled || enabled.length) && !ownerConfigured) {
    fail('bot.owner_id', '启用服务时必须在本地全局配置显式指定主人');
  }
  const ownerId = ownerConfigured ? id(bot.owner_id, 'bot.owner_id') : OWNER_ID;
  const tokenEnv = text(one, 'token_env', 'onebot', 'ONEBOT_ACCESS_TOKEN');
  const keyEnvs = new Map(
    [...modelTables].map(([name, raw]) => [
      name,
      text(raw, 'api_key_env', `models.${name}`, ''),
    ]),
  );
  for (const [name, field] of [
    [tokenEnv, 'onebot.token_env'],
    ...[...keyEnvs].map(
      ([model, env]) => [env, `models.${model}.api_key_env`] as const,
    ),
  ] as const) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      fail(field, '必须是大写环境变量名称');
    }
  }
  let secrets: Record<string, string> = {};
  try {
    secrets = parseDotenv(
      readFileSync(resolve(base, options.envPath ?? '.env')),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      fail('.env', '无法读取密钥文件');
    }
  }
  if (
    Object.keys(secrets).some(
      (key) =>
        key !== tokenEnv &&
        ![...keyEnvs.values()].includes(key) &&
        key !== 'DASHBOARD_PASSWORD',
    )
  ) {
    fail('.env', '只允许所选的密钥变量');
  }
  const env = options.env ?? process.env;
  function secret(name: string, field: string, required: boolean): string {
    for (const value of [secrets[name], env[name]]) {
      if (
        value !== undefined &&
        (typeof value !== 'string' || /[\r\n]/.test(value) || !value.trim())
      ) {
        fail(field, '密钥必须是非空单行文本');
      }
    }
    const value = (env[name] ?? secrets[name] ?? '').trim();
    if (required && !value) {
      fail(field, '缺少所选密钥');
    }
    return value;
  }
  const onebot = {
    url: url(text(one, 'url', 'onebot', 'ws://127.0.0.1:3001'), 'onebot.url'),
    token: secret(tokenEnv, 'onebot.token_env', true),
    apiTimeoutMs: num(one, 'api_timeout_ms', 'onebot', 10000, 1, 2147483647),
    reconnectBaseMs: num(
      one,
      'reconnect_base_ms',
      'onebot',
      1000,
      1,
      2147483647,
    ),
    reconnectMaxMs: num(
      one,
      'reconnect_max_ms',
      'onebot',
      30000,
      1,
      2147483647,
    ),
    heartbeatMs: num(one, 'heartbeat_ms', 'onebot', 30000, 1, 2147483647),
  };
  if (onebot.reconnectBaseMs > onebot.reconnectMaxMs) {
    fail('onebot.reconnect_max_ms', '不得小于重连基础间隔');
  }
  const level = text(logs, 'level', 'logging', 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    fail('logging.level', '日志级别无效');
  }
  const fileLogging =
    logs.file === false
      ? {}
      : table(logs.file, 'logging.file', [
          'directory',
          'retention_days',
          'max_file_mb',
          'max_total_mb',
        ]);
  const logging: LoggingConfig = {
    level: level as LogLevel,
    console: bool(logs, 'console', 'logging', true),
    file: logs.file !== false,
    directory: filePath(
      text(
        fileLogging,
        'directory',
        'logging.file',
        resolve(directory, 'logs'),
      ),
      base,
      'logging.file.directory',
    ),
    retentionDays: num(fileLogging, 'retention_days', 'logging.file', 7, 1, 30),
    maxFileMb: num(fileLogging, 'max_file_mb', 'logging.file', 20, 1, 100),
    maxTotalMb: num(fileLogging, 'max_total_mb', 'logging.file', 200, 1, 1000),
  };
  if (logging.maxTotalMb < logging.maxFileMb) {
    fail('logging.file.max_total_mb', '不得小于单文件大小上限');
  }
  assertStoragePaths(storage, [...resolved.values()]);
  // 即使没有显式配置的群，也要校验defaults中字面指定的数据库路径。
  if (defaultDatabaseExplicit) {
    assertStoragePaths(storage, [defaultPolicy]);
  }
  const app: AppConfig = {
    configPath,
    identity: { name: text(bot, 'name', 'bot', 'Listener'), ownerId },
    onebot,
    models: new Map(
      [...modelTables].map(([name, raw]) => [
        name,
        modelEntry(
          name,
          raw,
          secret(keyEnvs.get(name)!, `models.${name}.api_key_env`, true),
        ),
      ]),
    ),
    runtime: {
      maxConcurrentTurns: num(
        runtime,
        'max_concurrent_turns',
        'runtime',
        2,
        1,
        8,
      ),
    },
    web: { ...(own(web, 'search') ? { search: webSearch(web.search) } : {}) },
    storage,
    logging,
    defaultsEnabled: defaultPolicy.enabled,
    configuredGroupIds: Object.freeze([...configuredGroupIds]),
    resolveGroup(groupId: string) {
      id(groupId, 'groups');
      const group = structuredClone(
        resolved.get(groupId) ?? resolvePolicy(groupId),
      );
      assertStoragePaths(
        storage,
        [...resolved.values()]
          .filter((other) => other.groupId !== groupId)
          .concat(group),
      );
      return group;
    },
  };
  configSources.set(app, { path: configPath, digest: sourceDigest(source) });
  // 进程环境变量为空字符串时有意覆盖文件中的凭据，用于禁用登录。
  // 密码规则由AuthStore负责，因此无效或缺失的值也不影响加载UI。
  dashboardPasswords.set(
    app,
    env.DASHBOARD_PASSWORD ?? secrets.DASHBOARD_PASSWORD,
  );
  return app;
}
