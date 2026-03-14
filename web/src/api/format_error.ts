import { ApiError } from './index';

export function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.body && typeof err.body === 'object' && 'details' in err.body) {
      return (err.body as any).details;
    }
    return err.message || err.statusText || 'Unknown API Error';
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
