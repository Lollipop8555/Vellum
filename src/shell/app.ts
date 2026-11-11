import { applyStaticText, getLang, initLang, onLangChange, setLang, t } from '../i18n'
import { CodeMirrorAdapter } from '../editors/codemirror'
import type { EditorAdapter } from '../editors/adapter'
import { LANG_LABELS, langFromName, type LangId } from '../editors/languages'
import * as store from './store'
import {
  ENCODING_LABELS,
  decodeAuto,
  decodeWith,
  detectEol,
  encodeUtf8,
  looksBinary,
  normalizeEol,
} from './codec'
import { LIMITS, formatBytes, modeFor } from './largefile'
import { pickFileWithHandle, saveAs } from './save'
import { getSettings, loadSettings, updateSettings } from './settings'
import { DEFAULT_FORMAT, canFormat, formatText } from './format'
import { transformText, type TransformId } from './transform'
import { FileLock } from './lock'
import { Drawer } from '../ui/layout'
import { applyTheme } from '../ui/theme'
import { toast } from '../ui/toast'
import { renderMarkdown } from '../ui/markdown'
import * as sb from '../ui/statusbar'
import { renderFileList, renderSnapshotList } from '../ui/sidebar'
import {
  confirmDialog,
  diffDialog,
  helpDialog,
  openDialog,
  toolsDialog,
  transformsDialog,
} from '../ui/dialogs'
import type { EngineId, FileMode, FileRecord, SnapshotRecord } from '../types'

export const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T

export interface AppState {
  files: FileRecord[]
  current: FileRecord | null
  editor: EditorAdapter | null
  engineId: EngineId
  mode: FileMode
  text: string
  dirty: boolean
  locked: boolean
  snapshots: SnapshotRecord[]
  drawerTab: 'files' | 'snapshots'
  search: string
  rawBytes: ArrayBuffer | null
  encodingConfirmed: boolean
  previewOpen: boolean
}

export const state: AppState = {
  files: [],
  current: null,
  editor: null,
  engineId: 'cm',
  mode: 'full',
  text: '',
  dirty: false,
  locked: false,
  snapshots: [],
  drawerTab: 'files',
  search: '',
  rawBytes: null,
  encodingConfirmed: false,
  previewOpen: false,
}

const lock = new FileLock()
let drawer: Drawer
let autosaveTimer = 0
let previewTimer = 0

/* ------------------------------------------------------------------ 启动 */

export async function startApp() {
  initLang()
  state.engineId = loadSettings().defaultEngine
  applyTheme()
  applyStaticText()
  updateLangButton()

  drawer = new Drawer(el('drawer'), el('editorIsland'), () => state.editor?.layout())

  wireTopbar()
  wireRails()
  wireEditorHead()
  wireStatusbar()
  wireDrawer()
  wireKeyboard()
  wireDropZone()

  updateEngineSeg()
  await refreshFiles()
  await refreshStorage()

  const lastId = await store.getMeta<string>('lastFileId')
  if (lastId) await openRecord(lastId)

  void store.requestPersistence()
  prefetchMonaco()

  onLangChange(() => {
    updateLangButton()
    renderDrawerList()
    refreshMeta()
    renderPreviewNow()
  })

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      e.preventDefault()
      e.returnValue = ''
    }
  })
}

/* ---------------------------------------------------------------- 顶栏 */

function updateLangButton() {
  el<HTMLButtonElement>('langBtn').textContent = getLang() === 'zh' ? 'EN' : '中'
}

function wireTopbar() {
  el('importBtn').addEventListener('click', () => void importFile())

  el('engineSeg').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-engine]')
    if (btn) void switchEngine(btn.dataset.engine as EngineId)
  })

  el('themeBtn').addEventListener('click', () => {
    const next = getSettings().theme === 'dark' ? 'light' : 'dark'
    updateSettings({ theme: next })
    applyTheme(next)
    state.editor?.setTheme(next)
  })

  el('langBtn').addEventListener('click', () => {
    setLang(getLang() === 'zh' ? 'en' : 'zh')
  })

  el('helpBtn').addEventListener('click', () => helpDialog())
}

