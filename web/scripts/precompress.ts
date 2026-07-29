// Precompress the built frontend, in place, and record what was done.
//
// Hydra embeds web/dist into the binary (web/embed.go) and serves it itself, so
// the bytes on disk are both the binary's size AND, without this, the bytes on
// the wire. Compressing at build time rather than per request means the server
// never spends CPU on an asset, gets to use the slowest/best settings, and - the
// part that actually matters here - the binary shrinks, because the ORIGINAL is
// replaced rather than accompanied.
//
// For every compressible file above a size floor this writes `<name>.br` and
// `<name>.gz`, deletes `<name>`, and records it in ENCODED_MANIFEST. The Go side
// (internal/cli/server_frontend.go) reads that manifest once at startup, so
// serving an asset is a map lookup: it knows which encodings exist and whether
// the original is gone, rather than probing the filesystem for `.br`, then
// `.gz`, then the original, taking two misses on the way to every hit.
//
// Already-compressed types (png, woff2, webm) are left alone: gzip does nothing
// for them but would still cost a decompress on the way out. They simply do not
// appear in the manifest, which is how the server knows to read them directly.
import { readdir, readFile, writeFile, unlink, stat } from 'node:fs/promises'
import { join, extname, relative, sep } from 'node:path'
import { brotliCompress, gzip, constants } from 'node:zlib'
import { promisify } from 'node:util'

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

const COMPRESSIBLE = new Set([
  '.js', '.css', '.html', '.json', '.map', '.svg', '.txt', '.webmanifest', '.xml',
])

// Below this, the encodings' framing costs more than they save and the request
// is dominated by round-trip time anyway.
const MIN_BYTES = 1024

// Skip a file whose encodings came out no smaller than the original - possible
// for small or already-dense inputs, where serving them would be strictly worse.
const WORTH_IT = 0.98

// ENCODED_MANIFEST names the file the Go side reads. A dotfile so it is not
// mistaken for an asset; `//go:embed all:dist` picks up dotfiles, which is what
// the `all:` prefix is there for.
const ENCODED_MANIFEST = '.encoded.json'

const dist = 'dist'

interface Compressed {
  /** Path as the server looks it up: dist-relative, forward slashes. */
  name: string
  /** Available encodings, best first - the order the server offers them in. */
  encodings: string[]
  raw: number
  br: number
  gz: number
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

async function compressOne(path: string): Promise<Compressed | null> {
  const raw = await readFile(path)
  if (raw.length < MIN_BYTES) return null

  // Both encodings at their best settings. This is a build step; the seconds
  // here are paid once and saved on every request afterwards.
  const [br, gz] = await Promise.all([
    brotliAsync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }),
    gzipAsync(raw, { level: constants.Z_BEST_COMPRESSION }),
  ])

  if (br.length > raw.length * WORTH_IT && gz.length > raw.length * WORTH_IT) return null

  await writeFile(`${path}.br`, br)
  await writeFile(`${path}.gz`, gz)
  // The original is what we are replacing, not supplementing - leaving it would
  // mean embedding the payload three times over.
  await unlink(path)

  return {
    name: relative(dist, path).split(sep).join('/'),
    encodings: ['br', 'gzip'],
    raw: raw.length,
    br: br.length,
    gz: gz.length,
  }
}

try {
  await stat(dist)
} catch {
  console.error('precompress: no dist/ - run the build first')
  process.exit(1)
}

const files = (await walk(dist)).filter(
  (f) => COMPRESSIBLE.has(extname(f)) && !f.endsWith('.br') && !f.endsWith('.gz'),
)

const started = Date.now()
// node:zlib's async calls run on libuv's thread pool, so this fans out across
// cores; the whole point of doing it here rather than serially.
const results = (await Promise.all(files.map(compressOne))).filter((r) => r !== null)

// One entry per file whose original we removed. Anything absent is still on disk
// in its original form, and the server reads it directly.
const manifest: Record<string, string[]> = {}
for (const r of results) manifest[r.name] = r.encodings
await writeFile(join(dist, ENCODED_MANIFEST), JSON.stringify(manifest))

const mb = (n: number) => (n / 1048576).toFixed(1)
const raw = results.reduce((a, r) => a + r.raw, 0)
const br = results.reduce((a, r) => a + r.br, 0)
const gz = results.reduce((a, r) => a + r.gz, 0)

console.log(
  `precompress: ${results.length}/${files.length} files, ` +
    `${mb(raw)}MB -> ${mb(br)}MB brotli + ${mb(gz)}MB gzip ` +
    `(${((Date.now() - started) / 1000).toFixed(1)}s)`,
)
