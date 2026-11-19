/**
 * 幻灯片预览（编辑态）：连续页列表 + 与导图同构的缩放。
 *
 * 几个刻意的取舍：
 *   - **不抢键盘**：没有方向键/空格翻页，翻页靠滚动；滚轮只在按住 Ctrl/Cmd 时缩放。
 *   - **不改布局地缩放**：页卡固定画布尺寸（1280×720），缩放只是 `transform: scale()`，
 *     外层盒子用 `calc(画布 × scale)` 拿到正确的滚动范围 —— 文字始终是矢量。
 *   - **点击 ≠ 拖拽**：位移超过 4px 或存在选区就不跳行，否则跳到该页源码首行。
 *   - **页内容只走 `renderMarkdown()`**：与预览同一个管线，图表由调用方在
 *     `onPageRendered` 里 hydrate，保证面板里看到的与放映、导出完全一致。
 */
import { t } from '../../i18n'
import { fitPageContent } from './autofit'
import { ratioSize, type DeckDoc, type DeckPage } from './deck'
import { renderMarkdown } from '../markdown'

const ZOOM_STEP = 1.25
const MAX_SCALE = 10
const WHEEL_STEP = 1.08
const PAN_THRESHOLD = 4

export interface DeckViewOptions {
  /** 换文件时把缩放与滚动归零；打字触发的重画保留 */
  viewKey?: string
  /** 点击页卡 / 页码跳到该页源码首行 */
  onJump?: (line: number) => void
  /** 页内容挂载完成（图表在这里 hydrate）；返回 Promise 时等内容落定后再量一次高度 */
  onPageRendered?: (slot: HTMLElement, page: DeckPage) => void | Promise<void>
}

interface Slot {
  wrap: HTMLElement
  page: HTMLElement
  index: number
  source: string
  /** 已渲染的源码；和 source 不同就要重画 */
  rendered: string | null
  pending: boolean
}

interface Shell {
  root: HTMLElement
  viewport: HTMLElement
  stage: HTMLElement
  tools: HTMLElement
  label: HTMLElement
  empty: HTMLElement
  slots: Slot[]
  pagers: HTMLElement[]
  pages: DeckPage[]
  scale: number
  /** 按钮累计的目标比例，避免连点时被上一帧的 scale 吃掉步进 */
  target: number
  w: number
  h: number
  key: string
  generation: number
  observer: IntersectionObserver | null
  resize: ResizeObserver | null
  abort: AbortController
  options: DeckViewOptions
}

const shells = new WeakMap<HTMLElement, Shell>()

/** 渲染（或重画）幻灯片面板。同一份文本重复调用只会更新变化了的页。 */
export function renderDeck(host: HTMLElement, doc: DeckDoc, options: DeckViewOptions = {}): void {
  const shell = shells.get(host) ?? mount(host, options)
  shell.options = options
  shell.pages = doc.pages

  const size = ratioSize(doc.ratio)
  const sizeChanged = shell.w !== size.w || shell.h !== size.h
  shell.w = size.w
  shell.h = size.h

  // 换文件：缩放与位置归零（与导图 viewKey 语义一致）
  const fileChanged = options.viewKey !== undefined && options.viewKey !== shell.key
  if (fileChanged) {
    shell.key = options.viewKey ?? ''
    shell.scale = minScale(shell)
    shell.target = shell.scale
    shell.viewport.scrollTop = 0
    shell.viewport.scrollLeft = 0
  }

  syncEmpty(shell, doc)

  if (!doc.pages.length || doc.reason !== 'ok') {
    // 空态下不保留旧页，避免面板收起再打开时残留上一份内容
    shell.stage.replaceChildren()
    shell.slots = []
    shell.pagers = []
    shell.observer?.disconnect()
    paint(shell)
    return
  }

  const scrollTop = shell.viewport.scrollTop
  if (shell.slots.length !== doc.pages.length || sizeChanged) {
    buildSlots(shell, doc)
  } else {
    patchSlots(shell, doc)
  }
  paint(shell)
  shell.viewport.scrollTop = shell.observer ? scrollTop : 0
  shell.slots.forEach((slot) => ensureRendered(shell, slot))
}

