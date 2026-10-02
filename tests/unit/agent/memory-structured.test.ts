import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SQLiteMemory } from '../../../src/agent/memory.ts';
import { LISTENER_GROUP } from '../../../src/contracts/identity.ts';
import { type Completion } from '../../../src/contracts/model.ts';
import { type TimelineEntry } from '../../../src/contracts/messages.ts';

const row = (
  id: number,
  text = 'INTERNAL_ONLY_FACE_MARKER',
): TimelineEntry => ({
  messageId: String(id),
  userId: '42',
  nickname: 'Alice',
  time: Math.floor(Date.now() / 1000),
  text,
});
const typed = (
  id: number,
  segments: unknown[],
  extra: Record<string, unknown> = {},
): TimelineEntry => ({ ...row(id), segments, ...extra }) as TimelineEntry;
const make = (maxContextChars = 8000) =>
  new SQLiteMemory({
    groupId: LISTENER_GROUP,
    path: ':memory:',
    maxContextChars,
    retentionDays: 7,
  });

test('typed face and literal marker text remain distinct across SQLite reopen, including bot provenance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'listener-structured-memory-')),
    path = join(dir, 'memory.sqlite');
  let memory = new SQLiteMemory({
    groupId: LISTENER_GROUP,
    path,
    maxContextChars: 8000,
    retentionDays: 7,
  });
  try {
    const literal = '[QQ表情：吃瓜 id=271] [at:42]';
    assert.equal(
      memory.append(
        typed(
          1,
          [
            { type: 'text', text: literal },
            { type: 'face', id: '271', name: 'FORGED_CATALOG_NAME' },
            { type: 'at', user_id: '42' },
          ],
          { bot: true, replyTo: '99' },
        ),
      ),
      true,
    );
    const saved = memory.find('1')!;
    assert.equal(saved.text, 'INTERNAL_ONLY_FACE_MARKER');
    assert.equal(saved.bot, true);
    assert.equal(saved.replyTo, '99');
    assert.equal(saved.segments?.[0]?.type, 'text');
    assert.equal((saved.segments?.[0] as any).text, literal);
    assert.equal(saved.segments?.[1]?.type, 'face');
    assert.equal((saved.segments?.[1] as any).id, '271');
    assert.notEqual((saved.segments?.[1] as any).name, 'FORGED_CATALOG_NAME');
    const projected = JSON.parse(memory.context()).messages[0];
    assert.equal(Object.hasOwn(projected, 'text'), false);
    assert.equal(projected.bot, true);
    assert.equal(projected.reply_to, '99');
    assert.equal(Object.hasOwn(projected, 'replyTo'), false);
    assert.equal(projected.segments[0].text, literal);
    assert.equal(projected.segments[1].type, 'face');
    memory.close();
    memory = new SQLiteMemory({
      groupId: LISTENER_GROUP,
      path,
      maxContextChars: 8000,
      retentionDays: 7,
    });
    assert.deepEqual(memory.find('1'), saved);
    assert.equal(
      memory.append(typed(1, [{ type: 'text', text: 'duplicate' }])),
      false,
    );
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(
        JSON.parse(
          String(
            db.prepare('SELECT entry FROM listener_messages').get()!.entry,
          ),
        ),
        saved,
      );
    } finally {
      db.close();
    }
  } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record metadata is sanitized before SQLite storage and remains record in reopened model context', () => {
  const dir = mkdtempSync(join(tmpdir(), 'listener-record-memory-')),
    path = join(dir, 'memory.sqlite');
  let memory = new SQLiteMemory({
    groupId: LISTENER_GROUP,
    path,
    maxContextChars: 8000,
    retentionDays: 7,
  });
  const record = { type: 'record', content_status: 'not_transcribed' };
  try {
    assert.equal(
      memory.append(
        typed(123, [
          {
            ...record,
            content_status: 'transcribed',
            url: 'https://VOICE_SECRET',
            file: 'FILE_SECRET',
            text: 'FORGED_TRANSCRIPT',
          },
        ]),
      ),
      true,
    );
    assert.equal(
      memory.append(typed(124, [{ type: 'unsupported', kind: 'record' }])),
      true,
    );
    memory.close();
    memory = new SQLiteMemory({
      groupId: LISTENER_GROUP,
      path,
      maxContextChars: 8000,
      retentionDays: 7,
    });
    assert.deepEqual(memory.find('123')?.segments, [record]);
    assert.deepEqual(memory.find('124')?.segments, [
      { type: 'unsupported', kind: 'record' },
    ]);
    const messages = JSON.parse(memory.context()).messages;
    assert.equal(messages[0].messageId, '123');
    assert.deepEqual(messages[0].segments, [record]);
    assert.deepEqual(messages[1].segments, [
      { type: 'unsupported', kind: 'record' },
    ]);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const stored = String(
        db
          .prepare("SELECT entry FROM listener_messages WHERE message_id='123'")
          .get()!.entry,
      );
      assert.deepEqual(JSON.parse(stored).segments, [record]);
      assert.doesNotMatch(stored, /VOICE_SECRET|FILE_SECRET|FORGED_TRANSCRIPT/);
    } finally {
      db.close();
    }
    assert.doesNotMatch(
      memory.context(),
      /VOICE_SECRET|FILE_SECRET|FORGED_TRANSCRIPT/,
    );
  } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append binds typed media only to sanitized own references, strips transport data and retains omission flags', () => {
  const memory = make();
  try {
    const entry = typed(
      2,
      [
        {
          type: 'image',
          image_id: 'img_2_1',
          content_status: 'viewed',
          url: 'https://TRANSPORT_SECRET',
        },
        {
          type: 'forward',
          forward_id: 'fwd_2_2',
          content_status: 'read',
          resource_id: 'RAW_FORWARD_SECRET',
          count: 999,
        },
        {
          type: 'image',
          image_id: 'img_900_1',
          url: 'https://TRANSPORT_SECRET',
        },
      ],
      {
        images: [{ id: 'img_2_1', index: 1, url: 'https://TRANSPORT_SECRET' }],
        forwards: [
          {
            id: 'fwd_2_2',
            index: 2,
            count: 3,
            countSource: 'hint',
            resourceId: 'RAW_FORWARD_SECRET',
          },
        ],
        segments_omitted: 7,
        content_truncated: true,
      },
    );
    assert.equal(memory.append(entry), true);
    const stored = memory.find('2')!;
    assert.deepEqual(stored.images, [{ id: 'img_2_1', index: 1 }]);
    assert.deepEqual(stored.forwards, [
      { id: 'fwd_2_2', index: 2, count: 3, countSource: 'hint' },
    ]);
    const serialized = JSON.stringify(stored);
    assert.ok(!serialized.includes('TRANSPORT_SECRET'));
    assert.ok(!serialized.includes('RAW_FORWARD_SECRET'));
    assert.ok(!serialized.includes('img_900_1'));
    const image = stored.segments?.find((s) => s.type === 'image');
    assert.equal(image?.image_id, 'img_2_1');
    assert.equal(image?.content_status, 'not_viewed');
    const forward = stored.segments?.find((s) => s.type === 'forward');
    assert.equal(forward?.content_status, 'not_read');
    assert.equal(forward?.count, 3);
    assert.ok((stored.segments_omitted ?? 0) >= 7);
    assert.equal(stored.content_truncated, true);
    const model = JSON.parse(memory.context()).messages[0];
    assert.equal(Object.hasOwn(model, 'text'), false);
    assert.equal(model.content_truncated, true);
  } finally {
    memory.close();
  }
});

