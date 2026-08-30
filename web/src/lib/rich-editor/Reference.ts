import { Node, type Editor, type JSONContent } from '@tiptap/core'

export const REFERENCE_NAME = 'hydraReference'

export type ReferenceKind = 'file' | 'branch' | 'commit' | 'agent'

export interface ComposerReference {
  kind: ReferenceKind
  value: string
  label?: string
}

const REFERENCE_PATTERN = /@(file|branch|commit|agent)\[((?:\\.|[^\\\]\n])+)\]/g

function unescapeReference(value: string): string {
  return value.replaceAll(/\\([\\\]])/g, '$1')
}

export const HydraReference = Node.create({
  name: REFERENCE_NAME,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: 'file' },
      value: { default: '' },
      label: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-hydra-reference]' }]
  },

  renderHTML({ node }) {
    return ['span', {
      'data-hydra-reference': node.attrs.kind,
      'data-reference-value': node.attrs.value,
      contenteditable: 'false',
      class: `composer-reference composer-reference-${node.attrs.kind}`,
    }, `@${node.attrs.label || node.attrs.value}`]
  },

  renderText({ node }) {
    return `@${node.attrs.kind}[${node.attrs.value}]`
  },

  renderMarkdown(node) {
    const value = String(node.attrs?.value ?? '').replaceAll('\\', '\\\\').replaceAll(']', '\\]')
    return `@${node.attrs?.kind}[${value}]`
  },
})

export function insertReference(editor: Editor, reference: ComposerReference, range?: { from: number; to: number }): boolean {
  const content = {
    type: REFERENCE_NAME,
    attrs: { ...reference, label: reference.label ?? reference.value },
  }
  return range ? editor.commands.insertContentAt(range, content) : editor.commands.insertContent(content)
}

// The Markdown tokenizer intentionally sees references as plain readable text.
// Rehydrate the stable @kind[value] boundary after parsing so drafts and sent
// Markdown need no private protocol or backend support.
export function hydrateReferences(document: JSONContent): JSONContent {
  if (!document.content) return document
  const content: JSONContent[] = []
  for (const child of document.content) {
    if (child.type === 'text' && child.text) {
      let offset = 0
      let matched = false
      for (const match of child.text.matchAll(REFERENCE_PATTERN)) {
        matched = true
        if (match.index > offset) content.push({ ...child, text: child.text.slice(offset, match.index) })
        content.push({
          type: REFERENCE_NAME,
          attrs: { kind: match[1], value: unescapeReference(match[2]), label: unescapeReference(match[2]) },
        })
        offset = match.index + match[0].length
      }
      if (matched && offset < child.text.length) content.push({ ...child, text: child.text.slice(offset) })
      if (!matched) content.push(child)
    } else {
      content.push(hydrateReferences(child))
    }
  }
  return { ...document, content }
}
