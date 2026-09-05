// Fetches the self-hosted webfonts into public/fonts. EVERY font this UI renders
// is vendored here - nothing is fetched from a CDN at runtime.
//
// Two groups, fetched differently because they arrive differently.
//
// The Google families (GOOGLE_QUERY) come as Google's own stylesheet, which is
// already properly subsetted and unicode-range-split, so they are mirrored
// rather than re-cut: the CSS is fetched once, each .woff2 it points at is
// downloaded, and the urls are rewritten to /fonts/google/. See vendorGoogle.
//
// The patched families are not served as webfonts, so we cut our own:
//
//   Bundled mono families   patched Nerd Font Mono builds. They embed correctly
//                           sized Nerd/Powerline glyphs instead of relying on a
//                           size-adjusted fallback face.
//   Nerd Fonts symbols      NOT an offered family - a fallback face appended to
//                           every mono stack, scoped by unicode-range to the
//                           private-use blocks. Without it every Powerline
//                           separator, Devicon and Codicon an agent or a TUI
//                           prints comes out as a tofu box.
//
// The .woff2 output is NOT committed - it is gitignored and produced at build
// time. `npm run build` runs this first (see the prebuild script), and it is a
// no-op once the cache stamp matches.
//
// A real build costs around nine minutes, nearly all of it CPU spent subsetting,
// and a fresh worktree has no output and no stamp - so with a worktree per head
// that cost would be paid repeatedly for identical bytes. The built faces are therefore also
// kept in FONT_BUILD_CACHE_DIR/<signature>/ when that variable is set, or in
// ~/.cache/hydra/fonts/<signature>/ otherwise. The project config redirects the
// variable to Hydra's project-scoped cache, so the first head or test runner to
// build fills it and every later checkout copies (~14MB, ~0.1s) without touching
// the network or a subsetter. Only a version bump or an edit to the subsets
// below changes the signature and pays the real cost again.
//
//     cd web && npm run build-fonts          # or: node scripts/build-fonts.ts
//     cd web && npm run build-fonts -- --force
//
// Two things make fetching from source cheap enough to do on every build
// machine:
//
//  1. We never download the full patched-font release zip. The central directory lives
//     at the END of the file, and GitHub's asset host honours Range requests,
//     so we read the directory, look up the four faces we want, and range-fetch
//     only those members. Across the five families that is under 100MB of face
//     data instead of several complete release archives.
//  2. We subset. A full patched face covers far more Unicode than Hydra needs. Code, diffs and a
//     terminal need Latin, punctuation, box drawing, block elements, arrows and
//     the handful of symbols this UI draws - see SUBSET_RANGES. That cuts each
//     patched face from ~13MB to ~750KB.
//
// curl does the fetching rather than fetch(): inside a Hydra sandbox egress is
// a CONNECT proxy configured through the standard *_proxy env vars, which curl
// honours and Node's fetch does not.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import subsetFont from 'subset-font'

const NERD_FONTS_VERSION = '3.4.0'

// The families index.html used to request straight from fonts.googleapis.com.
// Weights are held to 400-700 (plus italics where the family has them) - that is
// everything the UI asks for, and the wider ranges in Google's own snippets
// triple the stylesheet for faces nothing renders.
const GOOGLE_QUERY =
  'family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600;1,700' +
  '&family=Inter:ital,opsz,wght@0,14..32,400..700;1,14..32,400..700' +
  '&family=Merriweather:ital,opsz,wght@0,18..144,300..900;1,18..144,300..900' +
  '&family=Roboto+Flex:slnt,wght@-10..0,100..1000' +
  '&family=Source+Serif+4:ital,opsz,wght@0,8..60,400..700;1,8..60,400..700' +
  '&display=swap'

// Google serves woff2 only to a UA it recognises as a modern browser; curl's own
// gets the ttf fallback, which is roughly twice the bytes.
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const GOOGLE_DIR = 'google'
const GOOGLE_CSS = 'google.css'

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(WEB_DIR, 'public', 'fonts')
// Records what the files in OUT_DIR were built from - all of it, not just
// Iosevka: the Nerd Fonts symbols and the mirrored Google families too. A build
// whose inputs match skips the network entirely; anything else (version bump,
// edited subset, a half-written file) rebuilds. Gitignored, like the fonts - and
// kept OUT of public/, which vite copies wholesale into dist/ and web/embed.go
// then bakes into the binary. A build receipt does not belong in a shipped
// artifact.

