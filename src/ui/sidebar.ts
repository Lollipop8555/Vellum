import { getLang, t } from '../i18n'
import { formatBytes } from '../shell/largefile'
import type { FileNode, SnapshotRecord } from '../types'

const DAY = 86_400_000

function groupOf(ts: number): string {
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= startToday) return t('list.today')
  if (ts >= startToday - DAY) return t('list.yesterday')
  return t('list.earlier')
}

function timeOf(ts: number): string {
  return new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(new Date(ts))
}

function iconBtn(label: string, cls = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = `mini-btn ${cls}`.trim()
  b.textContent = label
  return b
}

export interface FileListHandlers {
  open(id: string): void
  /** 以这个文件为基准，与当前文件对比 */
  compare(id: string): void
  remove(id: string): void
}

/** 一行列表所需的全部信息：元信息 + 只对当前文件有意义的会话态 */
export interface FileListItem {
  node: FileNode
  dirty: boolean
  readOnly: boolean
}

export function renderFileList(
  host: HTMLElement,
  items: FileListItem[],
  currentId: string | null,
  filter: string,
  handlers: FileListHandlers,
) {
  host.innerHTML = ''
  const shown = filter
    ? items.filter((it) => it.node.name.toLowerCase().includes(filter.toLowerCase()))
    : items

  if (shown.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'list-empty'
    empty.textContent = filter ? t('drawer.search') : t('list.empty')
    host.appendChild(empty)
    return
  }

  let lastGroup = ''
  for (const it of shown) {
    const file = it.node
    const group = groupOf(file.updatedAt)
    if (group !== lastGroup) {
      const g = document.createElement('div')
      g.className = 'list-group'
      g.textContent = group
      host.appendChild(g)
      lastGroup = group
    }

    const item = document.createElement('div')
    item.className = `list-item${file.id === currentId ? ' is-active' : ''}`
    item.tabIndex = 0

    const main = document.createElement('div')
    main.className = 'list-main'

    const title = document.createElement('div')
    title.className = 'list-title'
    const name = document.createElement('span')
    name.textContent = file.name
    name.style.overflow = 'hidden'
    name.style.textOverflow = 'ellipsis'
    title.appendChild(name)
    if (it.dirty) {
      const dot = document.createElement('span')
      dot.className = 'item-dot'
      title.appendChild(dot)
    }

    const sub = document.createElement('div')
    sub.className = 'list-sub'
    sub.textContent = `${formatBytes(file.size)} · ${timeOf(file.updatedAt)}${it.readOnly ? ' · RO' : ''}`

    main.append(title, sub)

    const actions = document.createElement('div')
    actions.className = 'item-actions'
    // 当前文件自己不用比；有别的文件时才给一个「以它为基准对比」的入口
    if (currentId && file.id !== currentId) {
      const diff = iconBtn('≠')
      diff.title = t('action.compare')
      diff.onclick = (e) => {
        e.stopPropagation()
        handlers.compare(file.id)
      }
      actions.appendChild(diff)
    }
    const del = iconBtn('×', 'danger')
    del.title = t('action.delete')
    del.onclick = (e) => {
      e.stopPropagation()
      handlers.remove(file.id)
    }
    actions.appendChild(del)

    item.append(main, actions)
    item.onclick = () => handlers.open(file.id)
    item.onkeydown = (e) => {
      if (e.key === 'Enter') handlers.open(file.id)
    }
    host.appendChild(item)
  }
}

export interface SnapshotHandlers {
  restore(id: string): void
  compare(id: string): void
  remove(id: string): void
}

/* ---------------------------------------------------------------- 搜索 */

export interface SearchContentHit {
  /** 1 起算的行号 */
  line: number
  text: string
}

/**
 * 一条结果就是一个文件。文件名命中、内容命中都归到同一条：
 * 名字上高亮，内容片段挂在下面，不再出现「同一个文件占两条」。
 */
export interface SearchEntry {
  id: string
  name: string
  /** 所在文件夹路径，根目录为空串 */
  path: string
  isFolder: boolean
  /** 文件名本身命中 */
  nameHit: boolean
  hits: SearchContentHit[]
  /** 这个文件里还有多少处没列出来 */
  more: number
}

export interface SearchView {
  query: string
  /** 勾了内容搜索才会去扫正文 */
  deep: boolean
  /** 词或开关改过但还没手动跑：只提示，别把上一轮的结果当成这一轮的 */
  stale: boolean
  scanning: boolean
  /** 已扫描 / 待扫描的内容条数，只用于进度文案 */
  scanned: number
  total: number
  /** 结果被条数/体积预算截断过 */
  truncated: boolean
  /** 因为体积过大跳过的文件数 */
  skipped: number
  entries: SearchEntry[]
}

export interface SearchHandlers {
  open(id: string, line?: number): void
  /** 命中的是文件夹：切回文件页并定位到它 */
  reveal(id: string): void
}

/** 命中词上色：全程 textContent 拼接，不碰 innerHTML */
function highlight(text: string, query: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let at = 0
  while (q) {
    const hit = lower.indexOf(q, at)
    if (hit < 0) break
    if (hit > at) frag.append(text.slice(at, hit))
    const mark = document.createElement('mark')
    mark.textContent = text.slice(hit, hit + q.length)
    frag.append(mark)
    at = hit + q.length
  }
  frag.append(text.slice(at))
  return frag
}