function updateEngineSeg() {
  el('engineSeg')
    .querySelectorAll<HTMLElement>('[data-engine]')
    .forEach((b) => b.classList.toggle('is-active', b.dataset.engine === state.engineId))
  sb.setEngineLabel(state.engineId === 'monaco' ? 'Monaco' : 'CodeMirror')
}

/* ---------------------------------------------------------------- 竖条 */

function wireRails() {
  document.querySelectorAll<HTMLElement>('[data-drawer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.drawer as 'files' | 'snapshots'
      if (drawer.isOpen && state.drawerTab === tab) {
        void drawer.hide()
        syncDrawerTabs()
      } else {
        state.drawerTab = tab
        syncDrawerTabs()
        void drawer.show()
      }
    })
  })

  el('previewBtn').addEventListener('click', () => togglePreview())
  el('toolsBtn').addEventListener('click', () => toolsDialog())
  el('drawerClose').addEventListener('click', () => void drawer.hide())
  el('previewClose').addEventListener('click', () => togglePreview(false))
  el('previewPrint').addEventListener('click', () => {
    if (!state.previewOpen) togglePreview(true)
    setTimeout(() => window.print(), 150)
  })
}

function syncDrawerTabs() {
  el('drawerTabs')
    .querySelectorAll<HTMLElement>('[data-tab]')
    .forEach((b) => b.classList.toggle('is-active', b.dataset.tab === state.drawerTab))
  document
    .querySelectorAll<HTMLElement>('[data-drawer]')
    .forEach((b) =>
      b.classList.toggle('is-active', drawer.isOpen && b.dataset.drawer === state.drawerTab),
    )
  renderDrawerList()
}

function wireDrawer() {
  el('drawerTabs').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')
    if (!btn) return
    state.drawerTab = btn.dataset.tab as 'files' | 'snapshots'
    syncDrawerTabs()
    void refreshSnapshots()
  })

  el<HTMLInputElement>('drawerSearch').addEventListener('input', (e) => {
    state.search = (e.target as HTMLInputElement).value
    renderDrawerList()
  })
}

/* ------------------------------------------------------------ 编辑器头部 */

function wireEditorHead() {
  el('saveBtn').addEventListener('click', () => void saveFile())
  el('formatBtn').addEventListener('click', () => void doFormat())
  el('moreBtn').addEventListener('click', (e) => openMoreMenu(e.currentTarget as HTMLElement))
  el('emptyPickBtn').addEventListener('click', () => void importFile())
  el('emptyPasteBtn').addEventListener('click', () => void importPasted())
}

function openMoreMenu(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect()
  const menu = document.createElement('div')
  menu.className = 'dialog'
  menu.style.cssText =
    `position:fixed;right:${window.innerWidth - rect.right}px;top:${rect.bottom + 6}px;` +
    'width:224px;max-height:none;z-index:70;padding:4px'

  const item = (label: string, fn: () => void) => {
    const b = document.createElement('button')
    b.className = 'btn'
    b.style.cssText = 'width:100%;justify-content:flex-start'
    b.textContent = label
    b.disabled = !state.current
    b.onclick = () => {
      close()
      fn()
    }
    menu.appendChild(b)
  }

  const close = () => {
    menu.remove()
    document.removeEventListener('click', outside, true)
  }
  const outside = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) close()
  }

  item(t('menu.newSnapshot'), () => void createSnapshot())
  item(t('menu.diff'), () => void diffWithLatest())
  item(t('menu.transforms'), () => transformsDialog((id) => applyTransform(id)))
  item(t('menu.wrap'), () => toggleWrap())
  item(t('menu.readonly'), () => toggleReadonly())
  item(t('menu.reencode'), () => pickEncoding())
  item(t('menu.stats'), () => showStats())

  document.body.appendChild(menu)
  setTimeout(() => document.addEventListener('click', outside, true), 0)
}

/* ------------------------------------------------------------ 状态栏 */

