import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import type {
  ToolCallObserver,
  ToolObservationStart,
  ToolObservationEnd,
} from '../contracts/tool-observation.ts';

import { TOOL_OBSERVATION_SCHEMA_VERSION } from '../contracts/tool-observation.ts';

export { TOOL_OBSERVATION_SCHEMA_VERSION } from '../contracts/tool-observation.ts';

interface Options {
  now?: () => number;
  maxRows?: number;
  retentionMs?: number;
  onError?: () => void;
}

const time = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 128 &&
  !/[\u0000-\u001f\u007f]/.test(v);
const startKeys = [
  'selfId',
  'groupId',
  'jobId',
  'seq',
  'tool',
  'startedAt',
] as const;
const endKeys = [
  'finishedAt',
  'resultStatus',
  'statusKind',
  'errorCode',
  'bridgeOutcome',
] as const;

/** Copy only own scalar data descriptors: never invoke getters, proxies or serializers. */
function snapshot(
  value: unknown,
  end: boolean,
): ToolObservationEnd | ToolObservationStart | null {
  if (!value || typeof value !== 'object' || types.isProxy(value)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of [...startKeys, ...(end ? endKeys : [])]) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d)) {
      return null;
    }
    out[key] = d.value;
  }
  if (
    !['selfId', 'groupId', 'jobId'].every((k) => text(out[k])) ||
    !text(out.tool) ||
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}(?![\s\S])/.test(out.tool) ||
    !time(out.seq) ||
    out.seq < 1 ||
    !time(out.startedAt)
  ) {
    return null;
  }
  if (
    end &&
    (!time(out.finishedAt) ||
      typeof out.statusKind !== 'string' ||
      !['present', 'missing', 'invalid'].includes(out.statusKind) ||
      typeof out.bridgeOutcome !== 'string' ||
      !['returned', 'threw', 'unavailable', 'invalid_result'].includes(
        out.bridgeOutcome,
      ) ||
      (out.statusKind === 'present'
        ? !text(out.resultStatus) ||
          !/^[-a-zA-Z0-9_]{1,64}(?![\s\S])/.test(out.resultStatus)
        : out.resultStatus !== null) ||
      (out.errorCode !== null &&
        (!text(out.errorCode) ||
          !/^[-a-zA-Z0-9_]{1,128}(?![\s\S])/.test(out.errorCode))))
  ) {
    return null;
  }
  return out as unknown as ToolObservationEnd;
}

