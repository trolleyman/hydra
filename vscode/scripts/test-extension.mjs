import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runTests } from '@vscode/test-electron'

const extensionDevelopmentPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const options = {
  extensionDevelopmentPath,
  extensionTestsPath: path.join(extensionDevelopmentPath, 'test', 'extension.cjs'),
  launchArgs: [path.resolve(extensionDevelopmentPath, '..'), '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
}
if (process.env.HYDRA_VSCODE_EXECUTABLE) options.vscodeExecutablePath = process.env.HYDRA_VSCODE_EXECUTABLE

try {
  await runTests(options)
} catch (error) {
  console.error(error)
  process.exit(1)
}
