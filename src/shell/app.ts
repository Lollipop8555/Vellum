import { applyStaticText, getLang, initLang, onLangChange, setLang, t } from '../i18n'
import { CodeMirrorAdapter } from '../editors/codemirror'
import type { EditorAdapter } from '../editors/adapter'
import { activeIndex, extractOutline, type OutlineItem } from '../ui/outline'
import {
  ALL_LANGS,
  LANG_LABELS,
  cmSupports,
  detectLang,
  langFromName,
  langKeywords,
  monoSupports,
  type LangId,
} from '../editors/languages'
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
import { pickFile, saveAs } from './save'
import {
  applyName,
  bumpContent,
  createFileNode,
  createFolderNode,
  toNode,
  toOpen,
} from './nodes'
import {
  buildTree,
  canMoveInto,
  dedupeName,
  hasNameElsewhere,
  isFile,
  isFolder,
  nextUntitled,
  nodePath,
  normalizeName,
  takenNames,
  validateName,
} from './tree'
import * as trash from './trash'
import { collectEntries, collectEntriesWithParents, estimateBytes, exportZip, zipName } from './export'
import { getSettings, loadSettings, updateSettings } from './settings'
import { DEFAULT_FORMAT, canFormat, formatText } from './format'
import { transformText, type TransformId } from './transform'
import { FileLock } from './lock'
import {
  initTabs,
  notifyFiles,
  probeOpenElsewhere,
  readTabFile,
  rememberTabFile,
  tabWindowName,
} from './tabs'
import { Drawer } from '../ui/layout'
import { applyTheme } from '../ui/theme'
import { toast } from '../ui/toast'
import { renderMarkdown } from '../ui/markdown'
import { createFindBar, type FindBar } from '../ui/findbar'
import * as sb from '../ui/statusbar'
import { ENGINE_NAMES, engineIcon, engineMark } from '../ui/icons'
import {
  renderSearchResults,
  renderSnapshotList,
  type SearchContentHit,
  type SearchEntry,
} from '../ui/sidebar'
import { renderTrashList, renderTree } from '../ui/tree'
import {
  confirmDialog,
  diffDialog,
  helpDialog,
  openDialog,
  promptDialog,
  toolsDialog,
  transformsDialog,
} from '../ui/dialogs'
import { DEFAULT_SETTINGS } from '../types'
import type {
  ContentRecord,
  EngineId,
  FileMode,
  FileNode,
  NodeRecord,
  OpenFile,
  SnapshotRecord,
} from '../types'

export const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T

type DrawerTab = 'files' | 'search' | 'trash' | 'snapshots'

const EXPANDED_KEY = 'vellum.expanded'

function readExpanded(): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveExpanded(): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...state.expanded]))
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略即可 */
  }
}

export interface AppState {
  /** 全部节点（含软删除），树由 buildTree 在内存中构建 */
  files: NodeRecord[]
  current: OpenFile | null
  /** 多选集合（§13.2），只装节点 id */
  selection: Set<string>
  /** Shift 范围选择的锚点 */
  anchor: string | null
  editor: EditorAdapter | null
  engineId: EngineId
  mode: FileMode
  /** 当前文件是否挂语法高亮：只读大文件也默认开，状态栏里的徽标可一键切换 */
  highlight: boolean
  text: string
  dirty: boolean
  locked: boolean
  snapshots: SnapshotRecord[]
  drawerTab: DrawerTab
  /** 抽屉里已展开的文件夹 id，持久化在 localStorage */
  expanded: Set<string>
  /** 正在内联重命名的节点 id */
  renamingId: string | null
  search: string
  rawBytes: ArrayBuffer | null
  encodingConfirmed: boolean
  /** 右侧面板是否展开（名字沿用老代码：它管的就是这个面板） */
  previewOpen: boolean
  /** 右侧面板当前显示哪一页 */
  rightTab: RightTab
}

export type RightTab = 'preview' | 'outline'

export const state: AppState = {
  files: [],
  current: null,
  selection: new Set<string>(),
  anchor: null,
  editor: null,
  engineId: 'cm',
  mode: 'full',
  highlight: true,
  text: '',
  dirty: false,
  locked: false,
  snapshots: [],
  drawerTab: 'files',
  expanded: new Set<string>(readExpanded()),
  renamingId: null,
  search: '',
  rawBytes: null,
  encodingConfirmed: false,
  previewOpen: false,
  rightTab: 'preview',
}

const lock = new FileLock()
let drawer: Drawer
let findBar: FindBar
let autosaveTimer = 0
let previewTimer = 0
/** 未保存改动最后一次写进草稿的时间；null = 还没写过（防抖窗口里，或这文件根本不写草稿） */
let draftAt: number | null = null

/* ------------------------------------------------------------------ 启动 */

export async function startApp() {
  initLang()
  state.engineId = loadSettings().defaultEngine
  applyTheme()
  applyStaticText()
  updateLangButton()

  drawer = new Drawer(el('drawer'), () => state.editor?.layout())
  // 开合只影响图标高亮与 aria 状态；列表内容与分区无关，不用重渲染
  drawer.onChange = () => syncLeftBarState()
  applyDrawerWidth(getSettings().drawerWidth)
  applyPanelWidth(getSettings().panelWidth)
  // 默认展开 files 分区：标题、高亮、底部动作都得在首帧就对上
  syncLeftPanel()

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
  wireDrawerResizer()
  wirePanelResizer()
  wireKeyboard()
  wireDropZone()

  updateEngineSeg()
  // 存储层面出问题不该把整个启动流程拖死：后面的标签页恢复、事件绑定都还得跑完，
  // 否则界面看着正常、其实什么都没接上
  try {
    await refreshFiles()
    await refreshStorage()
  } catch (err) {
    toast(t('toast.dbUnavailable', { msg: (err as Error).message }), 'error')
    // 占用方关掉后能自己恢复，试一次；仍失败就等用户下一次操作再触发
    window.setTimeout(() => {
      void refreshFiles()
        .then(() => refreshStorage())
        .catch(() => undefined)
    }, 3000)
  }

  wireTabs()

  // 地址里带 #file= 就落回那个文件（新标签页打开、复制链接都靠它）；
  // 否则恢复「本标签页」上次的文件：刷新照旧，新开的标签页仍是干净的
  const lastId = fileFromHash() ?? readTabFile()
  if (lastId) await openRecord(lastId)

  // 手改地址栏、或在别的标签页里用后退回到旧地址时，跟着换文件
  window.addEventListener('hashchange', () => {
    const id = fileFromHash()
    if (!id || id === state.current?.id) return
    void openRecord(id)
  })

  void store.requestPersistence()
  prefetchMonaco()

  onLangChange(() => {
    updateLangButton()
    // 标题是动态拼的分区名，静态文本应用不到，得单独刷一次
    syncLeftPanel()
    refreshMeta()
    updateDirtyDot()
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
    .forEach((b) => {
      const id = b.dataset.engine as EngineId
      // 图标 + 名字一次画好；窄窗口由 CSS 收掉名字，只留图标
      if (!b.innerHTML) {
        b.innerHTML = `${engineIcon(id)}<span class="seg-label">${ENGINE_NAMES[id]}</span>`
      }
      b.title = ENGINE_NAMES[id]
      b.classList.toggle('is-active', id === state.engineId)
    })
  sb.setEngine(state.engineId)
}

/* ---------------------------------------------------------------- 竖条 */

/**
 * 左侧图标栏：点图标切分区并展开面板；点当前分区的图标等于按 X。
 * 全部走显式点击，不再有任何「指针经过就改变布局」的隐式行为。
 */
function wireRails() {
  el('leftBar').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-left-tab]')
    if (!btn) return
    const tab = btn.dataset.leftTab as DrawerTab
    if (drawer.isOpen && state.drawerTab === tab) {
      void drawer.hide()
      return
    }
    switchDrawerTab(tab)
  })
  el('drawerClose').addEventListener('click', () => void drawer.hide())

  el('previewBtn').addEventListener('click', () => togglePanel('preview'))
  el('outlineBtn').addEventListener('click', () => togglePanel('outline'))
  el('transformsBtn').addEventListener('click', () => transformsDialog((id) => applyTransform(id)))
  el('statsBtn').addEventListener('click', () => showStats())
  el('diffBtn').addEventListener('click', () => void diffWithLatest())
  el('diffFileBtn').addEventListener('click', () => diffWithFile())
  el('toolsBtn').addEventListener('click', () => toolsDialog())
  // 页签只切页不收起：点当前页把它关掉，是在跟用户的手指作对（收起是右上角 × 的事）
  el('panelTabPreview').addEventListener('click', () => togglePanel('preview', true))
  el('panelTabOutline').addEventListener('click', () => togglePanel('outline', true))
  el('outlineBody').addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('.outline-item')
    if (!btn) return
    const item = outlineItems[Number(btn.dataset.index ?? -1)]
    if (!item) return
    state.editor?.goToLine(item.line)
    state.editor?.focus()
  })
  el('previewClose').addEventListener('click', () => closePanel())
  el('previewPrint').addEventListener('click', () => {
    togglePanel('preview', true)
    setTimeout(() => window.print(), 150)
  })
}

/**
 * 分区同步：标题、图标高亮、底部动作、列表一次到位。
 * 图标栏只在面板展开时给「当前分区」上高亮 —— 收起态没有可见内容，
 * 把某个图标标成选中会显得没头没尾。
 */
function syncLeftPanel() {
  syncLeftBarState()
  el('drawerTitle').textContent = t(TAB_TITLES[state.drawerTab])
  syncDrawerFoot()
  renderDrawerList()
}

const TAB_TITLES: Record<DrawerTab, 'rail.files' | 'rail.search' | 'rail.trash' | 'rail.snapshots'> = {
  files: 'rail.files',
  search: 'rail.search',
  trash: 'rail.trash',
  snapshots: 'rail.snapshots',
}

function syncLeftBarState() {
  el('leftBar')
    .querySelectorAll<HTMLElement>('[data-left-tab]')
    .forEach((b) => {
      const on = drawer.isOpen && b.dataset.leftTab === state.drawerTab
      b.classList.toggle('is-active', on)
      b.setAttribute('aria-pressed', String(on))
      // 三个图标控制同一张面板，展开态对它们是一致的
      b.setAttribute('aria-expanded', String(drawer.isOpen))
    })
}

/** 切换分区：面板收着就顺手展开；点当前分区不走这里，那等于按 X */
function switchDrawerTab(tab: DrawerTab) {
  const changed = state.drawerTab !== tab
  state.drawerTab = tab
  if (changed) {
    state.renamingId = null
    clearSelection()
  }
  // 离开搜索页就把正在跑的扫描掐掉：结果没人看，别继续读盘；顺手收起设置弹层
  if (tab !== 'search') {
    cancelSearch()
    el('searchOptions').hidden = true
  } else {
    el<HTMLInputElement>('searchInput').value = state.search
  }
  syncLeftPanel()
  if (!drawer.isOpen) void drawer.show()
  if (changed) void refreshSnapshots()
}

/**
 * 底部按钮随标签页切换：文件/回收站/快照各有各的动作。
 * 有选中项时整条换成批量操作条（§13.2），不再显示新建/导入。
 */
