import { applyStaticText, getLang, initLang, onLangChange, setLang, t } from '../i18n'
import { CodeMirrorAdapter } from '../editors/codemirror'
import type { EditorAdapter } from '../editors/adapter'
import { ALL_LANGS, LANG_LABELS, detectLang, langFromName, type LangId } from '../editors/languages'
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
import { createFindBar, type FindBar } from '../ui/findbar'
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
import { DEFAULT_SETTINGS } from '../types'
import type { EngineId, FileMode, FileRecord, SnapshotRecord } from '../types'

export const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T

export interface AppState {
  files: FileRecord[]
  current: FileRecord | null
  editor: EditorAdapter | null
  engineId: EngineId
  mode: FileMode
  /** 当前文件是否挂语法高亮：只读大文件也默认开，状态栏里的徽标可一键切换 */
  highlight: boolean
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
  highlight: true,
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
let findBar: FindBar
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
  applyPanelWidth(getSettings().panelWidth)

  wireTopbar()
  wireRails()
  wireEditorHead()
  wireStatusbar()

  findBar = createFindBar({
    getAdapter: () => state.editor,
    getText: () => state.editor?.getValue() ?? state.text,
    // 能不能替换只看当前是不是只读，不看体积：大文件手动解锁后照样能批量替换
    canReplace: () =>
      Boolean(state.current) && !state.locked && !state.current?.readOnly,
  })

  wireDrawer()
  wirePanelResizer()
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
    findBar?.relabel()
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
    refreshPreviewTheme()
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
  el('transformsBtn').addEventListener('click', () => transformsDialog((id) => applyTransform(id)))
  el('statsBtn').addEventListener('click', () => showStats())
  el('diffBtn').addEventListener('click', () => void diffWithLatest())
  el('diffFileBtn').addEventListener('click', () => diffWithFile())
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

/* ------------------------------------------------------------ 顶栏与空状态 */

function wireEditorHead() {
  el('saveBtn').addEventListener('click', () => void saveFile())
  el('formatBtn').addEventListener('click', () => void doFormat())
  el('findBtn').addEventListener('click', () => findBar?.open())
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

  // 加工 / 信息 / 两种对比已经搬到右竖条，菜单只留低频动作与偏好
  item(t('menu.newSnapshot'), () => void createSnapshot())
  item(t('menu.wrap'), () => toggleWrap())
  // 菜单里也说明「现在是只读，点了就放开」，和状态栏的徽标一致
  item(t(state.current?.readOnly ? 'menu.editable' : 'menu.readonly'), () => toggleReadonly())
  item(t('menu.reencode'), () => pickEncoding())

  // 字号与强调色是全局设置，与“是否打开文件”无关，单独成组
  const divider = document.createElement('div')
  divider.className = 'menu-divider'
  menu.appendChild(divider)

  const fontRow = document.createElement('div')
  fontRow.className = 'menu-row'
  const fontLabel = document.createElement('span')
  fontLabel.className = 'menu-row-label'
  fontLabel.textContent = t('settings.fontSize')
  const fontValue = document.createElement('span')
  fontValue.className = 'menu-row-value'

  const minus = document.createElement('button')
  minus.className = 'btn btn-ghost icon-only menu-step'
  minus.textContent = '−'
  const plus = document.createElement('button')
  plus.className = 'btn btn-ghost icon-only menu-step'
  plus.textContent = '+'

  const syncSteps = () => {
    const size = getSettings().fontSize
    fontValue.textContent = `${size}px`
    minus.disabled = size <= FONT_MIN
    plus.disabled = size >= FONT_MAX
  }
  const fontStep = (delta: number) => {
    const size = getSettings().fontSize
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, size + delta))
    if (next !== size) {
      updateSettings({ fontSize: next })
      applyTheme()
      state.editor?.setFontSize(next)
    }
    syncSteps()
  }
  minus.onclick = () => fontStep(-1)
  plus.onclick = () => fontStep(1)
  syncSteps()
  fontRow.append(fontLabel, minus, fontValue, plus)
  menu.appendChild(fontRow)

  const accent = document.createElement('button')
  accent.className = 'btn'
  accent.style.cssText = 'width:100%;justify-content:flex-start'
  const paintAccent = () => {
    accent.textContent = `${t('settings.accent')} · ${
      getSettings().accentOn ? t('settings.on') : t('settings.off')
    }`
  }
  paintAccent()
  accent.onclick = () => {
    toggleAccent()
    paintAccent()
  }
  menu.appendChild(accent)

  document.body.appendChild(menu)
  setTimeout(() => document.addEventListener('click', outside, true), 0)
}

