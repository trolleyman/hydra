// Fetches and subsets the self-hosted webfonts into public/fonts.
//
// Three families, none of which is on Google Fonts (everything else rides the
// single Google Fonts stylesheet in index.html, which already serves properly
// subsetted, unicode-range-split CSS):
//
//   Iosevka, Iosevka Term   offered mono families. No CDN and no maintained npm
//                           build at a current version, so we cut our own.
//   Nerd Fonts symbols      NOT an offered family - a fallback face appended to
//                           every mono stack, scoped by unicode-range to the
//                           private-use blocks. Without it every Powerline
//                           separator, Devicon and Codicon an agent or a TUI
//                           prints comes out as a tofu box.
//
// The .woff2 output is NOT committed - it is gitignored and produced at build
// time. `npm run build` runs this first (see the prebuild script), and it is a
// no-op once the cache stamp matches, so only a fresh checkout, a version bump
// or a change to the subsets below pays the download.
//
//     cd web && npm run build-fonts          # or: node scripts/build-fonts.ts
//     cd web && npm run build-fonts -- --force
//
// Two things make fetching from source cheap enough to do on every build
// machine:
//
//  1. We never download the 240MB release zip. The zip central directory lives
//     at the END of the file, and GitHub's asset host honours Range requests,
//     so we read the directory, look up the four faces we want, and range-fetch
//     only those members (~1MB each) - about 9MB of traffic per family instead
//     of a quarter of a gigabyte.
//  2. We subset. A full Iosevka face covers most of Unicode. Code, diffs and a
//     terminal need Latin, punctuation, box drawing, block elements, arrows and
//     the handful of symbols this UI draws - see SUBSET_RANGES. Together with
//     taking the Unhinted package (upstream's own recommendation for the web -
//     Skia and DirectWrite autohint anyway, and the instructions are a third of
//     the file) that cuts each face from ~1.6MB to ~200KB.
//
// curl does the fetching rather than fetch(): inside a Hydra sandbox egress is
// a CONNECT proxy configured through the standard *_proxy env vars, which curl
// honours and Node's fetch does not.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import subsetFont from 'subset-font'

const IOSEVKA_VERSION = '34.8.0'
const NERD_FONTS_VERSION = '3.4.0'

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(WEB_DIR, 'public', 'fonts')
// Records what the files in OUT_DIR were built from. A build whose inputs match
// skips the network entirely; anything else (version bump, edited subset, a
// half-written file) rebuilds. Gitignored, like the fonts - and kept OUT of
// public/, which vite copies wholesale into dist/ and web/embed.go then bakes
// into the binary. A build receipt does not belong in a shipped artifact.

const STAMP = join(WEB_DIR, '.iosevka-build.json')

const FORCE = process.argv.includes('--force')

// The four faces a webfont needs: the browser synthesises nothing and we ask
// for nothing else (no light/medium/extended widths - a code font is read at
// one weight plus bold, with italic for comments).
const FACES = [
  { file: 'Regular', weight: 400, style: 'normal' },
  { file: 'Bold', weight: 700, style: 'normal' },
  { file: 'Italic', weight: 400, style: 'italic' },
  { file: 'BoldItalic', weight: 700, style: 'italic' },
] as const

// Which Iosevka releases to cut, and the slug used for the output filenames and
// the CSS family name (src/lib/fonts.ts must agree).
const FAMILIES = [
  { pkg: 'Iosevka', family: 'Iosevka', slug: 'iosevka' },
  // Term differs from the default release only in that the wide symbols
  // (arrows, some math) are drawn at one character cell instead of two. That is
  // exactly what a grid-based terminal needs, and exactly what would break
  // xterm's column measuring in the default release.
  { pkg: 'IosevkaTerm', family: 'Iosevka Term', slug: 'iosevka-term' },
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
// meant. (Iosevka Term makes that worse by design: its whole point is that no
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

const cps = codepoints()
const text = cps.map((cp) => String.fromCodePoint(cp)).join('')
const nerdText = expand(NERD_RANGES)
const NERD_OUTPUT = 'nerd-symbols-400-normal.woff2'
const outputs = [
  ...FAMILIES.flatMap(({ slug }) => FACES.map((f) => `${slug}-${f.weight}-${f.style}.woff2`)),
  NERD_OUTPUT,
]

// The stamp covers everything that decides the bytes: the releases, which faces
// and families we cut, and the exact code point sets. Anything else changing (a
// deleted file, a truncated download) is caught by the size check.
const signature = createHash('sha256')
  .update(
    JSON.stringify({
      version: IOSEVKA_VERSION,
      nerd: NERD_FONTS_VERSION,
      families: FAMILIES.map((f) => f.pkg),
      faces: FACES.map((f) => f.file),
      codepoints: cps,
      nerdCodepoints: nerdText.length,
    }),
  )
  .digest('hex')
  .slice(0, 16)

function upToDate(): boolean {
  if (FORCE || !existsSync(STAMP)) return false
  try {
    const stamp = JSON.parse(readFileSync(STAMP, 'utf8')) as { signature?: string; sizes?: Record<string, number> }
    if (stamp.signature !== signature) return false
    return outputs.every((name) => {
      const path = join(OUT_DIR, name)
      return existsSync(path) && statSync(path).size === stamp.sizes?.[name]
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
console.log(
  `fonts: cutting Iosevka v${IOSEVKA_VERSION} (${cps.length} code points) ` +
    `+ Nerd Fonts symbols v${NERD_FONTS_VERSION} (${nerdText.length})`,
)

const sizes: Record<string, number> = {}
for (const { pkg, family, slug } of FAMILIES) {
  const url = `https://github.com/be5invis/Iosevka/releases/download/v${IOSEVKA_VERSION}/PkgWebFont-Unhinted-${pkg}-${IOSEVKA_VERSION}.zip`
  console.log(`  ${family}: reading directory of ${url.split('/').pop()}`)
  const size = contentLength(url)
  const entries = readCentralDirectory(url, size)

  for (const face of FACES) {
    const member = entries.get(`WOFF2-Unhinted/${pkg}-${face.file}.woff2`)
    if (!member) throw new Error(`WOFF2-Unhinted/${pkg}-${face.file}.woff2 missing from the release zip`)
    const source = readMember(url, member)
    // subset-font keeps every OpenType layout feature (it inverts harfbuzz's
    // layout-feature set), so Iosevka's ligation and character-variant tags -
    // calt, VLAC, VSAB, cvNN, which src/lib/fonts.ts turns on - survive the cut.
    const subset = await subsetFont(source, text, { targetFormat: 'woff2' })
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
// job - the patch glyphs with no Latin at all - so one face covers every mono
// family we offer instead of swapping each one for its patched twin (the
// patched Iosevka release alone is a 357MB zip, and there is no patched build
// for the system monospace at all).
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

writeFileSync(
  STAMP,
  JSON.stringify({ iosevka: IOSEVKA_VERSION, nerdFonts: NERD_FONTS_VERSION, signature, sizes }, null, 2) + '\n',
)
console.log(`fonts: done (${(Object.values(sizes).reduce((a, b) => a + b, 0) / 1024 / 1024).toFixed(1)}MB total)`)
