import type { Config } from './onebot.ts';
import type { ResolvedToolPolicies } from './tool-policy.ts';

/** 带标签的联合类型，新增provider只需加分支，无需重新解释已有字段。 */
export type WebSearchProviderConfig = { type: 'searxng'; url: string };

/**
 * 工具的呈现方式：ts把参数与返回值写成TypeScript声明放进系统提示词、
 * tools只给名字与一句话概要；both另在tools保留完整参数结构（无描述）；
 * json沿用完整JSON Schema与描述，不附声明。
 */
export type ToolSchemaMode = 'ts' | 'both' | 'json';

export type ModelTransport =
  'chat' | 'responses' | { type: 'responses'; incremental: boolean };

/** 一个具名模型：服务商地址、凭据与请求参数。 */
export interface ModelConfig {
  /** 配置中的名字，用于群选用、会话指纹与用量统计。 */
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 请求时发给服务商的模型ID。 */
  model: string;
  timeoutMs: number;
  maxTokens: number;
  opencodeHeaders: boolean;
  transport: ModelTransport;
  toolSchema: ToolSchemaMode;
}

export interface ResolvedGroupConfig {
  groupId: string;
  enabled: boolean;
  /** 所选模型的配置名，必定存在于AppConfig.models。 */
  model: string;
  personaPath: string;
  persona: string;
  reply: {
    mention: boolean;
    quoteBot: boolean;
    delayMs: readonly [number, number];
    cooldownMs: number;
    random:
      false | { probability: number; cooldownMs: number; maxPerMinute: number };
  };
  session: {
    eventWindowSize: number;
    maxTranscriptBytes: number;
  };
  execution: { maxToolCallsPerWake: number; wakeTimeoutMs: number };
  messages: { mentions: boolean };
  observation: { reactions: boolean };
  confirmation: { ttlSeconds: number };
  history: { retentionDays: number };
  storage: { databasePath: string };
  tools: ResolvedToolPolicies;
}

export interface AppConfig {
  configPath: string;
  identity: { name: string; ownerId: string };
  onebot: Config;
  /** 按配置名索引的模型；群通过model字段选用其中之一。 */
  models: ReadonlyMap<string, ModelConfig>;
  runtime: { maxConcurrentTurns: number };
  /** 未配置search时完全不提供web_search工具。 */
  web: { search?: WebSearchProviderConfig };
  storage: {
    directory: string;
    telemetryPath: string;
    registryPath: string;
    customFaceDirectory: string;
    napcatCustomFaceDirectory: string;
    artifactDirectory: string;
    napcatArtifactDirectory: string;
  };
  logging: LoggingConfig;
  defaultsEnabled: boolean;
  configuredGroupIds: readonly string[];
  resolveGroup(id: string): ResolvedGroupConfig;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggingConfig {
  level: LogLevel;
  console: boolean;
  file: boolean;
  directory: string;
  retentionDays: number;
  maxFileMb: number;
  maxTotalMb: number;
}
