import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const extensionRoot = path.dirname(here)
const repositoryRoot = path.dirname(extensionRoot)
const target = process.argv[2] || `${process.platform}-${process.arch}`
const targets = {
  'linux-x64': ['linux', 'amd64'], 'linux-arm64': ['linux', 'arm64'],
  'darwin-x64': ['darwin', 'amd64'], 'darwin-arm64': ['darwin', 'arm64'],
  'win32-x64': ['windows', 'amd64'], 'win32-arm64': ['windows', 'arm64'],
}
const selected = targets[target]
if (!selected) throw new Error(`Unsupported extension target: ${target}`)
const [goos, goarch] = selected
const outputDir = path.join(extensionRoot, 'bin', target)
mkdirSync(outputDir, { recursive: true })
const executable = path.join(outputDir, goos === 'windows' ? 'hydra-agent-host.exe' : 'hydra-agent-host')
const version = process.env.npm_package_version || 'dev'
const result = spawnSync('go', ['build', '-trimpath', '-ldflags', `-X main.version=${version}`, '-o', executable, './cmd/hydra-agent-host'], {
  cwd: repositoryRoot,
  env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
  stdio: 'inherit',
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`Built ${path.relative(extensionRoot, executable)}`)
