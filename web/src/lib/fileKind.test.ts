import { describe, it, expect } from 'vitest'
import { fileKind, langFromPath } from './fileKind'

// fileKind is what decides whether clicking a file leads to a picture, a player,
// a text pane, or a download card - so the cases that matter are the ones where
// guessing wrong is user-visible: a .webm treated as a picture (broken image), an
// .apk treated as text (a megabyte of mojibake), a .pdf treated as either.
describe('fileKind', () => {
  it('classifies the artifact media types', () => {
    expect(fileKind('home.png')).toBe('image')
    expect(fileKind('shot.JPEG')).toBe('image')
    expect(fileKind('icon.svg')).toBe('image')
    expect(fileKind('loader-animation.webm')).toBe('video')
    expect(fileKind('demo.mp4')).toBe('video')
    expect(fileKind('spec.pdf')).toBe('pdf')
    expect(fileKind('app-debug.apk')).toBe('binary')
    expect(fileKind('bundle.zip')).toBe('binary')
  })

  it('classifies text by extension, including source files', () => {
    expect(fileKind('build.log')).toBe('text')
    expect(fileKind('notes.txt')).toBe('text')
    expect(fileKind('data.json')).toBe('text')
    expect(fileKind('config.toml')).toBe('text')
    expect(fileKind('server.go')).toBe('text')
    expect(fileKind('Lightbox.tsx')).toBe('text')
    expect(fileKind('fix.patch')).toBe('text')
  })

  it('treats the conventional extensionless names as text', () => {
    expect(fileKind('README')).toBe('text')
    expect(fileKind('Makefile')).toBe('text')
    expect(fileKind('.gitignore')).toBe('text')
    expect(fileKind('src/LICENSE')).toBe('text')
  })

  it('falls back to binary for anything it cannot name', () => {
    // The safe direction: an unknown file gets the download card rather than
    // being fetched into a <pre> on the chance that it is text.
    expect(fileKind('core.dump')).toBe('binary')
    expect(fileKind('mystery')).toBe('binary')
    expect(fileKind('')).toBe('binary')
  })
})

describe('langFromPath', () => {
  it('maps extensions to Prism languages, and gives up quietly', () => {
    expect(langFromPath('a/b/server.go')).toBe('go')
    expect(langFromPath('deploy.sh')).toBe('bash')
    expect(langFromPath('config.toml')).toBe('ini')
    // A log has a grammar of its own, and it is eager - the chat highlights on
    // the spot, so a lazily-loaded one would render plain here.
    expect(langFromPath('watch.log')).toBe('log')
    expect(langFromPath('notes.txt')).toBe('')
    expect(langFromPath('Makefile')).toBe('')
  })
})
