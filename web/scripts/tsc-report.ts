// Runs the TypeScript compiler over the web sources and emits Hydra streaming
// test markers (::hydra:test:*:: on stdout) so type errors surface on the head's
// test verdict, exactly like eslint-report.ts does for lint findings (see
// internal/tests/stream.go for the marker format).
//
// This exists because typechecking previously gated NOTHING. `npm run lint` was
// eslint only, and the [tests.web] runner was vitest + eslint - so a type error
// was caught solely by `mage build`, which no automated path runs. A head could
// go green with a frontend that does not compile.
//
// tsconfig.app.json already sets noEmit, so `tsc -b` here is a pure typecheck.
// Build mode is incremental but re-reports errors on an unchanged tree (verified:
// two consecutive runs both exit 2 with the same diagnostic), so a cached run
// cannot silently read as clean.
//
// It always exits 0 once the compile completes - the markers, not the exit code,
// carry the verdict, matching eslint-report.ts. A genuine crash throws instead.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const esc = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')

// tsc's non-pretty diagnostic line: "src/x.tsx(12,5): error TS2322: message".
// --pretty false is essential - the default colourises and wraps, which no
// line-oriented parse survives.
const DIAG = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/

// Resolve typescript's own entry point rather than trusting `tsc` on PATH: the
// runner invokes this with plain `node`, and aube's virtual store means
// node_modules/.bin is not necessarily on PATH either.
const tscBin = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const tsc = spawnSync(process.execPath, [tscBin, '-b', '--pretty', 'false'], { encoding: 'utf8' })
const output = `${tsc.stdout ?? ''}\n${tsc.stderr ?? ''}`

let errors = 0
let warnings = 0
for (const line of output.split('\n')) {
  const m = DIAG.exec(line.trim())
  if (!m) continue
  const [, file, ln, col, severity, code, message] = m
  const failed = severity === 'error'
  if (failed) errors++
  else warnings++
  console.log(`::hydra:test:${failed ? 'fail' : 'warn'}:: web/${file}:${ln}:${col} › ${code} | ${esc(message)}`)
}

// A non-zero exit with no parseable diagnostic means tsc itself failed (a bad
// config, a missing tsconfig). That would otherwise vanish into a green verdict,
// so report it as a failing case rather than swallowing it.
if (errors === 0 && tsc.status !== 0) {
  console.log(`::hydra:test:fail:: web › tsc | ${esc(output.trim() || `tsc exited ${tsc.status}`)}`)
  errors++
}

console.log(`tsc: ${errors} error(s), ${warnings} warning(s)`)