const STAMP = join(WEB_DIR, '.fonts-build.json')

const FORCE = process.argv.includes('--force')

// The four faces a webfont may need. Fira Code has no italic source face, so the
// browser synthesises its uncommon italic use just as it did for the old Google
// variable face.
const FACES = [
  { file: 'Regular', weight: 400, style: 'normal' },
  { file: 'Bold', weight: 700, style: 'normal' },
  { file: 'Italic', weight: 400, style: 'italic' },
  { file: 'BoldItalic', weight: 700, style: 'italic' },
] as const
const UPRIGHT_FACES = FACES.filter((face) => face.style === 'normal')

// The patched face to cut, and the slug used for the output filenames. The Nerd
// Fonts release calls it IosevkaTermNerdFontMono; Hydra exposes the shorter
// Iosevka name because there is no second Iosevka cut in the catalogue.
const FAMILIES = [
  { archive: 'IosevkaTerm', memberPrefix: 'IosevkaTermNerdFontMono', family: 'Iosevka', slug: 'iosevka', faces: FACES },
  { archive: 'FiraCode', memberPrefix: 'FiraCodeNerdFontMono', family: 'Fira Code', slug: 'fira-code', faces: UPRIGHT_FACES },
  { archive: 'JetBrainsMono', memberPrefix: 'JetBrainsMonoNerdFontMono', family: 'JetBrains Mono', slug: 'jetbrains-mono', faces: FACES },
  { archive: 'IBMPlexMono', memberPrefix: 'BlexMonoNerdFontMono', family: 'IBM Plex Mono', slug: 'ibm-plex-mono', faces: FACES },
  { archive: 'SourceCodePro', memberPrefix: 'SauceCodeProNerdFontMono', family: 'Source Code Pro', slug: 'source-code-pro', faces: FACES },
] as const

// What survives subsetting. Kept deliberately generous for the terminal - a TUI
// draws its frames out of box drawing and block elements, agents write arrows
// and check marks into prose, and a diff is full of typographic punctuation -
// but stops short of the CJK/emoji/rare-script bulk that makes the full face
// 1MB. Measured per block against the regular face: dropping the whole
// latin/punctuation base would only save 160KB, so the symbol coverage is close
// to free, and the two bands that were NOT worth their weight (number forms,
// most dingbats) are the ones narrowed here.
const SUBSET_RANGES: [number, number][] = [
  [0x0000, 0x00ff], // Basic Latin + Latin-1 Supplement
  [0x0131, 0x0131], // dotless i
  [0x0152, 0x0153], // OE ligatures
  [0x02bb, 0x02bc], // turned/modifier comma (the Google latin subset's picks)
  [0x02c6, 0x02c6], // modifier circumflex
  [0x02da, 0x02da], // ring above
  [0x02dc, 0x02dc], // small tilde
  [0x0300, 0x036f], // combining diacritics - decomposed accents render wrong without them
  [0x2000, 0x206f], // general punctuation (quotes, dashes, ellipsis, NBSP kin)
  [0x2070, 0x209f], // super/subscripts
  [0x20a0, 0x20bf], // currency symbols
  [0x2100, 0x214f], // letterlike symbols (™ № ℃)
  [0x2190, 0x21ff], // arrows
  [0x2200, 0x22ff], // mathematical operators (≈ ≠ ≤ ∈ - common in agent prose)
  [0x2300, 0x23ff], // misc technical (⌘ ⌥ ⏎ ⏵ - the keys and transport marks TUIs draw)
  [0x2500, 0x257f], // box drawing
  [0x2580, 0x259f], // block elements
  [0x25a0, 0x25ff], // geometric shapes (incl. the UI's ▸)
  [0x2600, 0x26ff], // misc symbols (incl. the UI's ⚠)
  [0x2713, 0x2718], // check marks and ballot X (the UI's ✓ ✗) - the rest of Dingbats is decoration
  [0x27f0, 0x27ff], // supplemental arrows A (long arrows)
  [0xfffd, 0xfffd], // replacement character
]

