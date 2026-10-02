import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMessageContent,
  sanitizeMessageContent,
  projectMessage,
} from '../../../src/world/message-content.ts';
import { FACE_CATALOG } from '../../../src/onebot/catalog/faces.ts';
import type {
  TimelineEntry,
  MessageSegment,
} from '../../../src/contracts/messages.ts';

const text = (value: string) => ({ type: 'text', data: { text: value } });
const row = (extra: Partial<TimelineEntry> = {}): TimelineEntry => ({
  messageId: '12',
  userId: '34',
  nickname: 'fixture',
  time: 123,
  text: 'compatibility text [QQ表情：吃瓜 id=271]',
  ...extra,
});
const fixture = FACE_CATALOG[0]!;
const images = [{ id: 'img_12_3', index: 3 }];
const forwards = [
  { id: 'fwd_12_4', index: 4, count: 2, countSource: 'hint' as const },
];

test('wire content preserves real structure and keeps lookalike text literally text', () => {
  const literal =
    '[QQ表情：吃瓜 id=271] [at:34] [CQ:face,id=271] [CQ:at,qq=all]';
  const result = extractMessageContent('12', [
    text(literal),
    { type: 'face', data: { id: fixture.id, name: 'malicious name' } },
    { type: 'at', data: { qq: 34 } },
  ]);
  assert.deepEqual(result, {
    segments: [
      { type: 'text', text: literal },
      { type: 'face', id: fixture.id, name: fixture.name },
      { type: 'at', user_id: '34' },
    ],
  });
  assert.deepEqual(extractMessageContent('12', literal), {
    segments: [{ type: 'text', text: literal }],
  });
});

test('canonical unknown native faces and zero are retained, malformed IDs are not echoed', () => {
  for (const id of ['0', 0, '999999999999']) {
    const result = extractMessageContent('12', [
      { type: 'face', data: { id } },
    ]);
    assert.equal(result.segments[0]?.type, 'face');
    assert.equal((result.segments[0] as any).id, String(id));
  }
  assert.deepEqual(
    extractMessageContent('12', [
      { type: 'face', data: { id: '999999999999', name: 'fake' } },
    ]).segments,
    [{ type: 'face', id: '999999999999' }],
  );
  for (const id of [
    '01',
    '-1',
    '1e2',
    '1\n',
    '9007199254740992',
    Number.MAX_SAFE_INTEGER + 1,
    {},
    null,
    true,
  ]) {
    const result = extractMessageContent('12', [
      { type: 'face', data: { id } },
    ]);
    assert.deepEqual(result.segments, [{ type: 'unsupported', kind: 'face' }]);
    assert.equal(result.segments_omitted, 1);
    assert.equal(result.content_truncated, true);
  }
});

