import { describe, it, expect } from 'vitest'
import {
  countLines,
  detectCodeLanguage,
  extensionMime,
  fenceCode,
  getClipboardText,
  isLargePaste,
  pastedTextExtension,
  PASTE_CHAR_THRESHOLD,
} from './pastedText'

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

describe('isLargePaste', () => {
  it('is false for a short, narrow paste', () => {
    expect(isLargePaste('one\ntwo\nthree')).toBe(false)
  })
  it('is false at exactly the line threshold (8 lines)', () => {
    expect(isLargePaste('1\n2\n3\n4\n5\n6\n7\n8')).toBe(false)
  })
  it('is true just over the line threshold (9 lines)', () => {
    expect(isLargePaste('1\n2\n3\n4\n5\n6\n7\n8\n9')).toBe(true)
  })
  it('is true for a dense few-line blob over the char threshold', () => {
    expect(isLargePaste('x'.repeat(PASTE_CHAR_THRESHOLD + 1))).toBe(true)
  })
  it('is false for a single line at the char threshold', () => {
    expect(isLargePaste('x'.repeat(PASTE_CHAR_THRESHOLD))).toBe(false)
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

describe('pastedTextExtension', () => {
  it('uses the VS Code language, mapped to a file extension', () => {
    const dt = fakeDt({ 'text/plain': 'x', 'vscode-editor-data': '{"mode":"python"}' })
    expect(pastedTextExtension(dt)).toBe('py')
  })
  it('passes a language through when it already is the extension', () => {
    const dt = fakeDt({ 'text/plain': 'x', 'vscode-editor-data': '{"mode":"go"}' })
    expect(pastedTextExtension(dt)).toBe('go')
  })
  it('maps a VS Code markdown copy to md', () => {
    const dt = fakeDt({ 'text/plain': 'hi', 'vscode-editor-data': '{"mode":"markdown"}' })
    expect(pastedTextExtension(dt)).toBe('md')
  })
  it('does not sniff content - undeclared markdown-looking text stays txt', () => {
    const md = [
      '# Heading',
      '',
      '- [ ] task with a [link](https://example.com)',
      '',
      '| a | b |',
      '| --- | --- |',
    ].join('\n')
    expect(pastedTextExtension(fakeDt({ 'text/plain': md }))).toBe('txt')
  })
  it('falls back to txt for plain prose', () => {
    expect(pastedTextExtension(fakeDt({ 'text/plain': 'just some ordinary words here' }))).toBe('txt')
  })
  it('falls back to txt for a null clipboard', () => {
    expect(pastedTextExtension(null)).toBe('txt')
  })
})

describe('extensionMime', () => {
  it('maps md and html, defaulting to text/plain', () => {
    expect(extensionMime('md')).toBe('text/markdown')
    expect(extensionMime('html')).toBe('text/html')
    expect(extensionMime('ts')).toBe('text/plain')
  })
})