/* ------------------------------------------------------------ 状态栏 */

function wireStatusbar() {
  el('stLang').addEventListener('click', () => pickLanguage())
  el('stReadonly').addEventListener('click', () => toggleReadonly())
  el('stHighlight').addEventListener('click', () => {
    // 纯文本没有语法可切，点徽标直接去选语言，比点了没反应强
    if (state.current && currentLang() === 'text') {
      pickLanguage()
      return
    }
    void toggleHighlight()
  })
  el('stEncoding').addEventListener('click', () => pickEncoding())
  el('stEol').addEventListener('click', () => void toggleEol())
}

async function refreshStorage() {
  const info = await store.storageInfo()
  // 缓存占用只在状态栏显示一处，抽屉底部留给导入按钮
  sb.setCache(info.usage, info.quota)
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
  // 不设硬上限：超大文件只提醒一次，用户确认后照常打开（只读）
  if (file.size > LIMITS.warn) {
    const res = await confirmDialog(
      `${file.name || t('misc.untitled')} · ${formatBytes(file.size)}`,
      t('confirm.hugeBody', { size: formatBytes(file.size), limit: formatBytes(LIMITS.warn) }),
    )
    if (!res.ok) return
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

  // 没有体积上限后，大文件可能撑爆配额，这里给出明确提示而不是静默失败
  try {
    await store.putFile(rec)
  } catch (err) {
    toast(t('toast.cacheFailed', { msg: (err as Error).message }), 'error')
    return
  }
  await refreshFiles()
  // 抽屉底部不再显示缓存占用，导入后要把状态栏的数字刷新一次
  await refreshStorage()
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
  await refreshStorage()
  await openRecord(rec.id)
}

/* ------------------------------------------------------------ 打开文件 */

/** 高亮开关按文件记忆，放在 meta 里，避免为了一个布尔值重写整个 blob */
type HighlightPrefs = Record<string, boolean>

async function highlightPrefs(): Promise<HighlightPrefs> {
  return (await store.getMeta<HighlightPrefs>('highlightPrefs')) ?? {}
}

async function saveHighlightPref(id: string, on: boolean): Promise<void> {
  const prefs = await highlightPrefs()
  prefs[id] = on
  await store.setMeta('highlightPrefs', prefs)
}

async function openRecord(id: string) {
  const rec = await store.getFile(id)
  if (!rec) return

  // 大文件没有实时草稿，切走前补一次写入，免得改了半天一换文件就没了
  if (state.current && state.current.id !== id && state.dirty) await persistDraft()

  const free = await lock.claim(id)
  state.current = rec
  state.locked = !free
  if (!free) toast(t('toast.locked'), 'error')

  state.mode = modeFor(rec.size)
  // 高亮默认开，包括只读的大文件；关过的话按文件记忆恢复
  state.highlight = (await highlightPrefs())[id] !== false
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
  // 换引擎 / 换文件后，旧的匹配位置已经失效
  findBar?.close()
  state.editor?.destroy()
  state.editor = null
  host.innerHTML = ''

  const Adapter =
    state.engineId === 'monaco'
      ? (await import('../editors/monaco')).MonacoAdapter
      : CodeMirrorAdapter

  const settings = getSettings()
  const full = state.mode === 'full'
  // 高亮只跟开关走，不跟体积走：两个引擎都只解析视口附近的行，25MB 的日志照样能上色
  const lang: LangId = state.highlight ? langOf(rec, text) : 'text'

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
      findBar?.refresh()
    },
    onCursor: (line, col) => sb.setCursor(line, col),
    // 引擎内按下查找键，统一改用界面上的查找栏
    onFind: (replace) => findBar?.open({ replace }),
  })

  state.editor = adapter
  state.text = text
  state.dirty = rec.dirty
  if (offset) adapter.setOffset(offset)

  sb.setCount(text)
  sb.setEncoding(ENCODING_LABELS[rec.encoding])
  sb.setEol(rec.eol)
  // 语言是文件本身的属性，只读大文件只是不解析，状态栏仍显示识别结果
  sb.setLanguage(LANG_LABELS[langOf(rec, text)])
  syncReadonlyBadge()
  sb.setLight(state.mode === 'light')
  sb.setCursor(1, 1)
  updateDirtyDot()
  updateEngineSeg()
}

