import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getLogContext,
  withLogContext,
  sanitizeLogFields,
} from '../../../src/observability/logger.ts';
import { TelemetryStore } from '../../../src/observability/telemetry.ts';

test('request telemetry trace remains scoped across concurrent async operations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-context-')),
    store = new TelemetryStore(join(dir, 'metrics.sqlite'));
  try {
    await Promise.all(
      ['111', '222'].map((groupId, index) =>
        withLogContext(
          {
            group_id: groupId,
            turn_id: `t_${String(index).repeat(16)}`,
            phase: 'conversation',
            body: 'PRIVATE',
          },
          async () => {
            await Promise.resolve();
            const trace = getLogContext();
            assert.equal(trace.group_id, groupId);
            assert.equal(trace.body, undefined);
            store.record({
              requestId: `request-${index}`,
              startedAt: 100,
              endedAt: 101,
              durationMs: 0.5,
              transport: 'chat',
              model: 'test',
              status: 'success',
              usage: {
                inputTokens: 100,
                outputTokens: 10,
                cachedInputTokens: index * 50,
              },
              groupId: String(trace.group_id),
              turnId: String(trace.turn_id),
              phase: String(trace.phase),
            });
          },
        ),
      ),
    );
    assert.deepEqual(getLogContext(), {});
    assert.equal(
      store.summarize({ since: 0, until: 1000, groupId: '111' }).cacheHitRate,
      0,
    );
    assert.equal(
      store.summarize({ since: 0, until: 1000, groupId: '222' }).cacheHitRate,
      0.5,
    );
    assert.equal(store.summarize({ since: 0, until: 1000 }).cacheHitRate, 0.25);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('world tool names remain observable without arbitrary names', () => {
  const tools = ['get_wake_state', 'get_time', 'read_events'];
  assert.deepEqual(sanitizeLogFields({ tools: [...tools, 'SECRET'] }), {
    tools,
  });
  for (const tool of tools) {
    assert.deepEqual(sanitizeLogFields({ tool }), { tool });
  }
});

test('normalized usage fields are loggable without prompt contents', () => {
  assert.deepEqual(
    sanitizeLogFields({
      input_tokens: 100,
      output_tokens: 10,
      cached_input_tokens: 50,
      reasoning_tokens: 2,
      cache_hit_rate: 0.5,
      content: 'PRIVATE',
    }),
    {
      input_tokens: 100,
      output_tokens: 10,
      cached_input_tokens: 50,
      reasoning_tokens: 2,
      cache_hit_rate: 0.5,
    },
  );
});
