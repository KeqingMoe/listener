import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '../../../src/contracts/json.ts';
import type {
  ToolObservationEnd,
  ToolObservationStart,
} from '../../../src/contracts/tool-observation.ts';
import type { ExecutionResult } from '../../../src/sandbox/protocol.ts';
import { SandboxService } from '../../../src/sandbox/service.ts';
import { SandboxJobStore } from '../../../src/sandbox/store.ts';
import { observationResult } from '../../../src/sandbox/tool-observation.ts';

const scope = { selfId: '100', groupId: '200' };
const caller = { actorId: '300', messageId: '400' };
const input = {
  ...scope,
  description: 'metadata boundary',
  code: 'private-code-body',
  mode: 'sync' as const,
  waitMs: 10000,
};
const completed = (value = ''): ExecutionResult => ({
  status: 'completed',
  value,
  logs: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('host observations begin before dispatch, retain raw statuses, and do not count summary reads', async () => {
  const store = new SandboxJobStore({ path: ':memory:' });
  const starts: ToolObservationStart[] = [],
    ends: ToolObservationEnd[] = [];
  const results: JsonObject[] = [
    { status: 'ok' },
    { status: 'partial' },
    { status: 'pending' },
    { status: 'failed' },
    { status: 'unknown' },
    {},
    { status: 42 },
    { status: 'ok', duplicate: true },
  ];
  let dispatched = 0;
  const service = new SandboxService({
    store,
    observer: {
      start: (value) => {
        starts.push(value);
      },
      end: (value) => {
        ends.push(value);
      },
    },
    executor: (options) => ({
      result: (async () => {
        for (let i = 0; i < results.length; i++) {
          const value = await options.callTool!(
            'demo',
            { private: 'argument-secret' },
            new AbortController().signal,
          );
          assert.deepEqual(value, results[i]);
        }
        return completed();
      })(),
      cancel() {},
    }),
  });
  service.setToolBridge({
    names: () => ['demo'],
    async call() {
      assert.equal(starts.length, dispatched + 1);
      return results[dispatched++]!;
    },
  });
  try {
    const result = await service.execute(input, undefined, caller);
    assert.equal(result.status, 'completed');
    assert.ok(result.job_id);
    for (let i = 0; i < 5; i++) {
      service.query(scope, { jobId: result.job_id });
      service.calls(scope, result.job_id!);
      service.pendingResults(scope.selfId);
    }
    assert.equal(starts.length, results.length);
    assert.equal(ends.length, results.length);
    assert.deepEqual(
      starts.map((x) => x.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.deepEqual(
      ends.map((x) => [x.resultStatus, x.statusKind]),
      [
        ['ok', 'present'],
        ['partial', 'present'],
        ['pending', 'present'],
        ['failed', 'present'],
        ['unknown', 'present'],
        [null, 'missing'],
        [null, 'invalid'],
        ['ok', 'present'],
      ],
    );
    assert.ok(ends.every((x) => x.bridgeOutcome === 'returned'));
    // Legacy model-facing summary is intentionally unchanged in this statistics-only step.
    const job = service.query(scope, { jobId: result.job_id }) as {
      toolCalls?: { counts: Record<string, unknown> };
    };
    assert.deepEqual(job.toolCalls?.counts.demo, {
      error: 1,
      ok: 6,
      unknown: 1,
    });
    const serialized = JSON.stringify({ starts, ends });
    assert.ok(!serialized.includes('argument-secret'));
    assert.ok(!serialized.includes('private-code-body'));
    assert.ok(!serialized.includes('duplicate'));
  } finally {
    await service.stop();
    store.close();
  }
});

test('observer failures cannot replace tool output, stop dispatch, or cause a retry', async () => {
  const store = new SandboxJobStore({ path: ':memory:' });
  let calls = 0,
    observations = 0;
  const service = new SandboxService({
    store,
    observer: {
      start() {
        observations++;
        throw new Error('observer-start');
      },
      end() {
        observations++;
        throw new Error('observer-end');
      },
    },
    executor: (options) => ({
      result: options.callTool!('demo', {}, new AbortController().signal).then(
        (value) => completed(JSON.stringify(value)),
      ),
      cancel() {},
    }),
  });
  service.setToolBridge({
    names: () => ['demo'],
    async call() {
      calls++;
      return { status: 'submitted', value: 'kept' };
    },
  });
  try {
    const result = await service.execute(input, undefined, caller);
    assert.equal(result.status, 'completed');
    assert.equal(
      'value' in result ? result.value : null,
      '{"status":"submitted","value":"kept"}',
    );
    assert.equal(calls, 1);
    assert.equal(observations, 2);
  } finally {
    await service.stop();
    store.close();
  }
});

test('cancelled job can receive a late tool end without inventing cancellation of its effect', async () => {
  const store = new SandboxJobStore({ path: ':memory:' });
  const host = deferred<JsonObject>(),
    execution = deferred<ExecutionResult>();
  const starts: ToolObservationStart[] = [],
    ends: ToolObservationEnd[] = [];
  let hostPromise!: Promise<unknown>;
  const service = new SandboxService({
    store,
    observer: {
      start: (v) => {
        starts.push(v);
      },
      end: (v) => {
        ends.push(v);
      },
    },
    executor: (options) => {
      hostPromise = options.callTool!('demo', {}, new AbortController().signal);
      return {
        result: execution.promise,
        cancel() {
          execution.resolve({
            status: 'cancelled',
            error: 'cancelled',
            logs: [],
          });
        },
      };
    },
  });
  service.setToolBridge({ names: () => ['demo'], call: () => host.promise });
  try {
    const { waitMs: _wait, ...asyncInput } = input;
    const result = await service.execute(
      { ...asyncInput, mode: 'async' },
      undefined,
      caller,
    );
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 0);
    assert.ok(result.job_id);
    service.cancel(scope, result.job_id!);
    assert.equal(ends.length, 0);
    host.resolve({ status: 'executed' });
    assert.deepEqual(await hostPromise, { status: 'executed' });
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.jobId, starts[0]?.jobId);
    assert.equal(ends[0]?.resultStatus, 'executed');
    assert.equal(ends[0]?.bridgeOutcome, 'returned');
  } finally {
    host.resolve({ status: 'unknown' });
    await service.stop();
    store.close();
  }
});

test('bridge adaptation failures remain distinguishable and do not retain thrown error text', async () => {
  for (const mode of ['threw', 'invalid_result', 'unavailable'] as const) {
    const store = new SandboxJobStore({ path: ':memory:' });
    const ends: ToolObservationEnd[] = [];
    const service = new SandboxService({
      store,
      observer: {
        start() {},
        end: (v) => {
          ends.push(v);
        },
      },
      executor: (options) => ({
        result: options.callTool!(
          'demo',
          {},
          new AbortController().signal,
        ).then((v) => completed(JSON.stringify(v))),
        cancel() {},
      }),
    });
    service.setToolBridge({
      names: () => ['demo'],
      async call() {
        if (mode === 'threw') {
          throw new Error('private-error-secret');
        }
        return null as unknown as JsonObject;
      },
    });
    try {
      const result = await service.execute(
        input,
        undefined,
        mode === 'unavailable' ? undefined : caller,
      );
      assert.equal(result.status, 'completed');
      assert.equal(ends[0]?.bridgeOutcome, mode);
      assert.equal(ends[0]?.resultStatus, 'error');
      assert.ok(!JSON.stringify(ends).includes('private-error-secret'));
    } finally {
      await service.stop();
      store.close();
    }
  }
});

test('observation projection retains only bounded identifier metadata and never invokes getters', () => {
  let invoked = 0;
  const accessors = {
    get status() {
      invoked++;
      return 'ok';
    },
    get error() {
      invoked++;
      return 'secret';
    },
  };
  assert.deepEqual(observationResult(accessors), {
    resultStatus: null,
    statusKind: 'invalid',
    errorCode: null,
  });
  assert.equal(invoked, 0);
  for (const status of [
    'partial\n',
    'partial\r',
    'partial\u2028',
    'partial\u2029',
    'x'.repeat(65),
    '自由文本',
  ]) {
    assert.deepEqual(observationResult({ status, error: 'code\n' }), {
      resultStatus: null,
      statusKind: 'invalid',
      errorCode: null,
    });
  }
  assert.deepEqual(
    observationResult({
      status: 'new_status',
      error: 'bounded_error',
      body: 'private',
    }),
    {
      resultStatus: 'new_status',
      statusKind: 'present',
      errorCode: 'bounded_error',
    },
  );
});
