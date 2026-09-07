import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const result = spawnSync(process.execPath, ['../web/scripts/build-fonts.ts'], { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

const source = path.resolve('../web/public/fonts')
const destination = path.resolve('media/fonts')
await mkdir(destination, { recursive: true })
for (const name of await readdir(destination)) {
  if (name.endsWith('.woff2')) await rm(path.join(destination, name))
}

const css = await readFile(path.join(source, 'google.css'), 'utf8')
function googleFace(family, style) {
  for (const match of css.matchAll(/\/\* latin \*\/\s*@font-face\s*\{([^}]+)\}/g)) {
    const block = match[1]
    if (!block.includes(`font-family: '${family}'`) || !block.includes(`font-style: ${style}`)) continue
    const file = block.match(/url\(\/fonts\/google\/([^)]+)\)/)?.[1]
    if (file) return path.join(source, 'google', file)
  }
  throw new Error(`Could not find the Latin ${style} face for ${family}`)
}

const googleFaces = [
  ['IBM Plex Sans', 'normal', 'ibm-plex-sans-normal.woff2'],
  ['IBM Plex Sans', 'italic', 'ibm-plex-sans-italic.woff2'],
  ['Inter', 'normal', 'inter-normal.woff2'],
  ['Inter', 'italic', 'inter-italic.woff2'],
  ['Merriweather', 'normal', 'merriweather-normal.woff2'],
  ['Merriweather', 'italic', 'merriweather-italic.woff2'],
  ['Roboto Flex', 'oblique 0deg 10deg', 'roboto-flex-normal.woff2'],
  ['Source Serif 4', 'normal', 'source-serif-normal.woff2'],
  ['Source Serif 4', 'italic', 'source-serif-italic.woff2'],
]
const faces = googleFaces.map(([family, style, name]) => [googleFace(family, style), name])
for (const name of [
  'fira-code-400-normal.woff2',
  'fira-code-700-normal.woff2',
  'ibm-plex-mono-400-italic.woff2',
  'ibm-plex-mono-400-normal.woff2',
  'ibm-plex-mono-700-italic.woff2',
  'ibm-plex-mono-700-normal.woff2',
  'iosevka-400-italic.woff2',
  'iosevka-400-normal.woff2',
  'iosevka-700-italic.woff2',
  'iosevka-700-normal.woff2',
  'jetbrains-mono-400-italic.woff2',
  'jetbrains-mono-400-normal.woff2',
  'jetbrains-mono-700-italic.woff2',
  'jetbrains-mono-700-normal.woff2',
  'nerd-symbols-400-normal.woff2',
  'source-code-pro-400-italic.woff2',
  'source-code-pro-400-normal.woff2',
  'source-code-pro-700-italic.woff2',
  'source-code-pro-700-normal.woff2',
]) faces.push([path.join(source, name), name])
faces.push([path.join(source, 'noto-sans-math-arrows.woff2'), 'noto-sans-math-arrows.woff2'])
await Promise.all(faces.map(([from, name]) => copyFile(from, path.join(destination, name))))
console.log(`extension fonts: materialized ${faces.length} cached faces`)