function syncDrawerFoot() {
  const isFiles = state.drawerTab === 'files'
  const isTrash = state.drawerTab === 'trash'
  const hasTrash = trash.trashItems(state.files).length > 0
  const batch = isFiles && state.selection.size > 0

  el('batchBar').hidden = !batch
  // 整行一起收：只藏按钮会留下一条空白
  el('drawerActions').hidden = !isFiles || batch
  el('importBtn').hidden = !isFiles || batch
  el('restoreAllBtn').hidden = !isTrash
  el<HTMLButtonElement>('restoreAllBtn').disabled = !hasTrash
  el('emptyTrashBtn').hidden = !isTrash
  el<HTMLButtonElement>('emptyTrashBtn').disabled = !hasTrash
  // 折叠态的全局计数：始终反映「文件页 / 回收站」两个真实数字
  const trashedCount = trash.trashItems(state.files).length
  const liveCount = state.files.length - trashedCount
  el('railFilesCount').textContent = String(liveCount)
  el('railTrashCount').textContent = String(trashedCount)
  el('railFilesBtn').title = t('rail.filesTip', { n: liveCount })
  el('railTrashBtn').title = t('rail.trashTip', { n: trashedCount })
  // 搜索页有自己的输入框和列表，文件页的骨架（树、底部动作）整体让位
  const isSearch = state.drawerTab === 'search'
  el('searchPane').hidden = !isSearch
  el('drawerList').hidden = isSearch
  el('drawerFoot').hidden = isSearch
  // 空间条只属于文件页：回收站有自己的一行合计
  el('drawerStorage').hidden = !isFiles

  if (batch) el('batchCount').textContent = t('list.selectedCount', { n: state.selection.size })
}

function wireDrawer() {
  const input = el<HTMLInputElement>('searchInput')
  const options = el('searchOptions')
  const optBtn = el('searchOptionsBtn')

  input.addEventListener('input', () => {
    state.search = input.value
    el('searchClear').hidden = state.search === ''
    scheduleSearch()
  })

  // 清空搜索：只清搜索词，不动分区，也不动面板开合
  el('searchClear').addEventListener('click', () => {
    state.search = ''
    input.value = ''
    el('searchClear').hidden = true
    input.focus()
    void runSearch()
  })

  // 手动触发：开了设置之后不再边打字边搜
  el('searchGo').addEventListener('click', () => void runSearch())

  // 大文件只在内容搜索下才有意义：勾它就连带勾上内容，撤内容也一起撤掉
  el('searchDeep').addEventListener('change', (e) => {
    deepSearch = (e.target as HTMLInputElement).checked
    if (!deepSearch) bigSearch = false
    void runSearch()
  })

  el('searchBig').addEventListener('change', (e) => {
    bigSearch = (e.target as HTMLInputElement).checked
    if (bigSearch) deepSearch = true
    void runSearch()
  })

  // 设置弹层：点图标开合，点外面或按 Esc 收起
  optBtn.addEventListener('click', () => {
    options.hidden = !options.hidden
    renderSearchPane()
  })

  document.addEventListener('pointerdown', (e) => {
    if (options.hidden) return
    const target = e.target as Node
    if (options.contains(target) || optBtn.contains(target)) return
    options.hidden = true
    renderSearchPane()
  })

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !options.hidden) {
      options.hidden = true
      renderSearchPane()
      return
    }
    if (e.key !== 'Enter') return
    // 手动模式下词改过：回车先跑搜索；结果就绪后再回车才是打开第一条
    if (searchStale) {
      void runSearch()
      return
    }
    // 回车打开第一条结果：名字命中的从头打开，只有内容命中的落到第一处
    const first = searchEntries.find((entry) => !entry.isFolder)
    if (!first) return
    void openRecord(first.id, first.nameHit ? undefined : first.hits[0]?.line)
  })

  el('newFileBtn').addEventListener('click', () => void createNode('file'))
  el('newFolderBtn').addEventListener('click', () => void createNode('folder'))
  el('batchExportBtn').addEventListener('click', () => void batchExport())
  el('batchMoveBtn').addEventListener('click', () => batchMove())
  el('batchCleanBtn').addEventListener('click', () => void batchClean())
  el('batchTrashBtn').addEventListener('click', () => void batchTrash())
  el('batchClearBtn').addEventListener('click', () => {
    clearSelection()
    renderDrawerList()
  })
  el('restoreAllBtn').addEventListener('click', () => void restoreAllFromTrash())
  el('emptyTrashBtn').addEventListener('click', () => void emptyTrash())
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

  const item = (label: string, fn: () => void, needsFile = true) => {
    const b = document.createElement('button')
    b.className = 'btn'
    b.style.cssText = 'width:100%;justify-content:flex-start'
    b.textContent = label
    b.disabled = needsFile && !state.current
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
  item(t('action.saveAs'), () => void exportCurrent())
  item(t('menu.exportLibrary'), () => exportLibrary(), false)
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
    if (!state.current) return
    const lang = currentLang()
    // 纯文本没有语法可切，点徽标直接去选语言，比点了没反应强
    if (lang === 'text') {
      pickLanguage()
      return
    }
    // 当前引擎没这门语言的语法：徽标上挂的是能着色的那一侧，点一下问一句就切过去
    if (!engineHas(lang)) {
      void offerEngineSwitch(lang)
      return
    }
    void toggleHighlight()
  })
  el('stEncoding').addEventListener('click', () => pickEncoding())
  el('stEol').addEventListener('click', () => void toggleEol())
}

/**
 * 空间展示分两处（D-22 / §16）：
 * - 抽屉底部：库内总计 / 浏览器配额。库内总计只累加元信息 size，不读内容；
 *   不直接显示 estimate().usage，那是整站 origin 的口径，与库内净值对不上。
 * - 状态栏：当前文件大小（见 syncSizeBadge）。
 */
async function refreshStorage() {
  const [info, total] = await Promise.all([store.storageInfo(), store.totalSize()])
  const ratio = info.quota > 0 ? Math.min(1, total / info.quota) : 0
  const pct = ratio * 100
  // 小比例保留一位小数，免得 0.2% 这种真实占用被显示成 0
  const pctText = pct >= 10 ? String(Math.round(pct)) : pct.toFixed(1)
  const text = t('list.storage', {
    used: formatBytes(total),
    quota: info.quota ? formatBytes(info.quota) : '—',
    pct: pctText,
  })

  // 文件页底部：进度条占比 + 文字比例（环只给直觉）
  const box = el('drawerStorage')
  el('drawerStorageText').textContent = text
  el('storageFill').style.width = `${pct.toFixed(2)}%`
  box.title = t('list.storageHint', { usage: formatBytes(info.usage) })
  box.classList.toggle('is-warn', info.quota > 0 && total > info.quota * 0.8)

  // 图标栏那个环：2πr（r = 15）= 94.25
  const ring = document.getElementById('railDiskRing') as SVGCircleElement | null
  // 空库时留一小段起手的弧，否则这个位置看起来像「没有东西」；真实数字在 tooltip 里
  ring?.style.setProperty('stroke-dashoffset', String(94.25 * (1 - Math.max(ratio, 0.03))))
  const disk = el('railDisk')
  disk.classList.toggle('is-warn', ratio > 0.8)
  disk.title = text
}

/**
 * 状态栏的文件大小。dirty 时按当前文本估算，但只在小文件（full 档）里做：
 * 大文件每敲一个字都会整段编码一遍，代价不值得。
 */
function syncSizeBadge() {
  const rec = state.current
  if (!rec) {
    sb.setSize(null)
    return
  }
  if (!state.dirty || state.mode !== 'full') {
    sb.setSize(rec.size)
    return
  }
  const text = state.editor?.getValue() ?? state.text
  sb.setSize(encodeUtf8(text).byteLength)
}

/**
 * 编码格：库内一律 UTF-8，但导入时按什么解码是这文件的一段历史。
 * 源编码在第一次内容变更后就会被丢掉（D-16 单副本），所以这里每次都重新读节点。
 */
function syncEncodingBadge() {
  const rec = state.current
  if (!rec) {
    sb.setEncoding('utf-8')
    return
  }
  sb.setEncoding(rec.encoding, rec.sourceEncoding ?? null)
}

/* ---------------------------------------------------------------- 导入 */

async function importFile() {
  if (window.showOpenFilePicker) {
    try {
      const file = await pickFile()
      if (file) await ingestFile(file)
    } catch (err) {
      toast(t('toast.readFailed', { msg: (err as Error).message }), 'error')
    }
    return
  }
  el<HTMLInputElement>('filePicker').click()
}

/**
 * 语言只在导入时判定一次（D-07）：后缀说得清就按后缀，说不清才嗅探内容。
 * 之后运行时一律读节点上的 lang，不再嗅探。
 */
function autoLang(name: string, text: string): { lang: LangId; source: FileNode['langSource'] } {
  const byExt = langFromName(name)
  if (byExt !== 'text') return { lang: byExt, source: 'ext' }
  return { lang: detectLang(name, text), source: 'sniff' }
}

/** 超过这个体积就不再留原始字节，避免同一份内容占两倍配额（D-16） */
const KEEP_ORIGINAL_LIMIT = 5 * 1024 * 1024