function wireStatusbar() {
  el('stEncoding').addEventListener('click', () => pickEncoding())
  el('stEol').addEventListener('click', () => void toggleEol())
}

async function refreshStorage() {
  const info = await store.storageInfo()
  sb.setCache(info.usage, info.quota)
  el('drawerFoot').textContent = t('drawer.foot', {
    used: formatBytes(info.usage),
    quota: info.quota ? formatBytes(info.quota) : '—',
  })
}

/* ---------------------------------------------------------------- 导入 */

async function importFile() {
  if (window.showOpenFilePicker) {
    try {
      const picked = await pickFileWithHandle()
      if (picked) await ingestFile(picked.file, picked.handle)
    } catch (err) {
      toast(t('toast.readFailed', { msg: (err as Error).message }), 'error')
    }
    return
  }
  el<HTMLInputElement>('filePicker').click()
}

async function ingestFile(file: File, handle?: FileSystemFileHandle) {
  if (file.size > LIMITS.reject) {
    toast(
      t('toast.tooLarge', { size: formatBytes(file.size), limit: formatBytes(LIMITS.reject) }),
      'error',
    )
    return
  }

  const buf = await file.arrayBuffer()
  if (looksBinary(buf)) {
    toast(t('toast.binary'), 'error')
    return
  }

  const { text, encoding } = decodeAuto(buf)
  const now = Date.now()

  const rec: FileRecord = {
    id: crypto.randomUUID(),
    name: file.name || t('misc.untitled'),
    size: file.size,
    blob: new Blob([text], { type: 'text/plain' }),
    lang: langFromName(file.name),
    encoding,
    eol: detectEol(text),
    engine: state.engineId,
    readOnly: modeFor(file.size) === 'readonly',
    dirty: false,
    handle,
    // 5MB 以内保留原始字节，供“以其他编码重新解码”；大文件不额外占一份配额
    originalBytes: file.size > 5 * 1024 * 1024 ? undefined : new Blob([buf]),
    createdAt: now,
    updatedAt: now,
  }

  await store.putFile(rec)
  await refreshFiles()
  await openRecord(rec.id)
  toast(t('toast.imported', { name: rec.name }))
  if (encoding !== 'utf-8') toast(t('toast.encodingNote'))
}

async function importPasted() {
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    /* 权限被拒时按空处理 */
  }
  if (!text) {
    toast(t('toast.noText'), 'error')
    return
  }
  const now = Date.now()
  const rec: FileRecord = {
    id: crypto.randomUUID(),
    name: t('misc.untitled'),
    size: encodeUtf8(text).byteLength,
    blob: new Blob([text], { type: 'text/plain' }),
    lang: 'text',
    encoding: 'utf-8',
    eol: detectEol(text),
    engine: state.engineId,
    readOnly: false,
    dirty: true,
    createdAt: now,
    updatedAt: now,
  }
  await store.putFile(rec)
  await refreshFiles()
  await openRecord(rec.id)
}

/* ------------------------------------------------------------ 打开文件 */

async function openRecord(id: string) {
  const rec = await store.getFile(id)
  if (!rec) return

  const free = await lock.claim(id)
  state.current = rec
  state.locked = !free
  if (!free) toast(t('toast.locked'), 'error')

  state.mode = modeFor(rec.size)
  // 引擎偏好按文件记忆，其次回落到全局设置
  state.engineId = rec.engine ?? state.engineId
  state.encodingConfirmed = false
  state.rawBytes = rec.originalBytes ? await rec.originalBytes.arrayBuffer() : null

  const text = await rec.blob.text()
  await mountEditor(text)

  await store.setMeta('lastFileId', id)
  el('emptyState').hidden = true
  await refreshSnapshots()
  await refreshFiles()
  refreshMeta()
  updateFormatButton()
  renderPreviewNow()
  renderDrawerList()
}

