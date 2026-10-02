import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ToolObservationStore } from '../../../src/observability/tool-call-observations.ts';
import type {
  ToolObservationStart,
  ToolObservationEnd,
} from '../../../src/contracts/tool-observation.ts';

const start: ToolObservationStart = {
  selfId: '1',
  groupId: '2',
  jobId: 'js_test',
  seq: 1,
  tool: 'send_message',
  startedAt: 100,
};
const end: ToolObservationEnd = {
  ...start,
  finishedAt: 120,
  resultStatus: 'partial',
  statusKind: 'present',
  errorCode: null,
  bridgeOutcome: 'returned',
};

function fixture(
  options: ConstructorParameters<typeof ToolObservationStore>[1] = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-observation-'));
  const path = join(dir, 'telemetry.sqlite');
  const store = new ToolObservationStore(path, { now: () => 200, ...options });
  const db = new DatabaseSync(path);
  return {
    dir,
    path,
    store,
    db,
    rows: () =>
      db
        .prepare(
          'SELECT * FROM tool_call_observations ORDER BY self_id,group_id,seq',
        )
        .all(),
    cleanup() {
      store.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('idempotent observations retain raw status, retries and scoped identities', () => {
  const f = fixture();
  try {
    f.store.start(start);
    f.store.start(start);
    f.store.end(end);
    f.store.end(end);
    f.store.start(start);
    f.store.end({ ...end, seq: 2, resultStatus: 'pending' });
    f.store.end({ ...end, selfId: '3' });
    f.store.end({ ...end, groupId: '4' });
    assert.equal(f.rows().length, 4);
    assert.equal(f.rows()[0]!.result_status, 'partial');
    assert.equal(f.rows()[0]!.start_observed, 1);
    assert.equal(f.rows()[1]!.result_status, 'pending');
    assert.equal(f.rows()[1]!.start_observed, 0);
    f.store.start({ ...start, seq: 2 });
    assert.equal(f.rows()[1]!.start_observed, 1);
    assert.equal(f.rows()[1]!.end_observed, 1);
    f.store.end({ ...end, tool: 'different' });
    f.store.end({ ...end, resultStatus: 'ok' });
    assert.equal(
      f.db.prepare('SELECT conflicts FROM tool_observation_runs').get()!
        .conflicts,
      2,
    );
    assert.equal(f.rows()[0]!.result_status, 'partial');
  } finally {
    f.cleanup();
  }
});

test('missing/invalid status and clock rollback never become success or fictitious duration', () => {
  const f = fixture();
  try {
    f.store.end({
      ...end,
      statusKind: 'missing',
      resultStatus: null,
      finishedAt: 90,
    });
    f.store.end({ ...end, seq: 2, statusKind: 'invalid', resultStatus: null });
    assert.equal(f.rows()[0]!.finished_at, 90);
    assert.equal(f.rows()[0]!.status_kind, 'missing');
    assert.equal(f.rows()[1]!.status_kind, 'invalid');
    assert.equal(f.rows()[0]!.result_status, null);
  } finally {
    f.cleanup();
  }
});

test('multiple writers do not mark another writer interrupted; own close preserves missing ends', () => {
  const f = fixture();
  const other = new ToolObservationStore(f.path, { now: () => 210 });
  try {
    f.store.start(start);
    other.start({ ...start, seq: 2 });
    assert.equal(f.rows()[0]!.interrupted_at, null);
    other.close();
    assert.equal(f.rows()[0]!.interrupted_at, null);
    assert.equal(f.rows()[1]!.interrupted_at, 210);
    assert.equal(f.rows()[1]!.finished_at, null);
    // An interruption annotation is evidence, not a barrier to a late receipt.
    f.db
      .prepare(
        'UPDATE tool_call_observations SET interrupted_at=205 WHERE seq=1',
      )
      .run();
    f.store.end(end);
    assert.equal(f.rows()[0]!.interrupted_at, 205);
    assert.equal(f.rows()[0]!.end_observed, 1);
    f.store.close();
    assert.doesNotThrow(() => f.store.end({ ...end, seq: 3 }));
    assert.equal(f.rows().length, 2);
  } finally {
    other.close();
    f.cleanup();
  }
});

test('invalid metadata and storage failures are isolated and counted after recovery', () => {
  let failures = 0;
  const f = fixture({
    onError: () => {
      failures++;
      throw new Error('ignored');
    },
  });
  try {
    f.store.start(
      new Proxy(start, {
        get() {
          throw new Error('must not read');
        },
      }),
    );
    let getterCalls = 0;
    f.store.start({
      ...start,
      get tool() {
        getterCalls++;
        return 'secret';
      },
    });
    f.store.end({
      ...end,
      statusKind: {
        toString() {
          getterCalls++;
          return 'present';
        },
      },
    } as unknown as ToolObservationEnd);
    assert.equal(getterCalls, 0);
    f.db.exec('BEGIN IMMEDIATE');
    f.store.start(start);
    f.db.exec('ROLLBACK');
    f.store.end(end);
    assert.equal(f.rows().length, 1);
    assert.equal(f.rows()[0]!.start_observed, 0);
    assert.equal(
      f.db.prepare('SELECT dropped_events FROM tool_observation_runs').get()!
        .dropped_events,
      4,
    );
    assert.equal(failures, 4);
  } finally {
    f.cleanup();
  }
});

test('bounded retention atomically advances floor and late receipts cannot resurrect pruned calls', () => {
  let now = 200;
  const f = fixture({ now: () => now, maxRows: 2, retentionMs: 1000 });
  try {
    for (let seq = 1; seq <= 3; seq++) {
      f.store.start({ ...start, seq, startedAt: 100 + seq });
    }
    assert.equal(f.rows().length, 2);
    assert.equal(
      f.db.prepare('SELECT retained_since FROM tool_observation_meta').get()!
        .retained_since,
      102,
    );
    f.store.end({ ...end, startedAt: 101 });
    assert.equal(f.rows().length, 2);
    now = 1200;
    f.store.start({ ...start, seq: 4, startedAt: 1200 });
    assert.equal(f.rows().length, 1);
    assert.equal(f.rows()[0]!.seq, 4);
    assert.equal(
      f.db.prepare('SELECT retained_since FROM tool_observation_meta').get()!
        .retained_since,
      104,
    );
    now = 50;
    f.store.end({ ...end, seq: 2, startedAt: 102 });
    assert.equal(f.rows().length, 1);
  } finally {
    f.cleanup();
  }
});

test('additive migration leaves existing telemetry intact and rejects unsupported schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-migration-'));
  const path = join(dir, 'telemetry.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TABLE model_requests(request_id TEXT PRIMARY KEY); INSERT INTO model_requests VALUES('old');",
    );
    const store = new ToolObservationStore(path, { now: () => 200 });
    store.close();
    assert.equal(
      db.prepare('SELECT request_id FROM model_requests').get()!.request_id,
      'old',
    );
    assert.equal(
      db.prepare('SELECT retained_since FROM tool_observation_meta').get()!
        .retained_since,
      0,
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
    db.exec('UPDATE tool_observation_meta SET schema_version=2');
    assert.throws(() => new ToolObservationStore(path));
    symlinkSync(path, join(dir, 'link.sqlite'));
    assert.throws(() => new ToolObservationStore(join(dir, 'link.sqlite')));
    const readonly = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        readonly
          .prepare('SELECT schema_version FROM tool_observation_meta')
          .get()!.schema_version,
        2,
      );
    } finally {
      readonly.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run retention remains bounded and preserves historical fault counters', () => {
  const f = fixture();
  try {
    f.db.exec('BEGIN');
    const insert = f.db.prepare(
      'INSERT INTO tool_observation_runs VALUES(?,?,NULL,1,2)',
    );
    for (let i = 0; i < 5010; i++) {
      insert.run(`old_${i}`, 100);
    }
    f.db.exec('COMMIT');
    f.store.start(start);
    assert.equal(
      Number(
        f.db.prepare('SELECT COUNT(*) n FROM tool_observation_runs').get()!.n,
      ),
      5000,
    );
    const meta = f.db.prepare('SELECT * FROM tool_observation_meta').get()!;
    assert.equal(meta.historical_dropped_events, 11);
    assert.equal(meta.historical_conflicts, 22);
    assert.equal(meta.collection_started_at, 200);
    assert.equal(f.rows().length, 1);
  } finally {
    f.cleanup();
  }
});

