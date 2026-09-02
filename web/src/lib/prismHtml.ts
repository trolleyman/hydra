// Serialisation layer between refractor's hast (HTML AST) output and the HTML
// strings the app renders. Split out from highlightCore so lib/shellEmbed can
// highlight an embedded region without importing highlightCore, which imports
// shellEmbed in turn.
//
// Prism only ever emits nested `span`s and text, so this is a dozen lines rather
// than a hast serialiser dependency - and it keeps escaping in one place.
import type { Element, Root, RootContent } from 'hast'
import { refractor, hasLanguage } from './prism'

// escapeText escapes the three characters that can end a text run in HTML. Class
// names are ours, so attribute escaping never comes up.
export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function classOf(node: Element): string {
  const c = node.properties?.className
  return Array.isArray(c) ? c.join(' ') : String(c ?? '')
}

function openTag(node: Element): string {
  return `<span class="${classOf(node)}">`
}

// highlightTree returns the refractor tree for a run of code, or null when the
// grammar isn't registered (not eager, not yet lazy-loaded, or not a grammar at
// all) or throws.
export function highlightTree(code: string, language: string): Root | null {
  if (!code || !hasLanguage(language)) return null
  try {
    return refractor.highlight(code, language)
  } catch {
    return null
  }
}

// treeToHtml serialises a refractor tree to one HTML string.
export function treeToHtml(nodes: RootContent[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += escapeText(node.value)
    else if (node.type === 'element') out += openTag(node) + treeToHtml(node.children) + '</span>'
  }
  return out
}

// treeToLines serialises a refractor tree to ONE HTML STRING PER SOURCE LINE,
// re-opening every span still open at a line break so each line is independently
// valid markup. Splitting the tree (rather than re-scanning the serialised
// string for tags) means the nesting is known rather than inferred.
export function treeToLines(root: Root): string[] {
  const lines: string[] = []
  const open: Element[] = []
  let current = ''

  const walk = (nodes: RootContent[]) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const parts = node.value.split('\n')
        parts.forEach((part, i) => {
          if (i > 0) {
            current += '</span>'.repeat(open.length)
            lines.push(current)
            current = open.map(openTag).join('')
          }
          current += escapeText(part)
        })
      } else if (node.type === 'element') {
        current += openTag(node)
        open.push(node)
        walk(node.children)
        open.pop()
        current += '</span>'
      }
    }
  }
  walk(root.children)
  lines.push(current)
  return lines
}

export interface HighlightSpan {
  text: string
  cls: string
}

// treeToLineSpans is the text-and-classes counterpart to treeToLines. Tool
// output normally renders semantic pieces as React nodes rather than trusted
// HTML (see lib/outputSpan), but source excerpts embedded in that output still
// need the same Prism palette as a file view. Flattening the tree at each text
// leaf preserves those token classes while keeping the original text available
// to selection, copying and whitespace marks.
export function treeToLineSpans(root: Root): HighlightSpan[][] {
  const lines: HighlightSpan[][] = [[]]

  const append = (text: string, cls: string) => {
    if (!text) return
    const line = lines[lines.length - 1]
    const previous = line[line.length - 1]
    if (previous?.cls === cls) previous.text += text
    else line.push({ text, cls })
  }

  const walk = (nodes: RootContent[], inherited = '') => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const parts = node.value.split('\n')
        parts.forEach((part, i) => {
          if (i > 0) lines.push([])
          append(part, inherited)
        })
      } else if (node.type === 'element') {
        // A nested token's own class determines its colour; its parent's colour
        // reaches it only through CSS inheritance when it has no class itself.
        walk(node.children, classOf(node) || inherited)
      }
    }
  }

  walk(root.children)
  return lines
}

// highlightToHtml is the one-shot form: token HTML for a run of code, or null
// when the grammar isn't available.
export function highlightToHtml(code: string, language: string): string | null {
  const tree = highlightTree(code, language)
  return tree == null ? null : treeToHtml(tree.children)
}
