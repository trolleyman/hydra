import DOMPurify from 'dompurify'
import { marked } from 'marked'
import React, { useMemo } from 'react'
import { postMessage } from '../bridge'
import { highlight } from '../highlight'

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const container = document.createElement('div')
    container.innerHTML = marked.parse(text, { async: false }) as string
    for (const code of container.querySelectorAll('pre > code')) {
      const language = code.className.match(/language-([\w-]+)/)?.[1]
      const rendered = highlight(code.textContent ?? '', language)
      if (rendered) code.innerHTML = rendered
    }
    return DOMPurify.sanitize(container.innerHTML, { USE_PROFILES: { html: true } })
  }, [text])
  return <div className="markdown min-w-0 leading-[1.55]" onClick={event => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (anchor) {
      event.preventDefault()
      postMessage({ type: 'openLink', href: anchor.href })
    }
  }} dangerouslySetInnerHTML={{ __html: html }} />
}
