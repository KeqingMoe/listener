import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  argumentsLine,
  collectNames,
  collectQuotes,
  partsText,
  resultProblem,
  segmentParts,
  structuredText,
  toolView,
} from '../../../src/dashboard/web/src/components/review/tool-summary.ts';
import { highlightJs } from '../../../src/dashboard/web/src/components/review/js-highlight.ts';

test('segments become typed parts without the reply marker', () => {
  const parts = segmentParts([
    { type: 'reply', message_id: '1' },
    { type: 'at', user_id: '100000001' },
    { type: 'text', text: '你好' },
    { type: 'text', text: '' },
    { type: 'face', id: 14, name: '微笑' },
    { type: 'face', id: 15 },
    { type: 'image', content_status: 'not_viewed' },
    { type: 'image', image_id: 'img_9_0', content_status: 'not_viewed' },
    { type: 'unsupported', kind: 'json' },
  ]);
  assert.deepEqual(
    parts.map((part) => part.kind),
    ['at', 'text', 'face', 'face', 'media', 'media', 'other'],
  );
  assert.equal(
    partsText(parts),
    '[@100000001]你好[微笑][表情15][图片][图片 img_9_0][json]',
  );
  assert.deepEqual(segmentParts(null), []);
});

test('at parts show the collected name and keep the id as a tooltip', () => {
  const names = new Map([['100000001', '群友甲']]);
  assert.deepEqual(
    segmentParts([{ type: 'at', user_id: '100000001' }], names),
    [{ kind: 'at', text: '@群友甲', title: '100000001' }],
  );
});

test('names come from messages, events and members, then the server fallback; card wins over nickname', () => {
  const names = collectNames(
    [
      {
        result: {
          messages: [{ userId: '1', nickname: '甲' }],
          events: [{ payload: { message: { userId: '2', nickname: '乙' } } }],
        },
      },
      { result: { members: [{ user_id: '3', nickname: '丙', card: '丙卡' }] } },
      { result: { member: { user_id: '4', nickname: '丁', card: '' } } },
      { result: { messages: [{ userId: '1', nickname: '甲后来' }] } },
      { result: 'not an object' },
    ],
    { 1: '甲旧名', 5: '戊' },
  );
  assert.deepEqual(
    [...names],
    [
      ['1', '甲'],
      ['2', '乙'],
      ['3', '丙卡'],
      ['4', '丁'],
      ['5', '戊'],
    ],
  );
});

test('send_message shows the outgoing parts and reply target', () => {
  assert.deepEqual(
    toolView(
      'send_message',
      { reply_to: '42', segments: [{ type: 'text', text: '收到' }] },
      { status: 'ok' },
    ),
    {
      kind: 'send',
      parts: [{ kind: 'text', text: '收到' }],
      reply: { messageId: '42', quote: null },
    },
  );
});

test('replies resolve to the quoted message one level deep', () => {
  const quotes = collectQuotes(
    [
      {
        result: {
          messages: [
            {
              messageId: '42',
              userId: '100000001',
              nickname: '本次名字',
              replyTo: '41',
              representation: 'segments',
              segments: [{ type: 'text', text: '原消息' }],
            },
          ],
        },
      },
    ],
    {
      42: { userId: '100000001', nickname: '服务端名字', text: '旧' },
      41: { userId: '100000002', nickname: '乙', text: '更早' },
    },
  );
  const view = toolView(
    'send_message',
    { reply_to: '42', segments: [{ type: 'text', text: '好' }] },
    { status: 'ok' },
    { quotes },
  );
  assert.equal(view?.kind, 'send');
  if (view?.kind !== 'send') {
    return;
  }
  assert.equal(view.reply?.quote?.who, '本次名字');
  assert.equal(partsText(view.reply!.quote!.parts), '原消息');
  assert.equal(view.reply?.quote?.reply?.quote, null);
});

