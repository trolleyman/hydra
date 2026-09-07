// Browser-local rules for files that are normally machine-owned rather than
// reviewed line by line. The list is editable in Settings -> Browser. A
// conventional generator banner is detected separately because it describes
// the content rather than the path.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { StorageKeys, readLocal, singleFieldStorage, writeLocal } from './storage'

export const DEFAULT_GENERATED_FILE_GLOBS = [
  '{aube-lock.yaml,bun.lock,bun.lockb,Cargo.lock,composer.lock,flake.lock,Gemfile.lock,go.sum,mix.lock,npm-shrinkwrap.json,package-lock.json,Package.resolved,packages.lock.json,pdm.lock,Pipfile.lock,pnpm-lock.yaml,poetry.lock,pubspec.lock,uv.lock,yarn.lock}',
  '**/{generated,gen}/**',
  '{generated,gen}.*',
  '*{.,_,-}{generated,gen}.*',
  '*.g.dart',
  '*.pb.{go,cc,h,py,rb,php,cs,ts,js}',
  '*.designer.cs',
]

export interface GeneratedFileMatch {
  kind: 'banner' | 'glob'
  rule: string
}

function sameRules(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((rule, index) => rule === b[index])
}

export function loadGeneratedFileGlobs(): string[] {
  const raw = readLocal(StorageKeys.generatedFileGlobs)
  if (!raw) return [...DEFAULT_GENERATED_FILE_GLOBS]
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((rule) => typeof rule === 'string')) return parsed.slice(0, 100)
  } catch { /* fall back to the built-in rules */ }
  return [...DEFAULT_GENERATED_FILE_GLOBS]
}

function writeGeneratedFileGlobs(rules: string[]) {
  writeLocal(
    StorageKeys.generatedFileGlobs,
    sameRules(rules, DEFAULT_GENERATED_FILE_GLOBS) ? null : JSON.stringify(rules.slice(0, 100)),
  )
}

interface GeneratedFileRulesState {
  rules: string[]
  setRules: (rules: string[]) => void
}

export const useGeneratedFileRulesStore = create<GeneratedFileRulesState>()(
  persist(
    (set) => ({
      rules: loadGeneratedFileGlobs(),
      setRules: (rules) => set({ rules: rules.slice(0, 100) }),
    }),
    {
      name: StorageKeys.generatedFileGlobs,
      storage: singleFieldStorage('rules', loadGeneratedFileGlobs, writeGeneratedFileGlobs),
      partialize: (state) => ({ rules: state.rules }),
    },
  ),
)

// Expand the small brace-alternative form used by the defaults and accepted by
// the editor. Nested braces are intentionally out of scope; file globs rarely
// need them, and treating malformed input literally is safer than matching more
// paths than the user asked for.
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{')
  const close = open < 0 ? -1 : pattern.indexOf('}', open + 1)
  if (open < 0 || close < 0) return [pattern]
  const alternatives = pattern.slice(open + 1, close).split(',')
  if (alternatives.length < 2) return [pattern]
  return alternatives.flatMap((part) => expandBraces(`${pattern.slice(0, open)}${part}${pattern.slice(close + 1)}`))
}

function globRegex(pattern: string): RegExp {
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?' }
        else source += '.*'
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else source += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
  }
  return new RegExp(`${source}$`, 'i')
}

export function matchesGeneratedFileGlob(path: string, rule: string): boolean {
  const pattern = rule.trim().replaceAll('\\', '/').replace(/^\.\//, '')
  if (!pattern) return false
  const normalizedPath = path.replaceAll('\\', '/').replace(/^\.\//, '')
  const target = pattern.includes('/') ? normalizedPath : normalizedPath.split('/').at(-1) ?? normalizedPath
  return expandBraces(pattern).some((expanded) => globRegex(expanded).test(target))
}

export function generatedFileMatch(
  path: string,
  head?: string | null,
  rules: string[] = useGeneratedFileRulesStore.getState().rules,
): GeneratedFileMatch | null {
  const banner = head?.slice(0, 512).toLowerCase() ?? ''
  if (/(?:auto(?:matically)?[- ]generated|@generated|code generated.*do not edit|generated.*do not edit)/s.test(banner)) {
    return { kind: 'banner', rule: 'Generated or do-not-edit marker in the first line' }
  }
  for (const rule of rules) {
    if (matchesGeneratedFileGlob(path, rule)) return { kind: 'glob', rule }
  }
  return null
}

export function isGeneratedFile(path: string, head?: string | null, rules?: string[]): boolean {
  return generatedFileMatch(path, head, rules) != null
}
