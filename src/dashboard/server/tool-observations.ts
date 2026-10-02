import type { DatabaseSync } from 'node:sqlite';
import { TOOL_OBSERVATION_SCHEMA_VERSION } from '../../contracts/tool-observation.ts';
import type { Range } from '../contracts/contracts.ts';
import type {
  InternalToolSummary,
  InternalToolsResponse,
  ToolObservationCoverageReason,
} from '../contracts/tool-observations.ts';
import type { Repository } from './repository.ts';

const LIMIT = 10000;
const required = {
  tool_observation_meta: [
    'singleton',
    'schema_version',
    'collection_started_at',
    'retained_since',
    'historical_dropped_events',
    'historical_conflicts',
  ],
  tool_observation_runs: [
    'run_id',
    'started_at',
    'ended_at',
    'dropped_events',
    'conflicts',
  ],
  tool_call_observations: [
    'self_id',
    'group_id',
    'job_id',
    'seq',
    'tool',
    'run_id',
    'started_at',
    'start_observed',
    'finished_at',
    'end_observed',
    'result_status',
    'status_kind',
    'error_code',
    'bridge_outcome',
    'interrupted_at',
    'observed_at',
  ],
};
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const flag = (v: unknown) => v === 0 || v === 1;
const quantile = (values: number[], p: number) =>
  values.length
    ? values.sort((a, b) => a - b)[
        Math.max(0, Math.ceil(values.length * p) - 1)
      ]!
    : null;

function unavailable(
  status: InternalToolsResponse['coverage']['status'],
  reason: ToolObservationCoverageReason,
): InternalToolsResponse {
  return {
    coverage: {
      status,
      collectionStartedAt: null,
      retainedSince: null,
      reasons: [reason],
    },
    items: [],
  };
}

function schema(db: DatabaseSync): 'missing' | 'incompatible' | 'ready' {
  const tables = db
    .prepare(
      "SELECT name,type FROM sqlite_master WHERE name IN ('tool_observation_meta','tool_observation_runs','tool_call_observations')",
    )
    .all();
  if (!tables.length) {
    return 'missing';
  }
  if (tables.length !== 3 || tables.some((r) => r.type !== 'table')) {
    return 'incompatible';
  }
  for (const [table, names] of Object.entries(required)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (names.some((name) => !columns.some((c) => c.name === name))) {
      return 'incompatible';
    }
    const keys =
      table === 'tool_call_observations'
        ? ['self_id', 'group_id', 'job_id', 'seq']
        : table === 'tool_observation_meta'
          ? ['singleton']
          : ['run_id'];
    if (
      columns.some((c) => Number(c.pk) !== keys.indexOf(String(c.name)) + 1)
    ) {
      return 'incompatible';
    }
    if (
      table === 'tool_call_observations' &&
      keys.some(
        (name) => !columns.some((c) => c.name === name && c.notnull === 1),
      )
    ) {
      return 'incompatible';
    }
  }
  // Force the authorized group/time range index, never an unbounded fallback scan.
  const indices = db.prepare('PRAGMA index_list(tool_call_observations)').all();
  if (
    !indices.some(
      (r) => r.name === 'tool_observations_group_started' && r.partial === 0,
    )
  ) {
    return 'incompatible';
  }
  const columns = db
    .prepare('PRAGMA index_xinfo(tool_observations_group_started)')
    .all()
    .filter((c) => c.key === 1);
  const names = ['group_id', 'started_at', 'self_id', 'job_id', 'seq'];
  return columns.length === names.length &&
    columns.every(
      (c, i) => c.name === names[i] && c.coll === 'BINARY' && c.desc === 0,
    )
    ? 'ready'
    : 'incompatible';
}

