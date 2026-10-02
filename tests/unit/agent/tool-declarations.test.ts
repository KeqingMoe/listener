import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolDefinitions } from '../../../src/agent/tool-definitions.ts';
import { buildSystemPrompt } from '../../../src/agent/prompts/index.ts';
import {
  presentTools,
  renderDeclarations,
} from '../../../src/agent/tool-declarations/index.ts';
import {
  allToolsConfig,
  declarationDiagnostics,
  declarationNameMismatch,
} from '../../support/declaration-check.ts';
import { toolPermissions } from '../../support/tool-permissions.ts';

test('every tool that can be offered has exactly one declaration', () => {
  assert.deepEqual(declarationNameMismatch(allToolsConfig()), {
    missing: [],
    extra: [],
  });
});

test('rendered declarations compile as TypeScript in every catalog variant', () => {
  for (const overrides of [
    {},
    { observeReactions: false, messageMentions: false },
  ]) {
    assert.deepEqual(declarationDiagnostics(allToolsConfig(overrides)), []);
  }
});

test('declarations follow the enabled tools and per-group schema rewrites', () => {
  const config = allToolsConfig({
    toolSchema: 'ts',
    messageMentions: false,
    toolPermissions: toolPermissions({
      send_message: 'direct',
      mute_member: { mode: 'confirm', maxSeconds: 45 },
    } as never),
  });
  const tools = buildToolDefinitions(config);
  const text = renderDeclarations(config, tools);
  const declared = [...text.matchAll(/^ {2}function ([a-z_]+)\(/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    declared,
    tools.map((t) => t.function.name),
  );
  assert.match(text, /1 到 45/);
  assert.doesNotMatch(text, /web_fetch\(/);
  assert.doesNotMatch(
    /function send_message[\s\S]*?\): /.exec(text)![0],
    /'at'/,
  );
  // 附录只在对应工具启用时出现。
  assert.match(text, /原生表情（FaceId/);
  assert.doesNotMatch(text, /表情回应（react_message/);
  const prompt = buildSystemPrompt(config, tools);
  assert.ok(prompt.includes(text));
  assert.match(
    prompt,
    /本轮配置限制：\{"tools":\{[^}]*"mute_member":"confirm"/,
  );
});

test('presentation modes change only what the model sees', () => {
  const config = allToolsConfig();
  const tools = buildToolDefinitions(config);
  const snapshot = structuredClone(tools);
  assert.deepEqual(presentTools(tools, 'json'), tools);
  const ts = presentTools(tools, 'ts');
  const both = presentTools(tools, 'both');
  for (const [index, tool] of tools.entries()) {
    assert.equal(ts[index]!.function.name, tool.function.name);
    assert.deepEqual(ts[index]!.function.parameters, {
      type: 'object',
      additionalProperties: true,
    });
    assert.equal(
      both[index]!.function.description,
      ts[index]!.function.description,
    );
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          // properties下的键是参数名，参数本身可以叫description。
          if (key !== 'properties') {
            assert.notEqual(typeof item === 'string' && key, 'description');
          }
          walk(item);
        }
      }
    };
    walk(both[index]!.function.parameters);
    assert.deepEqual(
      Object.keys(
        (both[index]!.function.parameters.properties ?? {}) as object,
      ),
      Object.keys((tool.function.parameters.properties ?? {}) as object),
    );
  }
  assert.deepEqual(
    both.find((t) => t.function.name === 'mute_member')!.function.parameters
      .required,
    ['user_id', 'seconds'],
  );
  assert.deepEqual(tools, snapshot);
});

test('all model presentation modes use top-level reply_to without reply segments', () => {
  for (const toolSchema of ['json', 'ts', 'both'] as const) {
    const config = allToolsConfig({ toolSchema });
    const tools = buildToolDefinitions(config);
    const prompt = buildSystemPrompt(config, tools);
    const visible = `${prompt}\n${JSON.stringify(presentTools(tools, toolSchema))}`;
    assert.match(visible, /reply_to/);
    assert.doesNotMatch(
      visible,
      /replyTo|reply\.message_id|type\s*:\s*['"]reply['"]|不带 reply 引用/,
    );
    if (toolSchema !== 'json') {
      assert.match(prompt, /interface Message \{[^}]*reply_to\?: MessageId;/);
    }
  }
});

test('json mode keeps the capability-section prompt without declarations', () => {
  const config = allToolsConfig({ toolSchema: 'json' });
  const prompt = buildSystemPrompt(config);
  assert.doesNotMatch(prompt, /declare namespace tools/);
  assert.match(prompt, /观察边界：/);
  const declared = buildSystemPrompt({ ...config, toolSchema: 'ts' });
  assert.match(declared, /declare namespace tools \{/);
  assert.doesNotMatch(declared, /观察边界：/);
});
