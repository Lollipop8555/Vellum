/**
 * 文件树渲染层。
 *
 * 只消费 NodeRecord + TreeIndex，不碰 IndexedDB、不碰内容（不变式 1）。
 * 重命名是受控的：是否处于编辑态由调用方的 renamingId 决定，
 * 这样全量重建也不会丢失交互状态。
 */
import { t } from '../i18n'
import { formatBytes } from '../shell/largefile'
import { canMoveInto, isFile, isFolder, nodePath, type TreeIndex } from '../shell/tree'
import type { NodeRecord } from '../types'

export interface TreeHandlers {
  open(id: string): void
  toggle(folderId: string): void
  requestRename(id: string): void
  /** 返回 true 表示成功，落库与刷新由调用方负责 */
  rename(id: string, name: string): Promise<boolean>
  /** Esc 放弃编辑：由调用方清掉 renamingId，否则输入框会留在原地 */
  cancelRename(id: string): void
  /** Cmd/Ctrl+Click 切换单项，Shift+Click 选连续区间 */
  select(id: string, mode: 'toggle' | 'range'): void
  move(id: string): void
  /** 拖拽落点（P4）：把 id 移到 parentId 下，null = 根目录 */
  drop(id: string, parentId: string | null): void
  trash(id: string): void
  compare(id: string): void
  /** 文件夹批量导出为 zip；文件走单文件导出即可 */
  exportNode(id: string): void
  /** 在这个文件夹里新建（文件夹菜单里的「新建文件 / 新建文件夹」） */
  create(parentId: string, kind: 'file' | 'folder'): void
}

export interface TreeOptions {
  index: TreeIndex
  currentId: string | null
  expanded: Set<string>
  filter: string
  renamingId: string | null
  /** 当前文件是否未保存；其它节点没有会话态 */
  dirtyId: string | null
  /** 多选（§13.2）；只影响显示，真正的状态在 AppState 里 */
  selection: Set<string>
  handlers: TreeHandlers
}

export function renderTree(host: HTMLElement, opts: TreeOptions): void {
  host.innerHTML = ''

  if (opts.filter.trim()) {
    renderSearchHits(host, opts)
    return
  }
  if (!opts.index.roots.length) {
    host.appendChild(emptyNote(t('list.empty')))
    return
  }
  walk(host, opts.index.roots, 0, opts)
}

function walk(host: HTMLElement, nodes: NodeRecord[], depth: number, opts: TreeOptions): void {
  for (const node of nodes) {
    host.appendChild(renderRow(node, depth, opts))
    if (node.kind === 'folder' && opts.expanded.has(node.id)) {
      walk(host, opts.index.children.get(node.id) ?? [], depth + 1, opts)
    }
  }
}

