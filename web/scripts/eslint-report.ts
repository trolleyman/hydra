// Runs ESLint over the web sources and emits Hydra streaming test markers
// (::hydra:test:*:: on stdout) so lint findings surface on the head's test
// verdict (see internal/tests/stream.go for the marker format). ESLint 9's junit
// formatters don't tag severity in a way Hydra reads, so we map it ourselves: an
// error (severity 2) becomes a "fail" case that gates the merge like any red
// test; a warning (severity 1) becomes a "warn" case shown as an amber ⚠ N that
// is purely informational and never gates.
//
// It always exits 0 once the lint completes - the markers, not the exit code,
// carry the verdict - so a genuine crash (which throws before printing) is the
// only way it goes non-zero.
import { ESLint } from 'eslint'
import { relative } from 'node:path'

const esc = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')

const cwd = process.cwd()
const eslint = new ESLint()
const results = await eslint.lintFiles(['.'])

let errors = 0
let warnings = 0
for (const r of results) {
  const file = relative(cwd, r.filePath) || r.filePath
  for (const m of r.messages) {
    const failed = m.severity === 2
    if (failed) errors++
    else warnings++
    const loc = `web/${file}:${m.line ?? 0}:${m.column ?? 0}`
    console.log(`::hydra:test:${failed ? 'fail' : 'warn'}:: ${loc} › ${m.ruleId ?? 'eslint'} | ${esc(m.message)}`)
  }
}
console.log(`eslint: ${errors} error(s), ${warnings} warning(s) across ${results.length} files`)
