/**
 * Markdown → 思维导图（MM-01 ~ MM-06）。
 *
 * 它是「内容」不是「语言」：不新增 LangId，源文本仍是 Markdown，
 * 只是换一种画法。层级来自 mdast 的 heading + list 嵌套，不是自己解析文本。
 *
 * 节点标签复用预览那条管线的行内渲染：把节点对应的原文切片丢给 processSync，
 * 于是加粗、行内代码、链接、行内公式、强调色全都自动继承，白名单也没绕开。
 *
 * 视图（缩放/滚动）归内容自己管：编辑会每 350ms 重画一次，重画只换画布不换壳，
 * 视野必须原地不动；只有换文件（viewKey 变了）才归零。
 */
import type { Content, Heading, List, ListItem, Root } from 'mdast'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Edit } from '../editors/adapter'
import { t } from '../i18n'
import { processor } from './md/pipeline'

/**
 * 尺寸契约：这些数字和 styles.css 里 .mindmap-node / .mm-code / .mm-table 一一对应。
 * 连线端点与画布尺寸都是**算**出来的，不是量出来的，所以改一边必须同步改另一边。
 */
const NODE_W = 180
const NODE_H = 32
/** 代码块/表格块要放下好几行，比普通卡片宽一档 */
const BLOCK_W = 300
/** 列间距：曲线要有地方舒展，太窄会挤成一根斜线（markmap 的 levelGap 是 80） */
const COL_GAP = 78
/** 相邻两行之间的气口（原 ROW_H 44 − NODE_H 32） */
const V_GAP = 14
/** 代码块：上下内边距 14 + 语言头 15 + 头下边距 4 + 2 余量，正文每行 18 */
const CODE_HEAD_H = 35
const CODE_LINE_H = 18
const CODE_MAX_LINES = 8
/** 表格：上下内边距 14 + 2 余量，每行 20 */
const TABLE_PAD_H = 16
const TABLE_ROW_H = 20
const TABLE_MAX_ROWS = 5
/** 画布留白：上下至少留出半个节点高，否则第一行会顶在画布边上 */
const PAD_X = 26
const PAD_Y = 34
/** 分支色板长度，对应 styles.css 的 --mm-b0..7 */
const BRANCH_COLORS = 8
const MAX_NODES = 2000
const MAX_DEPTH = 8
/** 自己配对双击的时间窗与位移容差：原生 dblclick 会被提交重画吞掉，只能自己认 */
const DOUBLE_CLICK_MS = 500
const DOUBLE_CLICK_SLOP = 6

const SVG_NS = 'http://www.w3.org/2000/svg'

const MIN_ZOOM = 0.4
const MAX_ZOOM = 2.5
/** 点按钮的步长偏大，滚轮要更细，否则一滚就跳两档 */
const ZOOM_STEP = 1.2
const WHEEL_STEP = 1.08
/** 适应窗口时四周留的气口，给工具条与连线端点 */
const FIT_PAD = 16

/**
 * 只要 mdast，不要 hast：预览那条管线一路跑到 stringify，
 * 这里只需要结构 + position，所以另起一条只跑解析的短管线。
 */
const parser = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkMath)

/**
 * 节点种类。标题与列表项是树的骨架，其余是「标题下的正文块」，
 * 它们在下一级直接展开成节点，但仍然只允许改文字、不允许当骨架用。
 */
type NodeKind = 'heading' | 'item' | 'para' | 'code' | 'table' | 'quote' | 'math' | 'html'

interface Span {
  from: number
  to: number
}

interface MindNode {
  /** 已渲染好的行内 HTML */
  html: string
  /** 1 起算，用于点击跳行 */
  line: number
  x: number
  y: number
  /** 卡片尺寸：代码块/表格块按内容长高，普通节点是 NODE_W × NODE_H */
  w: number
  h: number
  /** 层级与所属分支：分支决定色系，层级决定渐变的深浅 */
  depth: number
  branch: number
  children: MindNode[]
  parent: MindNode | null
  kind: NodeKind
  /** 标题级别；列表项与正文块为 0 */
  level: number
  /** 可编辑的原文区间：标题与列表项都不含 `#`/`-` 前缀 */
  slice: Span
  /** 编辑态里展示的原文（原始切片，不是渲染结果） */
  raw: string
  /** 本行起止；标题删除时只删这一段 */
  lineStart: number
  lineEnd: number
  /** 本块（含子树）结束偏移：插入同级、整体缩进的范围 */
  tail: number
  /** 本行前缀（含缩进）：插入同级时原样复制 */
  prefix: string
  /** 本行缩进 */
  indent: string
}

/**
 * 线的粗细只跟层级走：一级最粗，越往后越细，底线 1.2 保证第八层还看得见。
 * 不按「深浅混色」做渐变 —— 那样一级分支全被混成同一个蓝，看不出是几条分支。
 */
/** 量文字宽度用的 2D 上下文：只建一次，2000 个节点也就几百次 measureText */
let measureCtx: CanvasRenderingContext2D | null | undefined

/**
 * 节点宽度贴合文字。下划线就是连线的延长线，如果一个三字标题也占 180px，
 * 线就会从一大截空白后面拐出来，看着「悬空」——markmap 那种观感靠的正是
 * 「下划线几乎等于文字宽度」。这里不挂 DOM 量，省掉一次强制重排。
 */
function textBoxWidth(html: string): number {
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d')
  // 字体必须和 .mindmap-node 一致（styles.css 的 --ui-font），否则量出来和实际排版对不上
  let width = text.length * 12
  if (measureCtx) {
    measureCtx.font =
      "12.5px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    width = measureCtx.measureText(text).width
  }
  // 左右各 10px 内边距 + 4px 余量；太短点不中，太长会把整列撑散
  return Math.min(260, Math.max(56, Math.round(width) + 24))
}

function strokeWidth(depth: number): number {
  // markmap classic 的 1 + 3/2^depth：4 → 2.5 → 1.75 → 1.375，越往后越细且收得快，
  // 于是二级之后就只是「细枝」，眼睛会自然落在主干上。1px 是可见底线。
  return Math.max(1, 1 + 3 / 2 ** depth)
}