async function ingestFile(file: File) {
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

  // 导入即规范化（D-08）：解码 → 统一换行 → UTF-8，之后不再反复解析
  const { text, encoding } = decodeAuto(buf)
  const eol = detectEol(text)
  const normalized = normalizeEol(text, eol)
  const bytes = encodeUtf8(normalized)
  const { lang, source } = autoLang(file.name, text)
  const name = dedupeName(file.name || t('misc.untitled'), takenNames(state.files, null))

  const node = createFileNode({
    name,
    lang,
    langSource: source,
    encoding: 'utf-8',
    ...(encoding === 'utf-8' ? {} : { sourceEncoding: encoding }),
    eol,
    engine: state.engineId,
    size: bytes.byteLength,
    // 大文件默认锁住防手滑，但仍可在状态栏一键解锁
    readOnlyUser: modeFor(bytes.byteLength) === 'readonly',
  })

  // 没有体积上限后，大文件可能撑爆配额，这里给出明确提示而不是静默失败
  try {
    await store.putNode(node)
    // 小文件留原始字节（切编码 / 逐字节保真），大文件直接存规范化内容，只占一份
    await store.putContent(
      file.size > KEEP_ORIGINAL_LIMIT
        ? { id: node.id, blob: new Blob([normalized], { type: 'text/plain' }) }
        : { id: node.id, originalBytes: new Blob([buf]) },
    )
  } catch (err) {
    toast(t('toast.cacheFailed', { msg: (err as Error).message }), 'error')
    return
  }

  await refreshFiles()
  // 抽屉底部不再显示缓存占用，导入后要把状态栏的数字刷新一次
  await refreshStorage()
  await openRecord(node.id)
  notifyFiles(node.id)
  toast(t('toast.imported', { name: node.name }))
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

  const eol = detectEol(text)
  const normalized = normalizeEol(text, eol)
  const name = dedupeName(t('misc.untitled'), takenNames(state.files, null))
  const { lang, source } = autoLang(name, text)
  const node = createFileNode({
    name,
    lang,
    langSource: source,
    eol,
    engine: state.engineId,
    size: encodeUtf8(normalized).byteLength,
  })

  await store.putNode(node)
  await store.putContent({ id: node.id, blob: new Blob([normalized], { type: 'text/plain' }) })
  await refreshFiles()
  await refreshStorage()
  await openRecord(node.id)
  notifyFiles(node.id)
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

/**
 * 取文件当前内容。
 * - 已编辑：contents.blob 就是规范 UTF-8
 * - 未编辑：由 originalBytes 现解现转，不额外存一份
 * 换行统一按节点属性应用，所以改 eol 后立刻生效。
 */
async function contentBlob(
  node: FileNode,
  content: ContentRecord | undefined,
): Promise<Blob | null> {
  let text: string | null = null
  if (content?.blob) text = await content.blob.text()
  else if (content?.originalBytes) {
    const raw = await content.originalBytes.arrayBuffer()
    text = decodeWith(raw, node.sourceEncoding ?? 'utf-8')
  }
  if (text === null) return null
  return new Blob([normalizeEol(text, node.eol)], { type: 'text/plain' })
}

/* ------------------------------------------------------ 用浏览器标签页打开 */

/** 文件的地址：hash 带上 id，刷新、复制链接、新标签页都能落到同一个文件 */
function fileUrl(id: string): string {
  const url = new URL(window.location.href)
  url.hash = `file=${id}`
  return url.toString()
}

function fileFromHash(): string | null {
  const m = /^#file=(.+)$/.exec(window.location.hash)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

/** 地址栏跟着当前文件走，但不产生历史记录（否则后退会变成切文件） */
function syncHash(id: string | null) {
  const hash = id ? `#file=${id}` : ''
  if (window.location.hash === hash) return
  try {
    const url = new URL(window.location.href)
    url.hash = hash
    window.history.replaceState(null, '', url.toString())
  } catch {
    /* file:// 之类的宿主可能不让改地址，功能降级即可 */
  }
}

/**
 * 用浏览器标签页打开文件：浏览器本身就是编辑器的标签栏。
 * 文件已在别的标签页开着就切过去——同一文件开两份只会互抢写锁。
 */
async function openFileInTab(id: string) {
  if (await probeOpenElsewhere(id)) {
    // 同名窗口会被复用：那个标签页打开这个文件时把文件名写进了 window.name。
    // 这里刻意不开 noopener —— 浏览器只在同一个上下文组里按名字找窗口，
    // 掐掉 opener 关系就等于各开各的，跳转永远落空。
    window.open(fileUrl(id), tabWindowName(id))
    return
  }
  window.open(fileUrl(id), '_blank')
}

/** line 只用于搜索命中跳转：打开后把光标带到那一行 */
async function openRecord(id: string, line?: number) {
  const node = await store.getNode(id)
  if (!node || node.kind !== 'file' || node.deletedAt !== null) {
    // 地址里是个已经没了的文件：顺手擦掉，别让刷新一直撞空
    if (fileFromHash() === id) syncHash(null)
    return
  }

  // 打开文件即离开批量上下文（§13.2）
  clearSelection()

  // 大文件没有实时草稿，切走前补一次写入，免得改了半天一换文件就没了
  if (state.current && state.current.id !== id && state.dirty) await persistDraft()

  const content = await store.getContent(id)
  const free = await lock.claim(id)
  const rec = toOpen(node, content, { locked: !free, mode: modeFor(node.size) })
  rec.blob = await contentBlob(node, content)

  state.current = rec
  state.locked = !free
  if (!free) toast(t('toast.locked'), 'error')

  state.mode = modeFor(node.size)
  // 高亮默认开，包括只读的大文件；关过的话按文件记忆恢复
  state.highlight = (await highlightPrefs())[id] !== false
  // 引擎偏好按文件记忆，其次回落到全局设置
  state.engineId = node.engine ?? state.engineId
  state.encodingConfirmed = false
  state.rawBytes = content?.originalBytes ? await content.originalBytes.arrayBuffer() : null

  const text = rec.blob ? await rec.blob.text() : ''
  await mountEditor(text)
  if (line && line > 0) state.editor?.goToLine(line)

  rememberTabFile(id)
  syncHash(id)
  el('emptyState').hidden = true
  await refreshSnapshots()
  await refreshFiles()
  refreshMeta()
  updateFormatButton()
  renderPreviewNow()
  renderDrawerList()
}

/** 回到空态：删除当前文件、或别的标签页把它删了，都走这里 */
function closeCurrent() {
  state.editor?.destroy()
  state.editor = null
  state.current = null
  state.text = ''
  state.dirty = false
  draftAt = null
  state.locked = false
  state.snapshots = []
  lock.release()
  rememberTabFile(null)
  syncHash(null)
  el('editorHost').innerHTML = ''
  el('emptyState').hidden = false
  closePanel()
  refreshMeta()
  sb.setLanguage('—')
  sb.setLight(false)
  sb.setReadonly(false)
  updateDirtyDot()
  updateFormatButton()
}

/**
 * 多标签页：数据本来就是共享的 IndexedDB，这里只同步「列表」和「写锁」。
 * 别的标签页导入/删除文件时刷一下列表；它关掉正在编辑的文件时，本页解除只读。
 */
function wireTabs() {
  initTabs((e) => {
    if (e.removed && e.fileId && state.current?.id === e.fileId) {
      closeCurrent()
      renderDrawerList()
      toast(t('toast.tabDeleted'), 'error')
    }
    void refreshFiles()
    void refreshStorage()
  })

  lock.onFree((fileId) => {
    if (!state.locked || state.current?.id !== fileId) return
    state.locked = false
    // 只读是合成值：对方放开写锁后要按自身属性重算，不能沿用旧结果
    state.current.readOnly = state.current.readOnlyUser || state.mode === 'readonly'
    state.editor?.setReadOnly(state.current.readOnly)
    refreshMeta()
    toast(t('toast.tabFree'))
  })

  // 关页/切走时把写锁让出去，否则另一个标签页会一直卡在只读
  window.addEventListener('pagehide', () => lock.release())
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
  const lang: LangId = state.highlight ? langOf(rec) : 'text'

  const adapter = new Adapter()
  await adapter.mount(host, {
    value: text,
    language: lang,
    readOnly: rec.readOnly,
    wordWrap: full ? settings.wordWrap : false,
    theme: settings.theme,
    fontSize: settings.fontSize,
    onChange: (v) => {
      state.text = v
      state.dirty = true
      // 这一版内容还没进草稿，状态栏先别急着说「草稿已存」
      draftAt = null
      updateDirtyDot()
      sb.setCount(v)
      syncSizeBadge()
      schedulePreview()
      scheduleOutline()
      scheduleAutosave()
      updateFormatButton()
      findBar?.refresh()
    },
    onCursor: (line, col) => {
      cursorLine = line
      sb.setCursor(line, col)
      syncOutlineActive()
    },
    // 引擎内按下查找键，统一改用界面上的查找栏
    onFind: (replace) => findBar?.open({ replace }),
  })

  state.editor = adapter
  state.text = text
  state.dirty = rec.dirty
  // dirty 是从内容记录的 draft 标记还原的，草稿写入时间就是内容更新时间
  draftAt = rec.dirty ? rec.updatedAt : null
  if (offset) adapter.setOffset(offset)

  sb.setCount(text)
  syncEncodingBadge()
  sb.setEol(rec.eol)
  // 语言是文件本身的属性，只读大文件只是不解析，状态栏仍显示识别结果
  sb.setLanguage(LANG_LABELS[langOf(rec)])
  syncReadonlyBadge()
  sb.setLight(state.mode === 'light')
  sb.setCursor(1, 1)
  updateDirtyDot()
  updateEngineSeg()
}

/**
 * 语言判定（D-07）：语言在导入或手动指定时就已定值落库，运行时不做任何嗅探。
 * 手动 override 优先，否则直接用节点上的 lang。
 */
function langOf(rec: FileNode): LangId {
  return rec.langOverride ?? rec.lang
}

function currentLang(): LangId {
  const rec = state.current
  return rec ? langOf(rec) : 'text'
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
  // 纯文本没有语法可挂，徽标要说「无语法」而不是跟着开关假装在着色；
  // 当前引擎没收录这个语言时也一样，否则用户会以为颜色只是没刷出来
  const lang = rec ? langOf(rec) : 'text'
  const engineMissing =
    Boolean(rec) && lang !== 'text' && state.editor ? !state.editor.supportsLanguage(lang) : false
  const plain = !rec || lang === 'text' || engineMissing
  const hl = !state.highlight ? 'off' : plain ? 'na' : 'on'
  // 徽标上挂对方引擎的图标：一眼看出「不是没得救，是引擎不对」
  // 「无语法」必须一直露面，哪怕文件不大、开关是开着的：那不是「一切正常」，是这门语言在这侧没语法
  sb.setHighlight(
    hl,
    Boolean(rec) && (engineMissing || state.mode !== 'full' || !state.highlight),
    // 只有「无语法」才有换引擎这回事；开关被关掉时不该挂图标
    hl === 'na' ? altEngine(lang) : null,
  )
  syncReadonlyBadge()
  syncPanelButtons()
  syncDocActions()
  syncSizeBadge()
  syncEncodingBadge()
  if (!rec) {
    sb.setLanguage('—')
    return
  }
}

/** 右侧面板的两个入口：预览只对 Markdown 有意义，大纲任何文本文件都有 */
function syncPanelButtons() {
  const rec = state.current
  const md = Boolean(rec) && currentLang() === 'markdown'
  el('previewBtn').hidden = !md
  el('outlineBtn').hidden = !rec
  // 预览这一页在当前文件上不适用时，面板不收起、转到大纲：
  // 切个文件就把侧栏闪没，比留着它更烦
  if (state.rightTab === 'preview' && !md) state.rightTab = 'outline'
  syncPanelChrome()
  if (state.previewOpen) renderActivePanel()
}

/** 面板头标签与竖条高亮的唯一真相源 */
function syncPanelChrome() {
  const outline = state.rightTab === 'outline'
  const md = Boolean(state.current) && currentLang() === 'markdown'
  el('panelTabPreview').hidden = !md
  el('panelTabPreview').classList.toggle('is-active', !outline)
  el('panelTabOutline').classList.toggle('is-active', outline)
  el('previewBody').hidden = outline
  el('outlineBody').hidden = !outline
  // 打印只对着渲染后的 Markdown 有意义
  el('previewPrint').hidden = outline
  el('previewBtn').classList.toggle('is-active', state.previewOpen && !outline)
  el('outlineBtn').classList.toggle('is-active', state.previewOpen && outline)
}

function closePanel() {
  state.previewOpen = false
  el('rightPanel').classList.remove('is-open')
  syncPanelChrome()
  requestAnimationFrame(() => state.editor?.layout())
}

/** 右竖条的文档操作（加工、信息、两种对比）没文件就没有意义，空状态一并收起 */
function syncDocActions() {
  const has = Boolean(state.current)
  document.querySelectorAll<HTMLElement>('[data-doc-action]').forEach((b) => {
    b.hidden = !has
  })
}

/**
 * 状态栏只读徽标：大文件默认锁着防手滑，但永远允许点开强制编辑。
 * 三种成因行为不同（他页占用只能等、大文件点了就是解锁、手动锁是开关），
 * 徽标上要分别说清楚，否则同一个「只读」点了有时有效有时只弹报错。
 */
function syncReadonlyBadge() {
  const rec = state.current
  // 优先级按点击行为排：他页占用谈不上解锁，大文件点了永远是「解锁」
  const reason = state.locked ? 'locked' : state.mode === 'readonly' ? 'big' : 'manual'
  sb.setReadonly(
    Boolean(rec?.readOnly),
    Boolean(rec) && state.mode === 'readonly',
    Boolean(rec) && !state.locked,
    reason,
  )
}

function updateDirtyDot() {
  const rec = state.current
  el('dirtyDot').hidden = !state.dirty
  if (!rec) {
    sb.setSaved('idle')
    return
  }
  if (!state.dirty) {
    sb.setSaved('saved')
    return
  }
  // 大文件（>LIMITS.autosave）和只读文件不写草稿，改了就只在内存里
  if (rec.readOnly || rec.size > LIMITS.autosave) {
    sb.setSaved('nodraft')
    return
  }
  sb.setSaved(draftAt === null ? 'unsaved' : 'draft', draftAt ?? undefined)
}

function updateFormatButton() {
  const rec = state.current
  const lang = rec ? langOf(rec) : 'text'
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
  const blob = new Blob([state.text], { type: 'text/plain' })
  const size = encodeUtf8(state.text).byteLength
  const node = bumpContent(toNode(rec), size)

  rec.blob = blob
  rec.size = size
  rec.updatedAt = node.updatedAt
  rec.dirty = true
  // 首次内容变更即丢弃原始字节，单副本生命周期（D-16）
  delete rec.sourceEncoding

  // draft 标记跟着内容走：刷新后 toOpen 才敢把「未保存」原样还回来
  await store.putContent({ id: rec.id, blob, draft: true })
  await store.putNode(node)
  await refreshFiles()

  // 写的过程中切走了文件就别动状态栏，那是另一个文件的事
  if (state.current?.id !== rec.id) return
  draftAt = node.updatedAt
  updateDirtyDot()
  syncEncodingBadge()
}

/* ------------------------------------------------------------ 保存 */

/**
 * Ctrl/Cmd + S 只落库，不再直连磁盘（D-14）。
 * 导出到磁盘是独立的显式动作，避免「按个保存就多出一个下载文件」。
 */
async function saveFile() {
  const rec = state.current
  if (!rec) return

  const text = state.editor?.getValue() ?? state.text
  const blob = new Blob([text], { type: 'text/plain' })
  const size = encodeUtf8(text).byteLength

  try {
    const node = bumpContent(toNode(rec), size)
    // 整条覆盖写，顺带把 draft 标记清掉：这份内容现在是版本，不是草稿
    await store.putContent({ id: rec.id, blob })
    await store.putNode(node)
    await store.addSnapshot(rec.id, blob, 'save')

    rec.blob = blob
    rec.size = size
    rec.dirty = false
    rec.updatedAt = node.updatedAt
    delete rec.sourceEncoding

    state.dirty = false
    draftAt = null
    updateDirtyDot()
    refreshMeta()
    await refreshFiles()
    await refreshSnapshots()
    await refreshStorage()
    notifyFiles(rec.id)

    toast(t('toast.saved', { name: rec.name }))
  } catch (err) {
    toast(t('toast.saveFailed', { msg: (err as Error).message }), 'error')
  }
}

/* ------------------------------------------------------------ 导出 */

/**
 * 单文件导出（O16/O17）。
 * 库内一律 UTF-8，落盘也写 UTF-8；换行按节点的 eol 属性还原，
 * 让从 CRLF 文件进来的内容出去还是 CRLF，而不是被编辑器悄悄统一掉。
 * 取消保存不降级为下载，见 save.ts。
 */
async function exportCurrent(): Promise<void> {
  const rec = state.current
  if (!rec) return

  const text = state.editor?.getValue() ?? state.text
  const eolText = rec.eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n')
  try {
    const outcome = await saveAs(rec.name, encodeUtf8(eolText))
    if (outcome === 'cancelled') return
    toast(
      outcome === 'picker'
        ? t('toast.exported', { name: rec.name })
        : t('toast.exportedDownload', { name: rec.name }),
    )
  } catch (err) {
    toast(t('toast.saveFailed', { msg: (err as Error).message }), 'error')
  }
}

/**
 * 批量导出（O18~O22）：一个文件夹、多个选中项或整个库，都走同一条通路。
 * 先估算体积让用户确认，再开进度条；取消是协作式的，正在读的那一条读完才停。
 */
async function exportArchive(
  rootIds: string[],
  baseName: string,
  prefix = '',
  preservePaths = false,
): Promise<void> {
  const index = buildTree(state.files)
  const entries = preservePaths
    ? collectEntriesWithParents(index, rootIds)
    : collectEntries(index, rootIds, prefix)
  const fileCount = entries.filter((e) => e.kind === 'file').length
  if (!fileCount) {
    toast(t('toast.exportEmpty'), 'error')
    return
  }

  const res = await confirmDialog(
    t('confirm.exportTitle'),
    t('confirm.exportBody', { n: fileCount, size: formatBytes(estimateBytes(entries)) }),
  )
  if (!res.ok) return

  const body = document.createElement('div')
  const label = document.createElement('div')
  label.className = 'progress-note'
  label.textContent = t('progress.preparing')
  const bar = document.createElement('div')
  bar.className = 'progress'
  const fill = document.createElement('div')
  fill.className = 'progress-fill'
  bar.appendChild(fill)
  body.append(label, bar)

  const foot = document.createElement('div')
  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'btn btn-ghost'
  cancelBtn.textContent = t('action.cancel')
  foot.appendChild(cancelBtn)

  let cancelled = false
  const dlg = openDialog({
    title: t('dialog.exporting'),
    body,
    foot,
    narrow: true,
    onClose: () => {
      cancelled = true
    },
  })
  cancelBtn.onclick = () => {
    cancelled = true
    dlg.close()
  }

  const name = zipName(baseName)
  try {
    const result = await exportZip(index, {
      rootIds,
      fileName: name,
      prefix,
      preservePaths,
      isCancelled: () => cancelled,
      onProgress: (p) => {
        const ratio = p.total ? p.done / p.total : 1
        fill.style.width = `${Math.round(ratio * 100)}%`
        label.textContent = t('progress.exporting', { done: p.done, total: p.total, name: p.name })
      },
    })
    if (!cancelled) dlg.close()
    if (result.outcome === 'cancelled') return
    toast(
      result.outcome === 'picker'
        ? t('toast.zipped', { name, n: result.files })
        : t('toast.zippedDownload', { name, n: result.files }),
    )
  } catch (err) {
    dlg.close()
    toast(t('toast.exportFailed', { msg: (err as Error).message }), 'error')
  }
}

/** 单个文件夹导出，归档根就是它自己 */
function exportFolder(id: string): void {
  const node = state.files.find((n) => n.id === id)
  if (!node || node.kind !== 'folder') return
  void exportArchive([id], node.name)
}

/** 整库导出：根级全部节点，外面套一层带日期的目录，避免解压散一地 */
function exportLibrary(): void {
  const index = buildTree(state.files)
  const roots = index.roots.map((n) => n.id)
  if (!roots.length) {
    toast(t('toast.exportEmpty'), 'error')
    return
  }
  const stamp = zipName('vellum-export').replace(/\.zip$/, '')
  void exportArchive(roots, 'vellum-export', `${stamp}/`)
}

/* ------------------------------------------------------------ 引擎切换 */

/** 当前引擎能不能给这门语言上色 */
function engineHas(lang: LangId): boolean {
  return state.engineId === 'monaco' ? monoSupports(lang) : cmSupports(lang)
}

/** 只有一侧引擎有语法时返回那一侧；两侧都有（或都没有）返回 null */
function onlyEngineOf(lang: LangId): EngineId | null {
  const cm = cmSupports(lang)
  const mono = monoSupports(lang)
  return cm === mono ? null : cm ? 'cm' : 'monaco'
}

/**
 * 换到另一侧就能着色时返回那个引擎，否则 null。
 * 当前引擎本来就能着色（含纯文本）时也返回 null：否则「无语法」徽标会挂上
 * 另一个引擎的图标，看着像是引擎串了台（纯文本两边都能打开，没有换的必要）。
 */
function altEngine(lang: LangId): EngineId | null {
  if (engineHas(lang)) return null
  const other: EngineId = state.engineId === 'monaco' ? 'cm' : 'monaco'
  const ok = other === 'monaco' ? monoSupports(lang) : cmSupports(lang)
  return ok ? other : null
}

/**
 * 当前引擎没有这个语言的语法、另一侧有时，问一句要不要换过去。
 * 两个引擎是并集菜单：能看见的语言就一定有着色的办法，代价只是换引擎。
 * 返回 true 表示已经换好了。
 */
async function offerEngineSwitch(lang: LangId): Promise<boolean> {
  const other = altEngine(lang)
  if (!other) return false
  const res = await confirmDialog(
    `${LANG_LABELS[lang]} · ${ENGINE_NAMES[other]}`,
    t('confirm.switchEngine', { lang: LANG_LABELS[lang], engine: ENGINE_NAMES[other] }),
  )
  if (!res.ok) return false
  await switchEngine(other)
  toast(t('toast.engineSwitched', { engine: ENGINE_NAMES[other] }))
  return true
}

async function switchEngine(id: EngineId) {
  if (id === state.engineId) return
  if (state.current && state.mode !== 'full') {
    const res = await confirmDialog(
      `${ENGINE_NAMES[id]} · ${formatBytes(state.current.size)}`,
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
    await store.putNode(toNode(state.current))
  }

  const host = el('editorHost')
  host.style.opacity = '0.35'
  await mountEditor(value, offset)
  host.style.opacity = '1'
  // 空白页没有文件记录，mountEditor 会提前返回，分段控件得自己刷一次
  updateEngineSeg()
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

  // 大文件只读只是「防手滑」：解锁是本次会话的选择，不落库，重开仍按体积判定
  if (state.mode === 'readonly') {
    // 已经解开了就别再弹一句假的「已解除只读」
    if (!rec.readOnly) return
    rec.readOnly = false
    state.editor?.setReadOnly(false)
    refreshMeta()
    toast(t('toast.readonlyOffBig'))
    return
  }

  rec.readOnlyUser = !rec.readOnlyUser
  rec.readOnly = rec.readOnlyUser
  state.editor?.setReadOnly(rec.readOnly)
  refreshMeta()
  void store.putNode(toNode(rec))

  toast(t(rec.readOnlyUser ? 'toast.readonlyOn' : 'toast.readonlyOff'))
}

/* ------------------------------------------------------------ 编码 / 换行 */

function pickEncoding() {
  const rec = state.current
  if (!rec) return

  const wrap = document.createElement('div')
  wrap.className = 'toolbar-row'
  // 内容已规范化成 UTF-8，菜单里能选的只是「原始字节按哪种编码读」，所以高亮源编码
  const active = rec.sourceEncoding ?? 'utf-8'
  ;(Object.keys(ENCODING_LABELS) as (keyof typeof ENCODING_LABELS)[]).forEach((enc) => {
    const b = document.createElement('button')
    b.className = `btn${enc === active ? ' btn-primary' : ''}`
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

  const current = langOf(rec)
  const wrap = document.createElement('div')
  wrap.className = 'lang-picker'

  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'lang-search'
  search.placeholder = t('lang.search')
  wrap.appendChild(search)

  const auto = document.createElement('button')
  auto.className = `btn lang-auto${rec.langOverride === null ? ' btn-primary' : ''}`
  auto.textContent = t('lang.auto')
  auto.onclick = () => {
    dlg.close()
    void applyLanguage(null)
  }
  wrap.appendChild(auto)

  // 菜单是两个引擎的并集：先说清当前是哪一侧、能着色多少种，
  // 再解释后缀标记的含义，否则带标记的条目会让人以为是灰色不可用
  const here = state.engineId === 'monaco' ? monoSupports : cmSupports
  const note = document.createElement('div')
  note.className = 'lang-note'
  note.innerHTML = `${engineIcon(state.engineId)}<span>${t('lang.engineNote', {
    engine: ENGINE_NAMES[state.engineId],
    n: ALL_LANGS.filter((id) => here(id)).length,
  })}</span>`
  wrap.appendChild(note)

  const grid = document.createElement('div')
  grid.className = 'lang-grid'
  wrap.appendChild(grid)

  const empty = document.createElement('div')
  empty.className = 'lang-empty'
  empty.textContent = t('lang.noMatch')
  empty.hidden = true
  wrap.appendChild(empty)

  const dlg = openDialog({ title: t('dialog.language'), body: wrap, wide: true })

  // 选一个当前引擎上不了色的语言，先问一句要不要换引擎，点「确定」就连引擎带语言一起换
  const choose = async (id: LangId) => {
    if (id === 'text' || engineHas(id)) {
      await applyLanguage(id)
      return
    }
    if (await offerEngineSwitch(id)) await applyLanguage(id)
  }

  const item = (id: LangId, active: boolean) => {
    const b = document.createElement('button')
    b.className = `btn lang-item${active ? ' btn-primary' : ''}`
    b.dataset.kw = langKeywords(id)

    const name = document.createElement('span')
    name.className = 'lang-name'
    name.textContent = LANG_LABELS[id]
    b.appendChild(name)

    // 只有一侧引擎有语法时才挂标记；两侧都有就不必占用视线
    const only = onlyEngineOf(id)
    if (only) {
      b.insertAdjacentHTML(
        'beforeend',
        engineMark(only, t('lang.onlyEngine', { engine: ENGINE_NAMES[only] })),
      )
    }

    b.onclick = () => {
      dlg.close()
      void choose(id)
    }
    grid.appendChild(b)
  }

  // 「纯文本」永远排第一；其余按显示名首字母排。上百项靠滚动找，顺序必须可预期
  item('text', current === 'text')
  ALL_LANGS.filter((id) => id !== 'text')
    .sort((a, b) => LANG_LABELS[a].localeCompare(LANG_LABELS[b], 'en', { sensitivity: 'base' }))
    .forEach((id) => item(id, rec.langOverride === id && current === id))

  // 一百多个语言，靠滚动找太慢，边打边筛
  search.oninput = () => {
    const q = search.value.trim().toLowerCase()
    let shown = 0
    for (const b of grid.querySelectorAll('button')) {
      const hit = !q || (b.dataset.kw ?? '').includes(q)
      b.hidden = !hit
      if (hit) shown += 1
    }
    empty.hidden = shown > 0 || !q
  }
  search.focus()
}

/** next 为 null 表示回到自动（重新判定一次，结果仍落库定值，运行时零嗅探） */
async function applyLanguage(next: LangId | null) {
  const rec = state.current
  if (!rec || !state.editor) return

  rec.langOverride = next
  if (next === null) {
    const auto = autoLang(rec.name, state.editor.getValue())
    rec.lang = auto.lang
    rec.langSource = auto.source
  } else {
    rec.lang = next
    rec.langSource = 'manual'
  }
  await store.putNode(toNode(rec))

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

/**
 * 以另一种编码重新读取原始字节。内容本身已规范化成 UTF-8，这里只改「怎么读」。
 * 只有从未编辑过的文件才有原始字节，编辑过就没得回头了（D-16）。
 */
async function reDecode(enc: keyof typeof ENCODING_LABELS) {
  const rec = state.current
  if (!rec || !state.editor) return
  if (enc === (rec.sourceEncoding ?? 'utf-8')) return

  const bytes = state.rawBytes
  if (!bytes) {
    toast(t('toast.noRawBytes'), 'error')
    return
  }

  const text = decodeWith(bytes, enc)
  const eol = detectEol(text)
  if (enc === 'utf-8') delete rec.sourceEncoding
  else rec.sourceEncoding = enc
  rec.eol = eol
  rec.size = encodeUtf8(normalizeEol(text, eol)).byteLength
  await store.putNode(toNode(rec))

  state.editor.setValue(text)
  state.text = text
  state.dirty = true
  updateDirtyDot()
  syncEncodingBadge()
  sb.setEol(eol)
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
  await store.putNode(toNode(rec))
}

/* ------------------------------------------------------------ 格式化 / 加工 */

async function doFormat() {
  const rec = state.current
  if (!rec || !state.editor) return
  const lang = langOf(rec)
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
  if (!state.current) return
  const other = state.files.find((f) => f.id === id)
  if (!other || !isFile(other)) return
  const blob = await contentBlob(other, await store.getContent(id))
  diffDialog(other.name, blob ? await blob.text() : '', state.text)
}

/** 从「更多」菜单挑一个文件当基准 */
function diffWithFile() {
  const rec = state.current
  if (!rec) return

  const others = state.files
    .filter(isFile)
    .filter((f) => f.id !== rec.id && f.deletedAt === null)
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
    b.onclick = async () => {
      dlg.close()
      const blob = await contentBlob(f, await store.getContent(f.id))
      diffDialog(f.name, blob ? await blob.text() : '', state.text)
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
  state.files = await store.listNodes()
  // 回收站与文件树共用同一份 nodes 快照，两个页签都要跟着重绘
  if (state.drawerTab !== 'snapshots') renderDrawerList()
  syncDrawerFoot()
}

function renderDrawerList() {
  if (state.drawerTab === 'search') {
    renderSearchPane()
    return
  }

  const host = el('drawerList')

  if (state.drawerTab === 'snapshots') {
    renderSnapshotList(host, state.snapshots, {
      restore: (id) => void restoreSnapshot(id),
      compare: (id) => void compareSnapshot(id),
      remove: (id) => void removeSnapshot(id),
    })
    return
  }

  if (state.drawerTab === 'trash') {
    const items = trash.trashItems(state.files)
    const index = buildTree(state.files)
    renderTrashList(
      host,
      items,
      {
        restore: (id) => void restoreFromTrash(id),
        purge: (id) => void purgeFromTrash(id),
      },
      {
        childCount: (id) => state.files.filter((n) => n.parentId === id).length,
        pathOf: (id) => nodePath(index, id),
      },
    )
    return
  }

  renderTree(host, {
    index: buildTree(state.files),
    currentId: state.current?.id ?? null,
    expanded: state.expanded,
    // 搜索已经独立成页，文件树不再被搜索词过滤
    filter: '',
    renamingId: state.renamingId,
    dirtyId: state.dirty && state.current ? state.current.id : null,
    selection: state.selection,
    handlers: {
      open: (id) => void openRecord(id),
      toggle: (id) => toggleFolder(id),
      requestRename: (id) => beginRename(id),
      rename: (id, name) => commitRename(id, name),
      cancelRename: () => {
        state.renamingId = null
        renderDrawerList()
      },
      move: (id) => void moveDialog(id),
      trash: (id) => void trashNode(id),
      compare: (id) => void compareWithFile(id),
      exportNode: (id) => exportFolder(id),
      create: (parentId, kind) => void createNode(kind, parentId),
      select: (id, mode) => selectNode(id, mode),
      drop: (id, parentId) => void dropMove(id, parentId),
      openTab: (id) => void openFileInTab(id),
      elsewhere: (id) => probeOpenElsewhere(id),
    },
  })
}

/* -------------------------------------------------------- 树的增删改 */

function toggleFolder(id: string): void {
  if (state.expanded.has(id)) state.expanded.delete(id)
  else state.expanded.add(id)
  saveExpanded()
  clearSelection()
  renderDrawerList()
}

/* -------------------------------------------------------- 多选（§13.2） */

function clearSelection(): void {
  if (!state.selection.size && !state.anchor) return
  state.selection.clear()
  state.anchor = null
  syncDrawerFoot()
}

/** 同一父级下的兄弟 id，顺序与树一致：范围选择只在这个序列上取区间 */
function siblingIds(node: NodeRecord): string[] {
  const index = buildTree(state.files)
  const list = node.parentId ? index.children.get(node.parentId) ?? [] : index.roots
  return list.map((n) => n.id)
}

function selectNode(id: string, mode: 'toggle' | 'range'): void {
  const node = state.files.find((n) => n.id === id)
  if (!node) return

  if (mode === 'toggle') {
    if (state.selection.has(id)) state.selection.delete(id)
    else state.selection.add(id)
    state.anchor = id
  } else {
    const siblings = siblingIds(node)
    const from = state.anchor ? siblings.indexOf(state.anchor) : -1
    const to = siblings.indexOf(id)
    if (from < 0 || to < 0) {
      state.selection.add(id)
      state.anchor = id
    } else {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      for (let i = lo; i <= hi; i++) state.selection.add(siblings[i])
    }
  }

  syncDrawerFoot()
  renderDrawerList()
}

/**
 * Cmd/Ctrl+A 的语义：选中「当前这一层」的直接子项。
 * 基准取最后一次点过的行（anchor），没有就取当前文件；都没有就选根目录。
 */
function selectSiblings(): void {
  const index = buildTree(state.files)
  const base = (state.anchor ? index.byId.get(state.anchor) : undefined) ??
    (state.current ? index.byId.get(state.current.id) : undefined)
  const parentId = base?.parentId ?? null
  const list = parentId ? index.children.get(parentId) ?? [] : index.roots
  if (!list.length) return
  state.selection = new Set(list.map((n) => n.id))
  state.anchor = base?.id ?? list[0].id
  syncDrawerFoot()
  renderDrawerList()
}

/** 选中项里如果已经有父级，子项就不必单列，避免重复导出/重复删除 */
function topLevelSelection(): string[] {
  const index = buildTree(state.files)
  const ids = [...state.selection]
  return ids.filter((id) => {
    const node = index.byId.get(id)
    if (!node) return false
    let p = node.parentId
    while (p) {
      if (state.selection.has(p)) return false
      p = index.byId.get(p)?.parentId ?? null
    }
    return true
  })
}

function batchExport(): void {
  const ids = topLevelSelection()
  if (!ids.length) return
  const base =
    ids.length === 1 ? (state.files.find((n) => n.id === ids[0])?.name ?? 'export') : 'vellum-selection'
  // 多选保留各自相对库根的路径（O21），单选时父路径为空，等于没加前缀
  void exportArchive(ids, base, '', true)
}

async function batchTrash(): Promise<void> {
  const ids = topLevelSelection()
  if (!ids.length) return
  const res = await confirmDialog(
    t('confirm.trashTitle'),
    t('confirm.trashMany', { n: ids.length }),
  )
  if (!res.ok) return
  await trash.softDelete(ids)
  // 与单项删除同序：先广播，再关掉正好打开着的那个
  for (const id of ids) notifyFiles(id, true)
  if (state.current && ids.includes(state.current.id)) await closeCurrent()
  state.selection.clear()
  state.anchor = null
  await refreshFiles()
  toast(t('toast.trashedMany', { n: ids.length }))
}

async function batchClean(): Promise<void> {
  const ids = topLevelSelection().filter((id) => {
    const n = state.files.find((x) => x.id === id)
    return n?.kind === 'file' && n.size === 0
  })
  if (!ids.length) {
    toast(t('toast.noEmptyFiles'))
    return
  }
  await trash.softDelete(ids)
  for (const id of ids) notifyFiles(id, true)
  if (state.current && ids.includes(state.current.id)) await closeCurrent()
  state.selection.clear()
  state.anchor = null
  await refreshFiles()
  toast(t('toast.trashedMany', { n: ids.length }))
}

function batchMove(): void {
  const ids = topLevelSelection()
  if (!ids.length) return
  const index = buildTree(state.files)

  const targets: { id: string | null; label: string }[] = [{ id: null, label: t('dialog.moveRoot') }]
  for (const n of state.files) {
    if (!isFolder(n) || n.deletedAt !== null) continue
    if (state.selection.has(n.id)) continue
    if (!ids.every((id) => canMoveInto(index, id, n.id))) continue
    targets.push({ id: n.id, label: nodePath(index, n.id) })
  }

  const list = document.createElement('div')
  list.className = 'move-targets'
  const dlg = openDialog({ title: t('dialog.moveMany', { n: ids.length }), body: list, narrow: true })

  for (const tg of targets) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'btn'
    b.textContent = tg.label
    b.addEventListener('click', () => {
      dlg.close()
      void (async () => {
        let done = 0
        for (const id of ids) {
          // 单个失败不打断整批，最后统一报结果
          if (await doMove(id, tg.id, true)) done += 1
        }
        state.selection.clear()
        state.anchor = null
        await refreshFiles()
        if (!done) {
          toast(t('toast.moveInvalid'), 'error')
          return
        }
        const path = tg.id ? nodePath(buildTree(state.files), tg.id) : t('dialog.moveRoot')
        toast(t('toast.moved', { path }))
      })()
    })
    list.appendChild(b)
  }
}

function beginRename(id: string): void {
  state.renamingId = id
  renderDrawerList()
}

/** 新建落在哪一层：跟着当前文件走，否则放根目录 */
function targetParent(): string | null {
  const cur = state.current
  if (!cur) return null
  return state.files.find((n) => n.id === cur.id)?.parentId ?? null
}

function nameErrorKey(reason: 'empty' | 'chars' | 'length' | 'reserved') {
  if (reason === 'empty') return 'err.nameEmpty' as const
  if (reason === 'chars') return 'err.nameChars' as const
  if (reason === 'length') return 'err.nameLength' as const
  return 'err.nameReserved' as const
}

/** 新建后滚到可见处：抽屉刚展开 / 列表很长时，不定位就等于没有反馈（§6） */
function revealNode(id: string): void {
  const row = el('drawerList').querySelector<HTMLElement>(`.tree-row[data-id="${CSS.escape(id)}"]`)
  row?.scrollIntoView({ block: 'nearest' })
}

/**
 * 新建：先在屏幕中心问名字，再落库。
 * 早先是「先建好一个未命名、再在列表里就地改名」，但那个输入框只能靠 Esc/回车提交，
 * 看不见提示、期间还挡住整个列表不能切文件——改成对话框后，回车、Esc、点空白都能收尾，
 * 名字在创建前就问清楚，失败也不会在库里留下半成品。
 */
async function createNode(
  kind: 'file' | 'folder',
  parentId: string | null = targetParent(),
): Promise<void> {
  // 回到文件页并把选择归位：新节点要能出现在列表里
  state.drawerTab = 'files'
  state.renamingId = null
  clearSelection()
  syncLeftPanel()
  // 建完立刻进重命名，面板收着的话输入框根本看不见
  if (!drawer.isOpen) void drawer.show()

  const taken = takenNames(state.files, parentId)
  const prefix =
    kind === 'file' ? `${t('misc.untitled').replace(/\.\w+$/, '')}-` : `${t('misc.newFolder')}-`
  // 落到子文件夹时把位置写进提示：抽屉可能收着，光看名字看不出建在哪
  const where = parentId ? nodePath(buildTree(state.files), parentId) : ''
  const hint = where ? `${t('dialog.newWhere', { path: where })}\n${t('dialog.newHint')}` : t('dialog.newHint')

  const name = await promptDialog({
    title: kind === 'file' ? t('action.newFile') : t('action.newFolder'),
    value: nextUntitled(taken, prefix),
    hint,
    submitOnDismiss: true,
    validate: (raw) => {
      const valid = validateName(raw)
      if (!valid.ok) return t(nameErrorKey(valid.reason))
      // 重名挡在窗口里说明，而不是建完再悄悄加 (1)
      if (taken.has(normalizeName(valid.name))) return t('err.nameDuplicate')
      return null
    },
  })
  if (name === null) return

  // 后缀说了算：写 a.ts 就该按 TS 高亮，不再一律当纯文本
  const node =
    kind === 'file'
      ? createFileNode({
          name,
          parentId,
          lang: langFromName(name),
          langSource: 'ext',
          engine: state.engineId,
        })
      : createFolderNode(name, parentId)

  // 新建即落库（D-09），空文件不写 contents；之后再改内容才写
  await store.putNode(node)
  if (parentId) {
    state.expanded.add(parentId)
    saveExpanded()
  }
  await refreshFiles()

  if (kind === 'file') await openRecord(node.id)
  // 抽屉收着就别白scroll：看不见的定位没有意义
  if (drawer.isOpen) revealNode(node.id)
  toast(t('toast.created', { name: node.name }))
}

async function commitRename(id: string, raw: string): Promise<boolean> {
  const node = state.files.find((n) => n.id === id)
  if (!node) return false

  const valid = validateName(raw)
  if (!valid.ok) {
    toast(t(nameErrorKey(valid.reason)), 'error')
    state.renamingId = null
    renderDrawerList()
    return false
  }
  if (valid.name === node.name) {
    state.renamingId = null
    renderDrawerList()
    return true
  }

  const taken = takenNames(state.files, node.parentId, id)
  if (taken.has(normalizeName(valid.name))) {
    toast(t('err.nameDuplicate'), 'error')
    state.renamingId = null
    renderDrawerList()
    return false
  }

  const updated = applyName(node, valid.name)
  // 跨级同名只是软提示，不拦
  if (hasNameElsewhere(state.files, updated.nameKey, id)) toast(t('hint.nameElsewhere'))
  await store.putNode(updated)

  // 改的正好是打开中的文件：语言跟着新后缀重算（只算这一次，之后仍读定值）
  if (state.current?.id === id) {
    Object.assign(state.current, {
      name: updated.name,
      ext: updated.ext,
      nameKey: updated.nameKey,
    })
    const auto = autoLang(updated.name, state.text)
    state.current.lang = auto.lang
    state.current.langSource = auto.source
    state.current.langOverride = null
    await store.putNode(toNode(state.current))
    // 只换语言不重挂编辑器：重挂会丢掉撤销栈，也会把 dirty 标记冲掉
    if (state.highlight) state.editor?.setLanguage(currentLang())
    refreshMeta()
  }

  state.renamingId = null
  await refreshFiles()
  toast(t('toast.renamed', { name: updated.name }))
  return true
}

async function doMove(id: string, parentId: string | null, quiet = false): Promise<boolean> {
  const node = state.files.find((n) => n.id === id)
  if (!node) return false

  const index = buildTree(state.files)
  if (!canMoveInto(index, id, parentId)) {
    if (!quiet) toast(t('toast.moveInvalid'), 'error')
    return false
  }

  const taken = takenNames(state.files, parentId, id)
  const name = taken.has(node.nameKey) ? dedupeName(node.name, taken) : node.name
  await store.putNode(applyName({ ...node, parentId }, name))

  if (parentId) {
    state.expanded.add(parentId)
    saveExpanded()
  }
  if (state.current?.id === id) {
    state.current.parentId = parentId
    state.current.name = name
  }

  await refreshFiles()
  if (!quiet) {
    const path = parentId ? nodePath(buildTree(state.files), parentId) : t('dialog.moveRoot')
    toast(t('toast.moved', { path }))
  }
  return true
}

/**
 * 拖拽落点（P4）。拖的是选中项之一时整批一起走，只 toast 一次；
 * 目标就是当前父级时直接忽略，不产生「移到了原处」的噪音。
 */
async function dropMove(id: string, parentId: string | null): Promise<void> {
  const ids = state.selection.has(id) && state.selection.size > 1 ? topLevelSelection() : [id]
  const moving = ids.filter((each) => {
    const node = state.files.find((n) => n.id === each)
    return node && node.parentId !== parentId
  })
  if (!moving.length) return

  let done = 0
  for (const each of moving) {
    if (await doMove(each, parentId, true)) done += 1
  }
  if (!done) {
    toast(t('toast.moveInvalid'), 'error')
    return
  }

  state.selection.clear()
  state.anchor = null
  await refreshFiles()
  const path = parentId ? nodePath(buildTree(state.files), parentId) : t('dialog.moveRoot')
  toast(t('toast.moved', { path }))
}

function moveDialog(id: string): void {
  const node = state.files.find((n) => n.id === id)
  if (!node) return
  const index = buildTree(state.files)

  const targets: { id: string | null; label: string }[] = [
    { id: null, label: t('dialog.moveRoot') },
  ]
  for (const n of state.files) {
    if (!isFolder(n) || n.deletedAt !== null) continue
    if (!canMoveInto(index, id, n.id)) continue
    targets.push({ id: n.id, label: nodePath(index, n.id) })
  }

  const list = document.createElement('div')
  list.className = 'move-targets'
  const dlg = openDialog({
    title: t('dialog.move', { name: node.name }),
    body: list,
    narrow: true,
  })

  for (const tg of targets) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'btn'
    b.textContent = tg.label
    // 已经在这个父级下，移过去是空操作
    b.disabled = tg.id === node.parentId
    b.addEventListener('click', () => {
      dlg.close()
      void doMove(id, tg.id)
    })
    list.appendChild(b)
  }
}

async function trashNode(id: string): Promise<void> {
  const node = state.files.find((n) => n.id === id)
  if (!node) return

  const res = await confirmDialog(
    t('confirm.trashTitle'),
    node.kind === 'folder'
      ? t('confirm.trashFolderBody', { name: node.name })
      : t('confirm.trashBody', { name: node.name }),
  )
  if (!res.ok) return

  await trash.softDelete([id])
  // 先广播再收尾，避免其它标签页先收到「可以编辑了」又立刻被关闭
  notifyFiles(id, true)
  if (state.current?.id === id) closeCurrent()
  await refreshFiles()
  toast(t('toast.trashed', { name: node.name }))
}

async function restoreFromTrash(id: string): Promise<void> {
  const result = await trash.restore([id])
  await refreshFiles()
  if (!result.restored) return
  if (result.relocated.length) toast(t('toast.relocated', { name: result.relocated[0] }))
  else {
    const node = state.files.find((n) => n.id === id)
    toast(t('toast.restoredItem', { name: node?.name ?? '' }))
  }
}

/** 全部恢复：逐个走 restore，父级不在的照样落根 */
async function restoreAllFromTrash(): Promise<void> {
  const ids = trash.trashItems(state.files).map((n) => n.id)
  if (!ids.length) return
  const result = await trash.restore(ids)
  await refreshFiles()
  if (!result.restored) return
  if (result.relocated.length) toast(t('toast.restoredAllRelocated', { n: result.restored }))
  else toast(t('toast.restoredAll', { n: result.restored }))
}

/**
 * 物理删除后收尾（§9.2）：高亮偏好是按文件 id 记的，不清理就会一直留垃圾。
 * 标签页会话与写锁由 closeCurrent 负责，那里只在「删的正好是打开中的文件」时触发。
 */
async function forgetDeleted(ids: string[]): Promise<void> {
  if (!ids.length) return
  const prefs = await highlightPrefs()
  let changed = false
  for (const id of ids) {
    if (!(id in prefs)) continue
    delete prefs[id]
    changed = true
  }
  if (changed) await store.setMeta('highlightPrefs', prefs)
  if (state.current && ids.includes(state.current.id)) closeCurrent()
}

async function purgeFromTrash(id: string): Promise<void> {
  const node = state.files.find((n) => n.id === id)
  if (!node) return
  const res = await confirmDialog(
    t('confirm.purgeTitle'),
    t('confirm.purgeBody', { name: node.name }),
  )
  if (!res.ok) return

  const gone = await trash.purge([id])
  await forgetDeleted(gone)
  await refreshFiles()
  toast(t('toast.purged', { n: gone.length }))
}

async function emptyTrash(): Promise<void> {
  if (!trash.trashItems(state.files).length) return
  const res = await confirmDialog(t('confirm.emptyTrashTitle'), t('confirm.emptyTrashBody'))
  if (!res.ok) return

  const gone = await trash.emptyTrash()
  await forgetDeleted(gone)
  await refreshFiles()
  if (gone.length) toast(t('toast.trashEmptied'))
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
    [
      '',
      rec.sourceEncoding
        ? `${ENCODING_LABELS[rec.sourceEncoding]} → ${ENCODING_LABELS[rec.encoding]}`
        : ENCODING_LABELS[rec.encoding],
    ],
    ['', rec.eol.toUpperCase()],
    ['', LANG_LABELS[langOf(rec)]],
    ['', ENGINE_NAMES[state.engineId]],
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
const DRAWER_MIN = 200

/** 编辑区最小可读宽度；和 CSS 的 --editor-min-w 同源，改一处即可 */
function editorMinWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--editor-min-w')
  return Number.parseFloat(raw) || 420
}

/**
 * 「这一侧面板 + 编辑区」之外的所有固定占用：两条竖条、间距、另一侧面板。
 * 拖动时面板会脱离文档流，那时量不准，所以只在按下的一刻取一次。
 */
function chromeAround(side: 'drawer' | 'panel'): number {
  const body = el('body')
  const editor = el('editorIsland').getBoundingClientRect().width
  const self =
    side === 'drawer'
      ? el('drawer').getBoundingClientRect().width
      : el('rightPanel').getBoundingClientRect().width
  return Math.max(0, body.clientWidth - editor - self)
}

/**
 * 一侧面板的宽度上限。
 * 不再限制「最多能拖多宽」——想拉满慢慢看是合理需求，关面板有按钮；
 * 唯一的约束是编辑区不能被挤到 --editor-min-w 以下。
 */
function clampSideWidth(px: number, min: number, chrome: number): number {
  const room = el('body').clientWidth - chrome - editorMinWidth()
  const max = Math.max(min, room)
  return Math.min(max, Math.max(min, Math.round(px)))
}

function clampPanelWidth(px: number, chrome = chromeAround('panel')): number {
  return clampSideWidth(px, PANEL_MIN, chrome)
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

/** 抽屉和预览面板用同一套规则：上限只由编辑区最小宽度决定 */
function clampDrawerWidth(px: number, chrome = chromeAround('drawer')): number {
  return clampSideWidth(px, DRAWER_MIN, chrome)
}

/**
 * 落定抽屉宽度。面板宽度直接来自 drawer-w，改完必须补一次 layout，
 * 否则编辑器还按旧宽度绘制，右边会多出一截空白或者被裁掉。
 */
function applyDrawerWidth(px: number): number {
  const width = clampDrawerWidth(px)
  drawer.settle(width)
  return width
}

/** 抽屉水平方向的左右箭头：向右变宽，与拖动方向一致；Shift 加速 */
function wireDrawerResizer() {
  const handle = el('drawerResizer')

  handle.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (ev.button !== 0) return
    ev.preventDefault()
    // 别让抽屉把这次按下当成「点了列表空白」
    ev.stopPropagation()
    const startX = ev.clientX
    const startW = drawer.width
    // 按下时量一次固定占用：拖动过程中面板宽度在变，量出来会漂
    const chrome = chromeAround('drawer')
    let last = startW
    handle.setPointerCapture(ev.pointerId)
    handle.classList.add('is-dragging')
    document.body.classList.add('is-resizing')
    // 拖动时关掉宽度过渡，否则岛宽会滞后于指针
    el('drawer').classList.add('is-resizing')

    // 拖动阶段只改宽度和左边距，不主动 layout：每帧重排编辑器太贵
    const move = (e: PointerEvent) => {
      last = clampDrawerWidth(startW + (e.clientX - startX), chrome)
      drawer.setWidth(last)
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId)
      handle.classList.remove('is-dragging')
      document.body.classList.remove('is-resizing')
      el('drawer').classList.remove('is-resizing')
      updateSettings({ drawerWidth: applyDrawerWidth(last) })
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  })

  handle.addEventListener('dblclick', () => {
    updateSettings({ drawerWidth: applyDrawerWidth(DEFAULT_SETTINGS.drawerWidth) })
  })

  handle.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
    ev.preventDefault()
    const step = ev.shiftKey ? 40 : 8
    const width = applyDrawerWidth(drawer.width + (ev.key === 'ArrowRight' ? step : -step))
    updateSettings({ drawerWidth: width })
  })

  // 窗口变窄时按容器重算显示宽度，但不覆盖用户设定的值
  let raf = 0
  window.addEventListener('resize', () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      applyDrawerWidth(getSettings().drawerWidth)
    })
  })
}