// Codepoints that are Emoji_Presentation=Yes: the ones a browser renders in
// COLOUR by default, from the system emoji font, even with no variation
// selector. They sit inside the symbol blocks above, and if Iosevka supplies
// them it wins - it is first in the stack - so a ⛔ or a ⏳ comes out as a small
// monochrome outline squeezed into one cell instead of the emoji the terminal
// meant. (The terminal-safe Iosevka makes that worse by design: no
// glyph is wider than one cell, and an emoji wants two.) Cutting them out hands
// those codepoints back to the emoji font, which is what draws them properly.
//
// Deliberately only the DEFAULT-emoji set. ⚠ ✓ ★ ▸ and friends are
// Emoji_Presentation=No - text by default - and Iosevka drawing them, in the
// same weight and colour as the code around them, is exactly right.
const EMOJI_PRESENTATION: [number, number][] = [
  [0x231a, 0x231b], // ⌚⌛
  [0x23e9, 0x23ec], // ⏩⏪⏫⏬
  [0x23f0, 0x23f0], // ⏰
  [0x23f3, 0x23f3], // ⏳
  [0x25fd, 0x25fe], // ◽◾
  [0x2614, 0x2615], // ☔☕
  [0x2648, 0x2653], // zodiac ♈-♓
  [0x267f, 0x267f], // ♿
  [0x2693, 0x2693], // ⚓
  [0x26a1, 0x26a1], // ⚡
  [0x26aa, 0x26ab], // ⚪⚫
  [0x26bd, 0x26be], // ⚽⚾
  [0x26c4, 0x26c5], // ⛄⛅
  [0x26ce, 0x26ce], // ⛎
  [0x26d4, 0x26d4], // ⛔
  [0x26ea, 0x26ea], // ⛪
  [0x26f2, 0x26f3], // ⛲⛳
  [0x26f5, 0x26f5], // ⛵
  [0x26fa, 0x26fa], // ⛺
  [0x26fd, 0x26fd], // ⛽
]

// The Nerd Fonts code point map, minus the Material Design block (U+F0001-
// U+F1AF0, ~7000 glyphs, which would take the face from 600KB to 1.1MB and
// which almost no prompt or TUI reaches for). These MUST stay in step with the
// `unicode-range` on the @font-face in src/index.css - a code point cut here but
// still listed there renders as a blank rather than falling through.
const NERD_RANGES: [number, number][] = [
  [0x23fb, 0x23fe], // IEC power symbols
  [0x2b58, 0x2b58], // heavy circle (the power-off pair)
  [0xe000, 0xe00a], // Pomicons
  [0xe0a0, 0xe0a3], // Powerline
  [0xe0b0, 0xe0d7], // Powerline extras - the prompt separators
  [0xe200, 0xe2a9], // Font Awesome Extension
  [0xe300, 0xe3e3], // Weather
  [0xe5fa, 0xe6b7], // Seti-UI + custom - the file-type icons eza/lsd print
  [0xe700, 0xe8ef], // Devicons
  [0xea60, 0xec1e], // Codicons
  [0xed00, 0xefce], // Font Awesome
  [0xf000, 0xf2ff], // Font Awesome (legacy range)
  [0xf300, 0xf381], // Font Logos (distro marks)
  [0xf400, 0xf533], // Octicons
]

function expand(ranges: [number, number][]): string {
  let out = ''
  for (const [lo, hi] of ranges) for (let cp = lo; cp <= hi; cp++) out += String.fromCodePoint(cp)
  return out
}

function codepoints(): number[] {
  const drop = new Set<number>()
  for (const [lo, hi] of EMOJI_PRESENTATION) for (let cp = lo; cp <= hi; cp++) drop.add(cp)
  const keep: number[] = []
  for (const [lo, hi] of SUBSET_RANGES) for (let cp = lo; cp <= hi; cp++) if (!drop.has(cp)) keep.push(cp)
  return keep
}

function curl(args: string[]): Buffer {
  return execFileSync('curl', ['-sfL', ...args], { maxBuffer: 1 << 28 })
}

function contentLength(url: string): number {
  // -I follows redirects, so the LAST Content-Length is the asset's own.
  const headers = curl(['-I', url]).toString()
  const all = headers.match(/^content-length:\s*(\d+)/gim)
  if (!all) throw new Error(`no Content-Length for ${url}`)
  return Number(all[all.length - 1].replace(/\D/g, ''))
}

function range(url: string, start: number, end: number): Buffer {
  return curl(['-r', `${start}-${end}`, url])
}

interface ZipEntry {
  name: string
  compressedSize: number
  method: number
  localHeaderOffset: number
}

