import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelSession } from '../../../../src/agent/session/store.ts';
import type { Completion } from '../../../../src/contracts/model.ts';
import type { ToolDefinition } from '../../../../src/contracts/tools.ts';
import { LISTENER_GROUP } from '../../../../src/contracts/identity.ts';

const tool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'finish',
    description: 'end',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};
const second: ToolDefinition = {
  type: 'function',
  function: {
    name: 'send_message',
    description: 'send',
    parameters: { type: 'object' },
  },
};
const completion = (...calls: any[]): Completion => ({
  content: null,
  tool_calls: calls,
});
const call = (id: string, name = 'finish', args = '{}') => ({
  id,
  type: 'function' as const,
  function: { name, arguments: args },
});

function file() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-session-'));
  return { dir, path: join(dir, 'session.sqlite') };
}

function cleanup(x: { dir: string }) {
  rmSync(x.dir, { recursive: true, force: true });
}

test('images remain transient, recovered session rotates explicitly and clears transport chain', () => {
  const x = file();
  try {
    let s = new ModelSession({
      model: 'main',
      groupId: LISTENER_GROUP,
      path: x.path,
    });
    s.beginWake('instructions', [tool]);
    const old = s.state();
    const image = 'data:image/jpeg;base64,PRIVATE_IMAGE_BYTES_DO_NOT_PERSIST';
    s.appendInput([
      { type: 'text', text: 'image follows' },
      { type: 'image_url', image_url: { url: image } },
    ]);
    assert.ok(JSON.stringify(s.messages()).includes(image));
    s.setTransportCheckpoint({ response_id: 'prior_image_response' });
    s.finishWake();
    s.close();
    assert.equal(readFileSync(x.path).includes(Buffer.from(image)), false);
    s = new ModelSession({
      model: 'main',
      groupId: LISTENER_GROUP,
      path: x.path,
    });
    assert.notEqual(s.state().sessionId, old.sessionId);
    assert.equal(s.state().resetReason, 'transient_images_lost');
    assert.equal(s.getTransportCheckpoint(), undefined);
    assert.deepEqual(s.messages(), []);
    assert.match(
      JSON.stringify(s.beginWake('instructions', [tool])),
      /read_tools_again/,
    );
    s.close();
  } finally {
    cleanup(x);
  }
});

test('transcript limits fail closed and rotate explicitly while preserving old ledger audit', () => {
  const x = file();
  try {
    let s = new ModelSession({
      model: 'main',
      groupId: LISTENER_GROUP,
      path: x.path,
      maxTranscriptBytes: 4096,
    });
    s.beginWake('instructions', [tool]);
    assert.throws(
      () =>
        s.appendAssistant(
          completion(call('large', 'send_message', 'x'.repeat(5000))),
        ),
      /resource/,
    );
    const before = s.messages();
    s.appendAssistant(
      completion(call('write', 'send_message'), call('skip', 'send_message')),
    );
    s.startTool('write');
    assert.throws(
      () => s.finishTool('write', { status: 'ok', body: 'x'.repeat(6000) }),
      /resource/,
    );
    s.close();
    s = new ModelSession({
      model: 'main',
      groupId: LISTENER_GROUP,
      path: x.path,
      maxTranscriptBytes: 4096,
    });
    const recovered = s.messages().filter((m) => m.role === 'tool');
    assert.equal(recovered.length, 2);
    assert.match(String(recovered[0]!.content), /unknown/);
    assert.match(String(recovered[1]!.content), /skipped/);
    s.beginWake('instructions', [tool]);
    s.appendInput('x'.repeat(3000));
    s.finishWake();
    const prior = s.state().sessionId;
    assert.match(
      JSON.stringify(s.beginWake('instructions', [tool])),
      /transcript_resource_boundary/,
    );
    assert.notEqual(s.state().sessionId, prior);
    assert.equal(before[0]!.content, 'instructions');
    s.close();
    const db = new DatabaseSync(x.path, { readOnly: true });
    assert.equal(
      Number(
        db.prepare('SELECT COUNT(*) AS n FROM model_tool_ledger').get()!.n,
      ),
      2,
    );
    db.close();
  } finally {
    cleanup(x);
  }
});

