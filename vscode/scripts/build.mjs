import esbuild from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

await mkdir('dist', { recursive: true })

function buildStyles() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/@tailwindcss/cli/dist/index.mjs', '-i', 'src/webview/style.css', '-o', 'dist/webview.css', '--minify'], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Tailwind exited with status ${code}`)))
  })
}

await Promise.all([
  buildStyles(),
  esbuild.build({
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: true,
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
  esbuild.build({
    entryPoints: ['src/webview/index.tsx'],
    outfile: 'dist/webview.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: true,
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
])