test('model reply_to displays signed and zero targets without rewriting historical evidence', () => {
  const quotes = collectQuotes([], {
    '-42': { userId: '1', text: '负数目标' },
    '0': { userId: '2', text: '零目标' },
  });
  for (const replyTo of ['-42', '0']) {
    for (const field of ['reply_to', 'replyTo']) {
      const message = {
        userId: '3',
        [field]: replyTo,
        segments: [{ type: 'text', text: '回复正文' }],
      };
      const original = JSON.stringify(message);
      for (const [name, result] of [
        ['read_message', { message }],
        ['read_messages', { messages: [message] }],
        [
          'read_events',
          { events: [{ type: 'message.created', payload: { message } }] },
        ],
      ] as const) {
        const view = toolView(name, {}, result, { quotes });
        assert.equal(view?.kind, 'messages');
        if (view?.kind !== 'messages') {
          continue;
        }
        assert.equal(view.lines[0]?.reply?.messageId, replyTo);
        assert.equal(
          partsText(view.lines[0]!.reply!.quote!.parts),
          replyTo === '0' ? '零目标' : '负数目标',
        );
        assert.equal(JSON.stringify(message), original);
      }
    }
  }
});

test('read_messages lists speakers with ids, marks bot and recalled, and caps length', () => {
  const message = (i: number, extra = {}) => ({
    messageId: String(i),
    userId: '100000001',
    nickname: `群友${i}`,
    time: 0,
    representation: 'segments',
    segments: [{ type: 'text', text: `第${i}条` }],
    ...extra,
  });
  const view = toolView(
    'read_messages',
    { limit: 30 },
    {
      status: 'ok',
      messages: [
        message(0, { bot: true }),
        message(1, { recalled: true }),
        message(2, { representation: 'legacy_text', text: '旧文本' }),
        ...Array.from({ length: 22 }, (_, i) => message(i + 3)),
      ],
    },
  );
  assert.equal(view?.kind, 'messages');
  if (view?.kind !== 'messages') {
    return;
  }
  assert.equal(view.lines.length, 20);
  assert.equal(view.more, 5);
  assert.deepEqual(view.lines[0], {
    who: '群友0',
    userId: '100000001',
    parts: [{ kind: 'text', text: '第0条' }],
    bot: true,
  });
  assert.equal(view.lines[1]!.recalled, true);
  assert.equal(partsText(view.lines[2]!.parts), '旧文本');
});

test('read_events shows messages inline and other events by type and actor name', () => {
  const view = toolView(
    'read_events',
    { limit: 5 },
    {
      status: 'ok',
      events: [
        {
          type: 'message.created',
          payload: {
            message: {
              userId: '100000002',
              nickname: '群友',
              representation: 'segments',
              segments: [{ type: 'text', text: 'hi' }],
            },
          },
        },
        { type: 'poke.created', actor_id: '100000002', payload: null },
      ],
    },
    { names: new Map([['100000002', '群友']]) },
  );
  assert.deepEqual(view, {
    kind: 'messages',
    lines: [
      {
        who: '群友',
        userId: '100000002',
        parts: [{ kind: 'text', text: 'hi' }],
      },
      {
        who: '群友',
        userId: '100000002',
        parts: [{ kind: 'other', text: 'poke.created' }],
      },
    ],
    more: 0,
  });
});

test('unknown tools fall back to a compact argument line', () => {
  assert.equal(toolView('get_group_info', {}, {}), null);
  assert.equal(
    argumentsLine({ user_id: '1', limit: 5, nested: { a: 1 }, flag: true }),
    'user_id=1 limit=5 nested flag=true',
  );
  assert.equal(
    argumentsLine({ image_ids: ['img_1_0', 'img_2_0'], items: [{ a: 1 }] }),
    'image_ids=img_1_0,img_2_0 items',
  );
  assert.equal(argumentsLine({ text: 'x'.repeat(200) }, 20).length, 20);
  assert.equal(argumentsLine(null), '');
});