test('returned snapshots are immutable and request/call IDs are scoped to assistant checkpoints', () => {
  const s = new ModelSession({
    model: 'main',
    groupId: LISTENER_GROUP,
    path: ':memory:',
  });
  s.beginWake('stable', [second]);
  const output = completion(call('reuse', 'send_message', '{invalid json'));
  const a = s.appendAssistant(output, 'request');
  assert.deepEqual(s.appendAssistant(output, 'request'), a);
  assert.throws(
    () => s.appendAssistant(completion(call('different')), 'request'),
    /conflict/,
  );
  s.startTool('reuse', a.assistantSeq);
  s.finishTool('reuse', { status: 'ok' }, a.assistantSeq);
  const snapshot = s.messages();
  snapshot[0]!.content = 'changed';
  assert.equal(s.messages()[0]!.content, 'stable');
  s.finishWake();
  s.beginWake('stable', [second]);
  const b = s.appendAssistant(output, 'request2');
  assert.notEqual(a.assistantSeq, b.assistantSeq);
  assert.equal(s.startTool('reuse', a.assistantSeq), false);
  assert.equal(s.startTool('reuse', b.assistantSeq), true);
  s.finishTool('reuse', { status: 'ok' }, b.assistantSeq);
  s.finishWake();
  s.close();
});

test('reopen preserves stable system/transcript prefix and group isolation', () => {
  const x = file();
  try {
    let s = new ModelSession({
      model: 'main',
      path: x.path,
      groupId: '123456789',
    });
    const first = s.beginWake('stable instructions', [tool], {
      reason: 'test',
    });
    s.appendInput('observe');
    s.appendAssistant(completion(call('c1', 'finish')), 'req-1');
    s.startTool('c1');
    s.finishTool('c1', { status: 'ok' });
    s.finishWake();
    s.close();
    s = new ModelSession({ model: 'main', path: x.path, groupId: '123456789' });
    assert.equal(s.messages()[0]!.content, 'stable instructions');
    assert.ok(
      s.messages().some((m) => m.role === 'tool' && m.tool_call_id === 'c1'),
    );
    assert.throws(
      () =>
        new ModelSession({ model: 'main', path: x.path, groupId: '100000002' }),
      /group/,
    );
    s.close();
    assert.notEqual(first.length, 0);
  } finally {
    cleanup(x);
  }
});

test('configuration fingerprint rotates current projection but keeps audit journal', () => {
  const x = file();
  try {
    const s = new ModelSession({
      model: 'main',
      groupId: LISTENER_GROUP,
      path: x.path,
    });
    s.beginWake('a', [tool]);
    s.finishWake();
    const old = s.state().sessionId;
    s.beginWake('b', [second]);
    assert.notEqual(s.state().sessionId, old);
    assert.equal(s.messages()[0]!.content, 'b');
    s.close();
  } finally {
    cleanup(x);
  }
});

test('ledger intent is durable, crash recovery marks started unknown and never replays', () => {
  const x = file();
  try {
    let s = new ModelSession({
      model: 'main',
      groupId: LISTENER_GROUP,
      path: x.path,
    });
    s.beginWake('instructions', [tool]);
    s.appendAssistant(completion(call('write', 'send_message', '{}')));
    assert.equal(s.startTool('write'), true);
    s.close();
    s = new ModelSession({
      model: 'main',
      groupId: LISTENER_GROUP,
      path: x.path,
    });
    const rows = s.messages();
    const result = rows.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'write',
    );
    assert.ok(result);
    assert.match(String(result?.content), /unknown/);
    assert.equal(s.startTool('write'), false);
    s.close();
  } finally {
    cleanup(x);
  }
});

test('unstarted calls are skipped and duplicate result never overwrites', () => {
  const x = file();
  try {
    const s = new ModelSession({
      model: 'main',
      groupId: LISTENER_GROUP,
      path: x.path,
    });
    s.beginWake('instructions', [tool, second]);
    s.appendAssistant(
      completion(call('a', 'send_message', '{}'), call('b', 'finish', '{}')),
    );
    assert.equal(s.startTool('a'), true);
    s.finishTool('a', { status: 'ok' });
    assert.doesNotThrow(() => s.finishTool('a', { status: 'error' }));
    s.skipPending('budget');
    const results = s.messages().filter((m) => m.role === 'tool');
    assert.equal(results.length, 2);
    assert.match(String(results[1]!.content), /skipped/);
    s.close();
  } finally {
    cleanup(x);
  }
});