async function mountEditor(text: string, offset = 0) {
  const rec = state.current
  if (!rec) return

  const host = el('editorHost')
  state.editor?.destroy()
  state.editor = null
  host.innerHTML = ''

  const Adapter =
    state.engineId === 'monaco'
      ? (await import('../editors/monaco')).MonacoAdapter
      : CodeMirrorAdapter

  const settings = getSettings()
  const full = state.mode === 'full'
  const lang: LangId = full ? langFromName(rec.name) : 'text'

  const adapter = new Adapter()
  await adapter.mount(host, {
    value: text,
    language: lang,
    readOnly: rec.readOnly || state.locked,
    wordWrap: full ? settings.wordWrap : false,
    theme: settings.theme,
    fontSize: settings.fontSize,
    onChange: (v) => {
      state.text = v
      state.dirty = true
      updateDirtyDot()
      sb.setCount(v)
      schedulePreview()
      scheduleAutosave()
      updateFormatButton()
    },
    onCursor: (line, col) => sb.setCursor(line, col),
  })

  state.editor = adapter
  state.text = text
  state.dirty = rec.dirty
  if (offset) adapter.setOffset(offset)

  sb.setCount(text)
  sb.setEncoding(ENCODING_LABELS[rec.encoding])
  sb.setEol(rec.eol)
  sb.setReadonly(rec.readOnly || state.locked)
  sb.setCursor(1, 1)
  updateDirtyDot()
  updateEngineSeg()
}

function refreshMeta() {
  const rec = state.current
  if (!rec) {
    el('fileName').textContent = t('editor.noFile')
    el('fileMeta').textContent = ''
    return
  }
  el('fileName').textContent = rec.name
  const parts = [formatBytes(rec.size)]
  if (state.mode === 'light') parts.push(t('meta.plain'))
  if (state.mode === 'readonly') parts.push(t('meta.readonly'))
  parts.push(LANG_LABELS[langFromName(rec.name)])
  el('fileMeta').textContent = parts.join(' · ')
}

function updateDirtyDot() {
  el('dirtyDot').hidden = !state.dirty
}

function updateFormatButton() {
  const rec = state.current
  const lang = rec ? langFromName(rec.name) : 'text'
  const long = (state.editor?.getValue().length ?? 0) > LIMITS.format
  el<HTMLButtonElement>('formatBtn').disabled =
    !rec || state.mode !== 'full' || long || !canFormat(lang)
  el<HTMLButtonElement>('saveBtn').disabled = !rec
}

/* ------------------------------------------------------------ 自动草稿 */

function scheduleAutosave() {
  const rec = state.current
  if (!rec) return
  window.clearTimeout(autosaveTimer)
  if (rec.size > LIMITS.autosave) return
  autosaveTimer = window.setTimeout(() => void persistDraft(), 2000)
}

async function persistDraft() {
  const rec = state.current
  if (!rec || !state.dirty) return
  rec.blob = new Blob([state.text], { type: 'text/plain' })
  rec.size = encodeUtf8(state.text).byteLength
  rec.dirty = true
  rec.updatedAt = Date.now()
  await store.putFile(rec)
  await refreshFiles()
}

/* ------------------------------------------------------------ 保存 */

async function saveFile() {
  const rec = state.current
  if (!rec) return

  if (rec.encoding !== 'utf-8' && !state.encodingConfirmed) {
    const res = await confirmDialog(
      t('confirm.encodingTitle'),
      t('confirm.encodingBody', { enc: ENCODING_LABELS[rec.encoding] }),
    )
    if (!res.ok) return
    state.encodingConfirmed = true
  }

  const text = state.editor?.getValue() ?? state.text
  const bytes = encodeUtf8(normalizeEol(text, rec.eol))

  try {
    const res = await saveAs(rec.name, bytes, rec.handle)
    if (res.how === 'picker' && !res.handle) return
    if (res.handle) rec.handle = res.handle

    rec.blob = new Blob([text], { type: 'text/plain' })
    rec.size = bytes.byteLength
    rec.dirty = false
    rec.updatedAt = Date.now()
    await store.putFile(rec)
    await store.addSnapshot(rec.id, rec.blob, 'save')

    state.dirty = false
    updateDirtyDot()
    refreshMeta()
    await refreshFiles()
    await refreshSnapshots()
    await refreshStorage()

    toast(
      res.how === 'download'
        ? t('toast.downloaded', { name: rec.name })
        : t('toast.saved', { name: rec.name }),
    )
  } catch (err) {
    toast(t('toast.saveFailed', { msg: (err as Error).message }), 'error')
  }
}