/**
 * 一条边 = 一段三次贝塞尔，就是 markmap 的 S 曲线（`packages/render/src/themes/shared.ts`
 * 的 `sCurve`，横向版）：两端切线都水平，控制点落在两者 x 的中点。
 *
 * 它像枝桠的原因不是算法花哨，而是**全程没有直线段**：所有边都从父节点下划线右端
 * 同一个点出发，各自弧向自己的子节点，自然张开成扇形。之前那版先横一段主干、
 * 再竖一条树脊、最后才弯，分叉处必然出现直角，所以看着"直愣愣"。
 */
function branchPath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2
  return `M${x1},${y1}C${mx},${y1} ${mx},${y2} ${x2},${y2}`
}

/** 折叠状态按行号记：换文件后行号对不上，自然不会误折叠 */
const collapsed = new Set<string>()
/** 同一个片段会被反复渲染（编辑时重算），缓存省掉大部分 processSync */
const htmlCache = new Map<string, string>()

function inlineHtml(source: string, nodes: readonly Content[]): string {
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  const from = first?.position?.start.offset
  const to = last?.position?.end.offset
  if (from == null || to == null) return ''
  const slice = source.slice(from, to).trim()
  if (!slice) return ''
  const cached = htmlCache.get(slice)
  if (cached != null) return cached
  const raw = processor.processSync(slice).toString()
  // 切片会被包一层块级标签，节点里只要里面那层
  const html = raw.replace(/^<(p|li|h[1-6])>/, '').replace(/<\/(p|li|h[1-6])>\s*$/, '')
  if (htmlCache.size > 600) htmlCache.clear()
  htmlCache.set(slice, html)
  return html
}

/** 代码/表格的标签是从原文抽一行，进 innerHTML 前必须转义 */
function esc(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char)
}

/** 表格头只要纯文本，行内标记在标签里没有意义 */
function plainText(nodes: readonly Content[]): string {
  let out = ''
  for (const node of nodes) {
    if ('value' in node && typeof node.value === 'string') out += node.value
    const kids = (node as { children?: Content[] }).children
    if (Array.isArray(kids)) out += plainText(kids)
  }
  return out
}

/**
 * 围栏块（代码/公式）里"内容"的区间：跳过开头的 ``` 与结尾的 ``` 两行。
 * 单行写法（```x```）退化时宁可整块返回，也不能算错偏移——写回是按偏移切片的。
 */
function fenceInner(source: string, start: number, end: number): Span {
  const raw = source.slice(start, end)
  const open = raw.indexOf('\n')
  if (open < 0) return { from: start, to: end }
  const close = raw.lastIndexOf('\n')
  const from = start + open + 1
  return { from, to: close <= open ? from : start + close }
}