test('finish result closes pending trailing calls with explicit skipped results', () => {
  const x = file();
  try {
    const s = new ModelSession({
      model: 'main',
      groupId: LISTENER_GROUP,
      path: x.path,
    });
    s.beginWake('instructions', [tool]);
    s.appendAssistant(
      completion(
        call('f', 'finish', '{"mode":"hard"}'),
        call('later', 'send_message', '{}'),
      ),
    );
    assert.equal(s.startTool('f'), true);
    s.finishTool('f', { status: 'ok', closed: true });
    const results = s.messages().filter((m) => m.role === 'tool');
    assert.equal(results.length, 2);
    assert.match(String(results[1]!.content), /turn_finished/);
    s.close();
  } finally {
    cleanup(x);
  }
});

test('finish requires a valid mode and explicit successful closed result to terminate', () => {
  for (const [args, result, terminal] of [
    ['{"mode":"soft"}', { status: 'ok', closed: false }, false],
    ['{"mode":"soft"}', { status: 'ok', closed: true }, true],
    ['{"mode":"hard"}', { status: 'ok', closed: true }, true],
    ['{"mode":"hard"}', { status: 'ok' }, false],
    ['{"mode":"hard"}', { status: 'error', closed: true }, false],
    ['{}', { status: 'ok', closed: true }, false],
    ['{"mode":"invalid"}', { status: 'ok', closed: true }, false],
    ['{"mode":"hard","extra":1}', { status: 'ok', closed: true }, false],
  ] as const) {
    const s = new ModelSession({
      model: 'main',
      groupId: LISTENER_GROUP,
      path: ':memory:',
    });
    try {
      s.beginWake('system', [tool]);
      s.appendAssistant(completion(call('finish', 'finish', args)));
      s.startTool('finish');
      s.finishTool('finish', result);
      if (terminal) {
        assert.throws(
          () => s.appendAssistant({ content: 'next', tool_calls: [] }),
          /wake_finished/,
        );
        assert.throws(
          () => s.appendContextUpdate('1', emptyContext(), { force: true }),
          /invalid_input_boundary/,
        );
      } else {
        assert.doesNotThrow(() =>
          s.appendAssistant({ content: 'next', tool_calls: [] }),
        );
      }
    } finally {
      s.close();
    }
  }
});

test('transport checkpoint is bounded and reset clears it', () => {
  const x = file();
  try {
    const s = new ModelSession({
      model: 'main',
      groupId: LISTENER_GROUP,
      path: x.path,
    });
    s.setTransportCheckpoint({ response_id: 'private' });
    assert.deepEqual(s.getTransportCheckpoint(), { response_id: 'private' });
    assert.throws(
      () => s.setTransportCheckpoint({ blob: 'x'.repeat(300000) }),
      /resource/,
    );
    s.reset('manual');
    assert.equal(s.getTransportCheckpoint(), undefined);
    s.close();
  } finally {
    cleanup(x);
  }
});

test('symlink database is refused before opening', () => {
  const x = file(),
    link = x.path + '-link';
  try {
    writeFileSync(x.path, 'not sqlite');
    symlinkSync(x.path, link);
    assert.throws(
      () =>
        new ModelSession({
          model: 'main',
          groupId: LISTENER_GROUP,
          path: link,
        }),
      /symlink|file/,
    );
  } finally {
    cleanup(x);
    try {
      rmSync(link);
    } catch {}
  }
});

test('switching the configured model name starts a new session and drops the transport chain', () => {
  const x = file();
  try {
    let s = new ModelSession({
      model: 'opencode_go',
      groupId: LISTENER_GROUP,
      path: x.path,
    });
    s.beginWake('instructions', [tool]);
    const first = s.state().sessionId;
    s.setTransportCheckpoint({ response_id: 'provider_a_response' });
    s.finishWake();
    s.close();
    // 同名模型重启后继续同一会话。
    s = new ModelSession({
      model: 'opencode_go',
      groupId: LISTENER_GROUP,
      path: x.path,
    });
    s.beginWake('instructions', [tool]);
    assert.equal(s.state().sessionId, first);
    s.finishWake();
    s.close();
    // 同样的指令和工具，换成另一个模型名即轮换。
    s = new ModelSession({
      model: 'qunyou_model',
      groupId: LISTENER_GROUP,
      path: x.path,
    });
    s.beginWake('instructions', [tool]);
    assert.notEqual(s.state().sessionId, first);
    assert.equal(s.state().resetReason, 'configuration_changed');
    assert.equal(s.getTransportCheckpoint(), undefined);
    s.finishWake();
    s.close();
  } finally {
    cleanup(x);
  }
});