// Reads a remote zip's central directory with two range requests. Deliberately
// minimal: Iosevka's packages are plain 32-bit zips (well under 4GB, ~100
// entries), so there is no zip64 path to handle here - it throws instead.
function readCentralDirectory(url: string, size: number): Map<string, ZipEntry> {
  const tailLen = Math.min(size, 64 * 1024 + 22)
  const tail = range(url, size - tailLen, size - 1)
  const eocd = tail.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'))
  if (eocd < 0) throw new Error(`no end-of-central-directory in ${url}`)
  const cdSize = tail.readUInt32LE(eocd + 12)
  const cdOffset = tail.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error('zip64 archives are not supported')

  const cd = range(url, cdOffset, cdOffset + cdSize - 1)
  const entries = new Map<string, ZipEntry>()
  let p = 0
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
    entries.set(name, {
      name,
      compressedSize: cd.readUInt32LE(p + 20),
      method: cd.readUInt16LE(p + 10),
      localHeaderOffset: cd.readUInt32LE(p + 42),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// Fetches and decompresses one member. The local file header repeats the name
// and extra field with its own lengths (they can differ from the central
// directory's), so read the 30-byte fixed part first to find where the data
// starts.
function readMember(url: string, entry: ZipEntry): Buffer {
  const header = range(url, entry.localHeaderOffset, entry.localHeaderOffset + 29)
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`)
  const dataStart = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
  const data = range(url, dataStart, dataStart + entry.compressedSize - 1)
  if (entry.method === 0) return data
  if (entry.method === 8) return inflateRawSync(data)
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`)
}

// vendorGoogle mirrors Google's stylesheet and everything it points at into
// public/fonts/google/, returning the sizes of what it wrote.
//
// Google's CSS is already the right shape - properly subsetted, split by
// unicode-range so a browser fetches only the blocks its text actually needs -
// so this rewrites the urls and changes nothing else. Vendoring it takes the
// network out of the render entirely, which fixes two things a runtime CDN
// caused: screenshots flapping between real and fallback metrics depending on
// whether a face arrived in time, and page loads timing out because a
// render-blocking stylesheet on a host the sandbox could not reach never
// settled.
async function vendorGoogle(): Promise<Record<string, number>> {
  const url = `https://fonts.googleapis.com/css2?${GOOGLE_QUERY}`
  console.log(`  Google families: fetching ${url.slice(0, 60)}...`)
  let css = curl(['-A', BROWSER_UA, url]).toString()

  const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))]
  if (urls.length === 0) throw new Error('no gstatic urls in the Google stylesheet - did the response shape change?')

  mkdirSync(join(OUT_DIR, GOOGLE_DIR), { recursive: true })
  const sizes: Record<string, number> = {}
  for (const remote of urls) {
    // The basename is Google's own content hash, so it is stable for a given
    // face and changes when they reissue it.
    const file = remote.split('/').pop()!
    const rel = `${GOOGLE_DIR}/${file}`
    const body = curl(['-A', BROWSER_UA, remote])
    writeFileSync(join(OUT_DIR, rel), body)
    sizes[rel] = body.length
    css = css.split(remote).join(`/fonts/${rel}`)
  }
  writeFileSync(join(OUT_DIR, GOOGLE_CSS), css)
  sizes[GOOGLE_CSS] = Buffer.byteLength(css)

  const total = Object.values(sizes).reduce((a, b) => a + b, 0)
  console.log(`    ${urls.length} faces  ${(total / 1024 / 1024).toFixed(2)}MB  ${GOOGLE_DIR}/`)
  return sizes
}

const cps = codepoints()
const text = cps.map((cp) => String.fromCodePoint(cp)).join('')
const nerdText = expand(NERD_RANGES)
const patchedText = text + nerdText
const NERD_OUTPUT = 'nerd-symbols-400-normal.woff2'
const outputs = [
  ...FAMILIES.flatMap(({ slug, faces }) => faces.map((f) => `${slug}-${f.weight}-${f.style}.woff2`)),
  NERD_OUTPUT,
  GOOGLE_CSS,
]

// The stamp covers everything that decides the bytes: the releases, which faces
// and families we cut, and the exact code point sets. Anything else changing (a
// deleted file, a truncated download) is caught by the size check.
const signature = createHash('sha256')
  .update(
    JSON.stringify({
      nerd: NERD_FONTS_VERSION,
      families: FAMILIES.map((f) => [f.archive, f.memberPrefix]),
      faces: FAMILIES.map((f) => f.faces.map((face) => face.file)),
      codepoints: cps,
      nerdCodepoints: nerdText.length,
      google: GOOGLE_QUERY,
    }),
  )
  .digest('hex')
  .slice(0, 16)