test('result problems preserve errors without treating accepted or pending states as failures', () => {
  assert.equal(resultProblem({ status: 'ok' }), null);
  assert.equal(resultProblem('text'), null);
  assert.equal(
    resultProblem({ status: 'error', error: 'invalid_arguments' }),
    'error: invalid_arguments',
  );
  for (const status of [
    'confirmation_required',
    'staged',
    'executed',
    'submitted',
    'duplicate',
    'success',
  ]) {
    assert.equal(resultProblem({ status }), null);
  }
  assert.equal(
    resultProblem({ status: 'unknown', error: 'delivery_unknown' }),
    'unknown: delivery_unknown',
  );
  // 转为后台任务不是失败。
  assert.equal(resultProblem({ status: 'pending', job_id: 'js_1' }), null);
});

test('action summaries describe requests, not completed external effects', () => {
  for (const result of [
    null,
    { status: 'error' },
    { status: 'unknown' },
    { status: 'ok', submitted: true },
  ]) {
    assert.deepEqual(toolView('poke_member', { user_id: '11' }, result), {
      kind: 'line',
      text: '戳一戳 11',
    });
    assert.deepEqual(
      toolView(
        'react_message',
        { message_id: 'm', emoji_id: 'e', action: 'add' },
        result,
      ),
      { kind: 'line', text: '添加回应 e → 消息 m' },
    );
    assert.deepEqual(
      toolView(
        'react_message',
        { message_id: 'm', emoji_id: 'e', action: 'remove' },
        result,
      ),
      { kind: 'line', text: '撤回回应 e → 消息 m' },
    );
  }
});

const budget = {
  max_tool_calls: 8,
  used_tool_calls: 1,
  remaining_tool_calls: 7,
  remaining_ms: 1000,
};

test('execute_javascript shows code, raw string value and sandbox tool calls', () => {
  const view = toolView(
    'execute_javascript',
    {
      description: '画一只椰子',
      code: 'return "ok";',
      mode: 'sync',
      wait_ms: 5000,
    },
    {
      job_id: 'js_1',
      value: '  *  \n *** ',
      logs: ['step 1'],
      tool_calls: {
        counts: { create_image: { ok: 1 }, view_images: { ok: 2, error: 1 } },
        abnormal: [],
        abnormal_omitted: 0,
      },
      status: 'ok',
      task_status: 'completed',
      wake_budget: budget,
    },
  );
  assert.deepEqual(view, {
    kind: 'script',
    code: 'return "ok";',
    description: '画一只椰子',
    mode: '同步',
    outcome: { kind: 'value', text: '  *  \n *** ' },
    calls: [
      { text: 'create_image ×1', status: 'ok', abnormal: false },
      { text: 'view_images ×2', status: 'ok', abnormal: false },
      { text: 'view_images error ×1', status: 'error', abnormal: true },
    ],
    logs: ['step 1'],
  });
});

test('execute_javascript distinguishes pending jobs and failures', () => {
  const pending = toolView(
    'execute_javascript',
    { description: 'd', code: 'x', mode: 'async' },
    { status: 'pending', job_id: 'js_2', wake_budget: budget },
  );
  assert.equal(pending?.kind, 'script');
  assert.deepEqual(pending?.kind === 'script' && pending.outcome, {
    kind: 'pending',
    jobId: 'js_2',
  });
  const failed = toolView(
    'execute_javascript',
    { description: 'd', code: 'x', mode: 'sync' },
    {
      job_id: 'js_3',
      error: 'execution_error',
      logs: [],
      diagnostic: {
        name: 'TypeError',
        message: 'x is not a function',
        stack: 'TypeError: x is not a function\n    at main',
        truncated: false,
        kind: 'guest_exception',
        phase: 'execute',
      },
      status: 'error',
      task_status: 'failed',
    },
  );
  assert.deepEqual(failed?.kind === 'script' && failed.outcome, {
    kind: 'error',
    message: 'TypeError: x is not a function',
    stack: 'TypeError: x is not a function\n    at main',
  });
  const contract = toolView(
    'execute_javascript',
    { code: 'x' },
    { error: 'invalid_log_type', status: 'error', task_status: 'failed' },
  );
  assert.deepEqual(contract?.kind === 'script' && contract.outcome, {
    kind: 'error',
    message: 'invalid_log_type',
    stack: '',
  });
});