const emptyContext = (read_through = 0) => ({
  events: [],
  unread_count: 0,
  omitted_count: 0,
  read_through,
});
const context = (s: ModelSession) =>
  JSON.parse(String(s.messages().at(-1)!.content)).context_update;

test('context updates require an active idle tool boundary, and force delivers zero events', () => {
  const s = new ModelSession({
    model: 'main',
    groupId: LISTENER_GROUP,
    path: ':memory:',
  });
  try {
    assert.throws(
      () => s.appendContextUpdate('1', emptyContext()),
      /invalid_input_boundary/,
    );
    s.beginWake('system', [second]);
    assert.deepEqual(s.appendContextUpdate('1', emptyContext(9)), {
      appended: false,
      hostEvents: 0,
    });
    assert.equal(s.chatReadThrough('1'), 0);
    assert.deepEqual(
      s.appendContextUpdate(
        '1',
        { ...emptyContext(9), unread_count: 7 },
        { force: true },
      ),
      { appended: true, hostEvents: 0 },
    );
    assert.deepEqual(context(s), {
      unread_count: 7,
      omitted_count: 0,
      read_through: 9,
      items: [],
    });
    s.appendAssistant(completion(call('pending', 'send_message')));
    assert.throws(
      () => s.appendContextUpdate('1', emptyContext(), { force: true }),
      /invalid_input_boundary/,
    );
    s.startTool('pending');
    assert.throws(
      () => s.appendContextUpdate('1', emptyContext(), { force: true }),
      /invalid_input_boundary/,
    );
    s.finishTool('pending', { status: 'ok' });
    s.appendContextUpdate('1', emptyContext(), { force: true });
    assert.equal(s.chatReadThrough('1'), 9);
  } finally {
    s.close();
  }
});

test('context batches all host results by receive time, keeps QQ intact and isolates accounts', () => {
  const x = file();
  const s = new ModelSession({
    model: 'main',
    groupId: LISTENER_GROUP,
    path: x.path,
  });
  try {
    s.beginWake('system', []);
    for (let i = 0; i < 40; i++) {
      s.receiveExternalEvent(`job-${i}`, '1', {
        job_id: `job-${i}`,
        status: 'ok',
      });
    }
    s.receiveExternalEvent('other', '2', { job_id: 'other', status: 'ok' });
    const db = new DatabaseSync(x.path);
    db.exec('UPDATE model_external_events SET received_at=2000');
    db.close();
    const events = [
      { observed_at: 3, text: 'later' },
      { observed_at: 1, text: 'earlier' },
    ];
    assert.deepEqual(
      s.appendContextUpdate('1', {
        events,
        unread_count: 50,
        omitted_count: 48,
        read_through: 12,
      }),
      { appended: true, hostEvents: 40 },
    );
    const update = context(s);
    assert.deepEqual(update.items[0], {
      type: 'world_event',
      event: events[1],
    });
    assert.deepEqual(update.items.at(-1), {
      type: 'world_event',
      event: events[0],
    });
    assert.equal(
      update.items.filter((item: any) => item.type === 'job_result').length,
      40,
    );
    assert.equal(s.hasExternalEvents('1'), false);
    assert.equal(s.hasExternalEvents('2'), true);
    assert.equal(s.chatReadThrough('2'), 0);
    assert.equal(s.chatReadThrough('1'), 12);
  } finally {
    s.close();
    cleanup(x);
  }
});

