import mermaid from 'mermaid'
import { cssVar } from './theme'

let configuredTheme: 'dark' | 'light' | null = null
let seq = 0

/**
 * 图表配色跟随 CSS 变量，和编辑器、Markdown 正文保持同一套色。
 *
 * 用 `base` 而不是 `dark` / `neutral`：后两个是 mermaid 自带的整套配色，
 * 只会「参考」传进去的 themeVariables（浅色下节点被它自己刷成 #eee 的灰白），
 * 于是同一份文档在浅色主题里像没上色。`base` 只认我们给的变量。
 */
function configure(theme: 'dark' | 'light') {
  if (configuredTheme === theme) return
  configuredTheme = theme
  const island = cssVar('--c-island')
  const island2 = cssVar('--c-island-2')
  const text = cssVar('--c-text')
  const border = cssVar('--c-border')
  const dim = cssVar('--c-dim')
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: cssVar('--ui-font') || 'inherit',
    themeVariables: {
      background: island,
      primaryColor: island2,
      mainBkg: island2,
      primaryTextColor: text,
      primaryBorderColor: border,
      nodeBorder: border,
      secondaryColor: island2,
      tertiaryColor: island,
      lineColor: dim,
      textColor: text,
      edgeLabelBackground: island,
      clusterBkg: island,
      clusterBorder: border,
      // 便签默认是亮黄，深色主题里会刺眼
      noteBkgColor: island2,
      noteTextColor: text,
      noteBorderColor: border,
      fontSize: '13px',
    },
  })
}

/**
 * mermaid 的临时节点。
 *
 * 成功时它自己会删掉；**失败时会留在 body 里**——一张带炸弹图标、
 * 写着「Syntax error in text」的 500×500 报错图，直接串在 .workbench 后面，
 * 把整页撑长、顶栏被顶出视口。所以不论成败都要扫一遍。
 *
 * 只删挂在 body 上的：`render` 返回的 svg 也用同一个 id 命名，
 * 但它在我们自己插进块里，删了图就空白。
 */
function dropScratch(id: string) {
  for (const el of [document.getElementById(id), document.getElementById(`d${id}`)]) {
    if (el?.parentElement === document.body) el.remove()
  }
}

/**
 * 给 svg 一个明确的固有尺寸。
 *
 * mermaid 输出的是 `width="100%"` + 行内 `max-width:Npx`，即「没有固有宽度」。
 * 放进 `width: fit-content` 的容器（幻灯片页）时，百分比宽度在固有尺寸计算里会
 * 退化成 300×150 的默认替换元素尺寸 —— 量出来的块又扁又小，`--deck-fit` 按这个
 * 错误尺寸算，图在页面上就被缩成一小坨（纵向的图还会被拉得很宽）。
 * 用 viewBox 写回 width/height，让「量到的」和「看到的」是同一个比例；缩放交给
 * `.mermaid-block svg { max-width:100%; height:auto }`。
 */
function sizeSvg(node: SVGSVGElement) {
  const box = (node.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) return
  const [, , width, height] = box
  if (width <= 0 || height <= 0) return
  node.setAttribute('width', String(Math.round(width)))
  node.setAttribute('height', String(Math.round(height)))
  // 行内 max-width 会盖掉样式表里的 max-width:100%，去掉整条 style 更干净
  node.removeAttribute('style')
}

/**
 * 把宿主里所有 .mermaid-block 画成图。
 * 渲染失败时保留源码并标红，不让整篇预览挂掉。
 *
 * 幂等：同一份源码 + 同一个主题只画一次。导图面板每 350ms 就整棵重排，
 * 但 markmap 复用节点 DOM，不判断的话图会被反复擦掉重画（闪，而且很慢）。
 */
export async function renderMermaidBlocks(host: HTMLElement, theme: 'dark' | 'light') {
  const blocks = [...host.querySelectorAll<HTMLElement>('.mermaid-block')]
  if (blocks.length === 0) return
  configure(theme)

  for (const block of blocks) {
    const source = decodeURIComponent(block.dataset.mermaid ?? '')
    if (!source.trim()) continue
    if (block.dataset.mermaidTheme === theme && block.querySelector('svg')) continue
    const id = `mermaid-${++seq}`
    try {
      // 先 parse 再 render：render 失败会往 body 里塞报错图，而 parse 不会。
      // 语法错误是我们预料之中的输入（用户正在打字），不该让预览布局跟着抖。
      await mermaid.parse(source)
      const { svg } = await mermaid.render(id, source)
      block.innerHTML = svg
      block.classList.add('is-rendered')
      block.classList.remove('is-error')
      const node = block.querySelector('svg')
      if (node) sizeSvg(node as SVGSVGElement)
    } catch (error) {
      block.classList.add('is-error')
      block.classList.remove('is-rendered')
      // 报错文本里可能带着图表源码片段，用 textContent 拼，别走 innerHTML
      const pre = document.createElement('pre')
      pre.className = 'mermaid-source is-error'
      pre.textContent = (error as Error).message
      block.replaceChildren(pre)
    } finally {
      block.dataset.mermaidTheme = theme
      dropScratch(id)
    }
  }
}