test('query_javascript_jobs shows the queried job without code, in either field naming', () => {
  for (const job of [
    {
      job_id: 'js_4',
      description: '旋转',
      mode: 'async',
      status: 'completed',
      value: '{"a":1}',
      tool_calls: { counts: { send_group_image: { ok: 1 } } },
    },
    {
      jobId: 'js_4',
      description: '旋转',
      mode: 'async',
      status: 'completed',
      value: '{"a":1}',
      toolCalls: { counts: { send_group_image: { ok: 1 } } },
    },
  ]) {
    assert.deepEqual(
      toolView(
        'query_javascript_jobs',
        { job_id: 'js_4' },
        { status: 'ok', job },
      ),
      {
        kind: 'script',
        code: null,
        description: '旋转',
        mode: '异步',
        outcome: { kind: 'value', text: '{"a":1}' },
        calls: [{ text: 'send_group_image ×1', status: 'ok', abnormal: false }],
        logs: [],
      },
    );
  }
  assert.deepEqual(
    toolView('query_javascript_jobs', {}, { status: 'ok', jobs: [{}, {}] }),
    { kind: 'line', text: '列出 2 个任务' },
  );
});

test('sandbox counters keep status distinctions and do not fabricate counts from malformed fields', () => {
  const view = toolView(
    'execute_javascript',
    {},
    {
      tool_calls: {
        counts: {
          known: {
            ok: 2,
            error: 1,
            unknown: 3,
            confirmation_required: 1,
            future: 1,
            bad: '4',
            zero: 0,
            negative: -1,
            fraction: 1.5,
            overflow: Number.MAX_SAFE_INTEGER + 1,
            '': 2,
          },
          ' ': { error: 3 },
          invalid: [],
        },
      },
    },
  );
  assert.equal(view?.kind, 'script');
  if (view?.kind === 'script') {
    assert.deepEqual(
      view.calls.map((call) => [call.status, call.abnormal]),
      [
        ['ok', false],
        ['error', true],
        ['unknown', true],
        ['confirmation_required', true],
        ['future', true],
      ],
    );
    assert.equal(view.calls.length, 5);
  }
});

test('only whole JSON objects or arrays are treated as structured return values', () => {
  assert.deepEqual(structuredText(' {"a":[1]} '), { a: [1] });
  assert.deepEqual(structuredText('[1,2]'), [1, 2]);
  // 标量、普通文本和夹着JSON的文本都按原文展示。
  for (const text of [
    '123456789123',
    '"hi"',
    'true',
    'null',
    '  *  \n ***',
    'x\n{"fish":42}',
    '{broken',
    '',
  ]) {
    assert.equal(structuredText(text), null, text);
  }
});

test('javascript highlighting keeps the exact source text', () => {
  const code = [
    '// 注释',
    'const s = `a ${b} c`; /* 块 */',
    "let n = 0x1f + 3.5e2 + 10n, t = 'it\\'s', u = \"q\";",
    'if (x === null) return undefined;',
    'const unterminated = "oops',
  ].join('\n');
  const tokens = highlightJs(code);
  assert.equal(tokens.map((t) => t.text).join(''), code);
  const kinds = (kind: string) =>
    tokens.filter((t) => t.kind === kind).map((t) => t.text.trim());
  assert.ok(kinds('comment').includes('// 注释'));
  assert.ok(kinds('keyword').some((t) => t.startsWith('const')));
  assert.ok(kinds('string').includes('`a ${b} c`'));
  assert.ok(kinds('number').includes('0x1f'));
  assert.ok(kinds('number').includes('10n'));
  assert.ok(kinds('literal').includes('null'));
  // 标识符中包含关键字片段时不着色。
  assert.ok(!highlightJs('constant').some((t) => t.kind === 'keyword'));
});
