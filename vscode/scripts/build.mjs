import esbuild from 'esbuild'
import { mkdir } from 'node:fs/promises'

await mkdir('dist', { recursive: true })

await Promise.all([
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