test('pruned idle writer restores its run without stealing another writer identity', () => {
  let now = 200;
  const f = fixture({ now: () => now, retentionMs: 50 });
  const other = new ToolObservationStore(f.path, {
    now: () => 300,
    retentionMs: 50,
  });
  try {
    now = 300;
    f.store.start({ ...start, startedAt: 300 });
    other.end({ ...end, startedAt: 300, finishedAt: 310 });
    assert.equal(f.rows()[0]!.end_observed, 0);
    assert.equal(
      f.db.prepare('SELECT SUM(conflicts) n FROM tool_observation_runs').get()!
        .n,
      1,
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(*) n FROM tool_observation_runs').get()!.n,
      2,
    );
  } finally {
    other.close();
    f.cleanup();
  }
});

test('status and tool identifiers obey shared bounded ASCII contracts', () => {
  const f = fixture();
  try {
    for (const resultStatus of ['x'.repeat(65), '成功', 'ok\n', '']) {
      f.store.end({ ...end, resultStatus });
    }
    for (const tool of ['工具', 'bad tool', '1tool', 'x'.repeat(129)]) {
      f.store.start({ ...start, tool });
    }
    for (const suffix of ['\u2028', '\u2029']) {
      f.store.end({ ...end, resultStatus: `ok${suffix}` });
      f.store.end({ ...end, errorCode: `error${suffix}` });
      f.store.start({ ...start, tool: `send_message${suffix}` });
    }
    assert.equal(f.rows().length, 0);
    f.store.end({ ...end, resultStatus: 'future_Status-2' });
    f.store.end({ ...end, seq: 2, resultStatus: 'x'.repeat(64) });
    assert.equal(f.rows()[0]!.result_status, 'future_Status-2');
    assert.equal(f.rows()[1]!.result_status, 'x'.repeat(64));
    assert.equal(
      f.db.prepare('SELECT dropped_events FROM tool_observation_runs').get()!
        .dropped_events,
      14,
    );
  } finally {
    f.cleanup();
  }
});

test('only contracted scalars are persisted, not arguments, results, exception text or code', () => {
  const f = fixture();
  try {
    f.store.end({
      ...end,
      args: 'secret_argument',
      result: 'secret_result',
      code: 'secret_code',
      error: 'secret_exception',
    } as ToolObservationEnd);
    const serialized = JSON.stringify(f.rows());
    assert.ok(!serialized.includes('secret_'));
    assert.equal(f.rows()[0]!.result_status, 'partial');
  } finally {
    f.cleanup();
  }
});