// A build costs around nine minutes, nearly all of it CPU spent subsetting - and
// the outputs are gitignored, so EVERY fresh worktree would pay it again. Hydra
// gives each head its own worktree despite the bytes being identical whenever
// the signature is.
//
// So the built faces are also kept outside the checkout, keyed by that
// signature. The first build anywhere fills the cache; every worktree after it
// copies (~14MB, milliseconds) and touches neither the network nor a subsetter.
// Hydra's sandbox cache supplies FONT_BUILD_CACHE_DIR to heads and sandboxed
// runners. Keep a conventional XDG fallback so the script also stays fast when
// it is run in an ordinary checkout without Hydra.
const CACHE_ROOT = process.env.FONT_BUILD_CACHE_DIR || join(
  process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'hydra',
  'fonts',
)
const CACHE_DIR = join(CACHE_ROOT, signature)
const CACHE_MANIFEST = 'sizes.json'

// restoreFromCache copies a previous build of this exact signature into OUT_DIR.
// Returns the sizes it restored, or null if there is no complete copy to use.
function restoreFromCache(): Record<string, number> | null {
  const manifest = join(CACHE_DIR, CACHE_MANIFEST)
  if (!existsSync(manifest)) return null
  let sizes: Record<string, number>
  try {
    sizes = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, number>
  } catch {
    return null
  }
  // Verify before trusting it: a cache interrupted mid-write would otherwise
  // hand back a truncated face that renders as tofu.
  for (const [name, size] of Object.entries(sizes)) {
    const src = join(CACHE_DIR, name)
    if (!existsSync(src) || statSync(src).size !== size) return null
  }
  for (const name of Object.keys(sizes)) {
    const dest = join(OUT_DIR, name)
    mkdirSync(dirname(dest), { recursive: true })
    // Copied, not hardlinked: a later --force rewrites these paths in place, and
    // a shared inode would corrupt the cache for every other worktree.
    copyFileSync(join(CACHE_DIR, name), dest)
  }
  return sizes
}

// saveToCache stores this build for every other worktree. Best-effort: a full
// disk or a read-only cache root must not fail a build that already succeeded.
function saveToCache(sizes: Record<string, number>): void {
  const tmp = `${CACHE_DIR}.tmp-${process.pid}`
  try {
    rmSync(tmp, { recursive: true, force: true })
    for (const name of Object.keys(sizes)) {
      const dest = join(tmp, name)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(join(OUT_DIR, name), dest)
    }
    writeFileSync(join(tmp, CACHE_MANIFEST), JSON.stringify(sizes))
    mkdirSync(CACHE_ROOT, { recursive: true })
    // Another worktree may have won the race; its copy is byte-identical (same
    // signature), so keep it and drop ours.
    if (existsSync(CACHE_DIR)) rmSync(tmp, { recursive: true, force: true })
    else renameSync(tmp, CACHE_DIR)
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    console.log(`  (not cached: ${(err as Error).message})`)
    return
  }
  // Old signatures are dead weight once nothing builds them - a version bump
  // would otherwise leave roughly 14MB behind for every version ever built.
  try {
    for (const entry of readdirSync(CACHE_ROOT)) {
      if (entry !== signature) rmSync(join(CACHE_ROOT, entry), { recursive: true, force: true })
    }
  } catch {
    // A concurrent build may be mid-rename; leaving a stale dir is harmless.
  }
}

function writeStamp(sizes: Record<string, number>): void {
  writeFileSync(
    STAMP,
    JSON.stringify({ nerdFonts: NERD_FONTS_VERSION, signature, sizes }, null, 2) + '\n',
  )
}

function upToDate(): boolean {
  if (FORCE || !existsSync(STAMP)) return false
  try {
    const stamp = JSON.parse(readFileSync(STAMP, 'utf8')) as { signature?: string; sizes?: Record<string, number> }
    if (stamp.signature !== signature) return false
    // Check every file the last build recorded, not just `outputs`: the Google
    // faces are named by Google's own hashes, so they are only knowable from the
    // stamp.
    const recorded = Object.entries(stamp.sizes ?? {})
    if (recorded.length < outputs.length) return false
    return outputs.every((name) => stamp.sizes?.[name] !== undefined) &&
      recorded.every(([name, size]) => {
        const path = join(OUT_DIR, name)
        return existsSync(path) && statSync(path).size === size
      })
  } catch {
    return false
  }
}

