import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { CODE_LANGUAGES } from './codeLanguages'

export function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  return (
    <NodeViewWrapper className="rich-code-block">
      <select
        contentEditable={false}
        aria-label="Code block language"
        className="text-2xs"
        value={String(node.attrs.language ?? '')}
        onChange={(event) => updateAttributes({ language: event.target.value || null })}
      >
        {CODE_LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <NodeViewContent className="rich-code-block-content" />
    </NodeViewWrapper>
  )
}