function wirePanelResizer() {
  const panel = el('rightPanel')
  const handle = el('panelResizer')

  handle.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (ev.button !== 0) return
    ev.preventDefault()
    const startX = ev.clientX
    const startW = panel.getBoundingClientRect().width
    // 同抽屉：面板浮起来之后几何值不可信，固定占用只在按下时量
    const chrome = chromeAround('panel')
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
      panel.style.width = `${clampPanelWidth(startW - (e.clientX - startX), chrome)}px`
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

function togglePanel(tab: RightTab, force?: boolean) {
  const rec = state.current
  if (!rec) return
  if (tab === 'preview' && currentLang() !== 'markdown') {
    toast(t('toast.previewUnsupported'))
    return
  }
  // 再点当前这一页才是收起；点另一边是换页
  const want = force ?? !(state.previewOpen && state.rightTab === tab)
  state.rightTab = tab
  state.previewOpen = want
  el('rightPanel').classList.toggle('is-open', want)
  syncPanelChrome()
  if (want) renderActivePanel()
  requestAnimationFrame(() => state.editor?.layout())
}

/** 面板只有一页是可见的，切换/刷新都从这里走，免得两页抢着写 DOM */
function renderActivePanel() {
  if (!state.previewOpen) return
  if (state.rightTab === 'outline') {
    renderOutlineNow()
    return
  }
  if (currentLang() === 'markdown') renderPreviewNow()
}

let previewSeq = 0

function currentTheme(): 'dark' | 'light' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function renderPreviewNow() {
  if (!state.previewOpen || state.rightTab !== 'preview') return
  // 预览只画 Markdown：切到日志之类的文件时由 syncPanelButtons 转到大纲，
  // 别把几十 MB 文本丢给 marked
  if (currentLang() !== 'markdown') return
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
  if (!state.previewOpen || state.rightTab !== 'preview') return
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(renderPreviewNow, 250)
}

/* ---------------------------------------------------------------- 大纲 */

let outlineItems: OutlineItem[] = []
let outlineTimer = 0
/** 光标行，用来在大纲里标出「你在哪一节」 */
let cursorLine = 1

function renderOutlineNow() {
  const host = el('outlineBody')
  if (!state.current) {
    outlineItems = []
    host.replaceChildren()
    return
  }
  // 与轻量模式同一条线：这么大的文件扫结构不如直接用查找
  if (state.text.length > LIMITS.light) {
    outlineItems = []
    host.innerHTML = `<p class="outline-empty">${t('outline.tooBig')}</p>`
    return
  }
  outlineItems = extractOutline(state.text, currentLang())
  if (!outlineItems.length) {
    host.innerHTML = `<p class="outline-empty">${t('outline.empty')}</p>`
    return
  }
  const frag = document.createDocumentFragment()
  outlineItems.forEach((item, index) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'outline-item'
    btn.dataset.index = String(index)
    btn.style.paddingLeft = `${8 + (item.level - 1) * 12}px`
    btn.textContent = item.label
    btn.title = t('outline.line', { line: item.line })
    frag.append(btn)
  })
  host.replaceChildren(frag)
  syncOutlineActive()
}

