import { describe, it, expect } from 'vitest'
import { formatError } from './format_error'
import { ApiError } from './index'
import type { ApiRequestOptions } from './core/ApiRequestOptions'
import type { ApiResult } from './core/ApiResult'

// Build an ApiError without going through the HTTP layer. The constructor only
// reads url/status/statusText/body off the response, so a partial is enough.
function apiError(opts: { status?: number; statusText?: string; body?: unknown; message?: string }): ApiError {
  const request = {} as ApiRequestOptions
  const response = {
    url: '/api/x',
    ok: false,
    status: opts.status ?? 500,
    statusText: opts.statusText ?? '',
    body: opts.body,
  } as ApiResult
  return new ApiError(request, response, opts.message ?? '')
}

describe('formatError', () => {
  it('prefers an API error body.details when present', () => {
    const err = apiError({ body: { details: 'pull conflicts' }, message: 'fallback' })
    expect(formatError(err)).toBe('pull conflicts')
  })

  it('falls back to the API error message when there is no details', () => {
    const err = apiError({ body: { other: 'x' }, message: 'boom' })
    expect(formatError(err)).toBe('boom')
  })

  it('falls back to statusText when an API error has no message or details', () => {
    const err = apiError({ statusText: 'Not Found', body: undefined, message: '' })
    expect(formatError(err)).toBe('Not Found')
  })

  it('uses a generic label when an API error carries nothing usable', () => {
    const err = apiError({ statusText: '', body: undefined, message: '' })
    expect(formatError(err)).toBe('Unknown API Error')
  })

  it('returns the message of a plain Error', () => {
    expect(formatError(new Error('kaboom'))).toBe('kaboom')
  })

  it('stringifies non-Error values', () => {
    expect(formatError('just a string')).toBe('just a string')
    expect(formatError(42)).toBe('42')
  })
})
