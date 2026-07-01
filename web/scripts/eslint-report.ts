// Runs ESLint over the web sources and writes a Hydra-native test report so lint
// findings surface on the head's test verdict (see internal/tests for the shape).
// ESLint 9's junit formatters don't tag severity in a way Hydra reads, so we map
// it ourselves: an error (severity 2) becomes a "failed" case that gates the
// merge like any red test; a warning (severity 1) becomes a "warning" case shown
// as an amber ⚠ N that is purely informational and never gates.
//
// Hydra sets HYDRA_TEST_OUTPUT to the dir the report must land in; run without it
// (e.g. by hand) and it just prints a summary. It always exits 0 once the lint
// completes — the report, not the exit code, carries the verdict — so a genuine
// crash (which throws before writing) is the only way it goes non-zero → no
// report → red.
import { ESLint } from 'eslint'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const cwd = process.cwd()
const eslint = new ESLint()
const results = await eslint.lintFiles(['.'])

type Case = { name: string; status: 'failed' | 'warning'; message: string }
const cases: Case[] = []
let errors = 0
let warnings = 0
for (const r of results) {
  const file = relative(cwd, r.filePath) || r.filePath
  for (const m of r.messages) {
    const failed = m.severity === 2
    if (failed) errors++
    else warnings++
    cases.push({
      name: `${m.ruleId ?? 'eslint'}: ${file}:${m.line ?? 0}:${m.column ?? 0}`,
      status: failed ? 'failed' : 'warning',
      message: m.message,
    })
  }
}

const outDir = process.env.HYDRA_TEST_OUTPUT
if (outDir) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'eslint.json'), JSON.stringify({ cases }))
}
console.log(`eslint: ${errors} error(s), ${warnings} warning(s) across ${results.length} files`)
