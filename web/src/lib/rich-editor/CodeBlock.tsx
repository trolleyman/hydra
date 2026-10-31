import CodeBlock, { type CodeBlockOptions } from '@tiptap/extension-code-block'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ReactNodeViewRenderer } from '@tiptap/react'
import type { RootContent } from 'hast'
import { highlightTree } from '../prismHtml'
import { CodeBlockView } from './CodeBlockView'

interface HighlightedCodeBlockOptions extends CodeBlockOptions {
  languagePicker: boolean
}

function tokenDecorations(doc: Parameters<typeof DecorationSet.create>[0]): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return
    const language = String(node.attrs.language ?? '')
    const tree = highlightTree(node.textContent, language)
    if (!tree) return
    let offset = 0
    const walk = (children: RootContent[], classes: string[]) => {
      for (const child of children) {
        if (child.type === 'text') {
          const start = offset
          offset += child.value.length
          if (classes.length > 0 && offset > start) {
            decorations.push(Decoration.inline(pos + 1 + start, pos + 1 + offset, { class: classes.join(' ') }))
          }
        } else if (child.type === 'element') {
          const own = child.properties?.className
          const names = Array.isArray(own) ? own.map(String) : own ? [String(own)] : []
          walk(child.children, classes.concat(names))
        }
      }
    }
    walk(tree.children, [])
  })
  return DecorationSet.create(doc, decorations)
}

export const HighlightedCodeBlock = CodeBlock.extend<HighlightedCodeBlockOptions>({
  addOptions() {
    return {
      ...(this.parent?.() as CodeBlockOptions),
      languagePicker: false,
    }
  },

  addNodeView() {
    return this.options.languagePicker ? ReactNodeViewRenderer(CodeBlockView) : null
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('richCodeBlockHighlight'),
        state: {
          init: (_, state) => tokenDecorations(state.doc),
          apply: (transaction, previous) => transaction.docChanged ? tokenDecorations(transaction.doc) : previous,
        },
        props: {
          decorations(state) {
            return this.getState(state)
          },
        },
      }),
    ]
  },
})
