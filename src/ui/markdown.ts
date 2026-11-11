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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const renderer = new marked.Renderer()
const defaultCode = renderer.code.bind(renderer)

renderer.code = (token) => {
  const lang = (token.lang ?? '').trim().split(/\s+/)[0]
  if (lang !== 'mermaid') return defaultCode(token)
  // 源码同时留在 data 属性（换主题要重画）和正文里（图表还没画出来时先看到代码）
  return (
    `<div class="mermaid-block" data-mermaid="${encodeURIComponent(token.text)}">` +
    `<pre class="mermaid-source">${escapeHtml(token.text)}</pre></div>`
  )
}

export function renderMarkdown(text: string): string {
  return sanitize(marked.parse(text, { async: false, renderer }) as string)
}