/** Read only the dedicated observation ledger, never sandbox.sqlite or summary snapshots. */
export function internalToolObservations(
  base: Repository,
  range: Range,
  groupId?: string,
): InternalToolsResponse {
  const db = base.telemetry();
  if (!db) {
    return unavailable('unavailable', 'source_unavailable');
  }
  try {
    const capability = schema(db);
    if (capability === 'missing') {
      return unavailable('not_recorded', 'collector_not_enabled');
    }
    if (capability !== 'ready') {
      return unavailable('unsupported', 'incompatible_schema');
    }
    const meta = db
      .prepare(
        'SELECT schema_version,collection_started_at,retained_since,historical_dropped_events,historical_conflicts FROM tool_observation_meta WHERE singleton=1',
      )
      .get();
    if (
      !meta ||
      meta.schema_version !== TOOL_OBSERVATION_SCHEMA_VERSION ||
      !integer(meta.collection_started_at) ||
      !integer(meta.retained_since) ||
      !integer(meta.historical_dropped_events) ||
      !integer(meta.historical_conflicts)
    ) {
      return unavailable('unsupported', 'incompatible_schema');
    }
    const coverage: InternalToolsResponse['coverage'] = {
      status: 'observed',
      collectionStartedAt: meta.collection_started_at,
      retainedSince: meta.retained_since,
      reasons: [],
    };
    if (range.since < meta.collection_started_at) {
      coverage.reasons.push('before_collection');
    }
    if (range.since < meta.retained_since) {
      coverage.reasons.push('retention_gap');
    }
    // These are lifetime collector warnings, not a claim that every selected group lost a call.
    const runs = db
      .prepare(
        'SELECT dropped_events,conflicts FROM tool_observation_runs LIMIT 55001',
      )
      .all();
    if (runs.length > 55000) {
      return unavailable('unavailable', 'query_limit');
    }
    if (!runs.length) {
      return unavailable('not_recorded', 'collector_not_enabled');
    }
    if (runs.some((r) => !integer(r.dropped_events) || !integer(r.conflicts))) {
      return unavailable('unsupported', 'incompatible_schema');
    }
    if (
      meta.historical_dropped_events > 0 ||
      meta.historical_conflicts > 0 ||
      runs.some((r) => Number(r.dropped_events) > 0 || Number(r.conflicts) > 0)
    ) {
      coverage.reasons.push('known_write_gaps');
    }
    const query = db.prepare(`SELECT
      CASE WHEN typeof(tool)='text' AND length(CAST(tool AS BLOB))<=128 THEN tool END name,
      started_at,start_observed,finished_at,end_observed,interrupted_at,
      CASE WHEN typeof(result_status)='text' AND length(CAST(result_status AS BLOB))<=64 THEN result_status END result_status,
      CASE WHEN length(CAST(status_kind AS BLOB))<=16 THEN status_kind END status_kind,
      CASE WHEN length(CAST(bridge_outcome AS BLOB))<=32 THEN bridge_outcome END bridge_outcome
      FROM tool_call_observations INDEXED BY tool_observations_group_started
      WHERE group_id COLLATE BINARY=? AND started_at>=? AND started_at<=?
      ORDER BY started_at,self_id COLLATE BINARY,job_id COLLATE BINARY,seq LIMIT ?`);
    const grouped = new Map<
      string,
      { item: InternalToolSummary; durations: number[] }
    >();
    let count = 0;
    for (const group of base.groups.filter(
      (g) => !groupId || g.groupId === groupId,
    )) {
      const rows = query.all(
        group.groupId,
        range.since,
        range.until,
        LIMIT - count + 1,
      );
      count += rows.length;
      if (count > LIMIT) {
        return unavailable('unavailable', 'query_limit');
      }
      for (const row of rows) {
        if (
          typeof row.name !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}(?![\s\S])/.test(row.name) ||
          !integer(row.started_at) ||
          !flag(row.start_observed) ||
          !flag(row.end_observed) ||
          (row.start_observed === 0 && row.end_observed === 0) ||
          (row.finished_at !== null && !integer(row.finished_at)) ||
          (row.interrupted_at !== null && !integer(row.interrupted_at))
        ) {
          return unavailable('unsupported', 'incompatible_schema');
        }
        if (
          row.end_observed === 1 &&
          (!integer(row.finished_at) ||
            !['present', 'missing', 'invalid'].includes(
              String(row.status_kind),
            ) ||
            !['returned', 'threw', 'unavailable', 'invalid_result'].includes(
              String(row.bridge_outcome),
            ) ||
            (row.status_kind === 'present'
              ? typeof row.result_status !== 'string' ||
                !/^[-a-zA-Z0-9_]{1,64}(?![\s\S])/.test(row.result_status)
              : row.result_status !== null))
        ) {
          return unavailable('unsupported', 'incompatible_schema');
        }
        if (
          row.end_observed === 0 &&
          (row.finished_at !== null ||
            row.result_status !== null ||
            row.status_kind !== null ||
            row.bridge_outcome !== null)
        ) {
          return unavailable('unsupported', 'incompatible_schema');
        }
        let entry = grouped.get(row.name);
        if (!entry) {
          if (grouped.size >= 512) {
            return unavailable('unavailable', 'query_limit');
          }
          entry = {
            item: {
              name: row.name,
              observedCalls: 0,
              withStart: 0,
              withEnd: 0,
              withoutEnd: 0,
              withoutStart: 0,
              interrupted: 0,
              bridgeFailures: 0,
              statuses: [],
              durationP50Ms: null,
              durationP95Ms: null,
            },
            durations: [],
          };
          grouped.set(row.name, entry);
        }
        const { item, durations } = entry;
        item.observedCalls++;
        if (row.start_observed === 1) {
          item.withStart++;
        } else {
          item.withoutStart++;
        }
        if (row.interrupted_at !== null) {
          item.interrupted++;
        }
        if (row.end_observed === 1) {
          item.withEnd++;
          if (row.bridge_outcome !== 'returned') {
            item.bridgeFailures++;
          }
          const kind = row.status_kind as 'present' | 'missing' | 'invalid';
          const status = row.result_status as string | null;
          const bucket = item.statuses.find(
            (s) => s.kind === kind && s.status === status,
          );
          if (bucket) {
            bucket.calls++;
          } else {
            if (item.statuses.length >= 64) {
              return unavailable('unavailable', 'query_limit');
            }
            item.statuses.push({ kind, status, calls: 1 });
          }
          if (
            row.start_observed === 1 &&
            Number(row.finished_at) >= row.started_at
          ) {
            durations.push(Number(row.finished_at) - row.started_at);
          }
        } else {
          item.withoutEnd++;
        }
      }
    }
    const items = [...grouped.values()]
      .map(({ item, durations }) => ({
        ...item,
        statuses: item.statuses.sort(
          (a, b) =>
            a.kind.localeCompare(b.kind) ||
            (a.status ?? '').localeCompare(b.status ?? ''),
        ),
        durationP50Ms: quantile(durations, 0.5),
        durationP95Ms: quantile(durations, 0.95),
      }))
      .sort(
        (a, b) =>
          b.observedCalls - a.observedCalls || a.name.localeCompare(b.name),
      );
    // A wall-clock rollback can leave real observations before the enable-time marker.
    // Never discard those facts merely because coverage metadata suggests an earlier window.
    if (!items.length && range.until < meta.collection_started_at) {
      coverage.status = 'not_recorded';
    }
    return { coverage, items };
  } catch {
    return unavailable('unavailable', 'source_unavailable');
  }
}