/** 搜索命中时平铺展示，副标题给出完整路径，方便区分同名文件 */
function renderSearchHits(host: HTMLElement, opts: TreeOptions): void {
  const q = opts.filter.trim().toLowerCase()
  const hits = [...opts.index.byId.values()]
    .filter((n) => n.deletedAt === null)
    .filter((n) => n.name.toLowerCase().includes(q) || nodePath(opts.index, n.id).toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  if (!hits.length) {
    host.appendChild(emptyNote(t('list.empty')))
    return
  }
  for (const n of hits) host.appendChild(renderRow(n, 0, opts, nodePath(opts.index, n.id)))
}

function renderRow(
  node: NodeRecord,
  depth: number,
  opts: TreeOptions,
  pathHint = '',
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'list-item tree-row'
  row.dataset.id = node.id
  row.dataset.kind = node.kind
  row.style.setProperty('--depth', String(depth))
  row.classList.toggle('is-current', node.id === opts.currentId)
  row.classList.toggle('is-selected', opts.selection.has(node.id))
  // 空文件淡化 + 空标记（§6），正在编辑的当前文件不算「空」，否则打字时会闪
  const empty = node.kind === 'file' && node.size === 0 && node.id !== opts.dirtyId
  row.classList.toggle('is-empty', empty)
  if (node.kind === 'folder') row.classList.toggle('is-open', opts.expanded.has(node.id))

  row.addEventListener('pointerdown', (e) => beginDrag(e, node, opts, row))

  // 层级引导线：每层一条竖线，靠占位块撑出缩进，比单纯 padding 更容易看清从属
  for (let i = 0; i < depth; i += 1) {
    const guide = document.createElement('span')
    guide.className = 'tree-guide'
    guide.setAttribute('aria-hidden', 'true')
    row.appendChild(guide)
  }

  // 折叠箭头；文件留同宽占位，避免名称左右跳动
  const open = node.kind === 'folder' && opts.expanded.has(node.id)
  const twisty = document.createElement('button')
  twisty.type = 'button'
  twisty.className = 'tree-twisty'
  if (node.kind === 'folder') {
    // 用 SVG 折角而不是 ▸/▾：9px 的字形在暗色背景上基本看不见
    twisty.classList.toggle('is-open', open)
    twisty.setAttribute('aria-expanded', String(open))
    twisty.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M6.1 3.6 10.6 8l-4.5 4.4" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>'
  }
  twisty.tabIndex = node.kind === 'folder' ? 0 : -1
  twisty.addEventListener('click', (e) => {
    e.stopPropagation()
    if (node.kind === 'folder') opts.handlers.toggle(node.id)
    else opts.handlers.open(node.id)
  })
  row.appendChild(twisty)

  const main = document.createElement('div')
  main.className = 'item-main'
  main.addEventListener('click', (e) => {
    if (opts.renamingId) return
    // 带修饰键就是选，不带才是打开/展开（§13.2）
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      opts.handlers.select(node.id, 'toggle')
      return
    }
    if (e.shiftKey) {
      e.preventDefault()
      opts.handlers.select(node.id, 'range')
      return
    }
    if (node.kind === 'folder') opts.handlers.toggle(node.id)
    else opts.handlers.open(node.id)
  })
  main.addEventListener('dblclick', () => {
    if (opts.renamingId !== node.id) opts.handlers.requestRename(node.id)
  })

  const title = document.createElement('div')
  title.className = 'item-title'

  const icon = document.createElement('span')
  icon.className = 'tree-icon'
  icon.textContent = node.kind === 'folder' ? (opts.expanded.has(node.id) ? '📂' : '📁') : '📄'
  title.appendChild(icon)

  if (opts.renamingId === node.id) {
    title.appendChild(buildRenameInput(node, opts))
  } else {
    const name = document.createElement('span')
    name.className = 'tree-name'
    fillHits(name, node.name, opts.filter)
    title.appendChild(name)
    if (node.id === opts.dirtyId) {
      const dot = document.createElement('span')
      dot.className = 'item-dot'
      title.appendChild(dot)
    }
    if (empty) {
      const mark = document.createElement('span')
      mark.className = 'item-empty'
      mark.textContent = t('list.emptyMark')
      title.appendChild(mark)
    }
  }
  main.appendChild(title)

  const sub = document.createElement('div')
  sub.className = 'list-sub'
  if (pathHint) fillHits(sub, pathHint, opts.filter)
  else sub.textContent = subtitleOf(node, opts)
  main.appendChild(sub)
  row.appendChild(main)

  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'tree-more icon-only'
  more.textContent = '⋯'
  more.title = t('action.more')
  more.addEventListener('click', (e) => {
    e.stopPropagation()
    showMenu(more, node, opts)
  })
  row.appendChild(more)

  return row
}

function subtitleOf(node: NodeRecord, opts: TreeOptions): string {
  if (isFile(node)) return `${formatBytes(node.size)} · ${formatTime(node.updatedAt)}`
  const kids = opts.index.children.get(node.id) ?? []
  return kids.length ? t('list.itemCount', { n: kids.length }) : t('list.folderEmpty')
}

function buildRenameInput(node: NodeRecord, opts: TreeOptions): HTMLInputElement {
  const input = document.createElement('input')
  input.className = 'tree-rename'
  input.value = node.name
  input.spellcheck = false
  input.title = t('rename.hint')

  // 全量重建后再拿焦点，否则会被 innerHTML='' 抹掉
  queueMicrotask(() => {
    input.focus()
    const dot = input.value.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
  })

  let settled = false
  const commit = () => {
    if (settled) return
    settled = true
    const next = input.value
    if (next !== node.name) void opts.handlers.rename(node.id, next)
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      settled = true
      input.value = node.name
      input.blur()
      opts.handlers.cancelRename(node.id)
    }
  })
  input.addEventListener('blur', commit)
  input.addEventListener('click', (e) => e.stopPropagation())
  input.addEventListener('dblclick', (e) => e.stopPropagation())
  return input
}

