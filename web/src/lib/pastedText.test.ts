import { describe, it, expect } from 'vitest'
import { countLines, detectCodeLanguage, fenceCode, getClipboardText } from './pastedText'

// A throwaway DataTransfer stand-in backed by a type→string map.
function fakeDt(data: Record<string, string>): DataTransfer {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer
}

describe('countLines', () => {
  it('counts newline-separated lines', () => {
    expect(countLines('a\nb\nc')).toBe(3)
  })
  it('is 0 for empty text', () => {
    expect(countLines('')).toBe(0)
  })
  it('ignores a single trailing newline', () => {
    expect(countLines('a\nb\n')).toBe(2)
  })
})

describe('getClipboardText', () => {
  it('reads the text/plain payload', () => {
    expect(getClipboardText(fakeDt({ 'text/plain': 'hi' }))).toBe('hi')
  })
  it('returns empty string for null', () => {
    expect(getClipboardText(null)).toBe('')
  })
})

describe('detectCodeLanguage', () => {
  it('uses the VS Code editor mode as the fence tag', () => {
    const dt = fakeDt({ 'text/plain': 'package main', 'vscode-editor-data': '{"mode":"go"}' })
    expect(detectCodeLanguage(dt)).toBe('go')
  })
  it('maps editor modes without a conventional fence tag', () => {
    const dt = fakeDt({ 'text/plain': 'x', 'vscode-editor-data': '{"mode":"typescriptreact"}' })
    expect(detectCodeLanguage(dt)).toBe('tsx')
  })
  it('ignores a plaintext VS Code mode', () => {
    const dt = fakeDt({ 'text/plain': 'just words', 'vscode-editor-data': '{"mode":"plaintext"}' })
    expect(detectCodeLanguage(dt)).toBeNull()
  })
  it('falls back to html when markup is offered as text/html', () => {
    const dt = fakeDt({ 'text/plain': '<div>Test123123</div>', 'text/html': '<div>Test123123</div>' })
    expect(detectCodeLanguage(dt)).toBe('html')
  })
  it('does not treat plain prose copied as text/html as code', () => {
    const dt = fakeDt({ 'text/plain': 'Just some copied prose.', 'text/html': '<p>Just some copied prose.</p>' })
    expect(detectCodeLanguage(dt)).toBeNull()
  })
  it('returns null for a plain text paste', () => {
    expect(detectCodeLanguage(fakeDt({ 'text/plain': 'hello' }))).toBeNull()
  })
})

describe('fenceCode', () => {
  it('wraps text in a tagged fence', () => {
    expect(fenceCode('<div>Test123123</div>', 'html')).toBe('```html\n<div>Test123123</div>\n```')
  })
})