function scheduleOutline() {
  if (!state.previewOpen || state.rightTab !== 'outline') return
  window.clearTimeout(outlineTimer)
  outlineTimer = window.setTimeout(renderOutlineNow, 350)
}

/** 标出光标所在条目；只在滚出可视范围时才滚动，否则每敲一个字整列都在抖 */
function syncOutlineActive() {
  if (!state.previewOpen || state.rightTab !== 'outline') return
  const host = el('outlineBody')
  const index = activeIndex(outlineItems, cursorLine)
  const nodes = host.querySelectorAll<HTMLElement>('.outline-item')
  nodes.forEach((node, i) => node.classList.toggle('is-active', i === index))
  const node = nodes[index]
  if (!node) return
  const top = node.offsetTop
  if (top < host.scrollTop || top + node.offsetHeight > host.scrollTop + host.clientHeight) {
    host.scrollTop = Math.max(0, top - host.clientHeight / 3)
  }
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

/**
 * 「焦点在抽屉里」判定：Ctrl/Cmd+A 只在此时拦截，绝不抢编辑器的全选。
 * 行本身不可聚焦，所以还得记住最后一次按下的位置在不在抽屉内；
 * 但只要焦点在输入框里，就一律让给输入框（搜索框里的全选、Esc 都归它）。
 */
let pointerInDrawer = false

function drawerHasKeys(): boolean {
  if (!drawer.isOpen) return false
  // 输入框 / 编辑器（含 CodeMirror、Monaco）里的按键一律归它们自己
  if (isTyping(document.activeElement)) return false
  const active = document.activeElement as HTMLElement | null
  if (active?.closest('#drawer')) return true
  return pointerInDrawer
}

/**
 * Esc 是否该收面板。
 * 与 drawerHasKeys() 的区别：搜索框里也算 —— 在面板里打字时按 Esc
 * 的预期是「退出这个面板」，而不是什么都不发生。
 */
function escTargetsDrawer(): boolean {
  if (!drawer.isOpen) return false
  if (!el('dialogLayer').hidden) return false
  if (document.querySelector('.tree-menu')) return false
  const active = document.activeElement as HTMLElement | null
  if (active?.closest('#drawer')) return true
  return pointerInDrawer
}

function wireKeyboard() {
  document.addEventListener(
    'pointerdown',
    (e) => {
      pointerInDrawer = Boolean((e.target as HTMLElement).closest('#drawer'))
    },
    true,
  )

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()

    // Cmd/Ctrl+A：抽屉里选中同层，编辑器里保持原生全选
    if (mod && !e.shiftKey && !e.altKey && key === 'a' && drawerHasKeys()) {
      if (state.drawerTab === 'files') {
        e.preventDefault()
        selectSiblings()
        return
      }
    }

    // F2：重命名当前文件，顺手把面板切到文件页并展开
    if (e.key === 'F2' && state.current && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      const id = state.current.id
      switchDrawerTab('files')
      void drawer.show().then(() => beginRename(id))
      return
    }

    if (mod && key === 's') {
      e.preventDefault()
      // Shift 才是「写到磁盘」，不给 Shift 就只落库
      void (e.shiftKey ? exportCurrent() : saveFile())
      return
    }
    if (mod && key === 'o') {
      e.preventDefault()
      void importFile()
      return
    }
    // Cmd/Ctrl+B：开关面板（图标栏的三个按钮都能再点一次收起，这里给键盘一条同样的路）
    if (mod && key === 'b') {
      e.preventDefault()
      void drawer.toggle()
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
    // 抽屉里的 Esc 先退选择，连按第二次才关抽屉——免得选了一半直接关掉
    if (e.key === 'Escape' && drawer.isOpen && state.selection.size > 0 && drawerHasKeys()) {
      e.preventDefault()
      clearSelection()
      renderDrawerList()
      return
    }
    if (e.key === 'Escape' && findBar?.isOpen()) {
      e.preventDefault()
      findBar.close()
      return
    }
    // 面板里的 Esc 收面板。放在查找之后，也只认「焦点/指针在面板里」——
    // 在编辑器里按 Esc 不该顺手把侧栏拆掉
    if (e.key === 'Escape' && escTargetsDrawer()) {
      void drawer.hide()
      return
    }
    if (e.key === '?' && !isTyping(e.target)) {
      e.preventDefault()
      helpDialog()
    }
  })
}

