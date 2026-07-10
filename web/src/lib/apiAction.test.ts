import { describe, it, expect, beforeEach } from 'vitest'
import { runWithToast } from './apiAction'
import { useToastStore } from '../stores/toastStore'
import { ApiError } from '../api'
import type { ApiRequestOptions } from '../api/core/ApiRequestOptions'
import type { ApiResult } from '../api/core/ApiResult'

function apiError(body: unknown, message = ''): ApiError {
  const request = {} as ApiRequestOptions
  const response = { url: '/api/x', ok: false, status: 500, statusText: '', body } as ApiResult
  return new ApiError(request, response, message)
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
})

describe('runWithToast', () => {
  it('returns the resolved value on success without a toast by default', async () => {
    const res = await runWithToast(() => Promise.resolve(42))
    expect(res).toEqual({ ok: true, value: 42 })
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('distinguishes a successful void action from a failure', async () => {
    const res = await runWithToast(() => Promise.resolve())
    expect(res.ok).toBe(true)
  })

  it('shows a success toast when `success` is provided', async () => {
    await runWithToast(() => Promise.resolve('x'), { success: 'Saved' })
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ message: 'Saved', type: 'success' })
  })

  it('shows an error toast via formatError on failure and reports !ok', async () => {
    const err = apiError({ details: 'pull conflicts' })
    const res = await runWithToast(() => Promise.reject(err))
    expect(res).toEqual({ ok: false, error: err })
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ message: 'pull conflicts', type: 'error' })
  })

  it('prefixes the error message when `errorPrefix` is provided', async () => {
    const res = await runWithToast(() => Promise.reject(new Error('boom')), { errorPrefix: 'Failed to rename agent' })
    expect(res.ok).toBe(false)
    expect(useToastStore.getState().toasts[0].message).toBe('Failed to rename agent: boom')
    expect(useToastStore.getState().toasts[0].code).toBeUndefined()
  })

  it('splits a code-like error detail into a code block under the prefix headline', async () => {
    const err = new Error('Generic Error: status: 501; body: { "error": "Not implemented in simulation mode" }')
    const res = await runWithToast(() => Promise.reject(err), { errorPrefix: 'Failed to switch mode' })
    expect(res.ok).toBe(false)
    const toast = useToastStore.getState().toasts[0]
    expect(toast.message).toBe('Failed to switch mode')
    expect(toast.code).toBe(err.message)
  })
})