/* ------------------------------------------------------------ 引擎切换 */

async function switchEngine(id: EngineId) {
  if (id === state.engineId) return
  if (state.current && state.mode !== 'full') {
    const res = await confirmDialog(
      `${id === 'monaco' ? 'Monaco' : 'CodeMirror'} · ${formatBytes(state.current.size)}`,
      t('confirm.bigEngine'),
    )
    if (!res.ok) return
  }

  const value = state.editor?.getValue() ?? state.text
  const offset = state.editor?.getOffset() ?? 0

  state.engineId = id
  updateSettings({ defaultEngine: id })
  if (state.current) {
    state.current.engine = id
    await store.putFile(state.current)
  }

  const host = el('editorHost')
  host.style.opacity = '0.35'
  await mountEditor(value, offset)
  host.style.opacity = '1'
  if (state.current) refreshMeta()
}

function prefetchMonaco() {
  const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 1500))
  idle(() => {
    void import('../editors/monaco').then(() => undefined)
  })
}

/* ------------------------------------------------------------ 其它开关 */

function toggleWrap() {
  const next = !getSettings().wordWrap
  updateSettings({ wordWrap: next })
  state.editor?.setWordWrap(next)
}

function toggleReadonly() {
  const rec = state.current
  if (!rec) return
  rec.readOnly = !rec.readOnly
  state.editor?.setReadOnly(rec.readOnly)
  sb.setReadonly(rec.readOnly || state.locked)
  void store.putFile(rec)
}

/* ------------------------------------------------------------ 编码 / 换行 */

function pickEncoding() {
  const rec = state.current
  if (!rec) return

  const wrap = document.createElement('div')
  wrap.className = 'toolbar-row'
  ;(Object.keys(ENCODING_LABELS) as (keyof typeof ENCODING_LABELS)[]).forEach((enc) => {
    const b = document.createElement('button')
    b.className = `btn${enc === rec.encoding ? ' btn-primary' : ''}`
    b.textContent = ENCODING_LABELS[enc]
    b.onclick = () => {
      dlg.close()
      void reDecode(enc)
    }
    wrap.appendChild(b)
  })

  const dlg = openDialog({ title: t('dialog.encoding'), body: wrap, narrow: true })
}

async function reDecode(enc: keyof typeof ENCODING_LABELS) {
  const rec = state.current
  if (!rec || !state.editor) return
  if (enc === rec.encoding) return

  const bytes = state.rawBytes ?? (rec.originalBytes ? await rec.originalBytes.arrayBuffer() : null)
  if (!bytes) {
    toast(t('toast.noRawBytes'), 'error')
    return
  }

  const text = decodeWith(bytes, enc)
  rec.encoding = enc
  rec.eol = detectEol(text)
  await store.putFile(rec)

  state.editor.setValue(text)
  state.text = text
  state.dirty = true
  updateDirtyDot()
  sb.setEncoding(ENCODING_LABELS[enc])
  sb.setEol(rec.eol)
  sb.setCount(text)
  schedulePreview()
  if (enc !== 'utf-8') toast(t('toast.encodingNote'))
}

async function toggleEol() {
  const rec = state.current
  if (!rec) return
  rec.eol = rec.eol === 'lf' ? 'crlf' : 'lf'
  const text = normalizeEol(state.text, rec.eol)
  state.editor?.setValue(text)
  state.text = text
  state.dirty = true
  updateDirtyDot()
  sb.setEol(rec.eol)
  await store.putFile(rec)
}

/* ------------------------------------------------------------ 格式化 / 加工 */