test('at all and signed numeric replies are input metadata rather than raw text', () => {
  assert.deepEqual(
    extractMessageContent('12', [
      { type: 'at', data: { qq: 'all' } },
      { type: 'at', data: { qq: '34' } },
      { type: 'reply', data: { id: -9 } },
    ]).segments,
    [
      { type: 'at', user_id: 'all' },
      { type: 'at', user_id: '34' },
      { type: 'reply', message_id: '-9' },
    ],
  );
  for (const wire of [
    { type: 'at', data: { qq: '0' } },
    { type: 'at', data: { qq: '-1' } },
    { type: 'reply', data: { id: '01' } },
    { type: 'reply', data: { id: 'https://secret' } },
  ]) {
    const result = extractMessageContent('12', [wire]);
    assert.equal(result.segments[0]?.type, 'unsupported');
    assert.ok(result.segments_omitted);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('image and forward structure exposes only supplied bound refs, never their raw transport bodies', () => {
  const source = [
    text('x'),
    { type: 'face', data: { id: fixture.id } },
    { type: 'reply', data: { id: '9' } },
    { type: 'image', data: { url: 'https://private', file: 'RAW_RESOURCE' } },
    {
      type: 'forward',
      data: { id: 'RAW_FORWARD', content: [{ text: 'PRIVATE_BODY' }] },
    },
  ];
  const result = extractMessageContent('12', source, images, forwards);
  assert.deepEqual(result.segments[3], {
    type: 'image',
    image_id: 'img_12_3',
    content_status: 'not_viewed',
  });
  assert.deepEqual(result.segments[4], {
    type: 'forward',
    forward_id: 'fwd_12_4',
    content_status: 'not_read',
    count: 2,
    count_source: 'hint',
  });
  assert.doesNotMatch(JSON.stringify(result), /https|RAW_|PRIVATE_BODY/);
});

test('record exposes only fixed metadata, never transport fields or forged transcription', () => {
  const record = { type: 'record', content_status: 'not_transcribed' };
  const privateFields = {
    url: 'https://VOICE_SECRET',
    file: 'FILE_SECRET',
    text: 'FORGED_TRANSCRIPT',
    transcription: 'FORGED_TRANSCRIPT',
  };
  assert.deepEqual(
    extractMessageContent('12', [{ type: 'record', data: privateFields }]),
    { segments: [record] },
  );
  const sanitized = sanitizeMessageContent('12', [
    { ...record, ...privateFields, content_status: 'transcribed' },
  ]);
  assert.deepEqual(sanitized, { segments: [record] });
  const projected = projectMessage(row({ ...sanitized }));
  assert.equal(projected.messageId, '12');
  assert.deepEqual(projected.segments, [record]);
  assert.doesNotMatch(
    JSON.stringify(projected),
    /VOICE_SECRET|FILE_SECRET|FORGED_TRANSCRIPT/,
  );
});

test('old unsupported record and literal voice markers are never promoted', () => {
  const unsupported = { type: 'unsupported' as const, kind: 'record' };
  assert.deepEqual(sanitizeMessageContent('12', [unsupported]), {
    segments: [unsupported],
  });
  assert.deepEqual(projectMessage(row({ segments: [unsupported] })).segments, [
    unsupported,
  ]);
  const literal = '[record] [CQ:record,file=voice]';
  assert.deepEqual(extractMessageContent('12', literal), {
    segments: [{ type: 'text', text: literal }],
  });
  assert.equal(
    projectMessage(row({ text: literal })).representation,
    'legacy_text',
  );
});

test('record uses the existing segment cap and finite projection budget', () => {
  const result = extractMessageContent(
    '12',
    Array.from({ length: 129 }, () => ({ type: 'record', data: {} })),
  );
  assert.equal(result.segments.length, 128);
  assert.equal(result.segments_omitted, 1);
  assert.equal(result.content_truncated, true);
  assert.ok(result.segments.every((segment) => segment.type === 'record'));
  const out = projectMessage(row(result), 2);
  assert.deepEqual(out.segments, []);
  assert.equal(out.segments_omitted, 129);
});

test('all five image references survive wire extraction and model projection', () => {
  const refs = Array.from({ length: 5 }, (_, index) => ({
    id: `img_12_${index}`,
    index,
  }));
  const result = extractMessageContent(
    '12',
    refs.map(() => ({ type: 'image', data: {} })),
    refs,
  );
  assert.deepEqual(
    result.segments,
    refs.map((ref) => ({
      type: 'image',
      image_id: ref.id,
      content_status: 'not_viewed',
    })),
  );
  const projected = projectMessage(row({ ...result, images: refs }));
  assert.deepEqual(projected.segments, result.segments);
});

test('JSON cards use only matched pre-extracted refs and unavailable media stays explicitly unread', () => {
  const card = { type: 'json', data: { data: 'PRIVATE_JSON_BODY' } };
  assert.deepEqual(
    extractMessageContent(
      '12',
      [card],
      [],
      [{ id: 'fwd_12_0', index: 0, count: 3, countSource: 'verified' }],
    ).segments,
    [
      {
        type: 'forward',
        forward_id: 'fwd_12_0',
        content_status: 'not_read',
        count: 3,
        count_source: 'verified',
      },
    ],
  );
  assert.equal(
    extractMessageContent('12', [card]).segments[0]?.type,
    'unsupported',
  );
  assert.deepEqual(
    extractMessageContent('12', [
      { type: 'image', data: {} },
      { type: 'forward', data: { id: 'https://raw' } },
    ]).segments,
    [
      {
        type: 'image',
        content_status: 'not_viewed',
        reason: 'reference_unavailable',
      },
      {
        type: 'forward',
        content_status: 'not_read',
        reason: 'reference_unavailable',
      },
    ],
  );
});

test('refs must match current message, exact index and canonical safe ID', () => {
  for (const ref of [
    { id: 'img_99_0', index: 0 },
    { id: 'img_12_0', index: 1 },
    { id: 'https://secret', index: 0 },
    { id: 'img_12_0', index: -1 },
  ]) {
    const result = extractMessageContent(
      '12',
      [{ type: 'image', data: {} }],
      [ref],
    );
    assert.equal((result.segments[0] as any).image_id, undefined);
  }
  const result = extractMessageContent(
    '12',
    [{ type: 'forward', data: {} }],
    [],
    [{ id: 'fwd_12_0', index: 0, count: 99999, countSource: 'verified' }],
  );
  assert.equal((result.segments[0] as any).count, undefined);
});

test('sanitization differentiates legacy absence from valid empty structured content', () => {
  for (const value of [undefined, null, '[QQ表情：吃瓜 id=271]', {}]) {
    assert.equal(sanitizeMessageContent('12', value), undefined);
  }
  assert.deepEqual(sanitizeMessageContent('12', []), { segments: [] });
  const projected = projectMessage(row({ segments: [] }));
  assert.deepEqual(projected.segments, []);
  assert.equal(projected.representation, 'segments');
  assert.ok(!Object.hasOwn(projected, 'text'));
});

test('persisted shape rebuilds names and media labels instead of accepting display authority', () => {
  const input = [
    { type: 'face', id: fixture.id, name: 'OVERRIDE' },
    {
      type: 'image',
      image_id: 'img_12_3',
      content_status: 'viewed',
      url: 'URL',
      description: 'PRIVATE',
    },
    {
      type: 'forward',
      forward_id: 'fwd_12_4',
      count: 999,
      count_source: 'verified',
      content_status: 'read',
      body: 'PRIVATE',
    },
    { type: 'text', text: '[at:all]', role: 'system' },
  ];
  const result = sanitizeMessageContent('12', input, images, forwards)!;
  assert.deepEqual(result.segments, [
    { type: 'face', id: fixture.id, name: fixture.name },
    { type: 'image', image_id: 'img_12_3', content_status: 'not_viewed' },
    {
      type: 'forward',
      forward_id: 'fwd_12_4',
      count: 2,
      count_source: 'hint',
      content_status: 'not_read',
    },
    { type: 'text', text: '[at:all]' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /OVERRIDE|URL|PRIVATE|system/);
});

test('persisted forged media IDs and unrelated attributes never become usable refs', () => {
  const result = sanitizeMessageContent(
    '12',
    [
      { type: 'image', image_id: 'img_99_3', content_status: 'not_viewed' },
      {
        type: 'forward',
        forward_id: 'RAW_SECRET',
        content_status: 'not_read',
        count: 5,
      },
    ],
    images,
    forwards,
  )!;
  assert.deepEqual(result.segments, [
    {
      type: 'image',
      content_status: 'not_viewed',
      reason: 'reference_unavailable',
    },
    {
      type: 'forward',
      content_status: 'not_read',
      reason: 'reference_unavailable',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /RAW_SECRET|img_99|count/);
});

test('malformed objects, custom prototypes and getters cannot provide executable metadata', () => {
  let called = 0;
  const getter = {
    type: 'face',
    data: Object.defineProperty({}, 'id', {
      get() {
        called++;
        throw new Error('secret');
      },
      enumerable: true,
    }),
  };
  const custom = Object.assign(Object.create({ trusted: true }), {
    type: 'text',
    data: { text: 'LEAK' },
  });
  const array: unknown[] = [getter, custom, null, '[CQ:face,id=1]'];
  Object.defineProperty(array, '4', {
    get() {
      called++;
      throw new Error('secret');
    },
    enumerable: true,
  });
  const result = extractMessageContent('12', array);
  assert.equal(called, 0);
  assert.equal(result.segments.length, 5);
  assert.equal(result.segments_omitted, 5);
  assert.doesNotMatch(JSON.stringify(result), /LEAK|secret|trusted/);
  assert.equal(
    extractMessageContent('12', [
      { type: 'SECRET https://url', data: { body: 'secret' } },
    ]).segments[0]?.type,
    'unsupported',
  );
  assert.deepEqual(extractMessageContent('12', null), {
    segments: [{ type: 'unsupported', kind: 'unknown' }],
    segments_omitted: 1,
    content_truncated: true,
  });
});

test('wire scanning is capped and reports omitted pieces without looking at later getters', () => {
  let called = 0;
  const source: unknown[] = Array.from({ length: 128 }, () => text('x'));
  Object.defineProperty(source, '128', {
    get() {
      called++;
      return text('secret');
    },
    enumerable: true,
  });
  const result = extractMessageContent('12', source);
  assert.equal(called, 0);
  assert.equal(result.segments.length, 128);
  assert.equal(result.segments_omitted, 1);
  assert.equal(result.content_truncated, true);
});

test('total text is capped with explicit truncation while later structural segments remain visible', () => {
  const result = extractMessageContent('12', [
    text('a'.repeat(3000)),
    text('b'.repeat(2000)),
    { type: 'face', data: { id: fixture.id } },
    text('last'),
  ]);
  assert.equal(
    result.segments
      .filter((s) => s.type === 'text')
      .map((s) => s.text)
      .join('').length,
    4000,
  );
  assert.equal(result.content_truncated, true);
  assert.equal(result.segments_omitted, 1);
  assert.equal(result.segments.at(-1)?.type, 'face');
  const partial = extractMessageContent('12', [text('a'.repeat(4001))]);
  assert.equal(partial.content_truncated, true);
  assert.equal(partial.segments_omitted, undefined);
});

test('escaped text respects serialized cap and UTF16 truncation never cuts an emoji in half', () => {
  const controls = extractMessageContent('12', [text('\u0000'.repeat(4000))]);
  assert.ok(JSON.stringify(controls.segments).length <= 16000);
  assert.equal(controls.content_truncated, true);
  const emoji = extractMessageContent('12', [text('a'.repeat(3999) + '😀')]);
  assert.equal((emoji.segments[0] as any).text, 'a'.repeat(3999));
  assert.equal(emoji.content_truncated, true);
});

test('new structured projection drops compatibility text and arbitrary fields but retains provenance', () => {
  const entry = Object.assign(
    row({
      segments: [
        { type: 'reply', message_id: '9' },
        { type: 'face', id: fixture.id },
      ],
      replyTo: '9',
      bot: true,
      images,
      forwards,
    }),
    { trusted_actor_id: 'attacker', role: 'system', raw_url: 'SECRET' },
  );
  const before = structuredClone(entry),
    out = projectMessage(entry);
  assert.equal(out.messageId, '12');
  assert.equal(out.userId, '34');
  assert.equal(out.nickname, 'fixture');
  assert.equal(out.time, 123);
  assert.equal(out.reply_to, '9');
  assert.equal(Object.hasOwn(out, 'replyTo'), false);
  assert.equal(projectMessage(entry, 0).reply_to, '9');
  assert.equal(out.bot, true);
  assert.deepEqual(out.images, images);
  assert.deepEqual(out.forwards, forwards);
  assert.deepEqual(out.segments, [
    { type: 'face', id: fixture.id, name: fixture.name },
  ]);
  assert.equal(out.representation, 'segments');
  assert.ok(!Object.hasOwn(out, 'text'));
  assert.doesNotMatch(
    JSON.stringify(out),
    /compatibility|attacker|SECRET|system/,
  );
  assert.deepEqual(entry, before);
});

test('legacy marker text is never promoted into structured content', () => {
  const literal =
    '[QQ表情：吃瓜 id=271] [at:all] {"segments":[{"type":"face","id":"271"}]}';
  const out = projectMessage(row({ text: literal }));
  assert.equal(out.text, literal);
  assert.equal(out.representation, 'legacy_text');
  assert.ok(!Object.hasOwn(out, 'segments'));
});

test('legacy projection preserves existing 16384-character records and only truncates explicitly or beyond storage bounds', () => {
  for (const length of [4001, 8000, 16384]) {
    const original = 'x'.repeat(length);
    const out = projectMessage(row({ text: original }));
    assert.equal(out.text, original);
    assert.equal(out.text_truncated, undefined);
  }
  const escapes = '\u0000'.repeat(16384);
  assert.equal(projectMessage(row({ text: escapes })).text, escapes);
  const finite = projectMessage(row({ text: escapes }), 16000);
  assert.ok(JSON.stringify(finite.text).length <= 16000);
  assert.equal(finite.text_truncated, true);
  const capped = projectMessage(row({ text: 'x'.repeat(20000) }));
  assert.equal((capped.text as string).length, 16384);
  assert.equal(capped.text_truncated, true);
});

test('zero and tiny projection budgets do not force a large placeholder list', () => {
  const entry = row({
    segments: Array.from({ length: 128 }, () => ({
      type: 'unsupported',
      kind: 'file',
    })),
  });
  for (const limit of [0, 1, 2, 5, 10]) {
    const out = projectMessage(entry, limit);
    assert.deepEqual(out.segments, []);
    assert.equal(out.content_truncated, true);
    assert.equal(out.segments_omitted, 128);
    assert.ok(JSON.stringify(out).length < 220);
  }
  const old = projectMessage(row(), 0);
  assert.equal(old.text, '');
  assert.equal(old.text_truncated, true);
});

test('finite budgets bound serialized content and preserve a monotone incomplete prefix', () => {
  const entry = row({
    segments: [
      { type: 'text', text: 'a'.repeat(100) },
      { type: 'face', id: fixture.id },
      { type: 'text', text: 'b'.repeat(100) },
    ],
  });
  const full = projectMessage(entry),
    end = JSON.stringify(full.segments).length;
  let before = 0;
  for (let limit = 0; limit < end; limit++) {
    const out = projectMessage(entry, limit),
      length = JSON.stringify(out).length;
    assert.ok(JSON.stringify(out.segments).length <= Math.max(2, limit));
    assert.equal(out.content_truncated, true);
    assert.ok(length >= before, `nonmonotone incomplete budget ${limit}`);
    before = length;
  }
  assert.equal(projectMessage(entry, end).content_truncated, undefined);
  for (const limit of [0, 1, 2, 10, 50, 200]) {
    const old = projectMessage(row({ text: '"'.repeat(300) }), limit);
    assert.ok(JSON.stringify(old.text).length <= Math.max(2, limit));
    assert.equal(old.text_truncated, true);
  }
});

test('maximal structured projection serializes each segment only a constant number of times', () => {
  const count = 128,
    entry = row({
      segments: Array.from({ length: count }, () => ({
        type: 'unsupported',
        kind: 'file',
      })),
    });
  const stringify = JSON.stringify;
  let visits = 0;
  try {
    JSON.stringify = ((value: unknown, ...args: unknown[]) => {
      if (Array.isArray(value)) {
        visits += value.filter(
          (item) => item && typeof item === 'object' && 'type' in item,
        ).length;
      } else if (value && typeof value === 'object' && 'type' in value) {
        visits++;
      }
      return Reflect.apply(stringify, JSON, [value, ...args]);
    }) as typeof JSON.stringify;
    const out = projectMessage(entry);
    assert.equal((out.segments as unknown[]).length, count);
  } finally {
    JSON.stringify = stringify;
  }
  assert.ok(
    visits <= 2 * count + 4,
    `serialization visited ${visits} segments for ${count} inputs`,
  );
});

test('persisted omission and truncation flags survive sanitization and further projection', () => {
  const entry = row({
    segments: [
      { type: 'text', text: 'abc' },
      { type: 'face', id: fixture.id },
    ],
    segments_omitted: 7,
    content_truncated: true,
  });
  const full = projectMessage(entry);
  assert.equal(full.segments_omitted, 7);
  assert.equal(full.content_truncated, true);
  assert.equal(projectMessage(entry, 0).segments_omitted, 9);
  const damaged = row({
    segments: [{ type: 'face', id: 'bad' }] as MessageSegment[],
    segments_omitted: 2,
  });
  assert.equal(projectMessage(damaged).segments_omitted, 3);
});
