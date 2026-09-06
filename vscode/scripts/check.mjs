import { spawnSync } from 'node:child_process'
import process from 'node:process'

const buildOnly = process.argv.includes('--build-only')
const commands = [
  ['node', ['node_modules/openapi-typescript/bin/cli.js', '../api/agent-host.yaml', '-o', 'src/generated/protocol.ts']],
  ...(!buildOnly ? [['node', ['node_modules/typescript/bin/tsc', '--noEmit']]] : []),
  ['node', ['scripts/build.mjs']],
]
for (const [executable, args] of commands) {
  const result = spawnSync(executable, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