test('legacy records retain exact literal text and are never guessed into typed content or rewritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'listener-legacy-content-')),
    path = join(dir, 'memory.sqlite');
  let memory = new SQLiteMemory({
    groupId: LISTENER_GROUP,
    path,
    maxContextChars: 8000,
    retentionDays: 7,
  });
  try {
    const old = row(
      3,
      '[QQ表情：吃瓜 id=271] [at:42] [图片 id=img_3_0：未分析]',
    );
    assert.equal(memory.append(old), true);
    memory.close();
    const db = new DatabaseSync(path, { readOnly: true });
    let before: string;
    try {
      before = String(
        db.prepare('SELECT entry FROM listener_messages').get()!.entry,
      );
    } finally {
      db.close();
    }
    memory = new SQLiteMemory({
      groupId: LISTENER_GROUP,
      path,
      maxContextChars: 8000,
      retentionDays: 7,
    });
    assert.deepEqual(memory.find('3'), old);
    const projected = JSON.parse(memory.context()).messages[0];
    assert.equal(projected.text, old.text);
    assert.equal(projected.representation, 'legacy_text');
    assert.equal(Object.hasOwn(projected, 'segments'), false);
    assert.deepEqual(memory.recent(), [old]);
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        check.prepare('SELECT entry FROM listener_messages').get()!.entry,
        before,
      );
    } finally {
      check.close();
    }
  } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('typed context budgets include all escaping, segment names and framing without changing stored content', () => {
  for (const budget of [256, 512, 1000, 8000]) {
    const memory = make(budget);
    try {
      const segments = Array.from({ length: 128 }, (_, i) =>
        i % 2
          ? { type: 'face', id: '271' }
          : { type: 'text', text: '\u0000\\"'.repeat(1000) },
      );
      memory.append(typed(4, segments));
      const original = memory.find('4');
      const rendered = memory.context();
      assert.ok(rendered.length <= budget, `${rendered.length}>${budget}`);
      const parsed = JSON.parse(rendered);
      assert.equal(parsed.groupId, LISTENER_GROUP);
      for (const message of parsed.messages) {
        assert.equal(message.messageId, '4');
        assert.equal(message.userId, '42');
        assert.equal(Object.hasOwn(message, 'text'), false);
        assert.ok(Array.isArray(message.segments));
        assert.ok(message.content_truncated || message.segments_omitted);
        assert.ok(!JSON.stringify(message).includes('[truncated]'));
      }
      if (budget >= 512) {
        assert.equal(parsed.messages.length, 1);
      }
      assert.deepEqual(memory.find('4'), original);
    } finally {
      memory.close();
    }
  }
});

