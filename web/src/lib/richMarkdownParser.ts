import type { Root } from 'hast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type { Attachment } from './spawnDrafts'

interface MarkdownAstNode {
  type: string
  value?: string
  url?: string
  children?: MarkdownAstNode[]
}

interface ParsedMarkdownTree {
  root: Root
  source: string
}

interface ParseRichMarkdownOptions {
  hardBreaks?: boolean
  attachments?: Attachment[]
}

function unescapeHydraValue(value: string): string {
  return value.replaceAll(/\\([\\\]])/g, '$1')
}

// Turn Hydra's stable Markdown boundaries into semantic links in the Markdown
// AST. Text inside code nodes is never visited, so a sample reference or
// attachment filename in a code block remains literal.
function remarkHydraNodes(attachmentNames: Map<string, number>) {
  return () => (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (!node.children || node.type === 'link' || node.type === 'image') return
      const next: MarkdownAstNode[] = []
      for (const child of node.children) {
        if (child.type !== 'text' || !child.value) {
          visit(child)
          next.push(child)
          continue
        }
        const token = /@(file|branch|commit|agent)\[((?:\\.|[^\\\]\n])+)\]|\[([^\]\n]+)\]/g
        let offset = 0
        for (const match of child.value.matchAll(token)) {
          if (match.index! > offset) next.push({ type: 'text', value: child.value.slice(offset, match.index) })
          if (match[1]) {
            const value = unescapeHydraValue(match[2])
            next.push({ type: 'link', url: `hydra-reference:${match[1]}:${encodeURIComponent(value)}`, children: [{ type: 'text', value }] })
          } else {
            const index = attachmentNames.get(match[3])
            if (index == null) next.push({ type: 'text', value: match[0] })
            else next.push({ type: 'link', url: `hydra-attachment:${index}`, children: [{ type: 'text', value: match[3] }] })
          }
          offset = match.index! + match[0].length
        }
        if (offset === 0) next.push(child)
        else if (offset < child.value.length) next.push({ type: 'text', value: child.value.slice(offset) })
      }
      node.children = next
    }
    visit(tree)
  }
}

export function parseRichMarkdownTree(
  source: string,
  { hardBreaks = true, attachments = [] }: ParseRichMarkdownOptions = {},
): ParsedMarkdownTree {
  const attachmentNames = new Map(attachments.map((attachment, index) => [attachment.filename, index]))
  const processor = unified().use(remarkParse).use(remarkGfm)
  if (hardBreaks) processor.use(remarkBreaks)
  processor.use(remarkHydraNodes(attachmentNames)).use(remarkRehype)
  const markdownTree = processor.parse(source)
  return { root: processor.runSync(markdownTree) as Root, source }
}