/* ---------------------------------------------------------------- 搜索 */

const SEARCH_NAME_LIMIT = 80
const SEARCH_ENTRY_LIMIT = 60
const SEARCH_HITS_PER_FILE = 5
/** 单次深搜的内容预算；超了就停，界面会说明只显示了一部分 */
const SEARCH_SCAN_BUDGET = 48 * 1024 * 1024
/** 一个字符的内容搜索命中太多，先让用户再打一个字 */
const SEARCH_MIN_DEEP = 2

let deepSearch = false
/** 允许扫超过 LIMITS.light 的文件；只有内容搜索才谈得上大小 */
let bigSearch = false
let searchSeq = 0
let searchTimer = 0
let searchScanning = false
let searchTruncated = false
let searchSkipped = 0
/** 手动模式：词或开关改过但还没跑，结果区先别拿上一轮的结果糊弄人 */
let searchStale = false
/** 一个文件一条：文件名命中的先排好，内容命中则往同一条里补片段 */
let searchEntries: SearchEntry[] = []
/** 扫描时按 id 找回已有的那条，避免同一个文件冒出两条 */
let searchIndex = new Map<string, SearchEntry>()
let searchScanned = 0
let searchTotal = 0

/** 换词或离开搜索页：让正在跑的扫描在下一圈自己停 */
function cancelSearch() {
  searchSeq += 1
  searchScanning = false
}