test('structured summary input stays bounded and prefix snapshots preserve new typed arrivals', async () => {
  const memory = make(14000);
  let resolve!: (v: Completion) => void;
  let captured: any;
  let calls = 0;
  try {
    for (let i = 0; i < 60; i++) {
      memory.append(
        typed(i, [
          { type: 'text', text: 'hello '.repeat(40) },
          { type: 'face', id: '271' },
        ]),
      );
    }
    const pending = memory.compact({
      complete(messages, tools) {
        calls++;
        assert.deepEqual(tools, []);
        assert.ok(String(messages[1]!.content).length <= 14000);
        captured = JSON.parse(String(messages[1]!.content));
        return new Promise((r) => {
          resolve = r;
        });
      },
    });
    assert.equal(calls, 1);
    assert.ok(captured.messages.length > 0);
    assert.equal(captured.summary, null);
    for (const message of captured.messages) {
      assert.equal(Object.hasOwn(message, 'text'), false);
      assert.ok(message.segments.some((s: any) => s.type === 'face'));
      assert.equal(message.userId, '42');
      assert.equal(message.nickname, 'Alice');
      assert.equal(typeof message.time, 'number');
    }
    assert.ok(!JSON.stringify(captured).includes('INTERNAL_ONLY_FACE_MARKER'));
    memory.append(
      typed(100, [
        { type: 'text', text: 'arrived during summary' },
        { type: 'at', user_id: '42' },
      ]),
    );
    await memory.compact({
      async complete() {
        assert.fail('concurrent compaction');
      },
    });
    resolve({ content: 'Preserved factual summary', tool_calls: [] });
    await pending;
    assert.equal(memory.find('0'), undefined);
    assert.ok(memory.find('30'));
    assert.ok(memory.find('59'));
    assert.ok(memory.find('100')?.segments);
    assert.equal(
      memory.append(typed(0, [{ type: 'text', text: 'dedup persists' }])),
      false,
    );
    assert.equal(
      JSON.parse(memory.context()).summary.text,
      'Preserved factual summary',
    );
  } finally {
    memory.close();
  }
});

