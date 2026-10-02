import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ToolsResponse,
  ToolSummary,
} from '../../../src/dashboard/contracts/contracts.ts';
import type { InternalToolSummary } from '../../../src/dashboard/contracts/tool-observations.ts';
import {
  directLifecycle,
  directOutcomes,
  internalCoverageNote,
  internalReadable,
  roleVersionNote,
  toolStatisticsRows,
} from '../../../src/dashboard/web/src/views/tool-statistics.ts';

const direct = (name: string, calls = 3): ToolSummary => ({
  name,
  calls,
  finished: 1,
  pending: 1,
  started: 1,
  unknown: 2,
  skipped: 0,
  handled: 1,
  rejected: 0,
  deferred: 0,
  cancelled: 0,
  errors: 0,
  durationP50Ms: null,
  durationP95Ms: null,
});
const internal = (name: string, observedCalls = 7): InternalToolSummary => ({
  name,
  observedCalls,
  withStart: 7,
  withEnd: 6,
  withoutEnd: 1,
  withoutStart: 0,
  interrupted: 2,
  bridgeFailures: 0,
  statuses: [{ kind: 'present', status: 'pending', calls: 6 }],
  durationP50Ms: null,
  durationP95Ms: null,
});
const fixture = (): ToolsResponse => ({
  range: { since: 0, until: 100 },
  availability: { telemetry: true, sessions: [] },
  items: [
    direct('read_events'),
    direct('finish', 99),
    direct('ack_events', 98),
    direct('execute_javascript', 97),
    direct('query_javascript_jobs', 96),
    direct('cancel_javascript_job', 95),
    direct('list_files'),
  ],
  internal: {
    coverage: {
      status: 'observed',
      collectionStartedAt: 10,
      retainedSince: 20,
      reasons: ['before_collection', 'retention_gap', 'known_write_gaps'],
    },
    items: [internal('read_events'), internal('create_image', 8)],
  },
});

test('source outer join preserves legacy counts and absence, sorting is source specific', () => {
  const data = fixture();
  const before = structuredClone(data);
  const rows = toolStatisticsRows(data, 'tool', 'internal');
  assert.deepEqual(
    rows.map((row) => row.name),
    ['create_image', 'read_events', 'list_files'],
  );
  assert.equal(rows[0]!.direct, undefined);
  assert.equal(rows[1]!.direct?.calls, 3);
  assert.equal(rows[1]!.internal?.observedCalls, 7);
  assert.equal(rows[2]!.internal, undefined);
  assert.equal(
    toolStatisticsRows(data, 'tool', 'direct').at(-1)?.name,
    'create_image',
  );
  assert.deepEqual(data, before);
  assert.deepEqual(
    toolStatisticsRows(data, 'tool', 'direct', ' READ_ ').map(
      (row) => row.name,
    ),
    ['read_events'],
  );
});

test('roles are independent from sources and retain all control records', () => {
  const data = fixture();
  assert.deepEqual(
    toolStatisticsRows(data, 'flow_control', 'direct').map((row) => row.name),
    ['finish', 'ack_events'],
  );
  assert.deepEqual(
    toolStatisticsRows(data, 'javascript_dispatch', 'direct').map(
      (row) => row.name,
    ),
    ['execute_javascript', 'query_javascript_jobs', 'cancel_javascript_job'],
  );
});

test('old and unreadable responses never turn internal data into zero or trust hidden rows', () => {
  const data = fixture();
  for (const status of [
    'not_recorded',
    'unavailable',
    'unsupported',
  ] as const) {
    data.internal!.coverage.status = status;
    assert.equal(internalReadable(data), false);
    assert.ok(
      toolStatisticsRows(data, 'tool', 'internal').every(
        (row) => row.internal === undefined,
      ),
    );
    assert.match(internalCoverageNote(data), /未知.*不能视为 0/);
  }
  delete data.internal;
  assert.match(internalCoverageNote(data), /仅有直接调用记录.*未知/);
  assert.ok(
    toolStatisticsRows(data, 'tool', 'direct').every((row) => !row.internal),
  );
});

test('partial observation notes disclose boundaries and gaps without completeness claims', () => {
  const note = internalCoverageNote(fixture());
  for (const text of [
    '不保证完整',
    '未回填',
    '裁剪',
    '写入故障',
    '采集启用',
    '裁剪边界',
    '非完整覆盖起点',
  ]) {
    assert.ok(note.includes(text));
  }
});

test('coverage hides the unpruned zero boundary and safely renders out-of-range dates', () => {
  const data = fixture();
  data.internal!.coverage.collectionStartedAt = 1000;
  data.internal!.coverage.retainedSince = 0;
  assert.doesNotMatch(
    internalCoverageNote(data),
    /裁剪边界|1970-01-01T00:00:00\.000Z/,
  );
  data.internal!.coverage.collectionStartedAt = Number.MAX_SAFE_INTEGER;
  data.internal!.coverage.retainedSince = Number.MAX_SAFE_INTEGER;
  const note = internalCoverageNote(data);
  assert.match(note, /采集启用：时间不可表示/);
  assert.match(note, /裁剪边界：时间不可表示（非完整覆盖起点）/);
});

test('state and return outcomes stay separate, role version mismatch is disclosed', () => {
  assert.match(directLifecycle(direct('read_events')), /待执行 1.*已开始 1/);
  assert.doesNotMatch(directLifecycle(direct('read_events')), /不明/);
  assert.match(directOutcomes(direct('read_events')), /不明 2/);
  assert.doesNotMatch(directOutcomes(direct('read_events')), /待执行|已开始/);
  assert.equal(roleVersionNote(fixture()), null);
  assert.match(
    roleVersionNote({ ...fixture(), toolUsageRoleVersion: 999 })!,
    /版本不同/,
  );
});
