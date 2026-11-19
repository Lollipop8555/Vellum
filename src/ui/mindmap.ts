/**
 * 导图：markmap 引擎版（MM-01 ~ MM-06）。
 *
 * 分工：
 * - **数据树自己建**：复用预览那条 remark 管线（mdast），压成 markmap 的 `IPureNode`。
 *   不引 markmap-lib —— 它带进 markdown-it + cheerio + prismjs + katex@0.16，
 *   和仓库已有的 remark 管线、katex@0.18 重复且打架，收益为零。
 * - **画法全交给 markmap-view**：flextree 布局、三次贝塞尔枝桠连线、d3-zoom 缩放、
 *   点圆点折叠。节点内容走 foreignObject，所以文字仍是我们渲染的 HTML。
 *
 * 早期的 v1（手写布局）已删，快照留在 `archive/mindmap-v1/`（只读参考，不参与构建）。
 */
import { toHtml } from 'hast-util-to-html'
import type { INode, IPureNode } from 'markmap-common'
import { Markmap } from 'markmap-view'
import type { Code, Content, Heading, List, ListItem, Root } from 'mdast'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { t } from '../i18n'
import { download } from '../shell/save'
import { lookupBlock } from './md/blocks'
import { highlightToHast, isHighlightable } from './md/highlight'
import { processor } from './md/pipeline'

/** 节点/层级上限：再大就不是「看一眼结构」了 */
const MAX_NODES = 2000
const MAX_DEPTH = 8
/** 代码块最多画几行；表格最多画几行数据（超出标 +N） */
const CODE_MAX_LINES = 8
const TABLE_MAX_ROWS = 5
/** 分支色板长度，对应 styles.css 的 --mm-b0..7 */
const BRANCH_COLORS = 8
const SVG_NS = 'http://www.w3.org/2000/svg'
/**
 * 缩放上限。文字 1 倍是基准，10 倍足够做演讲时的精细操作。
 *
 * 下限不写死：它是「整棵树塞进当前面板」的那个比例（`fitScale()`），
 * 树一复杂就自动小于 1，甚至小于 0.5 —— 那才是这棵树能一眼看全的极限，
 * 再往外缩只会得到一屏看不见的字。
 */
const MAX_SCALE = 10
/** 点一次 +/− 的步进（rescale 收的是相对倍数） */
const ZOOM_STEP = 1.25
/** 导出 SVG 时内容四周的留白 */
const EXPORT_PAD = 24

/** CSS 变量取不到时的兜底（深色主题那套） */
const FALLBACK_COLORS = [
  '#6ea8ff',
  '#a78bfa',
  '#f472b6',
  '#fb923c',
  '#facc15',
  '#34d399',
  '#22d3ee',
  '#d8b4fe',
]

const parser = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkMath)

/** 行内 HTML 缓存：打字时每 350ms 全量重画，同一段文字没必要重复走管线 */
let inlineCache = new Map<string, string>()