/* ---------------------------------------------------------------- 回收站 */

export interface TrashHandlers {
  restore(id: string): void
  purge(id: string): void
}

export interface TrashMeta {
  /** 该节点下还挂着多少子项：软删除只标记顶层，子项仍在它名下 */
  childCount(id: string): number
  /** 删除前的完整路径，用于悬停提示 */
  pathOf(id: string): string
}

export function renderTrashList(
  host: HTMLElement,
  nodes: NodeRecord[],
  handlers: TrashHandlers,
  meta?: TrashMeta,
): void {
  host.innerHTML = ''
  if (!nodes.length) {
    host.appendChild(emptyNote(t('list.trashEmpty')))
    return
  }

  // §9.4：回收站要有条数与 sum(size)，否则用户不知道清空会丢多少
  const total = nodes.reduce((sum, n) => sum + (n.kind === 'file' ? n.size : 0), 0)
  const summary = document.createElement('div')
  summary.className = 'trash-summary'
  summary.textContent = t('list.trashSummary', { n: nodes.length, size: formatBytes(total) })
  host.appendChild(summary)

  for (const node of nodes) {
    const row = document.createElement('div')
    row.className = 'list-item tree-row is-trash'
    row.dataset.id = node.id
    row.dataset.kind = node.kind
    if (meta) row.title = meta.pathOf(node.id)

    const main = document.createElement('div')
    main.className = 'item-main'

    const title = document.createElement('div')
    title.className = 'item-title'
    const icon = document.createElement('span')
    icon.className = 'tree-icon'
    icon.textContent = node.kind === 'folder' ? '📁' : '📄'
    title.appendChild(icon)

    const name = document.createElement('span')
    name.className = 'tree-name'
    name.textContent = node.name
    title.appendChild(name)
    main.appendChild(title)

    const sub = document.createElement('div')
    sub.className = 'list-sub'
    if (node.kind === 'file') {
      sub.textContent = `${formatBytes(node.size)} · ${formatTime(node.deletedAt ?? node.updatedAt)}`
    } else {
      const kids = meta ? meta.childCount(node.id) : 0
      sub.textContent = kids ? t('list.itemCount', { n: kids }) : t('list.folderEmpty')
    }
    main.appendChild(sub)
    row.appendChild(main)

    const actions = document.createElement('div')
    actions.className = 'tree-actions'
    const restore = document.createElement('button')
    restore.type = 'button'
    restore.className = 'btn btn-ghost'
    restore.textContent = t('action.restore')
    restore.addEventListener('click', (e) => {
      e.stopPropagation()
      handlers.restore(node.id)
    })
    const purge = document.createElement('button')
    purge.type = 'button'
    purge.className = 'btn btn-ghost is-danger'
    purge.textContent = t('action.deleteForever')
    purge.addEventListener('click', (e) => {
      e.stopPropagation()
      handlers.purge(node.id)
    })
    actions.append(restore, purge)
    row.appendChild(actions)

    host.appendChild(row)
  }
}

/* ------------------------------------------------------------------ 菜单 */

interface MenuItem {
  label: string
  danger?: boolean
  run(): void
}

let openMenu: HTMLElement | null = null

export function closeTreeMenu(): void {
  openMenu?.remove()
  openMenu = null
}