/** 拆掉面板里的实例（面板收起 / 内容切换时调用） */
export function destroyDeck(host: HTMLElement): void {
  const shell = shells.get(host)
  if (!shell) return
  shell.abort.abort()
  shell.observer?.disconnect()
  shell.resize?.disconnect()
  shells.delete(host)
  host.replaceChildren()
}

/* ------------------------------------------------------------------ 挂载 */

function mount(host: HTMLElement, options: DeckViewOptions): Shell {
  const abort = new AbortController()
  const { signal } = abort

  const viewport = node('div', 'deck-viewport')
  const stage = node('div', 'deck-stage')
  viewport.append(stage)

  const empty = node('div', 'deck-empty')
  empty.hidden = true

  const label = node('button', 'deck-tool deck-zoom-reset') as HTMLButtonElement
  label.type = 'button'
  label.textContent = '100%'
  label.title = t('deck.zoomReset')

  const tools = node('div', 'deck-tools')
  const zoomOut = toolButton('deck-zoom-out', t('deck.zoomOut'), 'M5 12h14')
  const zoomIn = toolButton('deck-zoom-in', t('deck.zoomIn'), 'M12 5v14M5 12h14')
  const fit = toolButton('deck-fit', t('deck.fit'), 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5')
  tools.append(zoomOut, label, zoomIn, fit)

  host.replaceChildren(viewport, tools, empty)
  host.classList.add('deck-body')

  const shell: Shell = {
    root: host,
    viewport,
    stage,
    tools,
    label,
    empty,
    slots: [],
    pagers: [],
    pages: [],
    scale: 1,
    target: 1,
    w: 1280,
    h: 720,
    key: options.viewKey ?? '',
    generation: 0,
    observer: null,
    resize: null,
    abort,
    options,
  }
  shells.set(host, shell)

  zoomOut.addEventListener('click', () => zoomBy(shell, 1 / ZOOM_STEP), { signal })
  zoomIn.addEventListener('click', () => zoomBy(shell, ZOOM_STEP), { signal })
  label.addEventListener('click', () => setScale(shell, 1), { signal })
  fit.addEventListener('click', () => setScale(shell, minScale(shell)), { signal })

  // Ctrl/Cmd + 滚轮缩放，锚在指针；纯滚轮留给滚动
  viewport.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const factor = event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP
      setScale(shell, shell.scale * factor, { x: event.clientX, y: event.clientY })
    },
    { passive: false, signal },
  )

  bindPan(shell, signal)

  shell.resize = new ResizeObserver(() => {
    const min = minScale(shell)
    shell.target = Math.max(shell.target, min)
    if (shell.scale < min - 1e-4) setScale(shell, min)
  })
  shell.resize.observe(viewport)

  const initial = minScale(shell)
  shell.scale = initial
  shell.target = initial
  paint(shell)

  return shell
}

/** 空白处拖拽平移；松手时若没拖动过，就是「点这一页跳源码」 */
function bindPan(shell: Shell, signal: AbortSignal): void {
  const viewport = shell.viewport
  let down: {
    x: number
    y: number
    left: number
    top: number
    page: number
    moved: boolean
  } | null = null

  viewport.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('.deck-tools')) return
      down = {
        x: event.clientX,
        y: event.clientY,
        left: viewport.scrollLeft,
        top: viewport.scrollTop,
        // 页卡与页码都能跳转。不能在页码上挂 click：pointerdown 里
        // setPointerCapture 之后，mousedown/mouseup 的共同祖先变成 viewport，
        // click 就不再派发到页码了（Chrome 行为）
        page: Number(
          (event.target as HTMLElement).closest('.deck-slot, .deck-pager')?.getAttribute('data-page') ?? -1,
        ),
        moved: false,
      }
      viewport.setPointerCapture(event.pointerId)
      viewport.classList.add('is-grab')
    },
    { signal },
  )

  viewport.addEventListener(
    'pointermove',
    (event) => {
      if (!down) return
      const dx = event.clientX - down.x
      const dy = event.clientY - down.y
      if (!down.moved && Math.hypot(dx, dy) > PAN_THRESHOLD) {
        down.moved = true
        viewport.classList.add('is-panning')
      }
      if (!down.moved) return
      viewport.scrollLeft = down.left - dx
      viewport.scrollTop = down.top - dy
    },
    { signal },
  )

  const end = (event: PointerEvent) => {
    if (!down) return
    const { page, moved } = down
    down = null
    viewport.classList.remove('is-grab', 'is-panning')
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
    // 拖拽不算点击；有选区也不算（用户想复制文字）
    if (moved || !window.getSelection()?.isCollapsed) return
    const target = page >= 0 ? shell.pages[page] : undefined
    if (target) shell.options.onJump?.(target.line)
  }

  viewport.addEventListener('pointerup', end, { signal })
  viewport.addEventListener('pointercancel', end, { signal })
}