/**
 * 语言判定：手动指定优先，否则按扩展名推断；
 * 推断不出（.txt/.log 这类）再嗅探内容，所以导出的 logcat 日志能自动认出来。
 */
let langCache: { id: string; manual: boolean; stored: string; head: string; lang: LangId } | null =
  null

function langOf(rec: FileRecord, text: string): LangId {
  // 每次按键都会走到这里，用前 256 个字符做键，避免重复嗅探整篇
  const head = text.slice(0, 256)
  if (
    langCache &&
    langCache.id === rec.id &&
    langCache.manual === !!rec.langManual &&
    langCache.stored === rec.lang &&
    langCache.head === head
  ) {
    return langCache.lang
  }
  const lang =
    rec.langManual && rec.lang ? (rec.lang as LangId) : detectLang(rec.name, text)
  langCache = {
    id: rec.id,
    manual: !!rec.langManual,
    stored: rec.lang,
    head,
    lang,
  }
  return lang
}

function currentLang(): LangId {
  const rec = state.current
  return rec ? langOf(rec, state.text) : 'text'
}

/**
 * 文件信息只保留在状态栏与抽屉里，顶栏用文件名当窗口标题。
 * 标题同时写进 document.title，切换标签页时也能看出当前文件。
 */
function refreshMeta() {
  const rec = state.current
  const name = rec ? rec.name : 'Vellum'
  el('titleText').textContent = name
  el('brand').title = rec ? `${rec.name} · ${formatBytes(rec.size)}` : 'Vellum'
  document.title = rec ? `${rec.name} — Vellum` : 'Vellum'
  // 高亮开关只在大文件（或已经手动关掉）时占用状态栏，小文件默认全开不必提示。
  // 纯文本没有语法可挂，徽标要说「无语法」而不是跟着开关假装在着色
  const plain = !rec || langOf(rec, state.text) === 'text'
  const hl = !state.highlight ? 'off' : plain ? 'na' : 'on'
  sb.setHighlight(hl, Boolean(rec) && (state.mode !== 'full' || !state.highlight))
  syncReadonlyBadge()
  syncPreviewButton()
  syncDocActions()
  if (!rec) {
    sb.setLanguage('—')
    return
  }
}

/** 预览只对 Markdown 有意义：别的文件连按钮都不用留，省得点了只弹提示 */
function syncPreviewButton() {
  const supported = Boolean(state.current) && currentLang() === 'markdown'
  el('previewBtn').hidden = !supported
  if (!supported && state.previewOpen) togglePreview(false)
}

/** 右竖条的文档操作（加工、信息、两种对比）没文件就没有意义，空状态一并收起 */
function syncDocActions() {
  const has = Boolean(state.current)
  document.querySelectorAll<HTMLElement>('[data-doc-action]').forEach((b) => {
    b.hidden = !has
  })
}

/** 状态栏只读徽标：大文件默认锁着防手滑，但永远允许点开强制编辑 */
function syncReadonlyBadge() {
  const rec = state.current
  sb.setReadonly(
    Boolean(rec && (rec.readOnly || state.locked)),
    Boolean(rec) && state.mode === 'readonly',
    Boolean(rec) && !state.locked,
  )
}

function updateDirtyDot() {
  el('dirtyDot').hidden = !state.dirty
}