test('single oversized typed summary source trims segments, not only hidden compatibility text', async () => {
  const memory = make(1000);
  let source: any;
  try {
    memory.append(
      typed(0, [
        { type: 'face', id: '271' },
        { type: 'text', text: '\u0000\\"'.repeat(5000) },
      ]),
    );
    for (let i = 1; i < 31; i++) {
      memory.append(typed(i, [{ type: 'text', text: 'recent' }]));
    }
    await memory.compact({
      async complete(messages) {
        const input = String(messages[1]!.content);
        assert.ok(input.length <= 1000);
        source = JSON.parse(input);
        return { content: 'bounded typed summary', tool_calls: [] };
      },
    });
    assert.equal(source.messages.length, 1);
    const message = source.messages[0];
    assert.equal(message.messageId, '0');
    assert.equal(message.userId, '42');
    assert.equal(Object.hasOwn(message, 'text'), false);
    assert.ok(message.content_truncated || message.segments_omitted);
    assert.ok(!JSON.stringify(message).includes('[truncated]'));
    assert.equal(memory.find('0'), undefined);
    assert.equal(memory.recent().length, 30);
    assert.ok(memory.context().length <= 1000);
  } finally {
    memory.close();
  }
});

test('existing summary remains literal prior input while new raw messages are structured', async () => {
  const memory = make(14000);
  let calls = 0;
  const prior = 'Legacy summary [QQ表情：吃瓜 id=271] remains exactly literal';
  try {
    for (let i = 0; i < 60; i++) {
      memory.append(typed(i, [{ type: 'text', text: 'x'.repeat(250) }]));
    }
    await memory.compact({
      async complete() {
        return { content: prior, tool_calls: [] };
      },
    });
    for (let i = 60; i < 90; i++) {
      memory.append(typed(i, [{ type: 'text', text: 'x'.repeat(250) }]));
    }
    await memory.compact({
      async complete(messages) {
        calls++;
        const input = JSON.parse(String(messages[1]!.content));
        assert.equal(input.summary.text, prior);
        assert.ok(
          input.messages.every(
            (m: any) => Array.isArray(m.segments) && !Object.hasOwn(m, 'text'),
          ),
        );
        return { content: 'next summary', tool_calls: [] };
      },
    });
    assert.equal(calls, 1);
  } finally {
    memory.close();
  }
});

test('reset and cancellation discard late structured summaries without rewriting survivors', async () => {
  for (const action of ['clear', 'abort'] as const) {
    const memory = make(14000),
      controller = new AbortController();
    let resolve!: (v: Completion) => void;
    try {
      for (let i = 0; i < 60; i++) {
        memory.append(typed(i, [{ type: 'text', text: 'x'.repeat(250) }]));
      }
      const before = memory.recent();
      const pending = memory.compact(
        {
          complete() {
            return new Promise((r) => {
              resolve = r;
            });
          },
        },
        controller.signal,
      );
      if (action === 'clear') {
        memory.clear();
        memory.append(typed(999, [{ type: 'face', id: '271' }]));
      } else {
        controller.abort();
      }
      resolve({ content: 'must not commit', tool_calls: [] });
      await pending;
      assert.equal(JSON.parse(memory.context()).summary, null);
      if (action === 'clear') {
        assert.deepEqual(
          memory.recent().map((e) => e.messageId),
          ['999'],
        );
      } else {
        assert.deepEqual(memory.recent(), before);
      }
    } finally {
      memory.close();
    }
  }
});
