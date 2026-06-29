import { ApiError } from './index';
import type { ErrorResponse } from './models/ErrorResponse';

// The JSON body our API returns on a failure. Every handler writes the
// ErrorResponse shape (see api/openapi.yaml), and the merge/update endpoints
// extend it with the MergeConflictError fields below. Fields are optional
// because a non-API failure (a proxy, a 502, a network blip) can surface an
// ApiError whose body is a string or undefined.
export type ApiErrorBody = Partial<Omit<ErrorResponse, 'error'>> & {
  // Machine-readable error type. Widened to string: merge/update return codes
  // (uncommitted_changes, merge_conflict) outside the base ErrorResponse enum.
  error?: string;
  // For uncommitted_changes: the destination files whose local changes the
  // merge/update would overwrite (MergeConflictError).
  conflicting_files?: string[];
};

// If `err` is an ApiError carrying a structured JSON body, return it typed;
// otherwise undefined. Lets call sites read `.error` / `.conflicting_files`
// without an `as any` cast or a hand-rolled `typeof err.body === 'object'` check.
export function apiErrorBody(err: unknown): ApiErrorBody | undefined {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    return err.body as ApiErrorBody;
  }
  return undefined;
}

export function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const details = apiErrorBody(err)?.details;
    if (details) return details;
    return err.message || err.statusText || 'Unknown API Error';
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
