import mermaid from 'mermaid'
import { cssVar } from './theme'

let configuredTheme: 'dark' | 'light' | null = null
let seq = 0

/** 图表配色跟随 CSS 变量，和编辑器、Markdown 正文保持同一套色 */
function configure(theme: 'dark' | 'light') {
  if (configuredTheme === theme) return
  configuredTheme = theme
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'dark' ? 'dark' : 'neutral',
    fontFamily: cssVar('--ui-font') || 'inherit',
    themeVariables: {
      background: cssVar('--c-island'),
      primaryColor: cssVar('--c-island-2'),
      primaryTextColor: cssVar('--c-text'),
      primaryBorderColor: cssVar('--c-border'),
      secondaryColor: cssVar('--c-island-2'),
      tertiaryColor: cssVar('--c-island'),
      lineColor: cssVar('--c-dim'),
      textColor: cssVar('--c-text'),
      fontSize: '13px',
    },
  })
}

/**
 * 把宿主里所有 .mermaid-block 画成图。
 * 渲染失败时保留源码并标红，不让整篇预览挂掉。
 */
export async function renderMermaidBlocks(host: HTMLElement, theme: 'dark' | 'light') {
  const blocks = [...host.querySelectorAll<HTMLElement>('.mermaid-block')]
  if (blocks.length === 0) return
  configure(theme)

  for (const block of blocks) {
    const source = decodeURIComponent(block.dataset.mermaid ?? '')
    if (!source.trim()) continue
    try {
      const { svg } = await mermaid.render(`mermaid-${++seq}`, source)
      block.innerHTML = svg
      block.classList.add('is-rendered')
      block.classList.remove('is-error')
    } catch (error) {
      block.classList.add('is-error')
      block.classList.remove('is-rendered')
      // 报错文本里可能带着图表源码片段，用 textContent 拼，别走 innerHTML
      const pre = document.createElement('pre')
      pre.className = 'mermaid-source is-error'
      pre.textContent = (error as Error).message
      block.replaceChildren(pre)
    }
  }
}