function parse(source: string): Root | null {
  try {
    return parser.parse(source) as Root
  } catch {
    return null
  }
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function plainText(nodes: Content[]): string {
  let out = ''
  for (const node of nodes) {
    if ('value' in node && typeof node.value === 'string') out += node.value
    else if ('children' in node && Array.isArray(node.children)) out += plainText(node.children as Content[])
  }
  return out
}

/**
 * 节点文字走预览管线的行内渲染，加粗/行内代码/链接/行内公式全部自动继承，
 * 也顺带享受同一套白名单。块级包一层 `<p>`，这里剥掉。
 */
function inlineHtml(source: string, nodes: Content[]): string {
  if (!nodes.length) return ''
  const from = nodes[0].position?.start.offset
  const to = nodes[nodes.length - 1].position?.end.offset
  if (from == null || to == null) return esc(plainText(nodes))
  const raw = source.slice(from, to)
  const hit = inlineCache.get(raw)
  if (hit != null) return hit
  let html: string
  try {
    html = processor.processSync(raw).toString().trim()
  } catch {
    html = ''
  }
  const unwrapped = /^<p>([\s\S]*)<\/p>$/.exec(html)
  const value = unwrapped ? unwrapped[1] : html
  inlineCache.set(raw, value)
  return value
}

/** 草稿节点：markmap 只认 content / children / payload，其余信息先挂在草稿上 */
interface Draft {
  content: string
  children: Draft[]
  /** 源码行号范围（1-based，闭区间），留给「点节点跳行」用 */
  lines: string
}

function make(content: string, lines: string): Draft {
  return { content, children: [], lines }
}

/** 高亮结果缓存：打字时每 350ms 全量重画，同一段代码没必要重跑一遍 lowlight */
const codeCache = new Map<string, string>()

/**
 * 代码正文：有语言就走和预览同一套 lowlight，输出 `hljs-*` 类名，
 * 配色由 styles.css 里那组 `--syn-*` 规则负责（选择器已扩到 `.mindmap-body`）。
 * 未知语言退化成纯文本 —— 与预览的行为一致，不抛错。
 */
function codeBody(lang: string, code: string): string {
  const key = `${lang}\u0000${code}`
  const hit = codeCache.get(key)
  if (hit != null) return hit
  let html: string
  try {
    html = toHtml({ type: 'root', children: highlightToHast(lang, code) })
  } catch {
    html = esc(code)
  }
  if (codeCache.size > 300) codeCache.clear()
  codeCache.set(key, html)
  return html
}

/**
 * 图表块的空壳（目前只有 mermaid，见下面的语言判断）。
 *
 * 复用预览的 renderer，所以 class 和 `data-*` 完全一致 —— 预览那套
 * `renderMermaidBlocks(host)` 不用改就能在导图里找到这些块。
 * 唯一的区别是去掉兜底的 `<pre>` 源码：节点只有 240px 宽，塞一段源码会把
 * 整棵树撑歪，而且源码只在「图还没画出来」的时候才有意义，导图里不需要。
 */
function diagramShell(lang: string, code: string): string | null {
  if (!code.trim()) return null
  const renderer = lookupBlock(lang)
  // 导图里只画 mermaid：graphviz 要额外拉 1.3MB 的 viz.js，plantuml 要联网。
  // 别的图表语言还是老实显示源码 —— 空壳画不出来比一段代码更让人困惑。
  if (!renderer?.langs.includes('mermaid')) return null
  const element = renderer.render({ type: 'code', lang, value: code } as Code)
  element.children = []
  return toHtml({ type: 'root', children: [element] })
}

function codeHtml(node: Content, source: string): string {
  const start = node.position?.start.offset ?? 0
  const end = node.position?.end.offset ?? start
  const raw = source.slice(start, end)
  // 围栏本身不带缩进时，去掉首尾围栏行就是内容
  const lines = raw.split('\n').slice(1, -1)
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const shown = lines.slice(0, CODE_MAX_LINES)
  const more = lines.length - shown.length
  const lang = ((node as { lang?: string | null }).lang ?? '').trim()
  // 语言名在语料里大小写混乱（JS / js / JavaScript），统一小写再交给 lowlight
  const alias = lang.toLowerCase()
  const head = lines.length
    ? `${lang || t('mindmap.code')} · ${t('mindmap.codeLines', { n: lines.length })}`
    : lang || t('mindmap.code')
  // 图表语言画真图：空壳先占位，SVG 等 markmap 把节点挂上去之后再补（见 paintDiagrams）
  const diagram = diagramShell(alias, lines.join('\n'))
  if (diagram) return `<span class="mm2-block-head">${esc(head)}</span>${diagram}`
  return (
    `<span class="mm2-block-head">${esc(head)}</span>` +
    `<pre class="mm2-code${isHighlightable(alias) ? ' hljs' : ''}">${codeBody(alias, shown.join('\n'))}</pre>` +
    (more > 0 ? `<span class="mm2-more">+${more}</span>` : '')
  )
}

function tableHtml(node: Content): string {
  const rows = ((node as { children?: Content[] }).children ?? []) as Array<{ children?: Content[] }>
  const headCells = rows[0]?.children ?? []
  const body = rows.slice(1)
  const shown = body.slice(0, TABLE_MAX_ROWS)
  const more = body.length - shown.length
  const cell = (c: Content): string => esc(plainText((c as { children?: Content[] }).children ?? []).trim())
  return (
    '<table class="mm2-table"><thead><tr>' +
    headCells.map((c) => `<th>${cell(c)}</th>`).join('') +
    '</tr></thead><tbody>' +
    shown.map((row) => `<tr>${(row.children ?? []).map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('') +
    '</tbody></table>' +
    (more > 0 ? `<span class="mm2-more">+${more}</span>` : '')
  )
}

function findParagraph(node: Content): { children: Content[] } | null {
  const kids = (node as { children?: Content[] }).children ?? []
  for (const kid of kids) {
    if (kid.type === 'paragraph') return kid as { children: Content[] }
    const deeper = findParagraph(kid)
    if (deeper) return deeper
  }
  return null
}

/**
 * 一棵 mdast → 草稿树。层级规则沿用初版的 `buildTree`：
 * heading 按 level 压栈，列表按缩进嵌套，段落/代码/表格/引用/公式都成为下一级节点。
 */
function build(source: string): Draft | null {
  const tree = parse(source)
  if (!tree) return null
  let count = 0
  let root: Draft | null = null
  const stack: Array<{ level: number; node: Draft }> = []
  const headings: Array<{ level: number; node: Draft; startOffset: number }> = []

  const spanOf = (node: Content, content: string): Draft | null => {
    const start = node.position?.start.line
    const end = node.position?.end.line
    if (start == null || end == null || count >= MAX_NODES) return null
    count++
    return make(content, `${start},${end}`)
  }

  const headingNode = (heading: Heading): Draft | null => {
    const start = heading.position?.start.line
    const end = heading.position?.end.line
    if (start == null || end == null || count >= MAX_NODES) return null
    count++
    const node = make(inlineHtml(source, heading.children), `${start},${end}`)
    headings.push({ level: heading.depth, node, startOffset: heading.position?.start.offset ?? 0 })
    return node
  }

  /**
   * 列表项的前缀标记。
   *
   * 不用 `•` / `1.` / `☑` 这类字符：它们靠 `line-height` 对齐，字号一换就歪。
   * 圆点、序号框、勾选框全在 CSS 里画；序号宽度按位数撑开（`ch` + padding），
   * 个位数是圆角方块，涨到两三位自然长成胶囊，圆角保持 4px 不变。
   */
  const listMark = (item: ListItem, ordered: boolean, index: number): string => {
    if (item.checked === true || item.checked === false) {
      return (
        `<span class="mm2-mark mm2-check${item.checked ? ' is-on' : ''}">` +
        '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.7 6.4 4.9 8.6 9.4 3.5" /></svg>' +
        '</span>'
      )
    }
    if (ordered) return `<span class="mm2-mark mm2-ord">${index}</span>`
    return '<span class="mm2-mark mm2-dot"></span>'
  }

  const itemNode = (item: ListItem, mark: string): Draft | null => {
    const start = item.position?.start.line
    const end = item.position?.end.line
    if (start == null || end == null || count >= MAX_NODES) return null
    count++
    const para = item.children.find((child) => child.type === 'paragraph')
    return make(mark + (para ? inlineHtml(source, para.children) : ''), `${start},${end}`)
  }

  const blockNode = (node: Content): Draft | null => {
    switch (node.type) {
      case 'paragraph':
        return spanOf(node, inlineHtml(source, node.children))
      case 'code':
        return spanOf(node, codeHtml(node, source))
      case 'table':
        return spanOf(node, tableHtml(node))
      case 'blockquote': {
        const para = findParagraph(node)
        return spanOf(node, para ? inlineHtml(source, para.children) : esc(t('mindmap.quote')))
      }
      case 'math': {
        const start = node.position?.start.offset ?? 0
        const end = node.position?.end.offset ?? start
        const first =
          source
            .slice(start, end)
            .split('\n')
            .find((line) => line.trim()) ?? ''
        return spanOf(node, esc(first.replace(/^\$\$\s*/, '').trim() || t('mindmap.math')))
      }
      case 'html': {
        const start = node.position?.start.offset ?? 0
        const end = node.position?.end.offset ?? start
        const first =
          source
            .slice(start, end)
            .split('\n')
            .find((line) => line.trim()) ?? ''
        return spanOf(node, esc(first.trim() || 'HTML'))
      }
      // 分割线、链接定义、脚注定义、frontmatter 都不是「内容」，不进图
      default:
        return null
    }
  }

  const attachList = (parent: Draft, list: List): void => {
    const ordered = list.ordered === true
    const first = (list.start ?? 1) - 1
    let i = 0
    for (const item of list.children) {
      if (item.type !== 'listItem' || count >= MAX_NODES) continue
      const node = itemNode(item, listMark(item, ordered, first + ++i))
      if (!node) continue
      parent.children.push(node)
      const label = item.children.find((child) => child.type === 'paragraph')
      for (const sub of item.children) {
        if (count >= MAX_NODES) break
        if (sub === label) continue
        if (sub.type === 'list') {
          attachList(node, sub)
          continue
        }
        const block = blockNode(sub)
        if (block) node.children.push(block)
      }
    }
  }

  for (const node of tree.children) {
    if (count >= MAX_NODES) break
    if (node.type === 'heading') {
      const item = headingNode(node)
      if (!item) continue
      while (stack.length && stack[stack.length - 1].level >= node.depth) stack.pop()
      if (!root) {
        root = item
      } else {
        const parent = stack.length ? stack[stack.length - 1].node : root
        parent.children.push(item)
      }
      stack.push({ level: node.depth, node: item })
      continue
    }
    if (!root) continue
    const parent = stack.length ? stack[stack.length - 1].node : root
    if (node.type === 'list') {
      attachList(parent, node as List)
      continue
    }
    const block = blockNode(node)
    if (block) parent.children.push(block)
  }

  // 超过层级上限的子树直接截断，避免 markmap 在极深链上把画布拉到几万像素
  const clamp = (node: Draft, depth: number): void => {
    if (depth >= MAX_DEPTH) node.children = []
    for (const kid of node.children) clamp(kid, depth + 1)
  }
  if (root) clamp(root, 0)
  return root
}

/** 草稿树 → markmap 数据树 */
/**
 * 压成 markmap 的树，顺手把「一级分支号」写进 payload。
 *
 * 不能事后从 `node.state.path` 推：markmap 的 path 是节点 **id 链**（"1" → "1.2" → "1.2.5"），
 * id 是全局自增的，拿它取模会让相邻分支撞色。只有根的子节点顺序才是稳定的 0..n，
 * 而且要给全部子孙继承 —— 同一分支一个色系，这是初版定下的规矩。
 */
function toTree(draft: Draft, branch = -1): IPureNode {
  const node: IPureNode = {
    content: draft.content,
    children: draft.children.map((kid, i) => toTree(kid, branch < 0 ? i : branch)),
    payload: { lines: draft.lines, branch },
  }
  return node
}

interface Shell {
  svg: SVGSVGElement
  markmap: Markmap
  /** viewKey 语义：换文件才重置视野 */
  key: string
  /** 右下角浮动工具条（缩放 / 自适应 / 导出），空态时整条藏起来 */
  tools: HTMLElement
}

const shells = new WeakMap<HTMLElement, Shell>()

/** 当前主题的分支色：从宿主元素上读 CSS 变量，切主题后下一次渲染自动跟上 */
function palette(host: HTMLElement): string[] {
  const cs = getComputedStyle(host)
  const list: string[] = []
  for (let i = 0; i < BRANCH_COLORS; i++) {
    list.push(cs.getPropertyValue(`--mm-b${i}`).trim() || FALLBACK_COLORS[i])
  }
  return list
}

/**
 * 一级分支号。
 *
 * 读的是 `toTree` 打好的 payload，不是 `state.path` —— path 的第一段永远是根的 id（"1"），
 * 早先按它取模，结果每个节点都算成同一个分支，整张图一片单色。
 */
function branchOf(node: INode): number {
  const branch = (node.payload as { branch?: number } | undefined)?.branch
  return typeof branch === 'number' && branch >= 0 ? branch : 0
}

export interface MindmapOptions {
  /** 点击节点时回传源码行号（1-based）；不传则只折叠/展开 */
  onJump?(line: number): void
  /** 视图标识，通常传当前文件 id；只有它变了才重新 fit */
  viewKey?: string
  /** 导出 SVG 时用的文件名（通常是当前文档名） */
  exportName?: string
}

/**
 * 渲染（或增量更新）导图。
 *
 * 外壳（svg + Markmap 实例 + 工具条）跨重画保留：打字触发的是 `setData`，
 * 视野与缩放原地不动；换文件（viewKey 变了）才 fit 回全貌。
 */
export function renderMindmap(host: HTMLElement, source: string, options: MindmapOptions = {}): void {
  let shell = shells.get(host)
  if (!shell || !host.contains(shell.svg)) {
    host.replaceChildren()
    host.classList.add('mindmap-body')
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
    svg.setAttribute('class', 'mindmap-svg')
    host.appendChild(svg)
    const colors = palette(host)
    const markmap = Markmap.create(svg, {
      duration: 260,
      // 右侧面板只有 400 多像素宽，节点再宽就会被 fit 缩成一团：
      // 240 大约是「中文 18 字换行」的宽度，四列刚好铺满面板
      maxWidth: 240,
      nodeMinHeight: 28,
      spacingHorizontal: 64,
      spacingVertical: 12,
      paddingX: 8,
      autoFit: false,
      color: (node: INode) => colors[branchOf(node) % colors.length],
      lineWidth: (node: INode) => Math.max(1, 1 + 3 / 2 ** node.state.depth),
    })
    const tools = createTools(host, markmap)
    host.appendChild(tools)
    shell = { svg, markmap, key: '', tools }
    shells.set(host, shell)
  }
  host.dataset.mindmapExport = options.exportName ?? ''

  // 空态提示：一个不吃指针事件的覆盖层，别挡住下面的拖拽
  let empty = host.querySelector<HTMLElement>('.mindmap-empty')
  if (!empty) {
    empty = document.createElement('div')
    empty.className = 'mindmap-empty'
    empty.textContent = t('mindmap.empty')
    host.appendChild(empty)
  }

  const draft = build(source)
  if (!draft) {
    empty.hidden = false
    shell.tools.hidden = true
    shell.markmap.setData({ content: '', children: [] })
    return
  }
  empty.hidden = true
  shell.tools.hidden = false
  // 主题可能换过：每次重设选项，颜色/线宽跟着当前的 CSS 变量走（markmap 会重排样式）
  const colors = palette(host)
  shell.markmap.setOptions({
    color: (node: INode) => colors[branchOf(node) % colors.length],
  })
  // 首次 / 换文件才摆视野；其余情况（打字触发的重画）原地不动，否则每 350ms 就把人拖回原点
  const key = options.viewKey ?? ''
  const firstView = key !== shell.key
  shell.key = key

  void shell.markmap
    .setData(toTree(draft))
    .then(async () => {
      // setData 是带过渡的异步过程，等它落定 rect 才是新树的包围盒
      const live = shells.get(host)
      if (!live) return
      // 图必须在 fit 之前画完：SVG 一进 foreignObject，节点尺寸就变了，
      // 按「还没画」的尺寸去 fit，整棵树会被缩到角落里。
      const painted = await paintDiagrams(host)
      if (!shells.get(host)) return
      if (!firstView) {
        // 内容变了，「能看全的极限」跟着变；视野不动，只把缩放区间挪一下
        if (painted) await nextLayout(live.markmap)
        applyScaleExtent(live.markmap)
        return
      }
      if (painted) await nextLayout(live.markmap)
      try {
        void fitView(live.markmap)
      } catch {
        /* 面板已移除 */
      }
    })
    .catch(() => {
      /* 渲染中途被销毁 */
    })
}

/**
 * 等 markmap 重量完节点尺寸。
 *
 * 节点内容变高变矮，markmap 靠挂在内容上的 `ResizeObserver`（100ms 防抖）
 * 触发 `renderData()` 重排。我们改完 DOM 就去 fit，量到的还是上一轮尺寸，
 * 所以至少等过这个防抖窗口再加一帧。
 */
function nextLayout(markmap: Markmap): Promise<void> {
  const node = markmap.svg.node()
  return new Promise((resolve) => {
    if (!node || !node.isConnected) return resolve()
    setTimeout(() => requestAnimationFrame(() => resolve()), 140)
  })
}

/**
 * 把导图节点里的图表空壳画成 SVG；返回是否真的画过。
 *
 * mermaid 4MB，只在真出现图表块时才动态加载 —— 纯文字文档不该付这份钱。
 * 同源码同主题不会重画（判断在 `renderMermaidBlocks` 里），所以打字触发的
 * 每 350ms 全量 setData 不会被这里拖慢。
 */
async function paintDiagrams(host: HTMLElement): Promise<boolean> {
  if (!host.querySelector('.mermaid-block')) return false
  try {
    const { renderMermaidBlocks } = await import('./mermaid')
    if (!host.isConnected) return false
    const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
    await renderMermaidBlocks(host, theme)
    return true
  } catch {
    return false
  }
}

/**
 * 「整棵树塞进当前面板」需要的比例 —— 也就是缩放下限。
 *
 * 公式与引擎 `fit()` 内部那套一致（含 `fitRatio` 0.95 的留白），
 * 这样「自适应」点下去不会先缩一档再弹回来。
 */
function fitScale(markmap: Markmap): number {
  const node = markmap.svg.node()
  if (!node) return 1
  const { width, height } = node.getBoundingClientRect()
  if (!width || !height) return 1
  const { rect } = markmap.state
  const contentW = Math.max(1, rect.x2 - rect.x1)
  const contentH = Math.max(1, rect.y2 - rect.y1)
  const ratio = markmap.options.fitRatio ?? 0.95
  return Math.min((width / contentW) * ratio, (height / contentH) * ratio)
}

/** 把缩放区间设成 [自适应比例, 10]：往下缩正好停在「全貌」，往上放到 10 倍 */
function applyScaleExtent(markmap: Markmap): void {
  const min = Math.max(0.02, fitScale(markmap))
  const zoom = markmap.zoom as unknown as { scaleExtent(extent: [number, number]): void }
  zoom.scaleExtent([min, MAX_SCALE])
}

/** 自适应：先按当前内容算下限，再交给引擎 fit（maxScale 传 10，小树才放得大） */
function fitView(markmap: Markmap): Promise<void> {
  applyScaleExtent(markmap)
  return markmap.fit(MAX_SCALE).catch(() => undefined)
}

/** 工具条按钮的图标（20×20 网格，左上到右下；stroke 由 CSS 给，两种主题共用） */
const TOOL_ICONS: Record<string, string[]> = {
  out: ['M12.6 7.6a4.8 4.8 0 1 1-9.6 0 4.8 4.8 0 0 1 9.6 0Z', 'M11.2 11.2 16 16', 'M5.4 7.6h4.4'],
  in: ['M12.6 7.6a4.8 4.8 0 1 1-9.6 0 4.8 4.8 0 0 1 9.6 0Z', 'M11.2 11.2 16 16', 'M5.4 7.6h4.4', 'M7.6 5.4v4.4'],
  fit: ['M3.6 7.8V3.6h4.2M16.4 7.8V3.6h-4.2M3.6 12.2v4.2h4.2M16.4 12.2v4.2h-4.2'],
  share: ['M10 3.4v9.2', 'M6.8 6.6 10 3.4l3.2 3.2', 'M4.6 11.8v4.4h10.8v-4.4'],
}

type ToolKey = 'mindmap.zoomIn' | 'mindmap.zoomOut' | 'mindmap.zoomReset' | 'mindmap.fit' | 'mindmap.exportSvg'

function toolButton(cls: string, titleKey: ToolKey, icon: string[], text?: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `mindmap-tool ${cls}`
  const title = t(titleKey)
  btn.title = title
  btn.setAttribute('aria-label', title)
  btn.dataset.i18nTitle = titleKey
  if (text != null) {
    btn.textContent = text
  } else {
    btn.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true">' +
      icon.map((d) => `<path d="${d}" />`).join('') +
      '</svg>'
  }
  return btn
}

/**
 * 右下角工具条：缩小 / 当前比例（点一下回 1 倍）/ 放大 / 自适应 / 导出 SVG。
 *
 * 比例标签靠 zoom 事件同步，滚轮、触控板、拖动、按钮、fit 全都过这一个口子，
 * 所以不用在每个操作后面手动刷新。
 */
function createTools(host: HTMLElement, markmap: Markmap): HTMLElement {
  const tools = document.createElement('div')
  tools.className = 'mindmap-tools'
  const out = toolButton('mindmap-zoom-out', 'mindmap.zoomOut', TOOL_ICONS.out)
  const label = toolButton('mindmap-zoom-reset', 'mindmap.zoomReset', [], '100%')
  const inc = toolButton('mindmap-zoom-in', 'mindmap.zoomIn', TOOL_ICONS.in)
  const fit = toolButton('mindmap-fit', 'mindmap.fit', TOOL_ICONS.fit)
  const share = toolButton('mindmap-export', 'mindmap.exportSvg', TOOL_ICONS.share)
  const sep = document.createElement('span')
  sep.className = 'mindmap-tool-sep'
  tools.append(out, label, inc, fit, sep, share)

  /** 屏幕上真实的比例，由 zoom 事件持续刷新 */
  let scale = 1
  /**
   * 按钮要去的目标比例。为什么不每次「当前 × 1.25」：缩放是 260ms 的过渡，
   * 快速连点时上一段动画还没走完，拿当前值当基数就会越点越慢（实测连点 30 次只到 1.9 倍）。
   * 所以按钮累计在 target 上，真实值只用来算这次要走的相对倍数。
   */
  let target = 1
  /** 按钮动画期间（= 不把 target 拉回真实值），到点后自动清掉 */
  let settling = 0
  const paint = (): void => {
    label.textContent = `${Math.round(scale * 100)}%`
  }
  // d3-zoom 的派发器是实时读的，后加的监听器立刻生效，不需要重新 call
  const zoom = markmap.zoom as unknown as {
    on(typenames: string, listener: (event: { transform?: { k?: number } }) => void): void
  }
  zoom.on('zoom.mm2', (event) => {
    const k = event?.transform?.k
    if (typeof k !== 'number') return
    scale = k
    // 滚轮/拖动改的是真实值，target 要跟上，否则下次点按钮会跳回旧目标
    if (!settling) target = k
    paint()
  })

  /** 按倍数走一步，自己先夹到 [自适应比例, 10] —— rescale 走的是 transform，不认 scaleExtent */
  const step = (factor: number): void => {
    const min = Math.max(0.02, fitScale(markmap))
    target = Math.min(MAX_SCALE, Math.max(min, target * factor))
    if (Math.abs(target - scale) < 0.001) return
    window.clearTimeout(settling)
    settling = window.setTimeout(() => {
      settling = 0
      target = scale
    }, (markmap.options.duration ?? 260) + 80)
    void markmap.rescale(target / scale).catch(() => undefined)
  }

  out.addEventListener('click', () => step(1 / ZOOM_STEP))
  inc.addEventListener('click', () => step(ZOOM_STEP))
  label.addEventListener('click', () => step(1 / target))
  fit.addEventListener('click', () => void fitView(markmap))
  share.addEventListener('click', () => exportSvg(host, markmap))
  return tools
}

/**
 * 导出 SVG。
 *
 * 样式分两处：一部分在 svg 自带的 `<style>` 里（引擎的 globalCSS，随 clone 一起走），
 * 另一部分在我们的 styles.css（节点内容、代码高亮、勾选框）。于是把后者里命中
 * `.mm2-*` / `.hljs-*` / `.markmap` 的规则捞出来、剥掉 `.mindmap-body` 前缀，
 * 再把 `:root` 的变量值灌成内联 `:root{}` —— 导出的文件不依赖任何外部资源，
 * 双击就能在浏览器里打开，也能直接贴进 Keynote/Figma。
 */
function exportSvg(host: HTMLElement, markmap: Markmap): void {
  const text = buildExportSvg(host, markmap)
  if (!text) return
  const base = (host.dataset.mindmapExport || 'mindmap').replace(/\.[^.]+$/, '') || 'mindmap'
  download(`${base}.svg`, new TextEncoder().encode(text), 'image/svg+xml;charset=utf-8')
}

function buildExportSvg(host: HTMLElement, markmap: Markmap): string | null {
  const source = markmap.svg.node()
  if (!source) return null
  const { rect } = markmap.state
  const contentW = rect.x2 - rect.x1
  const contentH = rect.y2 - rect.y1
  if (!(contentW > 1) || !(contentH > 1)) return null
  const clone = source.cloneNode(true) as SVGSVGElement
  // 视野那层 g 带着当前的平移和缩放；导出要整张图，先把它复位
  clone.querySelector(':scope > g')?.removeAttribute('transform')
  const width = Math.ceil(contentW + EXPORT_PAD * 2)
  const height = Math.ceil(contentH + EXPORT_PAD * 2)
  const left = rect.x1 - EXPORT_PAD
  const top = rect.y1 - EXPORT_PAD
  clone.setAttribute('viewBox', `${left} ${top} ${width} ${height}`)
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('xmlns', SVG_NS)
  // 底色：SVG 默认透明，浅色文字的图扔进白底浏览器等于白看
  const bg = document.createElementNS(SVG_NS, 'rect')
  bg.setAttribute('x', String(left))
  bg.setAttribute('y', String(top))
  bg.setAttribute('width', String(width))
  bg.setAttribute('height', String(height))
  bg.setAttribute('fill', opaqueBackdrop(host))
  const style = document.createElementNS(SVG_NS, 'style')
  style.textContent = exportCss()
  clone.insertBefore(style, clone.firstChild)
  clone.insertBefore(bg, style.nextSibling)
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`
}

/** 往上找第一个真正有底色的祖先；面板背景通常是透明的，直接取会导出成黑底透明图 */
function opaqueBackdrop(el: HTMLElement): string {
  let node: HTMLElement | null = el
  while (node) {
    const bg = getComputedStyle(node).backgroundColor
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg
    node = node.parentElement
  }
  return '#ffffff'
}

/** 只捞和导图有关的规则，免得把整个 app 的样式表塞进 svg */
const EXPORT_CSS_HINT = /\.mm2-|hljs-|\.markmap|markmap-foreign/

function exportCss(): string {
  const parts: string[] = []
  const root = getComputedStyle(document.documentElement)
  const vars: string[] = []
  for (const name of Array.from(root)) {
    if (!name.startsWith('--')) continue
    const value = root.getPropertyValue(name).trim()
    if (value) vars.push(`${name}:${value}`)
  }
  // 变量是导出文件自己的根，:root 在 svg 文档里就是 <svg>
  parts.push(`:root{${vars.join(';')}}`)
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // 跨源样式表读不到，跳过
    }
    for (const rule of Array.from(rules)) {
      const text = rule.cssText
      if (!EXPORT_CSS_HINT.test(text)) continue
      parts.push(
        text
          .replace(/:is\(\.markdown-body, \.mindmap-body\)\s*/g, '')
          .replace(/\.mindmap-body\s+/g, ''),
      )
    }
  }
  return parts.join('\n')
}

/** 面板被关掉/换掉时调用：清掉实例，别让 d3-zoom 的监听挂在死节点上 */
export function destroyMindmap(host: HTMLElement): void {
  const shell = shells.get(host)
  if (!shell) return
  shells.delete(host)
  try {
    shell.markmap.destroy()
  } catch {
    /* 已经拆过了 */
  }
}

/** 给验收脚本/调试用：当前实例的 svg（没有返回 null） */
export function mindmapSvg(host: HTMLElement): SVGSVGElement | null {
  return shells.get(host)?.svg ?? null
}

/** 打字频繁时行内 HTML 缓存会涨，超过阈值整体丢弃（重算一次也就几毫秒） */
export function trimMindmapCache(): void {
  if (inlineCache.size > 4000) inlineCache = new Map()
}
