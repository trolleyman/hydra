import { spawnSync } from 'node:child_process'
import process from 'node:process'

const args = process.argv.slice(2)
const targetIndex = args.indexOf('--target')
const target = targetIndex >= 0 ? args[targetIndex + 1] : `${process.platform}-${process.arch}`
if (!target) throw new Error('--target requires a VS Code target')

for (const command of [
  ['npm', ['run', 'check']],
  ['node', ['scripts/build-host.mjs', target]],
  ['npx', ['vsce', 'package', '--no-dependencies', '--target', target]],
]) {
  const result = spawnSync(command[0], command[1], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
