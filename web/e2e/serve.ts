// Foreground boot script for Playwright's webServer (see playwright.config.ts).
// Builds a hydra binary from the current checkout and runs it in --simulation
// mode (mock data, no daemon) so the smoke specs drive the real built UI.
//
// Contract: the frontend (web/dist) must already be built - the Go binary embeds
// it at build time (web/embed.go). Run `mage build` (or `npm run build`) first;
// CI does this before the e2e step. Set E2E_PORT to override the port.
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const repoRoot = join(import.meta.dirname, '..', '..') // web/e2e -> repo root
const port = process.env.E2E_PORT ?? '41825'
const addr = `127.0.0.1:${port}`

// The build step precompresses and then DELETES each original (see
// web/scripts/precompress.ts), so a built dist has index.html.br/.gz and no
// index.html. Check for any of the three, or this guard reports "not built"
// against a perfectly good build.
const distIndex = join(repoRoot, 'web', 'dist', 'index.html')
if (!['', '.br', '.gz'].some((suffix) => existsSync(distIndex + suffix))) {
  console.error('e2e: web/dist not built - run `mage build` (or `npm run build`) first')
  process.exit(1)
}

// Build into the OS temp dir, never inside the repo (the checkout doesn't ignore
// .hydra/local, so an in-tree binary would pollute git status).
const bin = join(tmpdir(), 'hydra-e2e')
console.log(`e2e: building hydra binary -> ${bin}`)
const build = spawnSync('go', ['build', '-o', bin, './'], { cwd: repoRoot, stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

console.log(`e2e: starting hydra server --simulation on ${addr}`)
const server = spawn(bin, ['server', '--simulation'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, HYDRA_API_ADDR: addr },
})
const stop = () => { try { server.kill('SIGTERM') } catch { /* already gone */ } }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
server.on('exit', (code) => process.exit(code ?? 0))
