import { describe, expect, it } from 'vitest'
import { providerErrorText } from './providerError'

describe('providerErrorText', () => {
  it('unwraps a JSON API error nested inside an app-server message', () => {
    const error = {
      message: JSON.stringify({
        type: 'error',
        status: 400,
        error: {
          type: 'invalid_request_error',
          message: "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.",
        },
      }),
      codexErrorInfo: 'other',
      additionalDetails: null,
    }

    expect(providerErrorText(error)).toBe(
      "invalid_request_error, HTTP 400: The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.",
    )
  })

  it('retains plain and unknown structured errors', () => {
    expect(providerErrorText({ message: 'Connection closed' })).toBe('Connection closed')
    expect(providerErrorText({ code: 17, reason: 'unknown' })).toBe('{\n  "code": 17,\n  "reason": "unknown"\n}')
  })
})
