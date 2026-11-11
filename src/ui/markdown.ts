import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: false })

const BLOCKED = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'STYLE'])

/** 本地文件也可能含恶意 HTML，渲染前做一次最小净化 */
function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('*').forEach((el) => {
    if (BLOCKED.has(el.tagName)) {
      el.remove()
      return
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || (name === 'href' && attr.value.trim().toLowerCase().startsWith('javascript:'))) {
        el.removeAttribute(attr.name)
      }
    }
  })
  return doc.body.innerHTML
}

export function renderMarkdown(text: string): string {
  return sanitize(marked.parse(text, { async: false }) as string)
}

export function looksLikeMarkdown(lang: string): boolean {
  return lang === 'markdown'
}