async function doFormat() {
  const rec = state.current
  if (!rec || !state.editor) return
  const lang = langFromName(rec.name)
  const btn = el<HTMLButtonElement>('formatBtn')
  btn.disabled = true
  try {
    const formatted = await formatText(state.text, lang, DEFAULT_FORMAT)
    if (formatted === state.text) {
      toast(t('toast.noChange'))
      return
    }
    state.editor.setValue(formatted)
    state.text = formatted
    state.dirty = true
    updateDirtyDot()
    sb.setCount(formatted)
    schedulePreview()
    toast(t('toast.formatDone'))
  } catch (err) {
    toast(t('toast.formatFailed', { msg: (err as Error).message }), 'error')
  } finally {
    updateFormatButton()
  }
}

function applyTransform(id: TransformId) {
  if (!state.editor) return
  const next = transformText(state.text, id)
  if (next === state.text) {
    toast(t('toast.noChange'))
    return
  }
  state.editor.setValue(next)
  state.text = next
  state.dirty = true
  updateDirtyDot()
  sb.setCount(next)
  schedulePreview()
}

/* ------------------------------------------------------------ 快照 */

async function createSnapshot() {
  const rec = state.current
  if (!rec) return
  await store.addSnapshot(rec.id, new Blob([state.text], { type: 'text/plain' }), 'manual')
  await refreshSnapshots()
  await refreshStorage()
  toast(t('toast.snapshotCreated'))
}

async function restoreSnapshot(id: string) {
  const rec = state.current
  const snap = state.snapshots.find((s) => s.id === id)
  if (!rec || !snap) return
  await store.addSnapshot(rec.id, new Blob([state.text], { type: 'text/plain' }), 'before-restore')
  const text = await snap.blob.text()
  state.editor?.setValue(text)
  state.text = text
  state.dirty = true
  updateDirtyDot()
  sb.setCount(text)
  schedulePreview()
  await refreshSnapshots()
  toast(t('toast.restored'))
}

async function diffWithLatest() {
  const snap = state.snapshots[0]
  if (!snap) {
    toast(t('list.snapshotsEmpty'))
    return
  }
  diffDialog(new Date(snap.createdAt).toLocaleString(), await snap.blob.text(), state.text)
}

async function compareSnapshot(id: string) {
  const snap = state.snapshots.find((s) => s.id === id)
  if (!snap) return
  diffDialog(new Date(snap.createdAt).toLocaleString(), await snap.blob.text(), state.text)
}

async function refreshSnapshots() {
  state.snapshots = state.current ? await store.listSnapshots(state.current.id) : []
  if (state.drawerTab === 'snapshots') renderDrawerList()
}

/* ------------------------------------------------------------ 历史列表 */

async function refreshFiles() {
  state.files = await store.listFiles()
  if (state.drawerTab === 'files') renderDrawerList()
}

function renderDrawerList() {
  const host = el('drawerList')
  if (state.drawerTab === 'files') {
    renderFileList(host, state.files, state.current?.id ?? null, state.search, {
      open: (id) => void openRecord(id),
      remove: (id) => void removeFile(id),
    })
  } else {
    renderSnapshotList(host, state.snapshots, {
      restore: (id) => void restoreSnapshot(id),
      compare: (id) => void compareSnapshot(id),
      remove: (id) => void removeSnapshot(id),
    })
  }
}

async function removeFile(id: string) {
  const rec = state.files.find((f) => f.id === id)
  if (!rec) return
  const res = await confirmDialog(
    t('confirm.deleteTitle'),
    `${t('confirm.deleteBody', { name: rec.name })} ${t('confirm.deleteCache')}`,
  )
  if (!res.ok) return

  await store.deleteFileCascade(id)

  if (state.current?.id === id) {
    state.editor?.destroy()
    state.editor = null
    state.current = null
    state.text = ''
    state.dirty = false
    lock.release()
    el('editorHost').innerHTML = ''
    el('emptyState').hidden = false
    el('rightPanel').classList.remove('is-open')
    state.previewOpen = false
    refreshMeta()
    updateDirtyDot()
    updateFormatButton()
    await store.setMeta('lastFileId', null)
  }

  await refreshFiles()
  await refreshSnapshots()
  await refreshStorage()
  toast(t('toast.deleted', { name: rec.name }))
}