/** 任一项打开就切成手动触发：扫全库要几秒，边打字边扫连输入都会被拖住 */
function manualSearch(): boolean {
  return deepSearch || bigSearch
}

function scheduleSearch() {
  window.clearTimeout(searchTimer)
  if (manualSearch()) {
    cancelSearch()
    searchStale = true
    renderSearchPane()
    return
  }
  searchTimer = window.setTimeout(() => void runSearch(), 200)
}

function renderSearchPane() {
  const options = el('searchOptions')
  const optBtn = el('searchOptionsBtn')
  el('searchClear').hidden = state.search === ''
  el<HTMLInputElement>('searchDeep').checked = deepSearch
  el<HTMLInputElement>('searchBig').checked = bigSearch
  // 放大镜按钮只在开了设置时出现；词改过就点亮，提示该按了
  el('searchGo').hidden = !manualSearch()
  el('searchGo').classList.toggle('is-ready', searchStale)
  optBtn.classList.toggle('is-on', manualSearch() || !options.hidden)
  optBtn.setAttribute('aria-expanded', String(!options.hidden))
  renderSearchResults(
    el('searchResults'),
    {
      query: state.search.trim(),
      deep: deepSearch,
      stale: searchStale,
      scanning: searchScanning,
      scanned: searchScanned,
      total: searchTotal,
      truncated: searchTruncated,
      skipped: searchSkipped,
      entries: searchStale ? [] : searchEntries,
    },
    { open: (id, line) => void openRecord(id, line), reveal: revealSearchHit },
  )
}

