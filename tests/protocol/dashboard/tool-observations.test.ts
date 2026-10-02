import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ToolObservationStore } from '../../../src/observability/tool-call-observations.ts';
import { Repository } from '../../../src/dashboard/server/repository.ts';
import { internalToolObservations } from '../../../src/dashboard/server/tool-observations.ts';
import { buildApp } from '../../../src/dashboard/server/app.ts';
import { AuthStore } from '../../../src/dashboard/server/auth.ts';
import type { ToolObservationEnd } from '../../../src/contracts/tool-observation.ts';

const event: ToolObservationEnd = {
  selfId: '1',
  groupId: '11',
  jobId: 'js_same',
  seq: 1,
  tool: 'send_message',
  startedAt: 100,
  finishedAt: 120,
  resultStatus: 'partial',
  statusKind: 'present',
  errorCode: null,
  bridgeOutcome: 'returned',
};
const range = { since: 0, until: 300 };

function fixture(mode: 'current' | 'old' | 'missing' = 'current') {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-tool-observations-'));
  const path = join(dir, 'telemetry.sqlite');
  let db: DatabaseSync | undefined;
  let store: ToolObservationStore | undefined;
  if (mode !== 'missing') {
    db = new DatabaseSync(path);
    db.exec('CREATE TABLE model_requests(request_id TEXT)');
  }
  if (mode === 'current') {
    store = new ToolObservationStore(path, { now: () => 50 });
  }
  let groups = ['11', '22'].map((groupId) => ({
    groupId,
    sessionPath: join(dir, `session-${groupId}.sqlite`),
  }));
  const sources = { telemetryPath: path, getGroups: () => groups };
  const repository = new Repository(sources);
  return {
    dir,
    path,
    db,
    store,
    repository,
    sources,
    revoke() {
      groups = [];
      repository.refreshGroups();
    },
    read: (groupId?: string, selected = range) =>
      internalToolObservations(repository, selected, groupId),
    cleanup() {
      repository.close();
      store?.close();
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('missing and legacy sources remain read-only and explicitly unrecorded', () => {
  for (const mode of ['missing', 'old'] as const) {
    const f = fixture(mode);
    try {
      const before = f.db
        ?.prepare('SELECT name FROM sqlite_schema ORDER BY name')
        .all();
      const result = f.read();
      assert.equal(
        result.coverage.status,
        mode === 'missing' ? 'unavailable' : 'not_recorded',
      );
      assert.deepEqual(result.items, []);
      assert.equal(existsSync(f.path), mode !== 'missing');
      assert.deepEqual(
        f.db?.prepare('SELECT name FROM sqlite_schema ORDER BY name').all(),
        before,
      );
      if (mode === 'old') {
        assert.throws(() =>
          f.repository.telemetry()!.exec('CREATE TABLE forbidden(x)'),
        );
      }
    } finally {
      f.cleanup();
    }
  }
});

test('schema, metadata versions and index substitutions fail closed', () => {
  for (const sql of [
    'DROP TABLE tool_observation_runs',
    'ALTER TABLE tool_call_observations RENAME COLUMN status_kind TO wrong',
    'DROP INDEX tool_observations_group_started',
    'DROP INDEX tool_observations_group_started; CREATE INDEX tool_observations_group_started ON tool_call_observations(started_at,group_id,self_id,job_id,seq)',
    'DROP INDEX tool_observations_group_started; CREATE INDEX tool_observations_group_started ON tool_call_observations(group_id,started_at,self_id,job_id,seq) WHERE seq>0',
    'CREATE TABLE replacement AS SELECT * FROM tool_call_observations; DROP TABLE tool_call_observations; ALTER TABLE replacement RENAME TO tool_call_observations; CREATE INDEX tool_observations_group_started ON tool_call_observations(group_id,started_at,self_id,job_id,seq)',
    'UPDATE tool_observation_meta SET schema_version=999',
    "UPDATE tool_observation_meta SET retained_since='bad'",
    'UPDATE tool_observation_runs SET dropped_events=-1',
  ]) {
    const f = fixture();
    try {
      f.db!.exec(sql);
      assert.equal(f.read().coverage.status, 'unsupported', sql);
      assert.deepEqual(f.read().items, []);
    } finally {
      f.cleanup();
    }
  }
});

test('clock rollback keeps observed facts before the collection marker', () => {
  const f = fixture();
  try {
    f.store!.end({ ...event, startedAt: 40, finishedAt: 45 });
    const result = f.read('11', { since: 0, until: 49 });
    assert.equal(result.coverage.status, 'observed');
    assert.deepEqual(result.coverage.reasons, ['before_collection']);
    assert.equal(result.items[0]!.observedCalls, 1);
  } finally {
    f.cleanup();
  }
});

test('BINARY range indexing is preserved when source columns default to NOCASE', () => {
  const f = fixture();
  try {
    const original = String(
      f
        .db!.prepare(
          "SELECT sql FROM sqlite_schema WHERE name='tool_call_observations'",
        )
        .get()!.sql,
    );
    f.db!.exec(`DROP TABLE tool_call_observations;
      ${original.replaceAll('TEXT NOT NULL', 'TEXT COLLATE NOCASE NOT NULL')};
      CREATE INDEX tool_observations_group_started ON tool_call_observations(group_id COLLATE BINARY,started_at,self_id COLLATE BINARY,job_id COLLATE BINARY,seq);`);
    f.store!.end(event);
    assert.equal(f.read('11').items[0]!.observedCalls, 1);
    const plan = f
      .db!.prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM tool_call_observations INDEXED BY tool_observations_group_started
      WHERE group_id COLLATE BINARY=? AND started_at>=? AND started_at<=?
      ORDER BY started_at,self_id COLLATE BINARY,job_id COLLATE BINARY,seq LIMIT ?`,
      )
      .all('11', 0, 300, 10001);
    assert.ok(
      plan.some((row) =>
        String(row.detail).includes(
          'SEARCH tool_call_observations USING INDEX tool_observations_group_started (group_id=? AND started_at>? AND started_at<?)',
        ),
      ),
    );
    assert.ok(plan.every((row) => !String(row.detail).includes('TEMP B-TREE')));
  } finally {
    f.cleanup();
  }
});

test('collection and retention windows and known gaps are distinct from zero calls', () => {
  const f = fixture();
  try {
    assert.equal(
      f.read(undefined, { since: 0, until: 49 }).coverage.status,
      'not_recorded',
    );
    assert.deepEqual(f.read().coverage.reasons, ['before_collection']);
    f.db!.exec(
      'UPDATE tool_observation_meta SET retained_since=90,historical_conflicts=1',
    );
    const result = f.read();
    assert.deepEqual(result.coverage.reasons, [
      'before_collection',
      'retention_gap',
      'known_write_gaps',
    ]);
    assert.deepEqual(result.items, []);
    assert.equal(result.coverage.collectionStartedAt, 50);
    f.db!.exec(
      'UPDATE tool_observation_meta SET historical_conflicts=0; UPDATE tool_observation_runs SET dropped_events=1',
    );
    assert.ok(f.read().coverage.reasons.includes('known_write_gaps'));
  } finally {
    f.cleanup();
  }
});

test('one identity counts once and lifecycle/status dimensions are not added together', () => {
  const f = fixture();
  try {
    f.store!.start(event);
    f.store!.start(event);
    f.store!.end(event);
    f.store!.end(event);
    f.store!.end({ ...event, seq: 2, resultStatus: 'pending' });
    f.store!.end({
      ...event,
      seq: 3,
      statusKind: 'missing',
      resultStatus: null,
    });
    f.store!.end({
      ...event,
      seq: 4,
      statusKind: 'invalid',
      resultStatus: null,
    });
    f.store!.start({ ...event, seq: 5 });
    f.store!.start({ ...event, seq: 6 });
    f.store!.end({ ...event, seq: 6, finishedAt: 90 });
    f.store!.close();
    const item = f.read('11').items[0]!;
    assert.equal(item.observedCalls, 6);
    assert.equal(item.withStart, 3);
    assert.equal(item.withEnd, 5);
    assert.equal(item.withoutStart, 3);
    assert.equal(item.withoutEnd, 1);
    assert.equal(item.interrupted, 1);
    assert.equal(item.durationP50Ms, 20);
    assert.equal(item.durationP95Ms, 20);
    assert.deepEqual(item.statuses, [
      { kind: 'invalid', status: null, calls: 1 },
      { kind: 'missing', status: null, calls: 1 },
      { kind: 'present', status: 'partial', calls: 2 },
      { kind: 'present', status: 'pending', calls: 1 },
    ]);
    assert.ok(!JSON.stringify(item).includes('"ok"'));
  } finally {
    f.cleanup();
  }
});

test('malformed stored lifecycle and raw status fields are never reported as valid totals', () => {
  for (const sql of [
    "UPDATE tool_call_observations SET result_status='ok' || char(10)",
    "UPDATE tool_call_observations SET result_status='成功'",
    "UPDATE tool_call_observations SET result_status='x'||printf('%064d',0)",
    "UPDATE tool_call_observations SET tool='send_message' || char(10)",
    'UPDATE tool_call_observations SET end_observed=0',
    'UPDATE tool_call_observations SET start_observed=0,end_observed=0',
    'UPDATE tool_call_observations SET finished_at=NULL',
    "UPDATE tool_call_observations SET status_kind='missing'",
    'UPDATE tool_call_observations SET interrupted_at=-1',
  ]) {
    const f = fixture();
    try {
      f.store!.end(event);
      f.db!.exec(sql);
      assert.equal(f.read().coverage.status, 'unsupported', sql);
      assert.deepEqual(f.read().items, []);
    } finally {
      f.cleanup();
    }
  }
});

test('negative and end-only durations are excluded rather than treated as zero', () => {
  const f = fixture();
  try {
    f.store!.start(event);
    f.store!.end({ ...event, finishedAt: 90 });
    f.store!.end({ ...event, seq: 2 });
    assert.equal(f.read().items[0]!.durationP50Ms, null);
    assert.equal(f.read().items[0]!.durationP95Ms, null);
  } finally {
    f.cleanup();
  }
});

test('same job identifiers across accounts/groups stay distinct and authorization is enforced', () => {
  const f = fixture();
  try {
    f.store!.end(event);
    f.store!.end({ ...event, selfId: '2' });
    f.store!.end({ ...event, groupId: '22' });
    f.store!.end({ ...event, groupId: '33' });
    assert.equal(f.read().items[0]!.observedCalls, 3);
    assert.equal(f.read('11').items[0]!.observedCalls, 2);
    assert.equal(f.read('22').items[0]!.observedCalls, 1);
    assert.deepEqual(f.read('33').items, []);
    f.revoke();
    assert.deepEqual(f.read().items, []);
    assert.deepEqual(f.read('11').items, []);
  } finally {
    f.cleanup();
  }
});

test('source overflow returns no partial internal totals and uses authorized range index', () => {
  const f = fixture();
  try {
    f.store!.end(event);
    const plan = f
      .db!.prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM tool_call_observations INDEXED BY tool_observations_group_started WHERE group_id=? AND started_at>=? AND started_at<=? ORDER BY started_at,self_id,job_id,seq LIMIT ?',
      )
      .all('11', 0, 300, 10001);
    assert.ok(
      plan.some((row) =>
        String(row.detail).includes(
          'SEARCH tool_call_observations USING INDEX tool_observations_group_started (group_id=? AND started_at>? AND started_at<?)',
        ),
      ),
    );
    f.db!
      .exec(`WITH RECURSIVE n(x) AS (VALUES(2) UNION ALL SELECT x+1 FROM n WHERE x<10001)
      INSERT INTO tool_call_observations SELECT self_id,group_id,job_id,n.x,tool,run_id,started_at,start_observed,finished_at,end_observed,result_status,status_kind,error_code,bridge_outcome,interrupted_at,observed_at FROM tool_call_observations,n WHERE seq=1`);
    const result = f.read();
    assert.equal(result.coverage.status, 'unavailable');
    assert.deepEqual(result.coverage.reasons, ['query_limit']);
    assert.deepEqual(result.items, []);
  } finally {
    f.cleanup();
  }
});

test('tools API preserves legacy calls and never sums query/notification summary snapshots', async () => {
  const f = fixture();
  const session = new DatabaseSync(f.sources.getGroups()[0]!.sessionPath);
  const auth = new AuthStore({
    path: join(f.dir, 'auth.sqlite'),
    password: 'test-password-long',
  });
  session.exec(`CREATE TABLE model_session_meta(singleton INTEGER,group_id TEXT); INSERT INTO model_session_meta VALUES(1,'11');
    CREATE TABLE model_session_journal(seq INTEGER,kind TEXT,payload TEXT);
    CREATE TABLE model_session_messages(request_id TEXT);
    CREATE TABLE model_tool_ledger(ordinal INTEGER,name TEXT,state TEXT,arguments TEXT,result TEXT,proposed_at INTEGER,started_at INTEGER,finished_at INTEGER);`);
  const snapshot = JSON.stringify({
    status: 'completed',
    job_id: 'js_same',
    tool_calls: { counts: { send_message: { ok: 500 } } },
  });
  const add = session.prepare(
    'INSERT INTO model_tool_ledger VALUES(?,?,?,?,?,?,?,?)',
  );
  add.run(
    1,
    'execute_javascript',
    'finished',
    'PRIVATE_CODE_SEND_MESSAGE',
    snapshot,
    100,
    100,
    120,
  );
  add.run(
    2,
    'query_javascript_jobs',
    'finished',
    '{}',
    snapshot,
    100,
    100,
    120,
  );
  add.run(
    3,
    'query_javascript_jobs',
    'finished',
    '{}',
    snapshot,
    100,
    100,
    120,
  );
  session
    .prepare('INSERT INTO model_session_journal VALUES(1,?,?)')
    .run('sandbox_result', snapshot);
  session.close();
  f.store!.start(event);
  f.store!.end(event);
  const app = buildApp({ ...f.sources, auth, now: () => 300 });
  try {
    const login = auth.login('test-password-long', '127.0.0.1');
    assert.equal(login.status, 'ok');
    if (login.status !== 'ok') {
      return;
    }
    const headers = { cookie: `dashboard_session=${login.token}` };
    assert.equal(
      (await app.inject('/api/tools?since=0&until=300')).statusCode,
      401,
    );
    const response = await app.inject({
      url: '/api/tools?since=0&until=300&groupId=11',
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(
      body.items.find(
        (item: { name: string }) => item.name === 'execute_javascript',
      ).calls,
      1,
    );
    assert.equal(
      body.items.find(
        (item: { name: string }) => item.name === 'query_javascript_jobs',
      ).calls,
      2,
    );
    assert.equal(body.internal.items[0].observedCalls, 1);
    assert.ok(!response.body.includes('PRIVATE_CODE'));
    f.revoke();
    const revoked = await app.inject({
      url: '/api/tools?since=0&until=300&groupId=11',
      headers,
    });
    assert.notEqual(revoked.statusCode, 200);
  } finally {
    await app.close();
    auth.close();
    f.cleanup();
  }
});
