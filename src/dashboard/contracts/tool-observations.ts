/** Role and invocation path are independent; role does not judge a tool's usefulness. */
export type ToolUsageRole = 'tool' | 'flow_control' | 'javascript_dispatch';
export const TOOL_USAGE_ROLE_VERSION = 1;

export function toolUsageRole(name: string): ToolUsageRole {
  if (name === 'finish' || name === 'ack_events') {
    return 'flow_control';
  }
  if (
    [
      'execute_javascript',
      'query_javascript_jobs',
      'cancel_javascript_job',
    ].includes(name)
  ) {
    return 'javascript_dispatch';
  }
  return 'tool';
}

/** Retained JavaScript host-tool observations. Never inferred from code, job queries, or notifications. */
export interface InternalToolSummary {
  name: string;
  observedCalls: number;
  withStart: number;
  withEnd: number;
  /** No end observation: may be in flight, lost, or interrupted; not proof of running or failure. */
  withoutEnd: number;
  withoutStart: number;
  /** Independent of end presence: a late end can coexist with an interruption observation. */
  interrupted: number;
  bridgeFailures: number;
  /** Only rows with an end observation; statuses are not external-effect confirmations. */
  statuses: Array<{
    kind: 'present' | 'missing' | 'invalid';
    status: string | null;
    calls: number;
  }>;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
}

export type ToolObservationCoverageReason =
  | 'collector_not_enabled'
  | 'before_collection'
  | 'retention_gap'
  | 'known_write_gaps'
  | 'incompatible_schema'
  | 'source_unavailable'
  | 'query_limit';

export interface InternalToolsResponse {
  /** No completeness promise: even readable counts are retained observations, not all effects. */
  coverage: {
    status: 'observed' | 'not_recorded' | 'unavailable' | 'unsupported';
    collectionStartedAt: number | null;
    retainedSince: number | null;
    reasons: ToolObservationCoverageReason[];
  };
  items: InternalToolSummary[];
}
