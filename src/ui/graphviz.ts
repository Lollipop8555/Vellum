import { instance, type Viz } from '@viz-js/viz'
import { cssVar } from './theme'

/**
 * DOT / Graphviz 图表。
 *
 * 与 mermaid 同一个套路：占位块里先放源码，浏览器侧异步画成 SVG 再替换。
 * 区别在成本：`@viz-js/viz` 把 WASM 内联在 JS 里（单文件 1.2MB），
 * 所以实例化一次就缓存住，不随每次预览重建——重排 WASM 是几十毫秒级的开销。
 */
let vizPromise: Promise<Viz> | null = null

function getViz(): Promise<Viz> {
  vizPromise ??= instance()
  return vizPromise
}

/** 图形属性跟着主题走；用户显式写了的属性优先，这里只是「没写时的默认值」 */
function themeAttributes() {
  const font = cssVar('--ui-font') || 'inherit'
  return {
    graphAttributes: { bgcolor: 'transparent', fontname: font },
    nodeAttributes: { color: cssVar('--c-border'), fontcolor: cssVar('--c-text'), fontname: font },
    edgeAttributes: { color: cssVar('--c-dim'), fontname: font },
  }
}

/**
 * 洗一遍 Graphviz 产出的 SVG。
 *
 * DOT 是用户内容，`<image href="http://…">` 会真的发请求（把文档里的路径变成
 * 一次出站访问），事件属性则是脚本入口。两者都不在预览的预期能力里，直接删。
 * 只删这几类，其余交给 CSS——Graphviz 的 svg 结构固定，不需要整棵白名单。
 */
function scrub(svg: SVGSVGElement) {
  svg.querySelectorAll('script, foreignObject, image').forEach((node) => node.remove())
  for (const node of svg.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || name === 'href' || name.endsWith(':href')) {
        node.removeAttribute(attr.name)
      }
    }
  }
}

function errorNode(message: string): HTMLElement {
  const pre = document.createElement('pre')
  pre.className = 'graphviz-source is-error'
  pre.textContent = message
  return pre
}

/**
 * 把宿主里所有 .graphviz-block 画成图。
 * 失败时保留源码、下面补一行错误：DOT 语法错很常见（少个分号就会），
 * 让用户能对照源码改，而不是只剩一句看不懂的报错。
 */
export async function renderGraphvizBlocks(host: HTMLElement, _theme: 'dark' | 'light') {
  const blocks = [...host.querySelectorAll<HTMLElement>('.graphviz-block')]
  if (blocks.length === 0) return

  let viz: Viz
  try {
    viz = await getViz()
  } catch (error) {
    // WASM 起不来属于环境问题，所有块一起降级，不逐块重试
    for (const block of blocks) fail(block, `Graphviz 引擎加载失败：${(error as Error).message}`)
    return
  }

  const attributes = themeAttributes()
  for (const block of blocks) {
    const source = decodeURIComponent(block.dataset.dot ?? '')
    if (!source.trim()) continue
    block.querySelector('.graphviz-error')?.remove()
    try {
      // renderSVGElement 直接给回真 DOM：比 innerHTML 少一次解析，也便于先洗后挂
      const svg = viz.renderSVGElement(source, attributes)
      scrub(svg)
      block.replaceChildren(svg)
      block.classList.add('is-rendered')
      block.classList.remove('is-error')
    } catch (error) {
      fail(block, (error as Error).message)
    }
  }
}

function fail(block: HTMLElement, message: string) {
  block.classList.add('is-error')
  block.classList.remove('is-rendered')
  // 已经画出来的图撤掉，避免「图还在、底下多一段报错」的错位感
  block.querySelector('svg')?.remove()
  const node = errorNode(message)
  node.classList.add('graphviz-error')
  block.append(node)
}
