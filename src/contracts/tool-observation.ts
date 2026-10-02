export const TOOL_OBSERVATION_SCHEMA_VERSION = 1;

/** One invocation arriving at the JavaScript host-tool boundary, not an external RPC or effect. */
export interface ToolObservationStart {
  selfId: string;
  groupId: string;
  jobId: string;
  seq: number;
  tool: string;
  startedAt: number;
}

/** Host boundary result before legacy summary normalization; not proof of script delivery or consumption. */
export interface ToolObservationEnd extends ToolObservationStart {
  finishedAt: number;
  resultStatus: string | null;
  statusKind: 'present' | 'missing' | 'invalid';
  errorCode: string | null;
  bridgeOutcome: 'returned' | 'threw' | 'unavailable' | 'invalid_result';
}

/** Observers must never determine the tool's permission, result, retry, or cancellation behavior. */
export interface ToolCallObserver {
  start(value: ToolObservationStart): void;
  end(value: ToolObservationEnd): void;
}
