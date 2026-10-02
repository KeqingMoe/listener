import type { AppConfig, ResolvedGroupConfig } from './app.ts';
import type {
  ListenerConfig,
  ProjectedListenerConfig,
  ResolvedListenerConfig,
} from './listener.ts';
import {
  EXTENDED_TOOL_NAMES,
  type ExtendedToolsConfig,
} from './extended-tools.ts';
import { TOOL_CAPABILITIES, type ToolName } from './tool-policy.ts';

/** 把工具策略单向投影为各模块选项。 */
export function applyToolPolicies(
  config: ListenerConfig,
): ProjectedListenerConfig {
  const policies = config.toolPermissions;
  const direct = (name: ToolName) => policies[name]?.mode === 'direct';
  const mode = (name: ToolName) => policies[name]?.mode ?? 'off';
  const extended: ExtendedToolsConfig = {};
  for (const name of EXTENDED_TOOL_NAMES) {
    extended[name] = mode(name);
  }
  return {
    ...config,
    tools: {
      members: direct('get_group_members') || direct('get_member_info'),
      mention: config.messageMentions ?? true,
      reactions: direct('react_message'),
      extended,
      moderation: {
        mute: mode('mute_member'),
        unmute: mode('unmute_member'),
        recall: mode('recall_message'),
        memberCard: mode('set_member_card'),
        confirmationTtlSeconds: config.confirmationTtlSeconds ?? 60,
        maxMuteSeconds:
          policies.mute_member.maxSeconds ??
          TOOL_CAPABILITIES.mute_member.options.max_seconds!.default,
      },
    },
    images: {
      enabled: direct('view_images'),
      maxDownloadMb:
        policies.view_images.maxDownloadMb ??
        TOOL_CAPABILITIES.view_images.options.max_download_mb!.default,
    },
    forward: { enabled: direct('read_forward') },
    attention: {
      enabled: direct('manage_attention'),
      maxPlans:
        policies.manage_attention.maxPlans ??
        TOOL_CAPABILITIES.manage_attention.options.max_plans!.default,
    },
  };
}

export function toolEnabled(config: ListenerConfig, name: ToolName): boolean {
  return config.toolPermissions[name]?.mode === 'direct';
}

export function observesReactions(config: ListenerConfig): boolean {
  return config.observeReactions ?? false;
}

/** 应用配置到listener配置的唯一适配入口。模型凭据来自全局配置，已解析的群配置从不携带。 */
export function toListenerConfig(
  app: AppConfig,
  group: ResolvedGroupConfig,
): ResolvedListenerConfig {
  const random = group.reply.random;
  return {
    groupId: group.groupId,
    ownerId: app.identity.ownerId,
    botName: app.identity.name,
    enabled: group.enabled,
    persona: group.persona,
    debounceMs: group.reply.delayMs[0],
    delayMaxMs: group.reply.delayMs[1],
    cooldownMs: group.reply.cooldownMs,
    mentionEnabled: group.reply.mention,
    quoteBotEnabled: group.reply.quoteBot,
    randomReplyProbability: random ? random.probability : 0,
    randomCooldownMs: random ? random.cooldownMs : 60000,
    randomMaxPerMinute: random ? random.maxPerMinute : 2,
    eventWindowSize: group.session.eventWindowSize,
    maxToolCallsPerWake: group.execution.maxToolCallsPerWake,
    wakeTimeoutMs: group.execution.wakeTimeoutMs,
    ...(app.web.search ? { webSearch: structuredClone(app.web.search) } : {}),
    retentionDays: group.history.retentionDays,
    // 没有配置后端的工具直接不提供，而不是可见但调用失败。
    toolPermissions: {
      ...structuredClone(group.tools),
      ...(app.web.search ? {} : { web_search: { mode: 'off' } }),
    },
    observeReactions: group.observation.reactions,
    messageMentions: group.messages.mentions,
    confirmationTtlSeconds: group.confirmation.ttlSeconds,
    toolSchema: app.models.get(group.model)!.toolSchema,
  };
}
