import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const result = spawnSync(process.execPath, ['../web/scripts/build-fonts.ts'], { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

const source = path.resolve('../web/public/fonts')
const destination = path.resolve('media/fonts')
await mkdir(destination, { recursive: true })

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

const faces = [
  [googleFace('Inter', 'normal'), 'inter-normal.woff2'],
  [googleFace('Inter', 'italic'), 'inter-italic.woff2'],
  [googleFace('Merriweather', 'normal'), 'merriweather-normal.woff2'],
  [googleFace('Merriweather', 'italic'), 'merriweather-italic.woff2'],
  [path.join(source, 'fira-code-400-normal.woff2'), 'fira-code-normal.woff2'],
  [path.join(source, 'fira-code-700-normal.woff2'), 'fira-code-bold.woff2'],
]
await Promise.all(faces.map(([from, name]) => copyFile(from, path.join(destination, name))))
console.log(`extension fonts: materialized ${faces.length} cached faces`)