async function removeSnapshot(id: string) {
  await store.deleteSnapshot(id)
  await refreshSnapshots()
  await refreshStorage()
}

/* ------------------------------------------------------------ 文档信息 */

function showStats() {
  const rec = state.current
  if (!rec) return
  const text = state.text
  const rows: [string, string][] = [
    [t('editor.noFile'), rec.name],
    ['', formatBytes(rec.size)],
    ['', `${text.split('\n').length} lines · ${text.length} chars`],
    ['', ENCODING_LABELS[rec.encoding]],
    ['', rec.eol.toUpperCase()],
    ['', LANG_LABELS[langFromName(rec.name)]],
    ['', state.engineId === 'monaco' ? 'Monaco' : 'CodeMirror'],
    ['', new Date(rec.createdAt).toLocaleString()],
    ['', new Date(rec.updatedAt).toLocaleString()],
  ]
  const grid = document.createElement('div')
  grid.className = 'keys'
  rows.forEach(([k, v]) => {
    const a = document.createElement('b')
    a.textContent = k
    const b = document.createElement('span')
    b.textContent = v
    grid.append(a, b)
  })
  openDialog({ title: t('dialog.stats'), body: grid, narrow: true })
}

/* ------------------------------------------------------------ 预览 */

function togglePreview(force?: boolean) {
  const rec = state.current
  const want = force ?? !state.previewOpen
  if (want && (!rec || langFromName(rec.name) !== 'markdown')) {
    toast(t('toast.previewUnsupported'))
    return
  }
  state.previewOpen = want
  el('rightPanel').classList.toggle('is-open', want)
  el('previewBtn').classList.toggle('is-active', want)
  if (want) renderPreviewNow()
  requestAnimationFrame(() => state.editor?.layout())
}

function renderPreviewNow() {
  if (!state.previewOpen) return
  el('previewBody').innerHTML = renderMarkdown(state.text)
}

function schedulePreview() {
  if (!state.previewOpen) return
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(renderPreviewNow, 250)
}

/* ------------------------------------------------------------ 快捷键 */

function isTyping(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null
  if (!node) return false
  return (
    node.tagName === 'INPUT' ||
    node.tagName === 'TEXTAREA' ||
    node.isContentEditable ||
    Boolean(node.closest('.cm-editor')) ||
    Boolean(node.closest('.monaco-editor'))
  )
}

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()

    if (mod && key === 's') {
      e.preventDefault()
      void saveFile()
      return
    }
    if (mod && key === 'o') {
      e.preventDefault()
      void importFile()
      return
    }
    if (mod && key === 'b') {
      e.preventDefault()
      void drawer.toggle().then(syncDrawerTabs)
      return
    }
    if (mod && key === 'p') {
      e.preventDefault()
      openQuickSwitch()
      return
    }
    if (e.shiftKey && e.altKey && key === 'e') {
      e.preventDefault()
      void switchEngine(state.engineId === 'cm' ? 'monaco' : 'cm')
      return
    }
    if (e.shiftKey && e.altKey && key === 'f') {
      e.preventDefault()
      void doFormat()
      return
    }
    if (e.key === 'Escape' && drawer.isOpen) {
      void drawer.hide().then(syncDrawerTabs)
      return
    }
    if (e.key === '?' && !isTyping(e.target)) {
      e.preventDefault()
      helpDialog()
    }
  })
}

function openQuickSwitch() {
  state.drawerTab = 'files'
  syncDrawerTabs()
  void drawer.show().then(() => {
    const input = el<HTMLInputElement>('drawerSearch')
    input.focus()
    input.select()
  })
}

/* ------------------------------------------------------------ 拖拽导入 */

function wireDropZone() {
  const overlay = el('dropOverlay')
  let depth = 0

  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    depth++
    overlay.hidden = false
  })
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) overlay.hidden = true
  })
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    depth = 0
    overlay.hidden = true
    const file = e.dataTransfer?.files?.[0]
    if (file) void ingestFile(file)
  })

  el<HTMLInputElement>('filePicker').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) void ingestFile(file)
    input.value = ''
  })
}