function buildTree(source: string): { root: MindNode; count: number } | null {
  const tree = parser.runSync(parser.parse(source)) as Root
  let count = 0
  let root: MindNode | null = null
  /** 标题层级栈：遇到更浅的标题就弹出去 */
  const stack: { level: number; node: MindNode }[] = []
  /** 所有标题节点：子树结束位置要等整篇走完才知道 */
  const headings: MindNode[] = []

  const make = (kind: NodeKind, html: string): MindNode => {
    count++
    return {
      html,
      line: 1,
      x: 0,
      y: 0,
      // 代码块/表格块在 blockNode 里按内容重新定尺寸，这里只管文字节点
      w: textBoxWidth(html),
      h: NODE_H,
      depth: 0,
      branch: 0,
      children: [],
      parent: null,
      kind,
      level: 0,
      slice: { from: 0, to: 0 },
      raw: '',
      lineStart: 0,
      lineEnd: 0,
      tail: 0,
      prefix: '',
      indent: '',
    }
  }

  const lineStartOf = (offset: number): number => {
    const at = source.lastIndexOf('\n', offset - 1)
    return at < 0 ? 0 : at + 1
  }
  const lineEndOf = (offset: number): number => {
    const at = source.indexOf('\n', offset)
    return at < 0 ? source.length : at
  }

  const headingNode = (heading: Heading): MindNode => {
    const start = heading.position?.start.offset ?? 0
    const end = heading.position?.end.offset ?? start
    const node = make('heading', inlineHtml(source, heading.children))
    node.line = heading.position?.start.line ?? 1
    node.level = heading.depth
    node.lineStart = lineStartOf(start)
    node.lineEnd = end
    node.tail = end
    const first = heading.children[0]?.position?.start.offset
    const last = heading.children[heading.children.length - 1]?.position?.end.offset
    // 空标题没有 children，切片钉在行尾，等用户输入时再补那个空格
    node.slice = first != null && last != null ? { from: first, to: last } : { from: end, to: end }
    node.raw = source.slice(node.slice.from, node.slice.to)
    node.prefix = source.slice(node.lineStart, node.slice.from)
    node.indent = /^\s*/.exec(node.prefix)?.[0] ?? ''
    return node
  }

  const itemNode = (item: ListItem, line: number): MindNode => {
    const start = item.position?.start.offset ?? 0
    const end = item.position?.end.offset ?? start
    const para = item.children.find((child) => child.type === 'paragraph')
    const node = make('item', para ? inlineHtml(source, para.children) : '')
    node.line = line
    node.lineStart = lineStartOf(start)
    node.lineEnd = lineEndOf(start)
    node.tail = end
    const marker = /^(\s*)([-*+]|\d+[.)])(\s+|$)/.exec(source.slice(node.lineStart, node.lineEnd))
    node.indent = marker?.[1] ?? ''
    node.prefix = marker ? marker[0] : `${node.indent}- `
    node.slice = {
      from: para?.position?.start.offset ?? node.lineEnd,
      to: para?.position?.end.offset ?? node.lineEnd,
    }
    node.raw = source.slice(node.slice.from, node.slice.to)
    return node
  }

  /**
   * 标题下的正文块。以前只画标题和列表，段落/代码/表格全被丢掉，
   * 于是「代码块去哪了」成了必然的疑问：它们现在在下一级直接成节点。
   */
  const blockNode = (node: Content): MindNode | null => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start == null || end == null) return null
    const line = node.position?.start.line ?? 1

    const span = (kind: NodeKind, html: string): MindNode => {
      const made = make(kind, html)
      made.line = line
      made.lineStart = lineStartOf(start)
      made.lineEnd = end
      made.tail = end
      made.slice = { from: start, to: end }
      made.raw = source.slice(start, end)
      return made
    }

    switch (node.type) {
      case 'paragraph':
        return span('para', inlineHtml(source, node.children))
      case 'code': {
        const made = span('code', '')
        made.slice = fenceInner(source, start, end)
        made.raw = source.slice(made.slice.from, made.slice.to)
        const lang = (node as { lang?: string | null }).lang ?? ''
        const lines = made.raw.split('\n')
        // 首尾空行不进卡片：围栏里常有人顺手留一行，画出来就是一块空白
        while (lines.length && !lines[0].trim()) lines.shift()
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
        const shown = lines.slice(0, CODE_MAX_LINES)
        const more = lines.length - shown.length
        made.w = BLOCK_W
        made.h = CODE_HEAD_H + CODE_LINE_H * Math.max(1, shown.length)
        // 头部保留「语言 · 行数」：一眼知道是哪种代码、还有多少没画
        const head = lines.length
          ? `${lang || t('mindmap.code')} · ${t('mindmap.codeLines', { n: lines.length })}`
          : lang || t('mindmap.code')
        made.html =
          `<span class="mm-block-head">${esc(head)}</span>` +
          `<pre class="mm-code">${esc(shown.join('\n'))}</pre>` +
          (more > 0 ? `<span class="mm-more">+${more}</span>` : '')
        return made
      }
      case 'table': {
        const made = span('table', '')
        const rows = ((node as { children?: Content[] }).children ?? []) as Array<{
          children?: Content[]
        }>
        const headCells = rows[0]?.children ?? []
        const body = rows.slice(1)
        const shownBody = body.slice(0, TABLE_MAX_ROWS)
        const more = body.length - shownBody.length
        const cell = (c: Content): string =>
          esc(plainText((c as { children?: Content[] }).children ?? []).trim())
        const cols = Math.max(1, headCells.length)
        // 宽度按列数长，但给上下限：两列表格不该占满一屏，八列表格也不能无底洞
        made.w = Math.min(380, Math.max(240, 90 + cols * 66))
        made.h = TABLE_PAD_H + TABLE_ROW_H * (1 + Math.max(1, shownBody.length))
        made.html =
          '<table class="mm-table"><thead><tr>' +
          headCells.map((c) => `<th>${cell(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          shownBody
            .map((row) => `<tr>${(row.children ?? []).map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`)
            .join('') +
          '</tbody></table>' +
          (more > 0 ? `<span class="mm-more">+${more}</span>` : '')
        return made
      }
      case 'blockquote': {
        const made = span('quote', '')
        const para = findParagraph(node)
        made.html = para ? inlineHtml(source, para.children) : esc(t('mindmap.quote'))
        return made
      }
      case 'math': {
        const made = span('math', '')
        made.slice = fenceInner(source, start, end)
        made.raw = source.slice(made.slice.from, made.slice.to)
        const first = made.raw.split('\n').find((lineText) => lineText.trim())?.trim() ?? ''
        made.html = esc(first || t('mindmap.math'))
        return made
      }
      case 'html': {
        const made = span('html', '')
        const first = made.raw.split('\n').find((lineText) => lineText.trim())?.trim() ?? ''
        made.html = esc(first || 'HTML')
        return made
      }
      // 分割线、链接定义、脚注定义、frontmatter 都不是"内容"，不进图
      default:
        return null
    }
  }

  const attachList = (parent: MindNode, list: List) => {
    for (const item of list.children) {
      if (item.type !== 'listItem' || count >= MAX_NODES) continue
      const node = itemNode(item, item.position?.start.line ?? parent.line)
      node.parent = parent
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
        if (block) {
          block.parent = node
          node.children.push(block)
        }
      }
    }
  }

  for (const node of tree.children) {
    if (count >= MAX_NODES) break
    if (node.type === 'heading') {
      const item = headingNode(node)
      while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop()
      if (!root) {
        root = item
      } else {
        const parent = stack.length ? stack[stack.length - 1].node : root
        item.parent = parent
        parent.children.push(item)
      }
      stack.push({ level: item.level, node: item })
      headings.push(item)
      continue
    }
    if (!root) continue
    const parent = stack.length ? stack[stack.length - 1].node : root
    if (node.type === 'list') {
      attachList(parent, node as List)
      continue
    }
    const block = blockNode(node)
    if (block) {
      block.parent = parent
      parent.children.push(block)
    }
  }

  // 标题的子树到下一个同级/更高级标题为止：插入同级要落在它后面，不能插进自己章节里
  for (let i = 0; i < headings.length; i++) {
    const cur = headings[i]
    let tail = source.length
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= cur.level) {
        tail = headings[j].lineStart
        break
      }
    }
    cur.tail = tail
  }

  return root ? { root, count } : null
}

/** 引用块里第一段正文：引用本身长什么样不重要，摘要取第一段就够了 */
function findParagraph(node: Content): { children: Content[] } | null {
  const kids = (node as { children?: Content[] }).children ?? []
  for (const kid of kids) {
    if (kid.type === 'paragraph') return kid as { children: Content[] }
    const deeper = findParagraph(kid)
    if (deeper) return deeper
  }
  return null
}

export interface MindmapOptions {
  onJump?(line: number): void
  /**
   * 视图标识，通常传当前文件 id。只有它变了才重置缩放与滚动：
   * 打字触发的重画若把视野拽回左上角，滚到深处看结构就没法用。
   */
  viewKey?: string
  /**
   * 导图内的块编辑写回通道：一次操作 = 一次 applyEdits（单事务），
   * 天然并进编辑器 undo 栈，也只碰被编辑的这几行。
   */
  applyEdits?(edits: Edit[]): void
  /** 读当前源码：写回后要立刻按新文本重画，不能等 350ms 防抖 */
  getSource?(): string
}

/** 进行中的原地编辑：跨重画保留，否则防抖重画会把输入框连内容一起冲掉 */
interface EditState {
  line: number
  value: string
  caret: number
  /** 首次进入全选，双击一个标题就能直接改成新名字 */
  select: boolean
}

/**
 * 外壳（视口 + 画布 + 工具条）跨重画保留，画布每次重建。
 * 缩放存在这里而不是 canvas 上，因为 canvas 会被整棵替换掉。
 */
interface Shell {
  host: HTMLElement
  viewport: HTMLDivElement
  stage: HTMLDivElement
  tools: HTMLDivElement
  zoomIn: HTMLButtonElement
  zoomOut: HTMLButtonElement
  zoomLabel: HTMLButtonElement
  fit: HTMLButtonElement
  canvas: HTMLElement | null
  /** 未缩放画布尺寸：stage 的显式尺寸 = 它 × zoom */
  width: number
  height: number
  zoom: number
  key: string | null
  options: MindmapOptions
  source: string
  edit: EditState | null
  /**
   * 「换一个节点继续改」的待办：提交当前编辑后要重画一次，
   * 重画会换掉所有节点元素，旧的那份 MindNode 连偏移都可能过期，
   * 所以只记行号 + 块类型，等新树建好再认领。
   */
  pendingOpen: { line: number; kind: NodeKind } | null
  /**
   * 提交重画把整块画布换掉时，浏览器会把那一次 click 一起丢掉，click 计数从 1 重来，
   * 于是原生 dblclick 永远不会出现 —— 双击另一个节点就得点两次。
   * 这里记下那一下的位置/时刻，由紧接着的下一次 pointerdown 自己配对。
   */
  switchDown: { at: number; x: number; y: number } | null
}

const shells = new WeakMap<HTMLElement, Shell>()

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** 折叠钮的图标：− 是横线，+ 再加一条竖线。用路径而不是字符，圆心才对得准 */
function toggleIcon(collapsedNow: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'mindmap-toggle-icon')
  svg.setAttribute('viewBox', '0 0 10 10')
  svg.setAttribute('aria-hidden', 'true')
  const horizontal = document.createElementNS(SVG_NS, 'path')
  horizontal.setAttribute('d', 'M2 5h6')
  svg.append(horizontal)
  if (collapsedNow) {
    const vertical = document.createElementNS(SVG_NS, 'path')
    vertical.setAttribute('d', 'M5 2v6')
    svg.append(vertical)
  }
  return svg
}

function toolButton(cls: string, text: string, titleKey: 'mindmap.zoomIn' | 'mindmap.zoomOut' | 'mindmap.zoomReset' | 'mindmap.fit'): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `mindmap-tool ${cls}`
  btn.textContent = text
  btn.title = t(titleKey)
  btn.setAttribute('aria-label', t(titleKey))
  btn.dataset.i18nTitle = titleKey
  return btn
}

/**
 * 缩放不改布局，只改 transform：tidy 布局已经算好坐标，重排一遍纯属浪费；
 * 但 transform 不影响文档流，滚动条要按缩放后的尺寸改，所以 stage 显式撑开。
 */
function paint(shell: Shell): void {
  shell.zoomLabel.textContent = `${Math.round(shell.zoom * 100)}%`
  if (!shell.canvas) {
    // 空态：别留着上一份画布的尺寸，否则是一片能滚的空白
    shell.stage.style.width = ''
    shell.stage.style.height = ''
    return
  }
  shell.stage.style.width = `${Math.round(shell.width * shell.zoom)}px`
  shell.stage.style.height = `${Math.round(shell.height * shell.zoom)}px`
  shell.canvas.style.transform = `scale(${shell.zoom})`
}

/**
 * 以 anchor（视口内坐标）为不动点缩放：缩放前后同一点必须还停在指针/视口中心下，
 * 否则每次缩放都像把画布甩了一下。
 */
function applyZoom(shell: Shell, next: number, anchor?: { x: number; y: number }): void {
  const zoom = clamp(next, MIN_ZOOM, MAX_ZOOM)
  const { viewport } = shell
  if (Math.abs(zoom - shell.zoom) < 0.001) {
    paint(shell)
    return
  }
  const ax = anchor?.x ?? viewport.clientWidth / 2
  const ay = anchor?.y ?? viewport.clientHeight / 2
  // 锚点在画布坐标系（未缩放）里的位置
  const cx = (viewport.scrollLeft + ax) / shell.zoom
  const cy = (viewport.scrollTop + ay) / shell.zoom
  shell.zoom = zoom
  paint(shell)
  viewport.scrollLeft = cx * zoom - ax
  viewport.scrollTop = cy * zoom - ay
}

function resetView(shell: Shell): void {
  shell.zoom = 1
  paint(shell)
  shell.viewport.scrollTo({ left: 0, top: 0 })
}

/** 适应窗口：只缩不放（放大到 100% 以上没意义），到下限就让它自己滚 */
function fitView(shell: Shell): void {
  if (!shell.width || !shell.height) return
  const { viewport } = shell
  const zoom = Math.min(
    (viewport.clientWidth - FIT_PAD) / shell.width,
    (viewport.clientHeight - FIT_PAD) / shell.height,
    1,
  )
  shell.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM)
  paint(shell)
  viewport.scrollTo({ left: 0, top: 0 })
}

function ensureShell(host: HTMLElement): Shell {
  const existing = shells.get(host)
  // 「文件太大」那条分支会 replaceChildren，壳子跟着没了：留着旧引用只会往孤岛上画
  if (existing && host.contains(existing.viewport)) return existing

  host.replaceChildren()
  const viewport = document.createElement('div')
  viewport.className = 'mindmap-viewport'
  const stage = document.createElement('div')
  stage.className = 'mindmap-stage'
  const tools = document.createElement('div')
  tools.className = 'mindmap-tools'

  const zoomOut = toolButton('mindmap-zoom-out', '\u2212', 'mindmap.zoomOut')
  const zoomLabel = toolButton('mindmap-zoom-reset', '100%', 'mindmap.zoomReset')
  const zoomIn = toolButton('mindmap-zoom-in', '+', 'mindmap.zoomIn')
  const fit = toolButton('mindmap-fit', '⤢', 'mindmap.fit')
  tools.append(zoomOut, zoomLabel, zoomIn, fit)
  viewport.append(stage)
  // 工具条是视口的兄弟而不是子节点：放进滚动容器会跟着画布滚走
  host.append(viewport, tools)

  const shell: Shell = {
    host,
    viewport,
    stage,
    tools,
    zoomIn,
    zoomOut,
    zoomLabel,
    fit,
    canvas: null,
    width: 0,
    height: 0,
    zoom: 1,
    key: null,
    options: {},
    source: '',
    edit: null,
    pendingOpen: null,
    switchDown: null,
  }
  shells.set(host, shell)

  zoomOut.addEventListener('click', () => applyZoom(shell, shell.zoom / ZOOM_STEP))
  zoomIn.addEventListener('click', () => applyZoom(shell, shell.zoom * ZOOM_STEP))
  zoomLabel.addEventListener('click', () => resetView(shell))
  fit.addEventListener('click', () => fitView(shell))

  // Ctrl/Cmd + 滚轮缩放，锚点跟着指针；不按修饰键就是普通滚动
  viewport.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const box = viewport.getBoundingClientRect()
      applyZoom(shell, shell.zoom * (e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP), {
        x: e.clientX - box.left,
        y: e.clientY - box.top,
      })
    },
    { passive: false },
  )

  // 空白处按住拖动 = 平移。节点有自己的点击（跳行）语义，所以只从空白起拖
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    // 从输入框里按下要能拖选文字，不能被平移抢走
    if (target.closest('.mindmap-node') || target.closest('.mindmap-editor') || target.closest('.mindmap-tools')) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const left = viewport.scrollLeft
    const top = viewport.scrollTop
    const pointer = e.pointerId
    viewport.setPointerCapture(pointer)
    viewport.classList.add('is-panning')
    const move = (ev: PointerEvent) => {
      viewport.scrollLeft = left - (ev.clientX - startX)
      viewport.scrollTop = top - (ev.clientY - startY)
    }
    const end = () => {
      viewport.classList.remove('is-panning')
      viewport.removeEventListener('pointermove', move)
      viewport.removeEventListener('pointerup', end)
      viewport.removeEventListener('pointercancel', end)
      if (viewport.hasPointerCapture(pointer)) viewport.releasePointerCapture(pointer)
    }
    viewport.addEventListener('pointermove', move)
    viewport.addEventListener('pointerup', end)
    viewport.addEventListener('pointercancel', end)
  })

  return shell
}

/** 偏移落在第几行（1 起算），插入新块之后要用它决定编辑框开在哪 */
function lineOf(source: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

function currentSource(shell: Shell): string {
  return shell.options.getSource?.() ?? shell.source
}

function previousSibling(node: MindNode): MindNode | null {
  const parent = node.parent
  if (!parent) return null
  const at = parent.children.indexOf(node)
  return at > 0 ? parent.children[at - 1] : null
}

/** 有序列表插入同级时要接着往下编号，否则新条目和上一条重号 */
function nextMarker(node: MindNode): string {
  const match = /^(\s*)(\d+)([.)])(\s*)$/.exec(node.prefix)
  if (!match) return node.prefix
  return `${match[1]}${Number(match[2]) + 1}${match[3]}${match[4] || ' '}`
}

/** 最近的列表项祖先：降级时要对齐到它的缩进，没有就回到顶格 */
function ancestorItem(node: MindNode): MindNode | null {
  let cursor = node.parent
  while (cursor && cursor.kind !== 'item') cursor = cursor.parent
  return cursor
}

/**
 * 整块（含子树）左右挪缩进：按字符数从每行行首拿掉/加回若干空白。
 * 只对真正有内容的行动手，空行保持原样——补上空格会让它变成「行尾空格」。
 */
function shiftBlock(source: string, from: number, to: number, edits: Edit[], delta: number): void {
  let at = from
  while (at < to) {
    const lineEnd = source.indexOf('\n', at)
    const stop = lineEnd < 0 || lineEnd > to ? to : lineEnd
    const text = source.slice(at, stop)
    if (text.trim()) {
      if (delta > 0) edits.push({ from: at, to: at, insert: ' '.repeat(delta) })
      else {
        const lead = /^[ \t]*/.exec(text)?.[0].length ?? 0
        const cut = Math.min(-delta, lead)
        if (cut > 0) edits.push({ from: at, to: at + cut, insert: '' })
      }
    }
    if (lineEnd < 0 || lineEnd >= to) break
    at = lineEnd + 1
  }
}

/** 标题层级按钮的上下限：Markdown 只有 H1~H6 */
const MAX_LEVEL = 6

/**
 * 超过这个体量就不整篇画（也不整篇不画）：按行截断，画前一部分。
 * 截断点的偏移和原文完全一致，所以画出来的节点照样能改、能删。
 */
const MAX_SOURCE_CHARS = 400_000

function clipSource(source: string): { text: string; lines: number } | null {
  if (source.length <= MAX_SOURCE_CHARS) return null
  const cut = source.lastIndexOf('\n', MAX_SOURCE_CHARS)
  const text = cut > 0 ? source.slice(0, cut) : source.slice(0, MAX_SOURCE_CHARS)
  return { text, lines: text.split('\n').length }
}

/**
 * 双击进入原地编辑：显示的是**原始切片**，不是渲染后的 HTML。
 * 因此 `**粗体**`、行内代码、链接一个符号都不会被抹掉。
 */
function openEditor(host: HTMLElement, shell: Shell, node: MindNode): void {
  if (!shell.options.applyEdits) return
  const source = currentSource(shell)
  if (source.slice(node.slice.from, node.slice.to) !== node.raw) {
    // 偏移已经过期（防抖窗口里文档改过，或刚提交过另一块）：
    // 不拿旧切片写回，改按「行号 + 块类型」在新文本里重新认领这个节点
    shell.pendingOpen = { line: node.line, kind: node.kind }
    renderMindmap(host, source, shell.options)
    return
  }
  shell.edit = { line: node.line, value: node.raw, caret: node.raw.length, select: true }
  renderMindmap(host, source, shell.options)
}

/**
 * 提交编辑。一次按键最多产生一次 applyEdits：
 * 文字替换 + 结构插入同处一个事务，undo 一步回到编辑前，diff 也只有这一块。
 */
type EditAction = 'stay' | 'sibling' | 'child' | 'dedent' | 'deeper' | 'shallower'

function commitEditor(host: HTMLElement, shell: Shell, node: MindNode, action: EditAction): void {
  const state = shell.edit
  if (!state) return
  const source = currentSource(shell)
  const edits: Edit[] = []
  const single = node.kind === 'heading' || node.kind === 'item'
  // 标题/条目里塞进换行会把这一行拆成两行，结构当场变形，写回前压平
  const value = single ? state.value.replace(/\s*\n\s*/g, ' ').trim() : state.value
  // 空标题、空条目原文里连前缀后的空格都没有，补一个才长得出合法标记
  const pad = node.raw === '' && value !== '' && !node.prefix.endsWith(' ')
  if (value !== node.raw) {
    edits.push({ from: node.slice.from, to: node.slice.to, insert: pad ? ` ${value}` : value })
  }

  let insertedAt = -1
  let leadingBreak = false
  if (action === 'sibling' && single) {
    // 插在整棵子树之后：插在自己章节中间会把原有内容划给新节点
    const at = node.tail
    const head = node.kind === 'heading' ? `${'#'.repeat(node.level)} ` : nextMarker(node)
    leadingBreak = at > 0 && source[at - 1] !== '\n'
    const trailingBreak = at < source.length && source[at] !== '\n'
    edits.push({ from: at, to: at, insert: `${leadingBreak ? '\n' : ''}${head}${trailingBreak ? '\n' : ''}` })
    insertedAt = at
  } else if (action === 'child' && node.kind === 'item') {
    const prev = previousSibling(node)
    if (prev) {
      const own = prev.prefix.slice(prev.indent.length)
      const sample = prev.children.find((kid) => kid.kind === 'item')?.indent
      const childIndent = sample ?? `${prev.indent}${' '.repeat(own.length)}`
      const delta = childIndent.length - node.indent.length
      // 整块（含子树）一起加缩进，行与行的相对层级不变
      if (delta > 0) shiftBlock(source, node.lineStart, node.tail, edits, delta)
    }
  } else if (action === 'dedent' && node.kind === 'item') {
    // 降级 = 对齐到上一层列表项：没有祖先项就已经是顶层，整块原地不动。
    // 子树跟着一起减，相对层级不变；比 delta 还浅的行本来就该顶格，只减它能减的那点。
    const delta = node.indent.length - (ancestorItem(node)?.indent.length ?? 0)
    if (delta > 0) shiftBlock(source, node.lineStart, node.tail, edits, -delta)
  } else if ((action === 'deeper' || action === 'shallower') && node.kind === 'heading') {
    // 只换行首那几个 #，正文一个字符都不动；替换整个前缀顺手把多余空格规范成一个
    const level = node.level + (action === 'deeper' ? 1 : -1)
    if (level >= 1 && level <= MAX_LEVEL) {
      edits.push({
        from: node.lineStart,
        to: node.lineStart + node.prefix.length,
        insert: `${'#'.repeat(level)} `,
      })
    }
  }

  shell.edit = null
  if (edits.length) shell.options.applyEdits?.(edits)
  const fresh = currentSource(shell)
  if (insertedAt >= 0) {
    // 替换文字可能改变长度，插入点的「新坐标」要补上这段位移
    const shift = value.length + (pad ? 1 : 0) - (node.slice.to - node.slice.from)
    const start = insertedAt + shift + (leadingBreak ? 1 : 0)
    shell.edit = { line: lineOf(fresh, start), value: '', caret: 0, select: false }
  }
  renderMindmap(host, fresh, shell.options)
}

/** 删除节点块：标题只删自己那一行，列表项连子树一起删（缩进决定归属） */
function deleteNode(host: HTMLElement, shell: Shell, node: MindNode): void {
  const source = currentSource(shell)
  const from = node.lineStart
  let to = node.kind === 'heading' ? node.lineEnd : node.tail
  // 只看行尾那个换行：吃前面的换行会把上一行原来的行尾也带走（删完文件少一个 \n）
  if (source[to] === '\n') to++
  if (to <= from) return
  shell.edit = null
  shell.options.applyEdits?.([{ from, to, insert: '' }])
  renderMindmap(host, currentSource(shell), shell.options)
}

/**
 * 当前活着的编辑框。为什么不用 blur 提交：
 * 面板每 350ms 防抖重画一次，`stage.replaceChildren()` 摘下焦点元素时浏览器会派发 blur，
 * 而那一刻 `isConnected` 还是 true —— 和用户真的点走无法区分，于是「刚建的空节点」
 * 会在 350ms 后被自己重画掉的 blur 误提交。改用文档级 pointerdown：只有真人点击才提交。
 */
let liveBox: HTMLTextAreaElement | null = null
let liveGuard: ((ev: PointerEvent) => void) | null = null

function mountEditor(host: HTMLElement, shell: Shell, layer: HTMLElement, node: MindNode): void {
  const state = shell.edit
  if (!state) return
  const box = document.createElement('textarea')
  box.className = 'mindmap-editor'
  box.spellcheck = false
  box.rows = 1
  box.dataset.kind = node.kind
  box.placeholder = t('mindmap.placeholder')
  box.value = state.value
  box.style.left = `${node.x}px`
  box.style.top = `${node.y - node.h / 2}px`
  const multiline = node.kind === 'code' || node.kind === 'table' || node.kind === 'quote' || node.kind === 'html'
  box.style.width = `${Math.max(multiline ? 320 : 220, node.w)}px`

  const fit = () => {
    box.style.height = 'auto'
    box.style.height = `${Math.min(360, Math.max(node.h, box.scrollHeight + 2))}px`
  }

  // 编辑态的值实时写回 state：350ms 防抖重画会重建输入框，值不能丢
  box.addEventListener('input', () => {
    if (shell.edit !== state) return
    state.value = box.value
    state.caret = box.selectionStart
    fit()
  })
  box.addEventListener('keyup', () => {
    if (shell.edit === state) state.caret = box.selectionStart
  })
  box.addEventListener('keydown', (ev) => {
    if (shell.edit !== state) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      shell.edit = null
      renderMindmap(host, currentSource(shell), shell.options)
      return
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      ev.stopPropagation()
      commitEditor(host, shell, node, ev.metaKey || ev.ctrlKey ? 'stay' : 'sibling')
      return
    }
    if (ev.key === 'Tab') {
      ev.preventDefault()
      ev.stopPropagation()
      commitEditor(host, shell, node, ev.shiftKey ? 'dedent' : 'child')
      return
    }
    // 标题层级：⌘/Ctrl + [ 升一级（# 变少），] 降一级（# 变多），H1~H6 封顶
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === '[' || ev.key === ']') && node.kind === 'heading') {
      ev.preventDefault()
      ev.stopPropagation()
      commitEditor(host, shell, node, ev.key === ']' ? 'deeper' : 'shallower')
      return
    }
    // 空节点上按退格/删除 = 删掉这一块；有字时仍然是普通的退格
    if ((ev.key === 'Backspace' || ev.key === 'Delete') && box.value.trim() === '') {
      ev.preventDefault()
      ev.stopPropagation()
      deleteNode(host, shell, node)
    }
  })
  layer.append(box)
  // 上一轮的守卫挂在旧输入框上，先摘掉，否则点到别处会按旧节点提交
  if (liveGuard) document.removeEventListener('pointerdown', liveGuard, true)
  const guard = (ev: PointerEvent) => {
    // 重画会换一个新的 box，旧守卫凭这两个条件立刻失效
    if (liveBox !== box || shell.edit !== state) return
    if (ev.target instanceof Node && box.contains(ev.target)) return
    // 落在另一个节点上：这一下之后很可能还跟着第二下（双击换节点），
    // 但下面的提交会重画整块画布，浏览器连 click 带 click 计数一起丢掉，
    // 原生 dblclick 就再也等不到了。记下位置/时刻，交给节点的 pointerdown 自己配对。
    const onNode = ev.target instanceof Element ? ev.target.closest('.mindmap-node') : null
    shell.switchDown = null
    if (onNode) {
      // 捕获阶段比节点自己的 pointerdown 早，直接赋值会被这一下自己认领掉；
      // 微任务也不行（每个监听器返回都会清空微任务队列），必须排到下一个任务
      const hint = { at: Date.now(), x: ev.clientX, y: ev.clientY }
      setTimeout(() => {
        shell.switchDown = hint
      }, 0)
    }
    commitEditor(host, shell, node, 'stay')
  }
  liveBox = box
  liveGuard = guard
  document.addEventListener('pointerdown', guard, true)
  requestAnimationFrame(() => {
    if (!box.isConnected) return
    fit()
    box.focus()
    if (state.select) box.select()
    else box.setSelectionRange(state.caret, state.caret)
  })
}

export function renderMindmap(host: HTMLElement, source: string, options: MindmapOptions = {}): void {
  const shell = ensureShell(host)
  shell.options = options
  shell.source = source

  // 换文件才归零；同一文件的重画（打字、折叠）保留缩放与滚动
  let fresh = false
  if (options.viewKey !== undefined && options.viewKey !== shell.key) {
    shell.key = options.viewKey ?? null
    shell.zoom = 1
    fresh = true
  }

  const { viewport, stage } = shell
  const scrollLeft = fresh ? 0 : viewport.scrollLeft
  const scrollTop = fresh ? 0 : viewport.scrollTop

  shell.canvas = null
  shell.width = 0
  shell.height = 0
  stage.replaceChildren()
  viewport.querySelectorAll('.mindmap-hint, .mindmap-empty').forEach((node) => node.remove())
  shell.tools.hidden = true

  // 大文件（原来是整块不画）改成按行截断：截断点的偏移和原文一致，
  // 画出来的节点照样能改能删，写回的是原文同一段切片。
  const clip = clipSource(source)
  const clipped = clip?.lines ?? 0
  const built = buildTree(clip?.text ?? source)
  if (!built) {
    // 树没了，「去那个节点继续改」也无从谈起
    shell.pendingOpen = null
    const empty = document.createElement('p')
    empty.className = 'mindmap-empty'
    empty.textContent = t('mindmap.empty')
    stage.append(empty)
    paint(shell)
    return
  }

  shell.tools.hidden = false

  const { root, count } = built
  const placed: MindNode[] = []
  /** 每列最宽的节点：列宽由它决定，块级节点把列撑宽，而不是压住右边的列 */
  const colW: number[] = []
  /** 纵向游标：叶子按自身高度往下堆，父节点再居中于子节点之间 */
  let cursor = PAD_Y
  let maxDepth = 0

  const place = (node: MindNode, depth: number, branch: number): number => {
    node.depth = depth
    node.branch = branch
    maxDepth = Math.max(maxDepth, depth)
    colW[depth] = Math.max(colW[depth] ?? 0, node.w)
    const kids = depth >= MAX_DEPTH || collapsed.has(String(node.line)) ? [] : node.children
    if (!kids.length) {
      // 叶子自己占多高就占多高：代码块/表格块不必再被压成一行
      node.y = cursor + node.h / 2
      cursor += node.h + V_GAP
    } else {
      // 一级分支各领一个色系，整棵子树沿用它 —— 同一条分支的线才连成一根
      const ys = kids.map((kid, i) => place(kid, depth + 1, depth === 0 ? i : branch))
      node.y = (ys[0] + ys[ys.length - 1]) / 2
    }
    placed.push(node)
    return node.y
  }
  place(root, 0, 0)

  // 列坐标要等整棵树排完：某列里有块级节点，后面的列就整体右移
  const colX: number[] = []
  let nextX = PAD_X
  for (let depth = 0; depth <= maxDepth; depth++) {
    colX[depth] = nextX
    nextX += (colW[depth] ?? NODE_W) + COL_GAP
  }
  for (const node of placed) node.x = colX[node.depth]
  // 后序遍历的插入顺序是「叶子在前、根在最后」；按坐标重排成列优先，
  // 于是 DOM 顺序 = 阅读顺序，键盘 Tab 也顺着树往下走
  placed.sort((a, b) => a.x - b.x || a.y - b.y)

  // 「换一个节点继续改」：提交时旧对象的偏移已经不可信，只记了行号 + 块类型，
  // 新树建好后在这里认领。认不到（节点被折叠了、行号被前面的编辑推走了）就不开。
  if (shell.pendingOpen) {
    const want = shell.pendingOpen
    shell.pendingOpen = null
    const target = placed.find((node) => node.line === want.line && node.kind === want.kind)
    if (target) shell.edit = { line: target.line, value: target.raw, caret: target.raw.length, select: true }
  }

  const width = nextX - COL_GAP + PAD_X
  const height = cursor - V_GAP + PAD_Y

  const canvas = document.createElement('div')
  canvas.className = 'mindmap-canvas'
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'mindmap-links')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))

  /**
   * 一条分支一根线：从父节点右缘出来一段水平主干，同级的子节点共用一条竖直树脊，
   * 再从树脊上各分一条 S 弯下去，落进子卡片**底缘**——卡片浮在线上，线从下面托着它。
   * 根出去的一级分支不共用主干：每条分支自己一个色，五条分支就是五种颜色。
   */
  const addLink = (d: string, branch: number, depth: number, opacity: number): void => {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    path.style.stroke = `var(--mm-b${branch % BRANCH_COLORS})`
    path.style.strokeWidth = String(strokeWidth(depth))
    if (opacity < 1) path.style.opacity = String(opacity)
    path.dataset.depth = String(depth)
    svg.append(path)
  }

  const foldAt = (node: MindNode): boolean =>
    node.depth >= MAX_DEPTH || collapsed.has(String(node.line))

  for (const node of placed) {
    if (foldAt(node) || !node.children.length) continue
    const opacity = Math.max(0.7, 1 - node.depth * 0.04)
    // 连线接在**下划线两端**（父右端 → 子左端，都在底缘高度），
    // 于是线看起来就是那条彩色下划线自己延伸出去拐个弯 —— 内容块自然坐在线上面
    const x1 = node.x + node.w
    const y1 = node.y + node.h / 2
    const kids = node.children
    for (const kid of kids) {
      addLink(
        branchPath(x1, y1, kid.x, kid.y + kid.h / 2),
        node.depth === 0 ? kid.branch : node.branch,
        node.depth === 0 ? 0 : node.depth + 1,
        opacity,
      )
    }
  }

  const layer = document.createElement('div')
  layer.className = 'mindmap-nodes'
  for (const node of placed) {
    // 正在编辑的那个节点换成输入框；其余照常渲染
    if (shell.edit && shell.edit.line === node.line) {
      mountEditor(host, shell, layer, node)
      continue
    }

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'mindmap-node'
    btn.style.left = `${node.x}px`
    btn.style.top = `${node.y - node.h / 2}px`
    btn.style.width = `${node.w}px`
    btn.style.height = `${node.h}px`
    btn.dataset.depth = String(node.depth)
    btn.dataset.kind = node.kind
    // 节点自己带分支色：下划线、折叠钮、hover 都读同一个 --mm-c；
    // 根节点取第一分支色，和下划线延伸出去的那条主线同一个色（markmap 也这么办）
    const branch = node.depth > 0 ? node.branch : 0
    btn.style.setProperty('--mm-c', `var(--mm-b${branch % BRANCH_COLORS})`)
    // --mm-lw 让下划线粗细和连线粗细用同一个公式（strokeWidth）
    btn.style.setProperty('--mm-lw', `${strokeWidth(node.depth)}px`)
    btn.title =
      `${t('outline.line', { line: node.line })} · ${t('mindmap.edit')}` +
      (node.kind === 'heading' && shell.options.applyEdits ? ` · ${t('mindmap.levelHint')}` : '')
    // 文字要单独一层：节点放开 overflow 后，省略号得由这一层负责。
    // 代码块/表格块是多行结构，换成不省略、不折行的块容器
    const blocky = node.kind === 'code' || node.kind === 'table'
    const label = document.createElement(blocky ? 'div' : 'span')
    label.className = blocky ? 'mindmap-label mindmap-label-block' : 'mindmap-label'
    label.innerHTML = node.html || '&nbsp;'
    btn.append(label)
    btn.addEventListener('click', () => shell.options.onJump?.(node.line))
    if (shell.options.applyEdits) {
      btn.addEventListener('dblclick', (ev) => {
        ev.preventDefault()
        openEditor(host, shell, node)
      })
      btn.addEventListener('pointerdown', (ev) => {
        // 「编辑中双击换个节点」的第二下：上一下的提交重画把原生 dblclick 吃掉了，
        // 这里按位置 + 时间自己配对，配上了就直接开这一块的编辑框
        const hint = shell.switchDown
        if (!hint) return
        shell.switchDown = null
        if (Date.now() - hint.at > DOUBLE_CLICK_MS) return
        if (Math.abs(ev.clientX - hint.x) > DOUBLE_CLICK_SLOP) return
        if (Math.abs(ev.clientY - hint.y) > DOUBLE_CLICK_SLOP) return
        if (ev.target instanceof Element && ev.target.closest('.mindmap-toggle')) return
        openEditor(host, shell, node)
      })
    }

    if (node.children.length) {
      const key = String(node.line)
      const toggle = document.createElement('span')
      toggle.className = 'mindmap-toggle'
      // 用两条 <path> 画 −/+：字体基线的 − 天生偏低，靠 line-height 对不齐
      toggle.append(toggleIcon(collapsed.has(key)))
      toggle.addEventListener('click', (ev) => {
        ev.stopPropagation()
        if (collapsed.has(key)) collapsed.delete(key)
        else collapsed.add(key)
        // 折叠只改结构，视野（缩放/滚动）要留住
        renderMindmap(host, shell.source, shell.options)
      })
      btn.append(toggle)
    }
    layer.append(btn)
  }

  canvas.append(svg, layer)

  if (count >= MAX_NODES) {
    const hint = document.createElement('p')
    hint.className = 'mindmap-hint'
    hint.textContent = t('mindmap.truncated', { n: MAX_NODES })
    viewport.append(hint)
    if (clipped) hint.textContent += ` ${t('mindmap.clipped', { n: clipped })}`
  } else if (clipped) {
    const hint = document.createElement('p')
    hint.className = 'mindmap-hint'
    hint.textContent = t('mindmap.clipped', { n: clipped })
    viewport.append(hint)
  }

  stage.append(canvas)
  shell.canvas = canvas
  shell.width = width
  shell.height = height
  paint(shell)
  viewport.scrollLeft = scrollLeft
  viewport.scrollTop = scrollTop
}