/* -------------------------------------------------------------- 缩放与刷新 */

/**
 * 「适应宽度」= 页卡宽度刚好等于可视区**可用**宽度。
 * `.deck-stage` 有左右内边距，扣不扣差一截：按 `clientWidth` 算出来会比可用宽度宽
 * 24px，最小缩放时页卡右侧被裁、还得横向滚一下才能看全。
 */
function minScale(shell: Shell): number {
  if (!shell.viewport.clientWidth) return 1
  const cs = getComputedStyle(shell.stage)
  const padding = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
  // 亚像素误差会让「刚好等于」变成一条横向滚动条，留半像素
  const usable = shell.viewport.clientWidth - padding - 0.5
  if (usable <= 0) return 1
  return usable / shell.w
}

function clampScale(shell: Shell, scale: number): number {
  const min = minScale(shell)
  return Math.min(MAX_SCALE, Math.max(min, Math.min(scale, MAX_SCALE)))
}

/**
 * 缩放并保持锚点下的内容不动。
 * 必须先让新尺寸落地（读一次 scrollHeight 触发同步布局），否则设置
 * scrollLeft/Top 会被旧的可滚动范围夹掉。
 */
function setScale(shell: Shell, next: number, anchor?: { x: number; y: number }): void {
  const viewport = shell.viewport
  const from = shell.scale
  const to = clampScale(shell, next)
  shell.target = to
  if (!Number.isFinite(to) || Math.abs(to - from) < 1e-4) {
    paint(shell)
    return
  }

  const rect = viewport.getBoundingClientRect()
  const ax = anchor ? anchor.x - rect.left : viewport.clientWidth / 2
  const ay = anchor ? anchor.y - rect.top : viewport.clientHeight / 2
  const cx = (viewport.scrollLeft + ax) / from
  const cy = (viewport.scrollTop + ay) / from

  shell.scale = to
  paint(shell)

  // 强制同步布局，拿到新的 scrollWidth/scrollHeight
  void viewport.scrollHeight
  viewport.scrollLeft = cx * to - ax
  viewport.scrollTop = cy * to - ay
}

function zoomBy(shell: Shell, factor: number): void {
  setScale(shell, shell.target * factor)
}

function paint(shell: Shell): void {
  shell.stage.style.setProperty('--deck-w', `${shell.w}px`)
  shell.stage.style.setProperty('--deck-h', `${shell.h}px`)
  // 打印时页宽铺满纸宽、高度按这个比例算（CSS 的 aspect-ratio 只吃数字，不吃 px）
  shell.stage.style.setProperty('--deck-ratio', `${shell.w} / ${shell.h}`)
  shell.stage.style.setProperty('--deck-scale', String(shell.scale))
  shell.label.textContent = `${Math.round(shell.scale * 100)}%`
}

/* ------------------------------------------------------------------ 页卡 */

function buildSlots(shell: Shell, doc: DeckDoc): void {
  shell.generation++
  shell.observer?.disconnect()

  const fragment = document.createDocumentFragment()
  const total = doc.pages.length
  const slots: Slot[] = []

  doc.pages.forEach((page, index) => {
    const wrap = node('div', 'deck-slot')
    wrap.dataset.page = String(index)

    const pageEl = node('div', 'deck-page')
    pageEl.title = t('deck.jump')
    applyPageStyle(pageEl, page)
    wrap.append(pageEl)

    const pager = node('div', 'deck-pager')
    pager.dataset.page = String(index)
    pager.textContent = `${index + 1} / ${total}`
    pager.title = t('deck.page', { n: index + 1, total })
    fragment.append(wrap, pager)

    slots.push({ wrap, page: pageEl, index, source: page.source, rendered: null, pending: false })
  })

  shell.stage.replaceChildren(fragment)
  shell.slots = slots
  shell.pagers = Array.from(shell.stage.querySelectorAll<HTMLElement>('.deck-pager'))

  shell.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const index = Number((entry.target as HTMLElement).dataset.page ?? -1)
        const slot = shell.slots[index]
        if (slot) void ensureRendered(shell, slot)
      }
    },
    { root: shell.viewport, rootMargin: '200px 0px' },
  )
  slots.forEach((slot) => shell.observer?.observe(slot.wrap))
}