async function runSearch() {
  const seq = (searchSeq += 1)
  window.clearTimeout(searchTimer)
  searchStale = false
  const query = state.search.trim()
  const index = buildTree(state.files)
  const lower = query.toLowerCase()

  // 文件名命中先按名字排好；内容命中的文件扫描时再往同一条里补片段
  searchEntries = query
    ? state.files
        .filter((n) => n.deletedAt === null && n.name.toLowerCase().includes(lower))
        .sort((a, b) => a.name.localeCompare(b.name, getLang()))
        .slice(0, SEARCH_NAME_LIMIT)
        .map((n) => ({
          id: n.id,
          name: n.name,
          path: nodePath(index, n.id),
          isFolder: n.kind === 'folder',
          nameHit: true,
          hits: [] as SearchContentHit[],
          more: 0,
        }))
    : []
  searchIndex = new Map(searchEntries.map((entry) => [entry.id, entry]))
  searchTruncated = false
  searchSkipped = 0
  searchScanning = false
  searchScanned = 0
  searchTotal = 0
  renderSearchPane()

  if (!deepSearch || query.length < SEARCH_MIN_DEEP) return
  searchScanning = true
  renderSearchPane()
  await scanContents(query, seq, index)
  if (seq !== searchSeq) return
  searchScanning = false
  renderSearchPane()
}

/**
 * 深度搜索：逐个内容记录读文本、按行匹配。
 * 三条硬边界——单文件超过轻量线上限跳过、总扫描量有预算、每个文件只列前几处；
 * 否则一次误搜就把整个库读一遍，抽屉还要渲染上千行。
 */
async function scanContents(query: string, seq: number, index: ReturnType<typeof buildTree>) {
  const lower = query.toLowerCase()
  const nodes = new Map(state.files.map((n) => [n.id, n]))
  const ids = await store.listContentIds()
  if (seq !== searchSeq) return

  searchTotal = ids.length
  // 先把手上有多少条告诉界面，进度才有个分母
  renderSearchPane()
  let budget = SEARCH_SCAN_BUDGET
  let drawn = 0
  let painted = 0

  for (const id of ids) {
    if (seq !== searchSeq) return
    searchScanned += 1

    const node = nodes.get(id)
    if (!node || node.kind !== 'file' || node.deletedAt !== null) continue
    // 大文件默认跳过：2MB 以上的正文读进来就是几十万行，开了设置才扫
    if (!bigSearch && node.size > LIMITS.light) {
      searchSkipped += 1
      continue
    }
    if (budget <= 0) {
      searchTruncated = true
      break
    }

    const content = await store.getContent(id)
    const blob = content ? await contentBlob(node, content) : null
    // 读盘期间用户可能已经换了词，别把上一轮的结果写进新列表
    if (seq !== searchSeq) return
    if (!blob) continue
    budget -= node.size

    const hits: SearchContentHit[] = []
    let more = 0
    const lines = (await blob.text()).split('\n')
    if (seq !== searchSeq) return
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].toLowerCase().includes(lower)) continue
      if (hits.length < SEARCH_HITS_PER_FILE) hits.push({ line: i + 1, text: lines[i] })
      else more += 1
    }
    if (!hits.length && !more) continue

    // 名字已经命中的文件不再新开一条：片段挂到它下面
    const known = searchIndex.get(id)
    if (known) {
      known.hits = hits
      known.more = more
    } else if (searchEntries.length < SEARCH_ENTRY_LIMIT) {
      const entry: SearchEntry = {
        id,
        name: node.name,
        path: nodePath(index, id),
        isFolder: false,
        nameHit: false,
        hits,
        more,
      }
      searchIndex.set(id, entry)
      searchEntries.push(entry)
    } else {
      searchTruncated = true
      break
    }
    drawn += 1

    // 边扫边画：大库要几秒，白屏等着很难受。每三个命中刷一次；
    // 一直没有命中时进度数字也别僵着，扫过 20 条也刷一次
    if (drawn % 3 === 0 || searchScanned - painted >= 20) {
      painted = searchScanned
      renderSearchPane()
    }
  }
}

/** 命中的是文件夹：切回文件页、展开祖先再定位 —— 搜索页里没有树可展开 */
function revealSearchHit(id: string) {
  switchDrawerTab('files')
  let parent = state.files.find((n) => n.id === id)?.parentId ?? null
  while (parent) {
    state.expanded.add(parent)
    parent = state.files.find((n) => n.id === parent)?.parentId ?? null
  }
  saveExpanded()
  renderDrawerList()
  revealNode(id)
}

/** Cmd/Ctrl+P：直接落到搜索页并聚焦输入框，比在文件树里翻快得多 */
function openQuickSwitch() {
  switchDrawerTab('search')
  el('searchOptions').hidden = true
  void drawer.show().then(() => {
    const input = el<HTMLInputElement>('searchInput')
    input.focus()
    input.select()
  })
}

/* ------------------------------------------------------------ 拖拽导入 */

function wireDropZone() {
  const overlay = el('dropOverlay')
  let depth = 0

  /** 只有真的带着文件的拖拽才接管，页内拖文字不受影响 */
  const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

  /**
   * 一律挂在捕获阶段：子元素（编辑器、树、抽屉）谁把事件拦在半路都不会影响导入。
   *
   * dragenter 也必须 preventDefault —— Safari 只认这一下，
   * 否则光标是「禁止」，drop 压根不派发，表现就是覆盖层亮了一下、松手却什么都没发生。
   */
  window.addEventListener(
    'dragenter',
    (e) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      depth += 1
      overlay.hidden = false
    },
    true,
  )

  window.addEventListener(
    'dragover',
    (e) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    },
    true,
  )

  window.addEventListener(
    'dragleave',
    () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) overlay.hidden = true
    },
    true,
  )

  window.addEventListener(
    'drop',
    (e) => {
      const dt = e.dataTransfer
      // 这里不看 types 只看有没有真文件：某些环境 types 会漏报，
      // 一旦漏报就该按「读到什么算什么」处理，而不是把这次拖拽丢掉
      const hasFile =
        (dt?.files?.length ?? 0) > 0 || Array.from(dt?.items ?? []).some((i) => i.kind === 'file')
      if (!hasFile) return
      e.preventDefault()
      depth = 0
      overlay.hidden = true

      // 从 Finder / 资源管理器拖文件夹进来时，files 里会有一个 0 字节的伪文件，
      // 照着导入只会得到一个空文件；说清楚比默默吞掉好
      const entry = Array.from(dt?.items ?? [])
        .find((i) => i.kind === 'file')
        ?.webkitGetAsEntry?.()
      if (entry?.isDirectory) {
        toast(t('toast.dropFolder'), 'error')
        return
      }

      // 少数环境下 files 是空的，只能从 items 里取
      const file = dt?.files?.[0] ?? dt?.items?.[0]?.getAsFile() ?? null
      if (!file) {
        toast(t('toast.dropEmpty'), 'error')
        return
      }
      // 导入失败要出声，别再出现「松手之后什么都没有」
      void ingestFile(file).catch((err) => {
        toast(t('toast.readFailed', { msg: (err as Error).message }), 'error')
      })
    },
    true,
  )

  el<HTMLInputElement>('filePicker').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) void ingestFile(file)
    input.value = ''
  })
}