test('context journal survives restart and explicit rotation without reprojecting acknowledged host', () => {
  const x = file();
  let s = new ModelSession({
    model: 'main',
    groupId: LISTENER_GROUP,
    path: x.path,
  });
  try {
    s.beginWake('system', []);
    s.receiveExternalEvent('job', '1', { job_id: 'job', status: 'ok' });
    s.appendContextUpdate('1', emptyContext(42));
    s.reset('owner_reset');
    assert.equal(s.hasExternalEvents('1'), false);
    assert.equal(s.chatReadThrough('1'), 42);
    s.close();
    s = new ModelSession({
      model: 'main',
      groupId: LISTENER_GROUP,
      path: x.path,
    });
    s.beginWake('changed', []);
    assert.equal(s.chatReadThrough('1'), 42);
    assert.equal(s.chatReadThrough('2'), 0);
  } finally {
    s.close();
    cleanup(x);
  }
});

test('context rollback is atomic even when journal fails after message and projected_at writes', () => {
  const x = file();
  const s = new ModelSession({
    model: 'main',
    groupId: LISTENER_GROUP,
    path: x.path,
  });
  const db = new DatabaseSync(x.path);
  try {
    s.beginWake('system', []);
    s.receiveExternalEvent('job', '1', { job_id: 'job', status: 'ok' });
    const before = s.messages();
    db.exec(
      "CREATE TRIGGER fail_chat_read BEFORE INSERT ON model_session_journal WHEN NEW.kind='chat_read' BEGIN SELECT RAISE(ABORT,'test_rollback'); END",
    );
    assert.throws(
      () => s.appendContextUpdate('1', emptyContext(8)),
      /test_rollback/,
    );
    assert.deepEqual(s.messages(), before);
    assert.equal(s.externalEventProjected('job', '1'), false);
    assert.equal(s.chatReadThrough('1'), 0);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM model_session_journal WHERE kind='external_event_received'",
        )
        .get()!.n,
      0,
    );
    db.exec('DROP TRIGGER fail_chat_read');
    assert.equal(s.appendContextUpdate('1', emptyContext(8)).hostEvents, 1);
  } finally {
    db.close();
    s.close();
    cleanup(x);
  }
});

test('empty delivery boundaries reserve the next model/tool round without modifying history', () => {
  const s = new ModelSession({
    model: 'main',
    groupId: LISTENER_GROUP,
    path: ':memory:',
    maxTranscriptBytes: 4096,
  });
  try {
    s.beginWake('system', []);
    let rounds = 0;
    const bytes = () =>
      s
        .messages()
        .reduce(
          (n, message) => n + Buffer.byteLength(JSON.stringify(message)),
          0,
        );
    while (bytes() <= 4096 - 2048) {
      assert.deepEqual(s.appendContextUpdate('1', emptyContext(99)), {
        appended: false,
        hostEvents: 0,
      });
      const id = `time-${rounds++}`;
      s.appendAssistant(completion(call(id, 'get_time')));
      s.startTool(id);
      s.finishTool(id, { status: 'ok', now: 123456789 });
      assert.ok(rounds < 30);
    }
    const before = s.messages();
    assert.throws(
      () => s.appendContextUpdate('1', emptyContext(99)),
      /session_resource_limit/,
    );
    assert.deepEqual(s.messages(), before);
    assert.equal(s.chatReadThrough('1'), 0);
  } finally {
    s.close();
  }
});

test('host byte batches preserve pending tails and reserve capacity for response and tool result', () => {
  const s = new ModelSession({
    model: 'main',
    groupId: LISTENER_GROUP,
    path: ':memory:',
    maxTranscriptBytes: 4096,
  });
  try {
    s.beginWake('system', [second]);
    for (let i = 0; i < 15; i++) {
      s.receiveExternalEvent(`job-${String(i).padStart(2, '0')}`, '1', {
        job_id: `job-${i}`,
        status: 'ok',
        value: 'x'.repeat(600),
      });
    }
    const result = s.appendContextUpdate('1', emptyContext(7));
    assert.ok(result.hostEvents > 1 && result.hostEvents < 15);
    assert.equal(s.hasExternalEvents('1'), true);
    const bytes = s
      .messages()
      .reduce(
        (n, message) => n + Buffer.byteLength(JSON.stringify(message)),
        0,
      );
    assert.ok(bytes <= 4096 - 2048);
    s.appendAssistant(completion(call('response', 'send_message')));
    s.startTool('response');
    s.finishTool('response', { status: 'ok' });
  } finally {
    s.close();
  }
});