function updateFormatButton() {
  const rec = state.current
  const lang = rec ? langOf(rec, state.text) : 'text'
  const long = (state.editor?.getValue().length ?? 0) > LIMITS.format
  el<HTMLButtonElement>('formatBtn').disabled =
    !rec || state.mode !== 'full' || long || !canFormat(lang)
  el<HTMLButtonElement>('saveBtn').disabled = !rec
  el<HTMLButtonElement>('findBtn').disabled = !rec
}

/* ------------------------------------------------------------ 自动草稿 */

function scheduleAutosave() {
  const rec = state.current
  if (!rec) return
  window.clearTimeout(autosaveTimer)
  // 大文件手动解锁后不给草稿自动保存：几十 MB 的文本每两秒重写一次 IndexedDB 会卡死
  if (rec.readOnly || rec.size > LIMITS.autosave) return
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

/** 字号可调区间：小于 11px 伤眼，大于 20px 一屏放不下几行 */
const FONT_MIN = 11
const FONT_MAX = 20

function toggleAccent() {
  updateSettings({ accentOn: !getSettings().accentOn })
  applyTheme()
  // Monaco 的颜色在 defineTheme 时读取 CSS 变量，同名主题不会自动重读
  state.editor?.refreshTheme()
}

function toggleWrap() {
  const next = !getSettings().wordWrap
  updateSettings({ wordWrap: next })
  state.editor?.setWordWrap(next)
}

/**
 * 只读 / 可编辑。
 * 大文件默认只读只是「防手滑」，不是禁令：点一下就能强制编辑，
 * 但这条路径没有草稿自动保存（几十 MB 的文本每次防抖都重写会卡），要自己保存。
 */
function toggleReadonly() {
  const rec = state.current
  if (!rec) return
  if (state.locked) {
    // 另一个标签页占着写锁，先放了那边再说
    toast(t('toast.locked'), 'error')
    return
  }

  const big = state.mode === 'readonly'
  rec.readOnly = !rec.readOnly
  state.editor?.setReadOnly(rec.readOnly)
  refreshMeta()
  void store.putFile(rec)

  if (rec.readOnly) toast(t('toast.readonlyOn'))
  else toast(t(big ? 'toast.readonlyOffBig' : 'toast.readonlyOff'))
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

/**
 * 高亮开关：大文件默认也开着，卡了就在状态栏点这儿关掉。
 * Monaco 是在建模时定死「是否分词」的，所以切换要重建编辑器。
 */
async function toggleHighlight() {
  const rec = state.current
  if (!rec || !state.editor) return

  const on = !state.highlight
  const value = state.editor.getValue()
  const offset = state.editor.getOffset()

  state.highlight = on
  await saveHighlightPref(rec.id, on)
  await mountEditor(value, offset)
  refreshMeta()
  toast(t(on ? 'toast.highlightOn' : 'toast.highlightOff'))
}

function pickLanguage() {
  const rec = state.current
  if (!rec) return

  const current = langOf(rec, state.text)
  const wrap = document.createElement('div')
  wrap.className = 'toolbar-row'

  const item = (label: string, active: boolean, run: () => void) => {
    const b = document.createElement('button')
    b.className = `btn${active ? ' btn-primary' : ''}`
    b.textContent = label
    b.onclick = () => {
      dlg.close()
      run()
    }
    wrap.appendChild(b)
  }

  item(t('lang.auto'), !rec.langManual, () => void applyLanguage(null))
  ALL_LANGS.forEach((id) => {
    item(LANG_LABELS[id], !!rec.langManual && current === id, () => void applyLanguage(id))
  })

  const dlg = openDialog({ title: t('dialog.language'), body: wrap, narrow: true })
}

/** next 为 null 表示回到自动（按扩展名 + 内容嗅探） */
async function applyLanguage(next: LangId | null) {
  const rec = state.current
  if (!rec || !state.editor) return

  rec.langManual = next !== null
  rec.lang = next ?? detectLang(rec.name, state.text)
  await store.putFile(rec)

  const lang = currentLang()
  // 高亮关着的时候选语言就是要求看颜色，顺手打开（大文件需要重建才生效）
  if (!state.highlight) {
    const value = state.editor.getValue()
    const offset = state.editor.getOffset()
    state.highlight = true
    await saveHighlightPref(rec.id, true)
    await mountEditor(value, offset)
  } else {
    state.editor.setLanguage(lang)
  }
  sb.setLanguage(LANG_LABELS[lang])
  // refreshMeta 里的 syncPreviewButton 会顺手收起非 Markdown 的预览
  refreshMeta()
  updateFormatButton()
  toast(t('toast.languageSet', { lang: LANG_LABELS[lang] }))
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
  const lang = langOf(rec, state.text)
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

/** 文件对文件：把另一个已导入文件的全文拿出来当基准 */
async function compareWithFile(id: string) {
  const rec = state.current
  const other = state.files.find((f) => f.id === id)
  if (!rec || !other) return
  diffDialog(other.name, await other.blob.text(), state.text)
}

/** 从「更多」菜单挑一个文件当基准 */
function diffWithFile() {
  const rec = state.current
  if (!rec) return

  const others = state.files.filter((f) => f.id !== rec.id)
  if (!others.length) {
    toast(t('diff.noOtherFiles'))
    return
  }

  const wrap = document.createElement('div')
  wrap.className = 'pick-list'

  const dlg = openDialog({ title: t('dialog.diffPick'), body: wrap, narrow: true })
  for (const f of others) {
    const b = document.createElement('button')
    b.className = 'btn pick-item'
    const name = document.createElement('span')
    name.className = 'pick-name'
    name.textContent = f.name
    const meta = document.createElement('span')
    meta.className = 'pick-meta'
    meta.textContent = formatBytes(f.size)
    b.append(name, meta)
    b.onclick = () => {
      dlg.close()
      void f.blob.text().then((text) => diffDialog(f.name, text, state.text))
    }
    wrap.appendChild(b)
  }
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
      compare: (id) => void compareWithFile(id),
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
    sb.setLanguage('—')
    sb.setLight(false)
    sb.setReadonly(false)
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
    [t('stats.name'), rec.name],
    ['', formatBytes(rec.size)],
    ['', `${text.split('\n').length} lines · ${text.length} chars`],
    ['', ENCODING_LABELS[rec.encoding]],
    ['', rec.eol.toUpperCase()],
    ['', LANG_LABELS[langOf(rec, text)]],
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

const PANEL_MIN = 280
const PANEL_MAX = 760
/** 两条竖条 + 间距 + 编辑区最小可读宽度，用于窗口变窄时收住预览 */
const PANEL_RESERVED = 520

function clampPanelWidth(px: number): number {
  const room = el('body').clientWidth - PANEL_RESERVED
  const max = Math.max(PANEL_MIN, Math.min(PANEL_MAX, room))
  return Math.min(max, Math.max(PANEL_MIN, Math.round(px)))
}

/**
 * 面板脱离文档流时，右缘要停在 rail-right 左侧。
 * 取实际几何值而不是算轨道宽度，改布局时不用同步这个数。
 */
function panelRightOffset(): number {
  const rail = document.querySelector('.rail-right')
  const host = el('body')
  if (!rail) return 0
  const gap = Number.parseFloat(getComputedStyle(host).columnGap) || 0
  // 面板右缘 + 间距 = 右竖条左缘
  return Math.round(host.getBoundingClientRect().right - rail.getBoundingClientRect().left + gap)
}

/** 落定宽度：回到文档流，此时才让编辑器重新布局一次 */
function applyPanelWidth(px: number): number {
  const width = clampPanelWidth(px)
  const panel = el('rightPanel')
  panel.classList.remove('is-floating')
  panel.style.right = ''
  panel.style.width = ''
  el('editorIsland').style.marginRight = ''
  // 写在根变量上而不是内联样式，否则打印时 @media print 的 width:100% 覆盖不掉
  document.documentElement.style.setProperty('--panel-w', `${width}px`)
  state.editor?.layout()
  return width
}

function wirePanelResizer() {
  const panel = el('rightPanel')
  const handle = el('panelResizer')

  handle.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (ev.button !== 0) return
    ev.preventDefault()
    const startX = ev.clientX
    const startW = panel.getBoundingClientRect().width
    handle.setPointerCapture(ev.pointerId)
    handle.classList.add('is-dragging')
    document.body.classList.add('is-resizing')

    // 拖动阶段面板浮起来（脱离文档流），宽度变化只重排它自己；
    // 编辑区用右边距抵消掉面板原本占的宽度，全程不重排，松手后再一次性落定
    const body = el('body')
    const gap = Number.parseFloat(getComputedStyle(body).columnGap) || 0
    panel.classList.add('is-floating')
    panel.style.right = `${panelRightOffset()}px`
    panel.style.width = `${startW}px`
    el('editorIsland').style.marginRight = `${startW + gap}px`

    const move = (e: PointerEvent) => {
      // 面板贴在编辑区右侧，向左拖才变宽
      panel.style.width = `${clampPanelWidth(startW - (e.clientX - startX))}px`
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId)
      handle.classList.remove('is-dragging')
      document.body.classList.remove('is-resizing')
      const width = Math.round(panel.getBoundingClientRect().width)
      updateSettings({ panelWidth: applyPanelWidth(width) })
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  })

  handle.addEventListener('dblclick', () => {
    applyPanelWidth(DEFAULT_SETTINGS.panelWidth)
    updateSettings({ panelWidth: DEFAULT_SETTINGS.panelWidth })
  })

  // ← 变宽、→ 变窄，与拖动方向一致；Shift 加速
  handle.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
    ev.preventDefault()
    const step = ev.shiftKey ? 40 : 8
    applyPanelWidth(panel.getBoundingClientRect().width + (ev.key === 'ArrowLeft' ? step : -step))
    updateSettings({ panelWidth: Math.round(panel.getBoundingClientRect().width) })
  })

  // 窗口变窄时按容器重算显示宽度，但不覆盖用户设定的值
  let raf = 0
  window.addEventListener('resize', () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      applyPanelWidth(getSettings().panelWidth)
    })
  })
}

