import { applyToolPolicies, toolEnabled } from '../config/runtime.ts';
import { resolveGroupId } from '../contracts/identity.ts';
import { type ToolDefinition } from '../contracts/tools.ts';
import { type JsonObject } from '../contracts/json.ts';
import { buildModerationTools } from '../tools/management/moderation.ts';
import type { ListenerConfig } from '../config/listener.ts';
import { GROUP_TOOLS, SEND_MESSAGE_TOOL } from '../tools/messaging/tools.ts';
import { VIEW_IMAGES_TOOL } from '../tools/images/tools.ts';
import { READ_FORWARD_TOOL } from '../tools/forwards/tools.ts';
import { FACE_LAYOUT_GUIDANCE } from '../tools/faces/tools.ts';
import { MANAGE_ATTENTION_TOOL } from './attention.ts';
import { createReactionTool } from '../tools/reactions/tools.ts';
import { GET_REACTION_USERS_TOOL } from '../tools/reactions/users.ts';
import { buildWorldTools } from '../tools/world/tools.ts';
import { buildExtendedToolDefinitions } from '../tools/extended.ts';

const objectSchema = (properties: JsonObject, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const CHAT_TOOLS: ToolDefinition[] = [
  SEND_MESSAGE_TOOL,
  {
    type: 'function',
    function: {
      name: 'finish',
      description:
        '完成当前工作。mode必填：soft有新事件或待投递的后台结果时投递并继续，否则结束本次唤醒；hard立即结束本次唤醒，保留未读事件及待投递结果供后续唤醒。两者之后同批工具调用都不执行；不发消息即保持沉默。',
      parameters: objectSchema(
        { mode: { type: 'string', enum: ['soft', 'hard'] } },
        ['mode'],
      ),
    },
  },
  ...GROUP_TOOLS,
];

export function buildToolDefinitions(input: ListenerConfig): ToolDefinition[] {
  const config = applyToolPolicies(input);
  const tools = structuredClone(
    CHAT_TOOLS.filter((tool) =>
      tool.function.name === 'get_group_members'
        ? toolEnabled(config, 'get_group_members')
        : tool.function.name === 'get_member_info'
          ? toolEnabled(config, 'get_member_info')
          : true,
    ),
  );
  const send = tools.find((tool) => tool.function.name === 'send_message')!;
  // send_message的segments.items.oneOf按片段类型列出各schema。
  type SegmentSchema = { properties: { type: { const: string } } };
  const params = send.function.parameters as {
    properties: { segments: { items: { oneOf: SegmentSchema[] } } };
  };
  if (config.tools.mention === false) {
    params.properties.segments.items.oneOf =
      params.properties.segments.items.oneOf.filter(
        (schema) => schema.properties.type.const !== 'at',
      );
    send.function.description =
      '向当前群发送文字和QQ原生表情，可混排或纯表情；提及成员能力已关闭，不允许at片段。表情仅使用目录id，不开放连击或指定动画结果，不另设表情数量配额。' +
      FACE_LAYOUT_GUIDANCE;
  }
  if (config.images.enabled) {
    const imageTool = structuredClone(VIEW_IMAGES_TOOL);
    tools.push(imageTool);
  }
  if (config.forward.enabled) {
    const forwardTool = structuredClone(READ_FORWARD_TOOL);
    tools.push(forwardTool);
  }
  if (config.tools.reactions) {
    tools.push(createReactionTool());
  }
  if (toolEnabled(config, 'get_reaction_users')) {
    tools.push(structuredClone(GET_REACTION_USERS_TOOL));
  }
  if (config.attention.enabled) {
    tools.push(structuredClone(MANAGE_ATTENTION_TOOL));
  }
  tools.push(...buildWorldTools());
  tools.push(...buildModerationTools(config.tools.moderation));
  tools.push(
    ...buildExtendedToolDefinitions(
      resolveGroupId(config.groupId),
      config.tools.extended,
    ),
  );
  return tools;
}

/** 控制当前wake本身的工具，在沙箱代码中没有意义，因此不暴露给沙箱。 */
export const SANDBOX_EXCLUDED_TOOLS: readonly string[] = [
  'finish',
  'manage_attention',
  'get_wake_state',
  'execute_javascript',
];
