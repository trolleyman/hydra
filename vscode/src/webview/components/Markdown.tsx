import DOMPurify from 'dompurify'
import { marked } from 'marked'
import React, { useMemo } from 'react'
import { postMessage } from '../bridge'

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { USE_PROFILES: { html: true } }), [text])
  return <div className="markdown min-w-0 leading-[1.55]" onClick={event => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (anchor) {
      event.preventDefault()
      postMessage({ type: 'openLink', href: anchor.href })
    }
  }} dangerouslySetInnerHTML={{ __html: html }} />
}