test('oversized head is bounded without starving later jobs; QQ and resource failures never ack early', () => {
  const s = new ModelSession({
    model: 'main',
    groupId: LISTENER_GROUP,
    path: ':memory:',
    maxTranscriptBytes: 4096,
  });
  try {
    s.beginWake('system', []);
    s.receiveExternalEvent('big', '1', {
      job_id: 'big',
      status: 'ok',
      value: 'x'.repeat(200000),
      logs: ['x'.repeat(100000)],
      diagnostic: { detail: 'x'.repeat(100000) },
    });
    s.receiveExternalEvent('small', '1', { job_id: 'small', status: 'ok' });
    const before = s.messages();
    assert.throws(
      () =>
        s.appendContextUpdate('1', {
          ...emptyContext(20),
          events: [{ observed_at: 1, text: 'x'.repeat(3000) }],
        }),
      /session_resource_limit/,
    );
    assert.deepEqual(s.messages(), before);
    assert.equal(s.chatReadThrough('1'), 0);
    assert.equal(s.externalEventProjected('big', '1'), false);
    assert.equal(s.appendContextUpdate('1', emptyContext(20)).hostEvents, 2);
    const result = context(s).items[0].result;
    assert.equal(result.job_id, 'big');
    assert.equal(result.status, 'ok');
    assert.equal(result.truncated, true);
    s.appendInput('x'.repeat(2000));
    s.receiveExternalEvent('remaining', '1', {
      job_id: 'remaining',
      status: 'ok',
    });
    assert.throws(
      () => s.appendContextUpdate('1', emptyContext(99)),
      /session_resource_limit/,
    );
    assert.equal(s.chatReadThrough('1'), 20);
    assert.equal(s.externalEventProjected('remaining', '1'), false);
  } finally {
    s.close();
  }
});

test('unexpected large host metadata falls back to job identity and the existing query entry', () => {
  const s = new ModelSession({
    model: 'main',
    groupId: LISTENER_GROUP,
    path: ':memory:',
    maxTranscriptBytes: 4096,
  });
  try {
    s.beginWake('system', []);
    s.receiveExternalEvent('metadata', '1', {
      job_id: 'metadata',
      status: 'ok',
      description: 'x'.repeat(10000),
    });
    assert.equal(s.appendContextUpdate('1', emptyContext()).hostEvents, 1);
    assert.deepEqual(context(s).items[0].result, {
      job_id: 'metadata',
      status: 'ok',
      truncated: true,
      query: {
        tool: 'query_javascript_jobs',
        arguments: { job_id: 'metadata' },
      },
    });
  } finally {
    s.close();
  }
});

test('automatic rotation requeues only host deliveries after the last stored model response', () => {
  const s = new ModelSession({
    model: 'main',
    groupId: LISTENER_GROUP,
    path: ':memory:',
  });
  try {
    s.beginWake('system', []);
    s.receiveExternalEvent('answered', '1', {
      job_id: 'answered',
      status: 'ok',
    });
    s.appendContextUpdate('1', emptyContext(1));
    s.appendAssistant({ content: 'seen', tool_calls: [] });
    s.receiveExternalEvent('unanswered', '1', {
      job_id: 'unanswered',
      status: 'ok',
    });
    s.appendContextUpdate('1', emptyContext(2));
    s.finishWake();
    s.beginWake('changed', []);
    assert.equal(s.externalEventProjected('answered', '1'), true);
    assert.equal(s.externalEventProjected('unanswered', '1'), false);
    assert.equal(s.chatReadThrough('1'), 2);
    assert.equal(s.projectExternalEvents('1'), 1);
    s.reset('response_state_expired');
    assert.equal(s.externalEventProjected('unanswered', '1'), false);
    assert.equal(s.externalEventProjected('answered', '1'), true);
    assert.equal(s.chatReadThrough('1'), 2);
  } finally {
    s.close();
  }
});

test('the model name is a required session option', () => {
  for (const model of [undefined, '', 1]) {
    assert.throws(
      () =>
        new ModelSession({
          model: model as string,
          groupId: LISTENER_GROUP,
          path: ':memory:',
        }),
      /invalid_session_options/,
    );
  }
});