/** 页数与画布都没变时的增量更新：只重画源码变了的页 */
function patchSlots(shell: Shell, doc: DeckDoc): void {
  doc.pages.forEach((page, index) => {
    const slot = shell.slots[index]
    if (!slot) return
    applyPageStyle(slot.page, page)
    if (slot.source === page.source) return
    slot.source = page.source
    slot.rendered = null
    slot.page.replaceChildren()
  })
}

function applyPageStyle(pageEl: HTMLElement, page: DeckPage): void {
  const { classes, background } = page.props
  // 默认就是居中，只有 `class: left` / `class: top` 需要写进 data 属性来关掉它
  pageEl.dataset.align = classes.includes('left') ? 'left' : 'center'
  pageEl.dataset.valign = classes.includes('top') ? 'top' : 'middle'
  pageEl.style.backgroundColor = background.color ?? ''
  pageEl.style.backgroundImage = background.image ? `url("${background.image}")` : ''
  pageEl.style.backgroundSize = background.size ?? ''
  pageEl.style.backgroundPosition = background.position ?? ''
}

async function ensureRendered(shell: Shell, slot: Slot): Promise<void> {
  if (slot.pending || slot.rendered === slot.source) return
  const page = shell.pages[slot.index]
  if (!page) return

  slot.pending = true
  const generation = shell.generation
  const source = slot.source
  try {
    const html = await renderMarkdown(page.source)
    // 期间可能换了文件 / 改了页数：丢掉过期结果
    if (generation !== shell.generation || slot.rendered === source) return
    // 借用 `markdown-body` 的内容样式（标题/表格/代码高亮/公式），
    // 只用 `.deck-page-inner` 覆盖容器属性与字号基准
    const inner = node('div', 'deck-page-inner markdown-body')
    inner.innerHTML = html
    scopeIds(inner, slot.index)
    slot.page.replaceChildren(inner)
    slot.rendered = source
    // 先按纯文本量一次（图表还没 hydrate），hydrate 完高度会变，再量一次
    fitPageContent(inner)
    const hydrated = shell.options.onPageRendered?.(slot.page, page)
    if (hydrated) {
      void Promise.resolve(hydrated).then(() => {
        if (generation === shell.generation) fitPageContent(inner)
      })
    }
  } finally {
    slot.pending = false
  }
}

/**
 * 每页是一个独立渲染的文档，`rehype-slug` 给的标题 id 会跨页重名。
 * 加页前缀，顺带修页内锚点链接（`[跳到第二节](#sec)`）。
 */
function scopeIds(root: HTMLElement, index: number): void {
  const prefix = `p${index + 1}-`
  root.querySelectorAll<HTMLElement>('[id]').forEach((el) => {
    el.id = prefix + el.id
  })
  root.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    const href = a.getAttribute('href') ?? ''
    if (href.length > 1) a.setAttribute('href', `#${prefix}${href.slice(1)}`)
  })
}

function syncEmpty(shell: Shell, doc: DeckDoc): void {
  // 没有「不是演示文稿」这一态了：面板打开就分页，只有「没内容」和「解析失败」需要说明
  const message =
    doc.reason === 'empty' ? t('deck.empty') : doc.reason === 'broken' ? t('deck.broken') : ''

  shell.empty.replaceChildren()
  if (message !== '') {
    const text = node('p', 'deck-empty-text')
    text.textContent = message
    shell.empty.append(text)
  }

  shell.empty.hidden = message === ''
  shell.viewport.hidden = message !== ''
  shell.tools.hidden = message !== ''
}

/* ------------------------------------------------------------------ 工具 */

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  return el
}

function toolButton(className: string, title: string, path: string): HTMLButtonElement {
  const button = node('button', `deck-tool ${className}`) as HTMLButtonElement
  button.type = 'button'
  button.title = title
  button.setAttribute('aria-label', title)
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`
  return button
}