function showMenu(anchor: HTMLElement, node: NodeRecord, opts: TreeOptions): void {
  closeTreeMenu()

  const items: (MenuItem | { sep: true })[] = []
  // 文件夹菜单的第一组是「往里建」：对着文件夹点开菜单，多半就是想往这层塞东西
  if (isFolder(node)) {
    items.push(
      { label: t('action.newFile'), run: () => opts.handlers.create(node.id, 'file') },
      { label: t('action.newFolder'), run: () => opts.handlers.create(node.id, 'folder') },
      { sep: true },
    )
  }
  items.push(
    { label: t('action.rename'), run: () => opts.handlers.requestRename(node.id) },
    { label: t('action.move'), run: () => opts.handlers.move(node.id) },
  )
  if (isFile(node)) {
    items.push({ label: t('action.compare'), run: () => opts.handlers.compare(node.id) })
  } else {
    items.push({ label: t('action.exportFolder'), run: () => opts.handlers.exportNode(node.id) })
  }
  items.push({ label: t('action.trash'), danger: true, run: () => opts.handlers.trash(node.id) })

  const menu = document.createElement('div')
  menu.className = 'tree-menu'
  for (const it of items) {
    if ('sep' in it) {
      const line = document.createElement('div')
      line.className = 'tree-menu-sep'
      menu.appendChild(line)
      continue
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `tree-menu-item${it.danger ? ' is-danger' : ''}`
    b.textContent = it.label
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      closeTreeMenu()
      it.run()
    })
    menu.appendChild(b)
  }

  document.body.appendChild(menu)
  const r = anchor.getBoundingClientRect()
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`
  openMenu = menu

  const away = (e: PointerEvent) => {
    if (menu.contains(e.target as Node)) return
    closeTreeMenu()
  }
  setTimeout(() => document.addEventListener('pointerdown', away, { once: true }))
}

/* ---------------------------------------------------------------- 搜索高亮 */

/**
 * 把命中片段包进 <mark>（O24）。
 * 只做大小写不敏感的子串匹配，与搜索过滤口径一致；路径里的 `api/readme` 也能命中。
 */
function fillHits(host: HTMLElement, text: string, filter: string): void {
  const q = filter.trim().toLowerCase()
  host.textContent = ''
  if (!q) {
    host.textContent = text
    return
  }
  const lower = text.toLowerCase()
  let at = 0
  for (;;) {
    const hit = lower.indexOf(q, at)
    if (hit < 0) {
      if (at < text.length) host.append(text.slice(at))
      return
    }
    if (hit > at) host.append(text.slice(at, hit))
    const mark = document.createElement('mark')
    mark.textContent = text.slice(hit, hit + q.length)
    host.append(mark)
    at = hit + q.length
  }
}

/* ------------------------------------------------------------ 拖拽移动（P4） */

// 用 Pointer Events 自绘而不是 HTML5 DnD：需要插入位置指示线，
// 且 DnD 在触屏上完全没有统一行为。落点判定仍走 canMoveInto，非法目标不画指示线。

type DropMode = 'into' | 'before' | 'after' | 'root' | 'invalid'

interface DropPlan {
  mode: DropMode
  parentId: string | null
  row: HTMLElement | null
}

interface DragState {
  id: string
  opts: TreeOptions
  source: HTMLElement
  startX: number
  startY: number
  active: boolean
  ghost: HTMLElement | null
  plan: DropPlan | null
}

let drag: DragState | null = null

function beginDrag(e: PointerEvent, node: NodeRecord, opts: TreeOptions, row: HTMLElement): void {
  if (e.button !== 0 || opts.renamingId) return
  if ((e.target as HTMLElement).closest('button, input')) return
  drag = {
    id: node.id,
    opts,
    source: row,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
    ghost: null,
    plan: null,
  }
  document.addEventListener('pointermove', onDragMove)
  document.addEventListener('pointerup', onDragUp)
  document.addEventListener('pointercancel', onDragCancel)
}

function onDragMove(e: PointerEvent): void {
  const d = drag
  if (!d) return
  if (!d.active) {
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return
    d.active = true
    d.source.classList.add('is-dragging')
    document.body.classList.add('is-tree-dragging')
    d.ghost = buildGhost(d.source)
    document.body.appendChild(d.ghost)
  }
  if (d.ghost) d.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`
  paintDrop(d, e.clientX, e.clientY)
}

function onDragUp(): void {
  const d = drag
  cleanupDrag()
  if (!d || !d.active) return
  // 拖完松手会补一个 click，不能让它顺手把文件打开
  swallowNextClick()
  const plan = d.plan
  if (!plan || plan.mode === 'invalid') return
  const current = d.opts.index.byId.get(d.id)?.parentId ?? null
  if (current === plan.parentId) return
  d.opts.handlers.drop(d.id, plan.parentId)
}