function togglePreview(force?: boolean) {
  const rec = state.current
  const want = force ?? !state.previewOpen
  if (want && (!rec || currentLang() !== 'markdown')) {
    toast(t('toast.previewUnsupported'))
    return
  }
  state.previewOpen = want
  el('rightPanel').classList.toggle('is-open', want)
  el('previewBtn').classList.toggle('is-active', want)
  if (want) renderPreviewNow()
  requestAnimationFrame(() => state.editor?.layout())
}

let previewSeq = 0

function currentTheme(): 'dark' | 'light' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function renderPreviewNow() {
  if (!state.previewOpen) return
  // 预览只画 Markdown：切到日志之类的文件时先收起，别把几十 MB 文本丢给 marked
  if (currentLang() !== 'markdown') {
    togglePreview(false)
    return
  }
  const body = el('previewBody')
  const seq = ++previewSeq
  const scrollTop = body.scrollTop
  body.innerHTML = renderMarkdown(state.text)
  if (!body.querySelector('.mermaid-block')) return
  void (async () => {
    // mermaid 体积大，只在文档里真有图表时才加载
    const { renderMermaidBlocks } = await import('../ui/mermaid')
    if (seq !== previewSeq || !state.previewOpen) return
    await renderMermaidBlocks(body, currentTheme())
    if (seq === previewSeq) body.scrollTop = scrollTop
  })()
}

/** 换主题后图表要按新配色重画，正文本身走 CSS 变量不用重建 */
function refreshPreviewTheme() {
  if (!state.previewOpen) return
  if (!el('previewBody').querySelector('.mermaid-block')) return
  renderPreviewNow()
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
    // 弹窗打开时把按键让给弹窗里的输入框
    if (mod && !el('dialogLayer').hidden) return
    if (mod && e.altKey && key === 'f') {
      e.preventDefault()
      findBar?.open({ replace: true })
      return
    }
    if (mod && key === 'f') {
      e.preventDefault()
      findBar?.open()
      return
    }
    if (e.key === 'Escape' && drawer.isOpen) {
      void drawer.hide().then(syncDrawerTabs)
      return
    }
    if (e.key === 'Escape' && findBar?.isOpen()) {
      e.preventDefault()
      findBar.close()
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