/** Optional observed lower-bound ledger; never a source of execution or permission decisions. */
export class ToolObservationStore implements ToolCallObserver {
  private readonly db: DatabaseSync;
  private readonly runId = randomUUID();
  private runStartedAt = 0;
  private readonly now: () => number;
  private readonly maxRows: number;
  private readonly retentionMs: number;
  private closed = false;
  private dropped = 0;
  constructor(
    path: string,
    private readonly options: Options = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxRows = options.maxRows ?? 50000;
    this.retentionMs = options.retentionMs ?? 7 * 86400000;
    if (
      !path ||
      path === ':memory:' ||
      path.includes('\0') ||
      !Number.isSafeInteger(this.maxRows) ||
      this.maxRows < 1 ||
      !time(this.retentionMs) ||
      this.retentionMs < 1
    ) {
      throw new Error('Invalid tool observation options');
    }
    const fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1) {
        throw new Error('Invalid tool observation path');
      }
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    this.db = new DatabaseSync(path);
    try {
      const now = this.clock();
      this.db
        .exec(`PRAGMA busy_timeout=250; PRAGMA secure_delete=ON; BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS tool_observation_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,collection_started_at INTEGER NOT NULL,retained_since INTEGER NOT NULL,historical_dropped_events INTEGER NOT NULL DEFAULT 0,historical_conflicts INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS tool_observation_runs(run_id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,ended_at INTEGER,dropped_events INTEGER NOT NULL,conflicts INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS tool_call_observations(self_id TEXT NOT NULL,group_id TEXT NOT NULL,job_id TEXT NOT NULL,seq INTEGER NOT NULL,tool TEXT NOT NULL,run_id TEXT NOT NULL,started_at INTEGER NOT NULL,start_observed INTEGER NOT NULL,finished_at INTEGER,end_observed INTEGER NOT NULL,result_status TEXT,status_kind TEXT,error_code TEXT,bridge_outcome TEXT,interrupted_at INTEGER,observed_at INTEGER NOT NULL,PRIMARY KEY(self_id,group_id,job_id,seq));
        CREATE INDEX IF NOT EXISTS tool_observations_group_started ON tool_call_observations(group_id,started_at,self_id,job_id,seq);
        CREATE INDEX IF NOT EXISTS tool_observations_started ON tool_call_observations(started_at);
        CREATE INDEX IF NOT EXISTS tool_observations_run ON tool_call_observations(run_id);
        CREATE INDEX IF NOT EXISTS tool_observation_runs_started ON tool_observation_runs(started_at);`);
      this.db
        .prepare(
          'INSERT OR IGNORE INTO tool_observation_meta(singleton,schema_version,collection_started_at,retained_since) VALUES(1,?,?,0)',
        )
        .run(TOOL_OBSERVATION_SCHEMA_VERSION, now);
      if (
        this.db
          .prepare(
            'SELECT schema_version FROM tool_observation_meta WHERE singleton=1',
          )
          .get()?.schema_version !== TOOL_OBSERVATION_SCHEMA_VERSION
      ) {
        throw new Error('Unsupported tool observation schema');
      }
      this.runStartedAt = now;
      this.ensureRun();
      this.cleanup(now);
      this.db.exec('COMMIT; PRAGMA busy_timeout=0;');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* no transaction */
      }
      this.db.close();
      throw error;
    }
  }

  private clock(): number {
    const now = this.now();
    if (!time(now)) {
      throw new Error('Invalid observation clock');
    }
    return now;
  }

  private failure(): void {
    this.dropped++;
    try {
      this.options.onError?.();
    } catch {
      /* optional diagnostic */
    }
  }

  start(value: ToolObservationStart): void {
    this.record(value, false);
  }

  end(value: ToolObservationEnd): void {
    this.record(value, true);
  }

  private record(value: unknown, end: boolean): void {
    if (this.closed) {
      this.failure();
      return;
    }
    let transaction = false;
    try {
      const v = snapshot(value, end);
      if (!v) {
        this.failure();
        return;
      }
      const now = this.clock();
      this.db.exec('BEGIN IMMEDIATE');
      transaction = true;
      this.ensureRun();
      this.cleanup(now);
      const floor = Number(
        this.db
          .prepare(
            'SELECT retained_since FROM tool_observation_meta WHERE singleton=1',
          )
          .get()!.retained_since,
      );
      const key = [v.selfId, v.groupId, v.jobId, v.seq];
      const old = this.db
        .prepare(
          'SELECT * FROM tool_call_observations WHERE self_id=? AND group_id=? AND job_id=? AND seq=?',
        )
        .get(...key);
      if (v.startedAt < floor || v.startedAt < now - this.retentionMs) {
        this.db
          .prepare(
            'UPDATE tool_observation_runs SET dropped_events=dropped_events+1 WHERE run_id=?',
          )
          .run(this.runId);
      } else if (
        old &&
        (old.tool !== v.tool ||
          old.started_at !== v.startedAt ||
          old.run_id !== this.runId)
      ) {
        this.conflict();
      } else {
        const e = end ? (v as ToolObservationEnd) : null;
        if (!old) {
          this.db
            .prepare(
              'INSERT INTO tool_call_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            )
            .run(
              ...key,
              v.tool,
              this.runId,
              v.startedAt,
              end ? 0 : 1,
              e?.finishedAt ?? null,
              end ? 1 : 0,
              e?.resultStatus ?? null,
              e?.statusKind ?? null,
              e?.errorCode ?? null,
              e?.bridgeOutcome ?? null,
              null,
              now,
            );
        } else if (e && old.end_observed === 1) {
          if (
            old.finished_at !== e.finishedAt ||
            old.result_status !== e.resultStatus ||
            old.status_kind !== e.statusKind ||
            old.error_code !== e.errorCode ||
            old.bridge_outcome !== e.bridgeOutcome
          ) {
            this.conflict();
          }
        } else if (e) {
          this.db
            .prepare(
              'UPDATE tool_call_observations SET finished_at=?,end_observed=1,result_status=?,status_kind=?,error_code=?,bridge_outcome=?,observed_at=? WHERE self_id=? AND group_id=? AND job_id=? AND seq=?',
            )
            .run(
              e.finishedAt,
              e.resultStatus,
              e.statusKind,
              e.errorCode,
              e.bridgeOutcome,
              now,
              ...key,
            );
        } else if (old.start_observed === 0) {
          this.db
            .prepare(
              'UPDATE tool_call_observations SET start_observed=1,observed_at=? WHERE self_id=? AND group_id=? AND job_id=? AND seq=?',
            )
            .run(now, ...key);
        }
      }
      this.cleanup(now);
      this.db
        .prepare(
          'UPDATE tool_observation_runs SET dropped_events=dropped_events+? WHERE run_id=?',
        )
        .run(this.dropped, this.runId);
      this.db.exec('COMMIT');
      transaction = false;
      this.dropped = 0;
    } catch {
      if (transaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* unavailable */
        }
      }
      this.failure();
    }
  }

  private conflict(): void {
    this.db
      .prepare(
        'UPDATE tool_observation_runs SET conflicts=conflicts+1 WHERE run_id=?',
      )
      .run(this.runId);
  }

  /** Advance a conservative timestamp floor, including ties, so pruned identities cannot resurrect. */
  private cleanup(now: number): void {
    const expired = this.db
      .prepare(
        'SELECT MAX(started_at) AS t FROM tool_call_observations WHERE started_at<?',
      )
      .get(now - this.retentionMs)?.t;
    const overflow = this.db
      .prepare(
        'SELECT started_at AS t FROM tool_call_observations ORDER BY started_at DESC LIMIT 1 OFFSET ?',
      )
      .get(this.maxRows)?.t;
    const removed = Math.max(
      typeof expired === 'number' ? expired : -1,
      typeof overflow === 'number' ? overflow : -1,
    );
    if (removed >= 0) {
      const floor = Math.min(Number.MAX_SAFE_INTEGER, removed + 1);
      this.db
        .prepare('DELETE FROM tool_call_observations WHERE started_at<?')
        .run(floor);
      this.db
        .prepare(
          'UPDATE tool_observation_meta SET retained_since=MAX(retained_since,?) WHERE singleton=1',
        )
        .run(floor);
    }
    // Keep all referenced runs, plus at most 5000 unreferenced runs. An idle
    // live writer whose empty run is pruned re-creates it on its next event.
    const obsolete = this.db
      .prepare(
        `SELECT run_id,dropped_events,conflicts FROM tool_observation_runs r
      WHERE run_id!=? AND NOT EXISTS(SELECT 1 FROM tool_call_observations c WHERE c.run_id=r.run_id)
      AND (started_at<? OR run_id IN (SELECT run_id FROM tool_observation_runs x
        WHERE run_id!=? AND NOT EXISTS(SELECT 1 FROM tool_call_observations c WHERE c.run_id=x.run_id)
        ORDER BY started_at DESC,run_id DESC LIMIT -1 OFFSET 4999))`,
      )
      .all(this.runId, now - this.retentionMs, this.runId);
    for (const run of obsolete) {
      this.db
        .prepare(
          'UPDATE tool_observation_meta SET historical_dropped_events=historical_dropped_events+?,historical_conflicts=historical_conflicts+? WHERE singleton=1',
        )
        .run(Number(run.dropped_events), Number(run.conflicts));
      this.db
        .prepare('DELETE FROM tool_observation_runs WHERE run_id=?')
        .run(String(run.run_id));
    }
  }

  private ensureRun(): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO tool_observation_runs VALUES(?,?,NULL,0,0)',
      )
      .run(this.runId, this.runStartedAt);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    try {
      const now = this.clock();
      this.db.exec('BEGIN IMMEDIATE');
      this.ensureRun();
      this.db
        .prepare(
          'UPDATE tool_call_observations SET interrupted_at=COALESCE(interrupted_at,?),observed_at=? WHERE run_id=? AND end_observed=0',
        )
        .run(now, now, this.runId);
      this.db
        .prepare(
          'UPDATE tool_observation_runs SET ended_at=?,dropped_events=dropped_events+? WHERE run_id=?',
        )
        .run(now, this.dropped, this.runId);
      this.db.exec('COMMIT');
      this.dropped = 0;
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* unavailable */
      }
      this.failure();
    } finally {
      this.closed = true;
      try {
        this.db.close();
      } catch {
        /* optional store */
      }
    }
  }
}
