import type { Editor } from '@tiptap/core'

const mountedEditors = new WeakMap<HTMLElement, Editor>()

export function registerMountedEditor(editor: Editor): () => void {
  mountedEditors.set(editor.view.dom, editor)
  return () => mountedEditors.delete(editor.view.dom)
}

export function editorForRichComposer(element: HTMLElement): Editor | undefined {
  return mountedEditors.get(element)
}
