import { defineConfig, type Plugin, type ResolvedConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The contents of the committed web/dist/.gitkeep placeholder. Written here and
// committed verbatim so a build (which re-creates the file) leaves git clean - keep
// the two in sync. The text explains, in-place, why a tracked file lives in an
// otherwise git-ignored build dir.
const DIST_GITKEEP = `This file keeps web/dist/ present in every checkout.

web/embed.go embeds this directory with \`//go:embed all:dist\`, which fails to
compile - "pattern all:dist: no matching files found" - when the directory is
absent, e.g. a fresh checkout that hasn't built the frontend (most importantly the
\`go\` [[tests]] runner in .hydra/config.toml). dist/ is git-ignored, so this
committed placeholder holds the directory open.

A real Vite build empties dist/, writes the hashed assets, then re-creates this
exact file (see keepDistGitkeep in web/vite.config.ts) - so building locally does
not leave a spurious change in \`git status\`.
`

// keepDistGitkeep re-creates web/dist/.gitkeep after every build. The file is
// committed (past web/.gitignore) so a fresh checkout that hasn't built the
// frontend - most importantly the `go` [[tests]] runner - still satisfies
// web/embed.go's `//go:embed all:dist` and compiles. Vite empties outDir on each
// build, deleting the placeholder, so we write it back here (with the same text it
// holds in git) to keep `git status` clean - the real assets land alongside it and
// are git-ignored.
function keepDistGitkeep(): Plugin {
  let cfg: ResolvedConfig
  return {
    name: 'hydra-keep-dist-gitkeep',
    apply: 'build',
    configResolved(c) {
      cfg = c
    },
    closeBundle() {
      const dir = resolve(cfg.root, cfg.build.outDir)
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, '.gitkeep'), DIST_GITKEEP)
    },
  }
}

// API_PORT: port the Go backend listens on (default 8080).
// DEV_PORT: port the Vite dev server listens on (default: Vite default of 5173).
const apiPort = process.env.API_PORT ?? '8080'
const devPort = process.env.DEV_PORT ? parseInt(process.env.DEV_PORT) : undefined
const apiBase = `http://localhost:${apiPort}`

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isDev = mode === 'development'

  return {
    plugins: [
      // '@tanstack/router-plugin' must be passed before '@vitejs/plugin-react'
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
      }),
      react(),
      tailwindcss(),
      keepDistGitkeep(),
    ],
    clearScreen: false,
    // Emit Web Workers as ES modules (they're instantiated with { type: 'module' }).
    // The default 'iife' worker format can't code-split, so it would inline every
    // dynamic import - re-bundling all ~150 lazily-loaded highlight.js grammars into
    // the highlight worker. 'es' lets those load on demand as separate chunks.
    worker: { format: 'es' },
    server: {
      port: devPort,
      proxy: {
        '/api': apiBase,
        '/uploads': apiBase,
        '/folder-picker': apiBase,
        '/health': apiBase,
        '/.well-known': apiBase,
        '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
      },
    },
    build: {
      // Disables minification entirely when in development mode to keep code readable
      minify: isDev ? false : 'esbuild',

      // Generates source maps to make debugging easier on the external server
      sourcemap: isDev,

      // Vite outputs to 'dist/' by default, but this explicitly defines the target
      outDir: 'dist',
    }
  }
})