if (upToDate()) {
  console.log(`fonts: already built (${outputs.length} faces) - nothing to do`)
  process.exit(0)
}

mkdirSync(OUT_DIR, { recursive: true })
// A checkout built by the old two-family catalogue may still contain these
// gitignored faces. Do not carry dead font binaries into the embedded web app.
for (const face of FACES) rmSync(join(OUT_DIR, `iosevka-term-${face.weight}-${face.style}.woff2`), { force: true })

if (!FORCE) {
  const cached = restoreFromCache()
  if (cached) {
    writeStamp(cached)
    const mb = Object.values(cached).reduce((a, b) => a + b, 0) / 1024 / 1024
    console.log(`fonts: restored ${Object.keys(cached).length} file(s), ${mb.toFixed(1)}MB from ${CACHE_DIR}`)
    process.exit(0)
  }
}
console.log(`fonts: cutting ${FAMILIES.length} patched families + symbols from Nerd Fonts v${NERD_FONTS_VERSION}`)

const sizes: Record<string, number> = {}
for (const { archive, memberPrefix, family, slug, faces } of FAMILIES) {
  const url = `https://github.com/ryanoasis/nerd-fonts/releases/download/v${NERD_FONTS_VERSION}/${archive}.zip`
  console.log(`  ${family}: reading directory of ${url.split('/').pop()}`)
  const size = contentLength(url)
  const entries = readCentralDirectory(url, size)

  for (const face of faces) {
    const memberName = `${memberPrefix}-${face.file}.ttf`
    const member = entries.get(memberName)
    if (!member) {
      const candidates = [...entries.keys()].filter((name) =>
        name.toLowerCase().includes('iosevka') && name.toLowerCase().includes(face.file.toLowerCase()),
      )
      throw new Error(`${memberName} missing from the release zip; candidates: ${candidates.join(', ') || '(none)'}`)
    }
    const source = readMember(url, member)
    // subset-font keeps every OpenType layout feature (it inverts harfbuzz's
    // layout-feature set), so Iosevka's ligation and character-variant tags -
    // calt, VLAC, VSAB, cvNN, which src/lib/fonts.ts turns on - survive the cut.
    const subset = await subsetFont(source, patchedText, { targetFormat: 'woff2' })
    const name = `${slug}-${face.weight}-${face.style}.woff2`
    writeFileSync(join(OUT_DIR, name), subset)
    sizes[name] = subset.length
    console.log(
      `    ${face.file.padEnd(10)} ${(source.length / 1024).toFixed(0).padStart(5)}KB -> ` +
        `${(subset.length / 1024).toFixed(0).padStart(4)}KB  ${name}`,
    )
  }
}

// The Nerd Fonts symbol face. Upstream's "Symbols Only" package is exactly this
// job - patch glyphs with no Latin at all. Bundled families now contain their
// own correctly sized glyphs; this remains necessary for System mono and as a
// last-resort fallback for a code point a patched source does not contain.
//
// Regular only: these are icons, and neither a bold nor an italic of an icon is
// a thing anyone needs.
{
  const url = `https://github.com/ryanoasis/nerd-fonts/releases/download/v${NERD_FONTS_VERSION}/NerdFontsSymbolsOnly.zip`
  console.log(`  Nerd Fonts symbols: reading directory of ${url.split('/').pop()}`)
  const entries = readCentralDirectory(url, contentLength(url))
  // The "Mono" cut is the one whose glyphs are normalised to a single cell
  // rather than the ~1.5 cells the proportional cut uses.
  const member = entries.get('SymbolsNerdFontMono-Regular.ttf')
  if (!member) throw new Error('SymbolsNerdFontMono-Regular.ttf missing from the release zip')
  const source = readMember(url, member)
  const subset = await subsetFont(source, nerdText, { targetFormat: 'woff2' })
  writeFileSync(join(OUT_DIR, NERD_OUTPUT), subset)
  sizes[NERD_OUTPUT] = subset.length
  console.log(
    `    ${'Symbols'.padEnd(10)} ${(source.length / 1024).toFixed(0).padStart(5)}KB -> ` +
      `${(subset.length / 1024).toFixed(0).padStart(4)}KB  ${NERD_OUTPUT}`,
  )
}

Object.assign(sizes, await vendorGoogle())

writeStamp(sizes)
saveToCache(sizes)
console.log(`fonts: done (${(Object.values(sizes).reduce((a, b) => a + b, 0) / 1024 / 1024).toFixed(1)}MB total)`)
