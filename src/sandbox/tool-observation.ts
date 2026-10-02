import type { ToolObservationEnd } from '../contracts/tool-observation.ts';

type ResultFields = Pick<
  ToolObservationEnd,
  'resultStatus' | 'statusKind' | 'errorCode'
>;

/** Metadata only: never copy arguments, result bodies, arbitrary errors, or invoke accessors. */
export function observationResult(result: object): ResultFields {
  const status = Object.getOwnPropertyDescriptor(result, 'status');
  const error = Object.getOwnPropertyDescriptor(result, 'error');
  const present =
    status &&
    Object.hasOwn(status, 'value') &&
    typeof status.value === 'string' &&
    /^[-a-zA-Z0-9_]{1,64}(?![\s\S])/.test(status.value);
  return {
    resultStatus: present ? (status.value as string) : null,
    statusKind: !status ? 'missing' : present ? 'present' : 'invalid',
    errorCode:
      error &&
      Object.hasOwn(error, 'value') &&
      typeof error.value === 'string' &&
      /^[-a-zA-Z0-9_]{1,128}(?![\s\S])/.test(error.value)
        ? error.value
        : null,
  };
}