/** 长行只留命中附近的一段：整行塞进 264px 的抽屉里只会被裁成省略号 */
function snippet(line: string, query: string): string {
  const max = 120
  if (line.length <= max) return line
  const at = line.toLowerCase().indexOf(query.toLowerCase())
  const start = at < 0 ? 0 : Math.max(0, at - 24)
  const cut = line.slice(start, start + max)
  return `${start > 0 ? '…' : ''}${cut}`
}

function sumLine(text: string): HTMLElement {
  const node = document.createElement('div')
  node.className = 'sr-sum'
  node.textContent = text
  return node
}

/** 扫描中的转圈：大库要几秒，只给一行静态文字会让人以为卡住了 */
function scanningRow(text: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'sr-scan'
  const spin = document.createElement('span')
  spin.className = 'spinner'
  const label = document.createElement('span')
  label.textContent = text
  row.append(spin, label)
  return row
}

function infoLine(text: string, cls = ''): HTMLElement {
  const node = document.createElement('div')
  node.className = `list-empty ${cls}`.trim()
  node.textContent = text
  return node
}

/** 一个文件一条：标题行 + 挂在下方的命中片段 */
function entryNode(entry: SearchEntry, query: string, handlers: SearchHandlers): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'sr-entry'

  const head = document.createElement('div')
  head.className = 'list-item'
  const main = document.createElement('div')
  main.className = 'list-main'

  const title = document.createElement('div')
  title.className = 'list-title'
  // 只有名字真的命中才标黄：内容命中却把文件名染上颜色会误导
  if (entry.nameHit) title.append(highlight(entry.name, query))
  else title.textContent = entry.name
  if (entry.isFolder) {
    const tag = document.createElement('span')
    tag.className = 'sr-tag'
    tag.textContent = t('search.folder')
    title.appendChild(tag)
  }

  const sub = document.createElement('div')
  sub.className = 'list-sub'
  const bits: string[] = []
  if (entry.path) bits.push(entry.path)
  if (entry.hits.length || entry.more) bits.push(t('search.hitCount', { n: entry.hits.length + entry.more }))
  sub.textContent = bits.join(' · ') || t('search.root')

  main.append(title, sub)
  head.appendChild(main)
  head.onclick = () => {
    if (entry.isFolder) {
      handlers.reveal(entry.id)
      return
    }
    // 文件名命中的从头打开；只有内容命中的直接落到第一处
    handlers.open(entry.id, entry.nameHit ? undefined : entry.hits[0]?.line)
  }
  wrap.appendChild(head)

  for (const hit of entry.hits) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'sr-hit'
    const no = document.createElement('span')
    no.className = 'sr-hit-line'
    no.textContent = String(hit.line)
    const code = document.createElement('span')
    code.className = 'sr-hit-text'
    code.append(highlight(snippet(hit.text, query), query))
    btn.append(no, code)
    btn.onclick = () => handlers.open(entry.id, hit.line)
    wrap.appendChild(btn)
  }
  if (entry.more > 0) wrap.appendChild(infoLine(t('search.more', { n: entry.more }), 'sr-note'))

  return wrap
}

export function renderSearchResults(host: HTMLElement, view: SearchView, handlers: SearchHandlers) {
  host.replaceChildren()
  const query = view.query

  if (!query) {
    host.appendChild(infoLine(t('search.hint')))
    return
  }

  // 手动模式下词改了还没跑：旧结果留着只会误导，直接让用户按按钮
  if (view.stale) {
    host.appendChild(infoLine(t('search.pending')))
    return
  }

  if (view.scanning) {
    host.appendChild(
      scanningRow(
        view.total > 0
          ? t('search.progress', { done: view.scanned, total: view.total })
          : t('search.scanning'),
      ),
    )
  } else if (view.entries.length) {
    host.appendChild(sumLine(t('search.count', { n: view.entries.length })))
  }

  for (const entry of view.entries) host.appendChild(entryNode(entry, query, handlers))

  if (view.skipped > 0) host.appendChild(infoLine(t('search.skipped', { n: view.skipped }), 'sr-note'))
  if (view.truncated) host.appendChild(infoLine(t('search.truncated'), 'sr-note'))
  if (!view.entries.length && !view.scanning) host.appendChild(infoLine(t('search.empty')))
}

export function renderSnapshotList(
  host: HTMLElement,
  snaps: SnapshotRecord[],
  handlers: SnapshotHandlers,
) {
  host.innerHTML = ''
  if (snaps.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'list-empty'
    empty.textContent = t('list.snapshotsEmpty')
    host.appendChild(empty)
    return
  }

  for (const snap of snaps) {
    const item = document.createElement('div')
    item.className = 'list-item'

    const main = document.createElement('div')
    main.className = 'list-main'
    const title = document.createElement('div')
    title.className = 'list-title'
    title.textContent = timeOf(snap.createdAt)
    const sub = document.createElement('div')
    sub.className = 'list-sub'
    sub.textContent = `${formatBytes(snap.blob.size)}${snap.note ? ` · ${snap.note}` : ''}`
    main.append(title, sub)

    const actions = document.createElement('div')
    actions.className = 'item-actions'
    const restore = iconBtn('↺')
    restore.title = t('action.restore')
    restore.onclick = (e) => {
      e.stopPropagation()
      handlers.restore(snap.id)
    }
    const diff = iconBtn('≠')
    diff.title = t('action.compare')
    diff.onclick = (e) => {
      e.stopPropagation()
      handlers.compare(snap.id)
    }
    const del = iconBtn('×', 'danger')
    del.title = t('action.delete')
    del.onclick = (e) => {
      e.stopPropagation()
      handlers.remove(snap.id)
    }
    actions.append(restore, diff, del)

    item.append(main, actions)
    host.appendChild(item)
  }
}
