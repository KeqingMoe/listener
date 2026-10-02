import type { ToolSchemaMode, WebSearchProviderConfig } from './app.ts';
import type { ResolvedToolPolicies } from './tool-policy.ts';
import type { ExtendedToolsConfig } from './extended-tools.ts';

export interface ImagesConfig {
  enabled: boolean;
  maxDownloadMb: number;
}

export interface ForwardConfig {
  enabled: boolean;
}

export type ModerationMode = 'off' | 'confirm' | 'direct';

export interface ModerationPolicy {
  mute: ModerationMode;
  unmute: ModerationMode;
  recall: ModerationMode;
  memberCard: ModerationMode;
  confirmationTtlSeconds: number;
  maxMuteSeconds: number;
}

interface ToolsConfig {
  members: boolean;
  mention: boolean;
  reactions?: boolean;
  extended?: ExtendedToolsConfig;
  moderation: ModerationPolicy;
}

/** Listener选项。实际部署通过toListenerConfig获得完整策略。 */
export interface ListenerConfig {
  groupId: string;
  /** 可信的全局部署owner；从不接受来自群级覆盖或聊天内容的值。 */
  ownerId: string;
  enabled: boolean;
  debounceMs: number;
  cooldownMs: number;
  /** 打开时最新未读QQ事件数及运行期QQ缓冲容量；异步结果不占此限。 */
  eventWindowSize?: number;
  maxToolCallsPerWake?: number;
  wakeTimeoutMs?: number;
  retentionDays: number;
  randomReplyProbability?: number;
  randomCooldownMs?: number;
  randomMaxPerMinute?: number;
  delayMaxMs?: number;
  persona?: string;
  botName?: string;
  mentionEnabled?: boolean;
  quoteBotEnabled?: boolean;
  /** 每个工具的已解析授权，是工具开关的唯一来源。 */
  toolPermissions: ResolvedToolPolicies;
  observeReactions?: boolean;
  messageMentions?: boolean;
  confirmationTtlSeconds?: number;
  /** 部署配置的搜索后端；未配置时不提供web_search。 */
  webSearch?: WebSearchProviderConfig;
  /** 所选模型的工具呈现方式；未给出时按json（完整JSON Schema）。 */
  toolSchema?: ToolSchemaMode;
}

/** 应用边界始终提供完整且按群独立的策略。 */
export interface ResolvedListenerConfig extends ListenerConfig {
  eventWindowSize: number;
  toolSchema: ToolSchemaMode;
  observeReactions: boolean;
  messageMentions: boolean;
  confirmationTtlSeconds: number;
}

/** applyToolPolicies从toolPermissions投影出的各模块选项，只在内部使用。 */
export interface ProjectedListenerConfig extends ListenerConfig {
  tools: ToolsConfig;
  images: ImagesConfig;
  forward: ForwardConfig;
  attention: { enabled: boolean; maxPlans: number };
}
