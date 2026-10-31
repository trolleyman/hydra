import { refractor } from 'refractor/core'
import bash from 'refractor/bash'
import clike from 'refractor/clike'
import css from 'refractor/css'
import diff from 'refractor/diff'
import go from 'refractor/go'
import javascript from 'refractor/javascript'
import json from 'refractor/json'
import jsx from 'refractor/jsx'
import markdown from 'refractor/markdown'
import markup from 'refractor/markup'
import python from 'refractor/python'
import tsx from 'refractor/tsx'
import typescript from 'refractor/typescript'
import yaml from 'refractor/yaml'

for (const language of [clike, markup, css, javascript, bash, diff, go, json, jsx, markdown, python, typescript, tsx, yaml]) {
  refractor.register(language)
}

const languageByExtension: Record<string, string> = {
  bash: 'bash', css: 'css', diff: 'diff', go: 'go', html: 'markup', js: 'javascript',
  json: 'json', jsx: 'jsx', md: 'markdown', py: 'python', sh: 'bash', ts: 'typescript',
  tsx: 'tsx', xml: 'markup', yaml: 'yaml', yml: 'yaml',
}

export function languageFromPath(value: string | undefined): string | undefined {
  const extension = value?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase()
  return extension ? languageByExtension[extension] : undefined
}

export function highlight(code: string, language: string | undefined): string | undefined {
  if (!language || !code || !refractor.registered(language)) return undefined
  try {
    return render(refractor.highlight(code, language))
  } catch {
    return undefined
  }
}

function render(node: any): string {
  if (node.type === 'text') return escape(node.value)
  if (node.type === 'root') return node.children.map(render).join('')
  const classes = Array.isArray(node.properties?.className) ? ` class="${node.properties.className.map(escape).join(' ')}"` : ''
  return `<${node.tagName}${classes}>${node.children.map(render).join('')}</${node.tagName}>`
}

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
