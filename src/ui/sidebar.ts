import { getLang, t } from '../i18n'
import { formatBytes } from '../shell/largefile'
import type { FileRecord, SnapshotRecord } from '../types'

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
  remove(id: string): void
}

export function renderFileList(
  host: HTMLElement,
  files: FileRecord[],
  currentId: string | null,
  filter: string,
  handlers: FileListHandlers,
) {
  host.innerHTML = ''
  const shown = filter
    ? files.filter((f) => f.name.toLowerCase().includes(filter.toLowerCase()))
    : files

  if (shown.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'list-empty'
    empty.textContent = filter ? t('drawer.search') : t('list.empty')
    host.appendChild(empty)
    return
  }

  let lastGroup = ''
  for (const file of shown) {
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
    if (file.dirty) {
      const dot = document.createElement('span')
      dot.className = 'item-dot'
      title.appendChild(dot)
    }

    const sub = document.createElement('div')
    sub.className = 'list-sub'
    sub.textContent = `${formatBytes(file.size)} · ${timeOf(file.updatedAt)}${file.readOnly ? ' · RO' : ''}`

    main.append(title, sub)

    const actions = document.createElement('div')
    actions.className = 'item-actions'
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