function onDragCancel(): void {
  cleanupDrag()
}

function cleanupDrag(): void {
  document.removeEventListener('pointermove', onDragMove)
  document.removeEventListener('pointerup', onDragUp)
  document.removeEventListener('pointercancel', onDragCancel)
  if (!drag) return
  drag.source.classList.remove('is-dragging')
  drag.ghost?.remove()
  document.body.classList.remove('is-tree-dragging')
  drag.source.closest('.drawer-list')?.classList.remove('is-drop-root')
  clearDropMarks()
  drag = null
}

function clearDropMarks(): void {
  document
    .querySelectorAll<HTMLElement>('.tree-row.is-drop-into, .tree-row.is-drop-before, .tree-row.is-drop-after')
    .forEach((r) => r.classList.remove('is-drop-into', 'is-drop-before', 'is-drop-after'))
}

function buildGhost(source: HTMLElement): HTMLElement {
  const ghost = source.cloneNode(true) as HTMLElement
  ghost.classList.remove('is-current', 'is-selected', 'is-dragging')
  ghost.classList.add('tree-drag-ghost')
  ghost.style.width = `${source.getBoundingClientRect().width}px`
  // 用 transform 跟随指针，避免每帧改 left/top 触发重排
  ghost.style.left = '0'
  ghost.style.top = '0'
  return ghost
}

function paintDrop(d: DragState, x: number, y: number): void {
  clearDropMarks()
  const listEl = d.source.closest('.drawer-list')
  listEl?.classList.remove('is-drop-root')

  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const rowEl = el?.closest<HTMLElement>('.tree-row') ?? null
  const plan = resolveDrop(d, rowEl, Boolean(el?.closest('.drawer-list')), y)
  d.plan = plan

  if (plan.mode === 'root') listEl?.classList.add('is-drop-root')
  if (!plan.row) return
  if (plan.mode === 'into') plan.row.classList.add('is-drop-into')
  if (plan.mode === 'before') plan.row.classList.add('is-drop-before')
  if (plan.mode === 'after') plan.row.classList.add('is-drop-after')
}

function resolveDrop(d: DragState, rowEl: HTMLElement | null, inList: boolean, y: number): DropPlan {
  const index = d.opts.index
  const invalid: DropPlan = { mode: 'invalid', parentId: null, row: null }

  if (!rowEl) {
    if (!inList) return invalid
    return { mode: 'root', parentId: null, row: null }
  }
  const target = rowEl.dataset.id ? index.byId.get(rowEl.dataset.id) : undefined
  if (!target || target.id === d.id) return invalid

  // 文件夹：整行就是「移入这里」的靶点
  if (target.kind === 'folder') {
    if (!canMoveInto(index, d.id, target.id)) return invalid
    return { mode: 'into', parentId: target.id, row: rowEl }
  }

  // 文件：按行中线分「之前 / 之后」；排序仍按 name，落点只是同层归属
  const parentId = target.parentId
  if (!canMoveInto(index, d.id, parentId)) return invalid
  const rect = rowEl.getBoundingClientRect()
  const mode: DropMode = y < rect.top + rect.height / 2 ? 'before' : 'after'
  return { mode, parentId, row: rowEl }
}

/**
 * 只吞掉紧跟着松手的那一下 click。
 *
 * 早先是用 400ms 时间窗拦截 document 上的 click，结果拖完 0.4 秒内
 * 任何一次真实点击都被吞掉（点文件没反应），像是拖完就坏了。
 * 改成一次性标记：吞掉下一发 click 立刻复位，下一发一定来自新的按下。
 */
let swallowClick = false

document.addEventListener(
  'click',
  (e) => {
    if (!swallowClick) return
    swallowClick = false
    e.stopPropagation()
    e.preventDefault()
  },
  true,
)

// 新手势开始就一定不是那次拖拽的补发 click，立刻复位兜底
document.addEventListener('pointerdown', () => {
  swallowClick = false
}, true)

function swallowNextClick(): void {
  swallowClick = true
}

/* ------------------------------------------------------------------ 小工具 */

function emptyNote(text: string): HTMLElement {
  const p = document.createElement('div')
  p.className = 'list-empty'
  p.textContent = text
  return p
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
