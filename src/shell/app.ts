import { applyStaticText, getLang, initLang, onLangChange, setLang, t, type MessageKey } from '../i18n'
import { CodeMirrorAdapter } from '../editors/codemirror'
import type { EditorAdapter } from '../editors/adapter'
import { destroyMindmap, renderMindmap } from '../ui/mindmap'
import { parseDeck, type DeckPage } from '../ui/slides/deck'
import { renderDeckHtml, playerPlaceholder, type PlayerPage } from '../ui/slides/player'
import { deckTemplate, specCheck, specDetail, specMarkdown } from '../ui/slides/spec'
import { destroyDeck, renderDeck } from '../ui/slides/view'
import { activeIndex, extractOutline, type OutlineItem } from '../ui/outline'
import { isMarkdownLike, supportsDocView } from '../doc-views'
import {
  activateBinding,
  activeContentId,
  closeSlot,
  contentById,
  createContent,
  refreshChrome,
  registerBinding,
  registerSlot,
  showContent,
} from './panel-view'
import { DIAG_VERSION, MAX_TEXT, analyze, contentHash } from '../diagnostics'
import { enabledMdRules } from '../diagnostics/providers/mdLint'
import { dictFailed, ensureDict, onDictFailed, onDictReady } from '../diagnostics/dict'
import { availabilityFor, dominantReason, enabledChecks, hasRunnable } from '../diagnostics/registry'
import {
  DEFAULT_CHECKS,
  checksMask,
  toRendered,
  type CheckKind,
  type ChecksSettings,
  type Issue,
} from '../diagnostics/types'
import {
  isAiChatReady,
  newAiSession,
  openAiHistory,
  openAiWorkspaces,
  relabelAiPanel,
  renderAiPanel,
} from '../ui/ai-panel'
import type { DocStat } from './ai/context'
import type { DocHost } from './ai/tools'
import { renderIssues, type IssuesPhase } from '../ui/issues'
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
import { downloadBlob, pickFile, saveAs } from './save'
import { isPreviewableImage, mimeForName } from './asset'
import { runScript as runInSandbox } from './ai/sandbox'
import { addGrant, createWorkspace, removeGrant, workspaceById } from './ai/grants'
import { clearWorkspace, sessionStatsByWorkspace, workspaceChatUsage, workspaceChatStats } from './ai/session'
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
import { trackViewportHeight } from '../ui/viewport'
import { applyTheme } from '../ui/theme'
import { toast } from '../ui/toast'
import { createPrefetcher, ringOffset, type PrefetchProgress } from './prefetch'
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
  closeNewItemMenu,
  confirmDialog,
  diffDialog,
  helpDialog,
  newItemMenuDialog,
  openDialog,
  pasteImportDialog,
  promptDialog,
  toolsDialog,
  transformsDialog,
  urlImportDialog,
} from '../ui/dialogs'
import { DEFAULT_SETTINGS } from '../types'
import type {
  ContentRecord,
  EngineId,
  FileMode,
  FileNode,
  FolderNode,
  NodeRecord,
  OpenFile,
  SnapshotRecord,
} from '../types'

export const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T

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
  /** 抽屉里已展开的文件夹 id，持久化在 localStorage */
  expanded: Set<string>
  /** 正在内联重命名的节点 id */
  renamingId: string | null
  search: string
  rawBytes: ArrayBuffer | null
  encodingConfirmed: boolean
  /** 右侧面板是否展开（名字沿用老代码：它管的就是这个面板） */
  previewOpen: boolean
}

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
  expanded: new Set<string>(readExpanded()),
  renamingId: null,
  search: '',
  rawBytes: null,
  encodingConfirmed: false,
  previewOpen: false,
}

/* --------------------------------------------------------- 右侧面板内容 */

/**
 * 内容只声明自己的标题、头部按钮和渲染入口，不持有任何容器引用。
 * 挂到哪个槽位由 startApp 里的绑定决定（plans/panel-registry.md）。
 */
const previewContent = createContent({
  id: 'preview',
  titleKey: 'panel.preview',
  className: 'markdown-body',
  rootId: 'previewBody',
  actions: ['previewPrint'],
  render: () => renderPreviewInto(previewContent.root),
})

const outlineContent = createContent({
  id: 'outline',
  titleKey: 'panel.outline',
  className: 'outline-body',
  rootId: 'outlineBody',
  render: () => renderOutlineInto(outlineContent.root),
})

const issuesContent = createContent({
  id: 'issues',
  titleKey: 'panel.issues',
  className: 'issues-body',
  rootId: 'issuesBody',
  actions: ['issuesOptions'],
  actionsVisible: () => Boolean(state.current),
  render: () => renderIssuesPanel(issuesContent.root),
})

/**
 * 导图和预览同源：都读 state.text，只是画法不同。
 * 布局/连线/缩放交给 markmap 引擎，关面板时要把实例拆掉（d3-zoom 的监听挂在 svg 上）。
 */
const mindmapContent = createContent({
  id: 'mindmap',
  titleKey: 'panel.mindmap',
  className: 'mindmap-body',
  rootId: 'mindmapBody',
  render: () => renderMindmapInto(mindmapContent.root),
  onUnmount: () => destroyMindmap(mindmapContent.root),
})

/**
 * 幻灯片：同一份文本的第三种画法。分页由 remark 的词法器决定，
 * 每页内容仍走 renderMarkdown —— 面板、打印、放映看到的是同一个渲染结果。
 * 页面列表靠 IntersectionObserver 惰性渲染，关面板时要拆掉观察者与拖拽监听。
 */
const pptContent = createContent({
  id: 'ppt',
  titleKey: 'panel.ppt',
  className: 'deck-body',
  rootId: 'deckBody',
  // 放映 / 导出 / 语法速查都只属于这一视图；
  // 速查页正文就是 `spec.ts` 的速查页，与新建模板、AI 说明同源
  actions: ['deckOpen', 'deckExport', 'deckHelp'],
  render: () => renderDeckInto(pptContent.root),
  onUnmount: () => destroyDeck(pptContent.root),
})

/**
 * AI 面板：唯一一个「不读 state.text」的右侧内容 —— 凭据库与当前文件无关，
 * 所以它不带 `data-doc-action`，没有文件时也点得开（plans/ai-assistant.md §14.5）。
 */
const aiContent = createContent({
  id: 'ai',
  titleKey: 'panel.ai',
  className: 'ai-body',
  rootId: 'aiBody',
  // 会话按**工作区**落库（v3 W-01），但「当前文件」仍要递给面板：读写票、选区、
  // 光标都属于当前文件。用 getter 而不是存快照，流式期间切走文件时读到的是最新那个
  render: () =>
    renderAiPanel(aiContent.root, aiTarget, aiDocHost, () => refreshChrome('right')),
  // 新建 / 历史两颗按钮在**标题栏**（跟预览的打印、检查的筛选同一位置），
  // 不画在会话话题旁边 —— 那里是内容，不是面板 chrome
  actions: ['aiWorkspace', 'aiNew', 'aiHistory'],
  // 没解锁时对话区根本不存在，两颗点了没反应的图标比没有更糟
  actionsVisible: () => isAiChatReady(),
})

/**
 * 面板眼里的「当前文件」。
 *
 * 副本上要**回指原文**：AI 第一次写就建副本并打开它，如果这里返回副本自己的 id，
 * 文件票据（读写票、选区）就会指向副本，用户看到的选区与 AI 读到的内容对不上。
 * 同一个工作区里切文件不换会话，所以这里只管文件通道，不再影响会话归属。
 */
function aiTarget(): { id: string; name: string } | null {
  const file = state.current
  if (!file) return null
  if (file.aiCopy) {
    const source = state.files.find((node) => node.id === file.aiCopy?.sourceId)
    if (source && source.kind === 'file' && source.deletedAt === null) {
      return { id: source.id, name: source.name }
    }
  }
  return { id: file.id, name: file.name }
}

/* --------------------------------------------------- AI 的文档读写接口 */

/**
 * 文档版本号：任何一次内容变更（用户敲键或 AI 写入）都自增。
 *
 * 它是 AI 读票的「快路径」：票上的 rev 等于当前 rev，说明读完之后没人动过，
 * 不必逐字比对；不等就走慢路径，比那一段原文还在不在。
 */
let docRev = 0

/** 当前文件的状态。AI 只看这个，不看界面上还有什么 */
function aiDocStat(): DocStat | null {
  const file = state.current
  if (!file) return null
  const text = state.text
  let selection: { from: number; to: number } | null = null
  try {
    const range = state.editor?.searchApi().getSelection()
    if (range && range.to > range.from) selection = { from: range.from, to: range.to }
  } catch {
    // 编辑器正处在重建中：当成没有选区，别把整段对话挡在这里
    selection = null
  }
  return {
    fileId: file.id,
    fileName: file.name,
    // 空文件也算 1 行：否则 read_doc 的任何行号都会被判越界
    totalLines: Math.max(1, text.split('\n').length),
    totalBytes: state.dirty ? encodeUtf8(text).byteLength : file.size,
    readOnly: file.readOnly,
    isCopy: Boolean(file.aiCopy),
    copySourceId: file.aiCopy?.sourceId ?? null,
    cursor: { line: cursorLine, col: cursorCol },
    selection,
  }
}

/**
 * AI 写文档的**唯一入口**。
 *
 * 必须是唯一入口：绕过它直接改 `state.text` 会漏掉草稿、预览、诊断、状态栏、
 * 格式按钮……每漏一项就是一个「AI 改完但界面没跟上」的 bug。
 */
async function aiDocWrite(next: string): Promise<void> {
  const file = state.current
  if (!file) throw new Error('no-file')
  if (next === state.text) return

  docRev += 1
  if (state.editor) state.editor.setValue(next)
  state.text = next
  state.dirty = true
  draftAt = null
  updateDirtyDot()
  sb.setCount(next)
  syncSizeBadge()
  schedulePreview()
  scheduleOutline()
  scheduleDiagnostics()
  scheduleAutosave()
  updateFormatButton()
  findBar?.refresh()
  // 立刻落草稿：AI 一轮改完用户随手刷新，不能只活在内存里
  await persistDraft()
}

/**
 * 给当前工作区建一份 AI 副本并打开（§8 懒创建）。
 *
 * 同一工作区只建一份：连着两轮改不该每轮多一个文件。已有的副本直接打开。
 * v3（W-03）起归属是工作区而不是会话：换会话继续改同一个文件，复用的是同一份副本。
 */
async function aiDocCreateCopy(workspaceId: string): Promise<{ id: string; name: string }> {
  const source = state.current
  if (!source) throw new Error('no-file')

  const existing = state.files.find(
    (node) =>
      node.kind === 'file' &&
      node.deletedAt === null &&
      node.id !== source.id &&
      node.aiCopy?.workspaceId === workspaceId &&
      node.aiCopy?.sourceId === source.id,
  )
  if (existing) {
    await openRecord(existing.id)
    return { id: existing.id, name: existing.name }
  }

  const dot = source.name.lastIndexOf('.')
  const stem = dot > 0 ? source.name.slice(0, dot) : source.name
  const ext = dot > 0 ? source.name.slice(dot) : ''
  const name = dedupeName(
    `${stem}${t('ai.copyName', { name: '' })}${ext}`,
    takenNames(state.files, source.parentId),
  )
  const text = state.text
  const node = createFileNode({
    name,
    parentId: source.parentId,
    lang: source.lang,
    langSource: source.langSource,
    encoding: 'utf-8',
    eol: source.eol,
    engine: state.engineId,
    size: encodeUtf8(text).byteLength,
  })
  node.aiCopy = { workspaceId, sourceId: source.id, createdAt: Date.now() }

  await store.putNode(node)
  await store.putContent({ id: node.id, blob: new Blob([text], { type: 'text/plain' }) })
  await refreshFiles()
  await openRecord(node.id)
  if (!state.current || state.current.id !== node.id) throw new Error('copy-not-open')
  return { id: node.id, name: node.name }
}

/** AI 面板拿到的全部文档能力（L5 边界，不多给一个字段） */
const aiDocHost: DocHost = {
  stat: aiDocStat,
  text: () => state.text,
  rev: () => docRev,
  createCopy: aiDocCreateCopy,
  write: aiDocWrite,
  deckSpec: aiDeckSpec,
  workspace: (id) => aiWorkspaceView(id),
  listWorkspaces: aiWorkspaceList,
  createWorkspace: createAiWorkspace,
  workspaceOf: aiWorkspaceOf,
  readNodeText: aiReadNodeText,
  revokeGrant: (refId, workspaceId) => revokeFromAi(refId, workspaceId),
  grantRef: aiAutoReference,
  copyNode: aiCopyNode,
  readProjectFile: aiReadProjectFile,
  writeNodeText: aiWriteNodeText,
  createProjectNode: aiCreateProjectNode,
  deleteProjectNode: aiDeleteProjectNode,
  moveProjectNode: aiMoveProjectNode,
  createProjectAsset: aiCreateProjectAsset,
  writeNodeBytes: aiWriteNodeBytes,
  runScript: aiRunScript,
}

/**
 * `read_deck_spec` 的正文：只有当前文档**已经在按页组织**时才给规格。
 *
 * 没有文档级别的声明了，判据换成「至少有一处分页」（≥2 页）：普通 Markdown
 * 里没有 `---` 分页时不该让模型照着幻灯片语法往里加分页线；已经分了页的文档，
 * 模型确实需要知道页属性与备注怎么写。
 */
function aiDeckSpec(): string | null {
  if (!supportsDocView(currentLang(), 'ppt')) return null
  if (parseDeck(state.text).pages.length < 2) return null
  return specDetail()
}

/** grep 用：文本文件的规范 UTF-8 文本；二进制资产与无内容的节点返回 null */
async function aiReadNodeText(id: string): Promise<string | null> {
  const node = state.files.find((n) => n.id === id)
  if (!node || node.kind !== 'file' || node.asset) return null
  const content = await store.getContent(id)
  const blob = await contentBlob(node, content)
  return blob ? blob.text() : ''
}

/**
 * cp：把源文本复制成目标文件夹下的新文件（只新建，源节点不动）。
 * 同名自动 dedupe（a.txt -> a(1).txt）；新节点带 aiCopy 标记，记录来源工作区。
 */
async function aiCopyNode(
  fromId: string,
  toFolderId: string,
  workspaceId: string,
): Promise<{ id: string; name: string }> {
  const source = state.files.find((n) => n.id === fromId)
  if (!source || source.kind !== 'file') throw new Error('bad-source')
  const text = (await aiReadNodeText(fromId)) ?? ''
  const name = dedupeName(source.name, takenNames(state.files, toFolderId))
  const node = createFileNode({
    name,
    parentId: toFolderId,
    lang: source.lang,
    langSource: source.langSource,
    engine: source.engine,
    size: encodeUtf8(text).byteLength,
  })
  node.aiCopy = { workspaceId, sourceId: source.id, createdAt: Date.now() }

  await store.putNode(node)
  await store.putContent({ id: node.id, blob: new Blob([text], { type: 'text/plain' }) })
  await refreshFiles()
  return { id: node.id, name: node.name }
}

/* ------------------------------------------------------- S4 项目读写（headless） */
// 这些函数只做落库，不弹窗、不 toast、不碰「当前打开文件」的编辑器状态。
// 权限（checkWrite）、读票、额度都由 tools.ts 判完才调到这里（L5 边界）。

/** 按 id 读项目文本文件；rev 用节点 updatedAt（内容变更会 bump） */
async function aiReadProjectFile(id: string): Promise<{ text: string; rev: number } | null> {
  const node = state.files.find((n) => n.id === id)
  if (!node || node.kind !== 'file' || node.asset) return null
  const content = await store.getContent(id)
  const blob = await contentBlob(node, content)
  return { text: blob ? await blob.text() : '', rev: node.updatedAt }
}

/**
 * 按 id 写项目文本。若该文件正好是当前打开的，走 aiDocWrite 以同步编辑器/草稿/诊断；
 * 否则直接落 store 并刷新文件树。两种路径都 bump 节点 updatedAt 作为新 rev。
 */
async function aiWriteNodeText(id: string, text: string): Promise<{ lines: number; rev: number }> {
  const node = state.files.find((n) => n.id === id)
  if (!node || node.kind !== 'file') throw new Error('node-not-found')
  const rev = Date.now()
  const size = encodeUtf8(text).byteLength
  await store.putNode(bumpContent(node as FileNode, size, rev))
  await store.putContent({ id, blob: new Blob([text], { type: 'text/plain' }) })
  if (state.current?.id === id) {
    // 打开中的文件：让编辑器/预览/草稿跟上（aiDocWrite 内部会 setValue + persistDraft）
    docRev += 1
    if (state.editor) state.editor.setValue(text)
    state.text = text
    state.dirty = true
    await persistDraft()
  }
  await refreshFiles()
  return { lines: text.split('\n').length, rev }
}

/** 在 proj 文件夹下建节点；同名自动 dedupe。空文件不写 contents */
async function aiCreateProjectNode(
  parentId: string,
  kind: 'file' | 'folder',
  name: string,
): Promise<{ id: string; name: string }> {
  const taken = takenNames(state.files, parentId)
  const finalName = taken.has(normalizeName(name)) ? dedupeName(name, taken) : name
  const node =
    kind === 'file'
      ? createFileNode({
          name: finalName,
          parentId,
          lang: langFromName(finalName),
          langSource: 'ext',
          engine: state.engineId,
        })
      : createFolderNode(finalName, parentId)
  await store.putNode(node)
  state.expanded.add(parentId)
  saveExpanded()
  await refreshFiles()
  return { id: node.id, name: node.name }
}

/** 软删除 proj 内节点：只标顶层 deletedAt，不物理删（可恢复） */
async function aiDeleteProjectNode(id: string): Promise<void> {
  await trash.softDelete([id])
  notifyFiles(id, true)
  await refreshFiles()
}

/** 移动/改名 proj 内节点；非法移动抛错由 tools 层转成 tool_failed */
async function aiMoveProjectNode(
  id: string,
  parentId: string,
  name?: string,
): Promise<{ name: string; parentId: string }> {
  const node = state.files.find((n) => n.id === id)
  if (!node) throw new Error('node-not-found')
  const index = buildTree(state.files)
  if (!canMoveInto(index, id, parentId)) throw new Error('illegal-move')
  const taken = takenNames(state.files, parentId, id)
  const desired = name ?? node.name
  const finalName = taken.has(normalizeName(desired)) ? dedupeName(desired, taken) : desired
  const next = applyName({ ...node, parentId }, finalName)
  await store.putNode(next)
  state.expanded.add(parentId)
  saveExpanded()
  await refreshFiles()
  return { name: finalName, parentId }
}

/**
 * 在 proj 文件夹下新建二进制资产（P-10：AI 用 base64 写出的图/包）。
 * 只落 Blob + `asset` 标记，不进编辑器；父级不存在抛错由 tools 层转 tool_failed。
 */
async function aiCreateProjectAsset(
  parentId: string,
  name: string,
  bytes: Uint8Array,
  mime: string,
): Promise<{ id: string; name: string; rev: number }> {
  const parent = state.files.find((n) => n.id === parentId)
  if (!parent || parent.kind !== 'folder' || parent.deletedAt !== null) throw new Error('bad-parent')
  const taken = takenNames(state.files, parentId)
  const finalName = taken.has(normalizeName(name)) ? dedupeName(name, taken) : name
  const node = createFileNode({
    name: finalName,
    parentId,
    lang: 'text',
    langSource: 'ext',
    engine: state.engineId,
    size: bytes.byteLength,
    asset: { mime },
  })
  await store.putNode(node)
  await store.putContent({ id: node.id, blob: new Blob([bytes as unknown as BlobPart], { type: mime }) })
  state.expanded.add(parentId)
  saveExpanded()
  await refreshFiles()
  return { id: node.id, name: node.name, rev: node.updatedAt }
}

/** 覆盖已有二进制资产的内容；节点一旦失去 `asset` 标记就拒绝（避免把资产写成文本） */
async function aiWriteNodeBytes(id: string, bytes: Uint8Array, mime: string): Promise<{ rev: number }> {
  const node = state.files.find((n) => n.id === id)
  if (!node || node.kind !== 'file' || !node.asset) throw new Error('not-asset')
  const rev = Date.now()
  const { sourceEncoding: _drop, ...rest } = node as FileNode
  const next: FileNode = { ...rest, asset: { mime }, size: bytes.byteLength, updatedAt: rev }
  await store.putNode(next)
  await store.putContent({ id, blob: new Blob([bytes as unknown as BlobPart], { type: mime }) })
  await refreshFiles()
  return { rev }
}

/**
 * 沙箱执行（S7）：联网开关每次现读设置，用户中途关掉也能立刻生效。
 * `runInSandbox` 永不 reject，这里直接透传。
 */
function aiRunScript(lang: 'js' | 'py', code: string, timeoutMs?: unknown) {
  return runInSandbox(lang, code, {
    timeoutMs,
    allowNetwork: getSettings().aiNetwork !== false,
  })
}

/**
 * 某个节点属于哪个工作区（沿祖先链找最近的 AI 工作区文件夹）；不在任何工作区里返回空串。
 *
 * 面板的「当前工作区」最后就回落到这里：文件在哪工作区里，打开它就默认聊那个（W-10）。
 * 不能退回「库里的第一个工作区」—— 那只在「全库只有一个工作区」时才等价（W-S5 已清）。
 */
function aiWorkspaceOf(refId: string): string {
  const byId = new Map(state.files.map((n) => [n.id, n] as const))
  let node = byId.get(refId)
  // 祖先链上限：脏数据里的环不能把这里挂死
  for (let depth = 0; node && depth < 4096; depth += 1) {
    if (node.kind === 'folder' && node.aiWorkspace) return node.aiWorkspace.id
    node = node.parentId ? byId.get(node.parentId) : undefined
  }
  return ''
}

/**
 * 面板此刻停在哪个工作区（W-S4：右键菜单写的是「当前 AI 工作区」，落点必须跟它一致）。
 *
 * 与 `chat.ts` 的 `currentWorkspaceId()` 同一条链：记住的那个 > 文件所属的。
 * 用户选过就一定能对上；没选过时面板显示文件所属的那个，这里也取它。
 */
function aiActiveWorkspaceId(refId: string): string {
  const saved = getSettings().aiLastWorkspace ?? ''
  if (workspaceById(state.files, saved)) return saved
  return aiWorkspaceOf(refId)
}

/**
 * 「授权 / 取消授权」该落到哪个工作区：**当前激活的那个**。
 *
 * 不按「文件自己属于谁」去挑：激活 A 时右键一个 B 里的文件却写进 B，
 * 结果与菜单文案、与用户此刻的上下文都对不上，纯属给人添迷惑。
 * 当前工作区不存在（一个都没建）时，只有全库**唯一**一个工作区才能用它；
 * 多工作区且没有激活的，宁可返回 `null` 让调用方提示先选（W-08）。
 */
function aiGrantTarget(refId: string): FolderNode | null {
  const active = workspaceById(state.files, aiActiveWorkspaceId(refId))
  if (active) return active
  const list = aiWorkspaceList()
  return list.length === 1 ? workspaceById(state.files, list[0].id) : null
}

/** 工作区视图：根 + 节点表。id 是 URI 前缀，查不到就 `null`（调用方报 not_project） */
function aiWorkspaceView(id: string): { root: FolderNode; nodes: ReadonlyMap<string, NodeRecord> } | null {
  const root = workspaceById(state.files, id)
  if (!root) return null
  return { root, nodes: new Map(state.files.map((n) => [n.id, n])) }
}

/* --------------------------------------------------------- 左侧抽屉内容 */

/**
 * 四个分区同为内容，都挂在 left 槽位（plans/panel-registry.md §11）。
 * 文件页与搜索页的骨架结构复杂、静态文案多，直接接管 index.html 里的预置节点；
 * 回收站与快照复用列表样式，根节点现建。
 */
const filesContent = createContent({
  id: 'files',
  titleKey: 'rail.files',
  className: 'drawer-list',
  element: el('drawerList'),
  actions: ['newMenuBtn', 'importBtn', 'batchBar'],
  render: () =>
    renderTree(filesContent.root, {
      index: buildTree(state.files),
      currentId: state.current?.id ?? null,
      expanded: state.expanded,
      // 搜索已经独立成页，文件树不再被搜索词过滤
      filter: '',
      renamingId: state.renamingId,
      dirtyId: state.dirty && state.current ? state.current.id : null,
      selection: state.selection,
      workspaceSessions: aiSessionCounts,
      handlers: {
        open: (id) => void openRecord(id),
        toggle: (id) => toggleFolder(id),
        requestRename: (id) => beginRename(id),
        rename: (id, name) => commitRename(id, name),
        cancelRename: () => {
          state.renamingId = null
          renderLeftContent()
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
        grantAi: (id) => void grantToAi(id),
        isGranted: (id) => !!aiGrantTarget(id)?.aiWorkspace?.grants.some((g) => g.refId === id),
        revokeAi: (id) => void revokeFromAi(id),
      },
    }),
  syncChrome: syncFilesChrome,
  // 离开文件页：重命名、多选、新建菜单都是「这一页才成立」的状态
  onUnmount: () => {
    state.renamingId = null
    clearSelection()
    closeNewItemMenu()
  },
})

const searchContent = createContent({
  id: 'search',
  titleKey: 'rail.search',
  className: 'drawer-searchpane',
  element: el('searchPane'),
  render: () => renderSearchPane(),
  syncChrome: syncSearchChrome,
  // 离开搜索页就掐掉扫描：结果没人看，别继续读盘；顺手收起设置弹层
  // （root 已脱离文档，不能再用 el() 按 id 取，得从自己的树里找）
  onUnmount: () => {
    cancelSearch()
    const options = searchContent.root.querySelector<HTMLElement>('#searchOptions')
    if (options) options.hidden = true
  },
})

const trashContent = createContent({
  id: 'trash',
  titleKey: 'rail.trash',
  className: 'drawer-list',
  rootId: 'trashList',
  actions: ['restoreAllBtn', 'emptyTrashBtn'],
  render: () => {
    const index = buildTree(state.files)
    renderTrashList(
      trashContent.root,
      trash.trashItems(state.files),
      {
        restore: (id) => void restoreFromTrash(id),
        purge: (id) => void purgeFromTrash(id),
      },
      {
        childCount: (id) => state.files.filter((n) => n.parentId === id).length,
        pathOf: (id) => nodePath(index, id),
      },
    )
  },
  syncChrome: syncTrashChrome,
})

const snapshotsContent = createContent({
  id: 'snapshots',
  titleKey: 'rail.snapshots',
  className: 'drawer-list',
  rootId: 'snapshotList',
  render: loadSnapshots,
  syncChrome: syncSnapshotsChrome,
})

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
  // 上次开着拼写检查：现在就把词典拉起来，别等用户再点一次
  if (diagChecks().spell || diagChecks().spellIdent) watchDictReady()

  // 移动端的顶部标题栏 / 地址栏会吃掉一截高度，先按真实可见区域定高度基准；
  // 之后地址栏收放、软键盘弹起、横竖屏切换都会回调，编辑器必须按新容器重新 measure
  trackViewportHeight(() => state.editor?.layout())

  drawer = new Drawer(el('drawer'), () => state.editor?.layout())
  // 开合只影响图标高亮与 aria 状态；列表内容与分区无关，不用重渲染
  drawer.onChange = () => refreshChrome('left')
  applyDrawerWidth(getSettings().drawerWidth)
  applyPanelWidth(getSettings().panelWidth)
  registerPanelSlot()
  registerLeftSlot()
  // 默认展开 files 分区：标题、高亮、底部动作都得在首帧就对上
  await showContent('left', 'files')

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
  wirePrefetch()

  onLangChange(() => {
    updateLangButton()
    renderPrefetch(prefetcher.state())
    // 标题是动态拼的分区名，静态文本应用不到，得单独刷一次
    syncLeftPanel()
    refreshMeta()
    updateDirtyDot()
    renderActivePanel()
    findBar?.relabel()
    // AI 面板的骨架文案也是挂载时写死的，切语言要自己重套一遍
    relabelAiPanel()
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
    // 导图的分支色是渲染时从 CSS 变量读成 hex 交给引擎的，换主题要重画一次
    if (mindmapContent.isVisible()) renderMindmapInto(mindmapContent.root)
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
  // 左竖条：与右竖条同一套绑定，点当前分区的图标等于按 X（toggle 由绑定表决定）
  el('leftBar').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-panel-trigger]')
    const trigger = btn?.dataset.panelTrigger
    if (!trigger) return
    void activateBinding(trigger)
  })
  el('drawerClose').addEventListener('click', () => void drawer.hide())

  // 右竖条：按钮只声明绑定（data-panel-trigger），切换逻辑全在 panel-view 里
  el('rightRail').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-panel-trigger]')
    const trigger = btn?.dataset.panelTrigger
    if (!trigger) return
    void activateBinding(trigger)
  })
  el('issuesOptions').addEventListener('click', () => {
    issuesOptionsOpen = !issuesOptionsOpen
    renderIssuesPanel(issuesContent.root)
  })
  el('transformsBtn').addEventListener('click', () => transformsDialog((id) => applyTransform(id)))
  el('statsBtn').addEventListener('click', () => showStats())
  el('diffBtn').addEventListener('click', () => void diffWithLatest())
  el('diffFileBtn').addEventListener('click', () => diffWithFile())
  el('toolsBtn').addEventListener('click', () => toolsDialog())
  // 点击委托属于内容自己：root 由内容持有，不依赖容器里有没有 id
  outlineContent.root.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('.outline-item')
    if (!btn) return
    const item = outlineItems[Number(btn.dataset.index ?? -1)]
    if (!item) return
    state.editor?.goToLine(item.line)
    state.editor?.focus()
  })
  el('previewClose').addEventListener('click', () => closePanel())
  // AI 标题栏：新建会话 / 历史会话。真正的状态在 ui/ai/chat.ts 里，
  // app 只做转发——面板不该反过来 import app（会成环）
  el('aiWorkspace').addEventListener('click', () => openAiWorkspaces(el('aiWorkspace')))
  el('aiNew').addEventListener('click', () => newAiSession())
  el('aiHistory').addEventListener('click', () => openAiHistory(el('aiHistory')))
  el('previewPrint').addEventListener('click', () => {
    // 渲染是异步的，`window.print()` 不会等 Promise：
    // 必须先把这一轮渲染（含图表）跑完，否则会打出占位源码（§12.5）
    void activateBinding('previewBtn', true).finally(() => window.print())
  })
  el('deckOpen').addEventListener('click', () => void openDeckPlayer())
  el('deckExport').addEventListener('click', () => void exportDeckHtml())
  el('deckHelp').addEventListener('click', () => openDeckHelp())
}

/**
 * 幻灯片语法速查。
 *
 * 内容来自 `ui/slides/spec.ts`——和新建模板、AI 说明、诊断共用一份定义，
 * 改语法时只需要改那一处。渲染走 `renderMarkdown()`，所以对话框里的表格、
 * 代码块跟正文长得一模一样，不需要第二套样式。
 */
function openDeckHelp(): void {
  const holder = document.createElement('div')
  holder.className = 'markdown-body dialog-doc'
  openDialog({ title: t('deck.help'), body: holder })
  void renderMarkdown(specMarkdown()).then((html) => {
    holder.innerHTML = html
  })
}

/**
 * 左侧面板同步：标题、图标高亮、动作按钮一次到位，内容自己重画。
 * 图标栏只在面板展开时给「当前分区」上高亮 —— 收起态没有可见内容，
 * 把某个图标标成选中会显得没头没尾。
 */
function syncLeftPanel() {
  refreshChrome('left')
  renderLeftContent()
}

/** 折叠态的全局计数：始终反映「文件页 / 回收站」两个真实数字 */
function syncRailCounts() {
  const trashedCount = trash.trashItems(state.files).length
  const liveCount = state.files.length - trashedCount
  el('railFilesCount').textContent = String(liveCount)
  el('railTrashCount').textContent = String(trashedCount)
  el('railFilesBtn').title = t('rail.filesTip', { n: liveCount })
  el('railTrashBtn').title = t('rail.trashTip', { n: trashedCount })
}

/** 文件页的细粒度 chrome：批量条与空间条；按钮显隐由槽位按 actions 管（§13.2） */
function syncFilesChrome() {
  const batch = state.selection.size > 0
  el('batchBar').hidden = !batch
  el('importBtn').hidden = batch
  el('drawerStorage').hidden = false
  el('storageDetail').hidden = !storageDetailOpen
  el('drawerFoot').hidden = false
  if (batch) el('batchCount').textContent = t('list.selectedCount', { n: state.selection.size })
}

function syncTrashChrome() {
  const hasTrash = trash.trashItems(state.files).length > 0
  el<HTMLButtonElement>('restoreAllBtn').disabled = !hasTrash
  el<HTMLButtonElement>('emptyTrashBtn').disabled = !hasTrash
  // 空间条只属于文件页：回收站里没有「还占多少」这回事
  el('drawerStorage').hidden = true
  el('storageDetail').hidden = true
  el('drawerFoot').hidden = false
}

/** 搜索页与快照页没有底部动作：列表自己就是全部内容 */
function syncSearchChrome() {
  el('drawerStorage').hidden = true
  el('storageDetail').hidden = true
  el('drawerFoot').hidden = true
}

function syncSnapshotsChrome() {
  syncSearchChrome()
}

/**
 * 搜索页的骨架归 searchContent 所有，启动时已脱离文档，
 * 所以这里不能再用 el() 按 id 取，只能从它自己的树里找。
 */
function wireSearchPane(root: HTMLElement) {
  const pick = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!
  const input = pick<HTMLInputElement>('searchInput')
  const options = pick('searchOptions')
  const optBtn = pick('searchOptionsBtn')
  const clearBtn = pick('searchClear')

  input.addEventListener('input', () => {
    state.search = input.value
    clearBtn.hidden = state.search === ''
    scheduleSearch()
  })

  // 清空搜索：只清搜索词，不动分区，也不动面板开合
  clearBtn.addEventListener('click', () => {
    state.search = ''
    input.value = ''
    clearBtn.hidden = true
    input.focus()
    void runSearch()
  })

  // 手动触发：开了设置之后不再边打字边搜
  pick('searchGo').addEventListener('click', () => void runSearch())

  // 大文件只在内容搜索下才有意义：勾它就连带勾上内容，撤内容也一起撤掉
  pick('searchDeep').addEventListener('change', (e) => {
    deepSearch = (e.target as HTMLInputElement).checked
    if (!deepSearch) bigSearch = false
    void runSearch()
  })

  pick('searchBig').addEventListener('change', (e) => {
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
}

function wireDrawer() {
  wireSearchPane(searchContent.root)

  // 传按钮本身：菜单要贴着它弹，而不是跑到屏幕中间
  const newMenuBtn = el('newMenuBtn')
  newMenuBtn.addEventListener('click', () =>
    newItemMenuDialog(newMenuBtn, {
      file: () => void createNode('file'),
      // 演示文稿 = 预填模板的文件：模板与语法速查、AI 说明同源（ui/slides/spec.ts）
      deck: () =>
        void createNode('file', targetParent(), {
          seed: deckTemplate(),
          suffix: '.md',
          titleKey: 'action.newDeck',
          prefix: `${t('action.newDeck')}-`,
        }),
      folder: () => void createNode('folder'),
      paste: () => void importPasted(),
      url: () => void importFromUrl(),
    }),
  )
  el('batchExportBtn').addEventListener('click', () => void batchExport())
  el('batchMoveBtn').addEventListener('click', () => batchMove())
  el('batchCleanBtn').addEventListener('click', () => void batchClean())
  el('batchTrashBtn').addEventListener('click', () => void batchTrash())
  el('batchClearBtn').addEventListener('click', () => {
    clearSelection()
    renderLeftContent()
  })
  el('restoreAllBtn').addEventListener('click', () => void restoreAllFromTrash())
  el('emptyTrashBtn').addEventListener('click', () => void emptyTrash())
  // 底部空间条本身是按钮语义：点一下就地展开体积明细（W-11）
  const storageBox = el('drawerStorage')
  storageBox.addEventListener('click', () => void toggleStorageDetail())
  storageBox.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    void toggleStorageDetail()
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
  el('emptyUrlBtn').addEventListener('click', () => void importFromUrl())
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

  // PlantUML 是唯一会把内容发到机器外的能力：开关和「发去哪儿」必须同屏可见，
  // 不能只藏在 tooltip 里
  const plantuml = document.createElement('button')
  plantuml.className = 'btn'
  plantuml.style.cssText = 'width:100%;justify-content:flex-start'
  const paintPlantuml = () => {
    plantuml.textContent = `${t('chart.plantuml')} · ${
      getSettings().plantumlRemote ? t('settings.on') : t('settings.off')
    }`
  }
  paintPlantuml()
  plantuml.onclick = () => {
    updateSettings({ plantumlRemote: !getSettings().plantumlRemote })
    paintPlantuml()
    // 立刻重画：否则已画好的图/源码块要等到下次编辑才变
    void previewContent.render()
  }
  menu.appendChild(plantuml)

  const plantumlHint = document.createElement('div')
  plantumlHint.className = 'menu-hint'
  plantumlHint.textContent = t('chart.plantumlHint')
  menu.appendChild(plantumlHint)

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
  // 徽标是这个功能唯一的常驻入口：任何「没结果」的状态都要能点进来
  el('stDiag').addEventListener('click', () => {
    if (!state.current) return
    void activateBinding('issuesBtn', true)
  })
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
  box.title = `${t('list.storageHint', { usage: formatBytes(info.usage) })} · ${t('storage.detailHint')}`
  box.classList.toggle('is-warn', info.quota > 0 && total > info.quota * 0.8)

  // 图标栏那个环：2πr（r = 15）= 94.25
  const ring = document.getElementById('railDiskRing') as SVGCircleElement | null
  // 空库时留一小段起手的弧，否则这个位置看起来像「没有东西」；真实数字在 tooltip 里
  ring?.style.setProperty('stroke-dashoffset', String(94.25 * (1 - Math.max(ratio, 0.03))))
  const disk = el('railDisk')
  disk.classList.toggle('is-warn', ratio > 0.8)
  disk.title = text

  // 明细开着的时候跟着重算：删了文件/清了回收站，数字得跟着变（W-11）
  if (storageDetailOpen) void renderStorageDetail()
}

/* --------------------------------------------------------- 体积明细（W-11） */

/**
 * 明细是否展开。它只属于文件页：切到回收站/搜索页时不销毁状态，
 * 只是把内容藏起来，回到文件页再原样展开（少一次重算）。
 */
let storageDetailOpen = false
/** 计算代次：收起、重算、切页时自增；过期的异步结果不许再往 DOM 上写 */
let storageCalcGen = 0

interface WorkspaceUsage {
  id: string
  nodeId: string
  name: string
  files: number
  sessions: number
  messages: number
  bytes: number
}

/**
 * 每个工作区的文件体积：整棵树走一遍，文件算给**最近的**工作区祖先。
 *
 * 不能按「子树求和」：工作区可以嵌套（用户把它拖进另一个工作区），那样父子重复计数，
 * 各工作区之和会超过「文件」那一行。
 */
function workspaceFileBytes(): Map<string, number> {
  const children = new Map<string | null, NodeRecord[]>()
  for (const node of state.files) {
    const bucket = children.get(node.parentId)
    if (bucket) bucket.push(node)
    else children.set(node.parentId, [node])
  }
  const out = new Map<string, number>()
  const walk = (parentId: string | null, workspaceId: string) => {
    for (const node of children.get(parentId) ?? []) {
      // 软删的整棵子树都带 deletedAt，不必也不该往下走
      if (node.deletedAt !== null) continue
      const next = node.kind === 'folder' && node.aiWorkspace ? node.aiWorkspace.id : workspaceId
      if (node.kind === 'file') {
        if (next) out.set(next, (out.get(next) ?? 0) + node.size)
      } else {
        walk(node.id, next)
      }
    }
  }
  walk(null, '')
  return out
}

function detailRow(label: string): { row: HTMLElement; value: HTMLElement } {
  const row = document.createElement('div')
  row.className = 'storage-line'
  const name = document.createElement('span')
  name.className = 'storage-name'
  name.textContent = label
  const value = document.createElement('span')
  value.className = 'storage-val'
  row.append(name, value)
  return { row, value }
}

/** 超 50 MB 的单项单独标红：混在一堆数字里看不出哪个才是罪魁 */
const STORAGE_BIG = 50 * 1024 * 1024

async function renderStorageDetail(): Promise<void> {
  const host = el('storageDetail')
  const gen = ++storageCalcGen
  if (!storageDetailOpen) {
    host.hidden = true
    host.textContent = ''
    return
  }
  host.hidden = false
  host.textContent = ''

  const files = detailRow(t('storage.files'))
  host.append(files.row)

  const wsHead = detailRow(t('storage.workspaces'))
  host.append(wsHead.row)
  const wsHost = document.createElement('div')
  wsHost.className = 'storage-ws-list'
  host.append(wsHost)

  const trashRow = detailRow(t('storage.trash'))
  const emptyTrashBtn = document.createElement('button')
  emptyTrashBtn.type = 'button'
  emptyTrashBtn.className = 'btn btn-ghost storage-act'
  emptyTrashBtn.textContent = t('storage.emptyTrash')
  emptyTrashBtn.disabled = true
  emptyTrashBtn.addEventListener('click', () => {
    void emptyTrash().then(() => renderStorageDetail())
  })
  trashRow.row.append(emptyTrashBtn)
  host.append(trashRow.row)

  files.value.textContent = t('storage.calc')
  wsHead.value.textContent = t('storage.calc')
  trashRow.value.textContent = t('storage.calc')

  const [fileBytes, trashBytes] = await Promise.all([store.totalSize(), store.trashSize()])
  if (gen !== storageCalcGen) return
  files.value.textContent = formatBytes(fileBytes)
  files.value.classList.toggle('is-big', fileBytes > STORAGE_BIG)
  trashRow.value.textContent = formatBytes(trashBytes)
  trashRow.value.classList.toggle('is-big', trashBytes > STORAGE_BIG)
  emptyTrashBtn.disabled = trashBytes === 0

  const list = aiWorkspaceList()
  if (!list.length) {
    const empty = document.createElement('div')
    empty.className = 'storage-empty'
    empty.textContent = t('storage.empty')
    wsHost.append(empty)
    wsHead.value.textContent = '—'
    return
  }

  const bytesByWs = workspaceFileBytes()
  let wsTotal = 0
  for (const brief of list) {
    const filesBytes = bytesByWs.get(brief.id) ?? 0
    const box = document.createElement('div')
    box.className = 'storage-ws'

    const line = detailRow(brief.name)
    line.value.textContent = t('storage.calc')
    const sub = document.createElement('div')
    sub.className = 'storage-sub'
    sub.textContent = t('storage.calc')
    box.append(line.row, sub)
    wsHost.append(box)

    // 逐个算、逐个 await：每个工作区之间让出一次主线程，大库不会卡成一帧
    const usage = await workspaceChatUsage(brief.id)
    if (gen !== storageCalcGen || !box.isConnected) return
    const item: WorkspaceUsage = {
      id: brief.id,
      nodeId: brief.nodeId,
      name: brief.name,
      files: filesBytes,
      sessions: usage.sessions,
      messages: usage.messages,
      bytes: usage.bytes,
    }
    wsTotal += filesBytes + usage.bytes
    line.value.textContent = formatBytes(filesBytes + usage.bytes)
    line.value.classList.toggle('is-big', filesBytes + usage.bytes > STORAGE_BIG)
    sub.textContent = t('storage.wsDetail', {
      files: formatBytes(filesBytes),
      n: usage.sessions,
      chat: formatBytes(usage.bytes),
    })

    const acts = document.createElement('div')
    acts.className = 'storage-acts'
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'btn btn-ghost storage-act'
    clear.textContent = t('storage.clearChat')
    clear.disabled = usage.sessions === 0
    clear.addEventListener('click', () => void clearWorkspaceChats(item))
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'btn btn-ghost storage-act is-danger'
    del.textContent = t('ai.ws.delete')
    del.addEventListener('click', () => void trashNode(item.nodeId).then(() => renderStorageDetail()))
    acts.append(clear, del)
    box.append(acts)
  }
  if (gen !== storageCalcGen) return
  wsHead.value.textContent = formatBytes(wsTotal)
  wsHead.value.classList.toggle('is-big', wsTotal > STORAGE_BIG)
}

/** 清理某个工作区的全部会话：文件不动，会话不可恢复，所以文案要写明「无法恢复」 */
async function clearWorkspaceChats(item: WorkspaceUsage): Promise<void> {
  const res = await confirmDialog(
    t('storage.clearChatTitle'),
    t('storage.clearChatBody', {
      name: item.name,
      sessions: item.sessions,
      messages: item.messages,
    }),
  )
  if (!res.ok) return
  const n = await clearWorkspace(item.id)
  toast(t('storage.cleared', { n }))
  // 面板可能正停在被清空的工作区上：重画一次才会回到空态，而不是留着一条已经不存在的会话
  renderRightContent()
  await renderStorageDetail()
}

/** 点底部空间条就地展开/收起明细；不弹窗（§8.6） */
async function toggleStorageDetail(): Promise<void> {
  storageDetailOpen = !storageDetailOpen
  const box = el('drawerStorage')
  box.classList.toggle('is-open', storageDetailOpen)
  box.setAttribute('aria-expanded', String(storageDetailOpen))
  await renderStorageDetail()
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
 * URL 导入：下载阶段在对话框里完成（含重试与错误提示），
 * 拿到 File 之后和本地选文件走同一条 ingestFile —— 编码、大文件分档、落库都不另写一套。
 */
async function importFromUrl() {
  const file = await urlImportDialog()
  if (!file) return
  // 导入完成要能看见新文件，面板收着就先展开
  if (!drawer.isOpen) void drawer.show()
  await ingestFile(file)
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

/**
 * 二进制导入（P-08）：存 Blob、节点标 `asset`，不进入编辑器。
 * 图片可预览，其余只给元信息（P-09）；移动/重命名与文本节点同一套逻辑。
 */
async function ingestAsset(file: File, buf: ArrayBuffer) {
  const mime = mimeForName(file.name, file.type)
  const name = dedupeName(file.name || t('misc.untitled'), takenNames(state.files, null))
  const node = createFileNode({
    name,
    lang: 'text',
    langSource: 'ext',
    engine: state.engineId,
    size: buf.byteLength,
    asset: { mime },
  })

  try {
    await store.putNode(node)
    await store.putContent({ id: node.id, blob: new Blob([buf], { type: mime }) })
  } catch (err) {
    toast(t('toast.cacheFailed', { msg: (err as Error).message }), 'error')
    return
  }

  await refreshFiles()
  await refreshStorage()
  await openRecord(node.id)
  notifyFiles(node.id)
  toast(t('toast.imported', { name: node.name }))
}

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
    await ingestAsset(file, buf)
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
  const text = await pasteImportDialog()
  if (!text) return

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

/* ------------------------------------------------------------ 二进制预览 */

/** 当前预览图的对象 URL；换文件/关文件时必须释放，否则 Blob 一直被引用（P-09） */
let assetUrl: string | null = null

function releaseAssetUrl() {
  if (!assetUrl) return
  URL.revokeObjectURL(assetUrl)
  assetUrl = null
}

/**
 * 渲染二进制资产的预览视图：图片内联显示，其余（aar/so/zip 等）只给元信息。
 * 不创建编辑器实例 —— 资产不参与文本编辑（P-09）。
 */
function mountAssetView(node: FileNode, blob: Blob | null) {
  const host = el('editorHost')
  releaseAssetUrl()
  findBar?.close()
  state.editor?.destroy()
  state.editor = null
  host.innerHTML = ''

  const mime = node.asset?.mime ?? 'application/octet-stream'
  const card = document.createElement('div')
  card.className = 'asset-view'

  if (blob && isPreviewableImage(mime)) {
    assetUrl = URL.createObjectURL(blob)
    const img = document.createElement('img')
    img.className = 'asset-image'
    img.src = assetUrl
    img.alt = node.name
    card.appendChild(img)
  } else {
    const note = document.createElement('div')
    note.className = 'asset-note'
    note.textContent = t('asset.noPreview')
    card.appendChild(note)
  }

  const meta = document.createElement('div')
  meta.className = 'asset-meta'
  meta.textContent = t('asset.meta', { mime, size: formatBytes(node.size) })
  card.appendChild(meta)

  const dl = document.createElement('button')
  dl.className = 'btn btn-ghost'
  dl.textContent = t('action.download')
  dl.onclick = () => {
    if (blob) downloadBlob(node.name, blob)
  }
  card.appendChild(dl)

  host.appendChild(card)
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

  // 二进制资产（P-08）：不进编辑器，直接预览。锁照拿，避免两个标签页同时覆盖
  if (node.asset) {
    state.current = rec
    state.locked = !free
    if (!free) toast(t('toast.locked'), 'error')
    state.text = ''
    state.dirty = false
    state.rawBytes = null
    state.mode = modeFor(node.size)
    mountAssetView(node, content?.blob ?? content?.originalBytes ?? null)
    rememberTabFile(id)
    syncHash(id)
    el('emptyState').hidden = true
    await refreshSnapshots()
    await refreshFiles()
    refreshMeta()
    updateFormatButton()
    renderLeftContent()
    return
  }

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
  void previewContent.render()
  renderLeftContent()
}

/** 回到空态：删除当前文件、或别的标签页把它删了，都走这里 */
function closeCurrent() {
  state.editor?.destroy()
  state.editor = null
  releaseAssetUrl()
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
      renderLeftContent()
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
  releaseAssetUrl()
  host.innerHTML = ''

  // Monaco 是按需下载的：断网且离线包还没下到它时，import() 会失败。
  // 这里降级回 CodeMirror 而不是让调用方吃一个未处理异常——否则编辑区会一直
  // 停在切换时的半透明状态，看着像卡死。
  let Adapter: new () => EditorAdapter = CodeMirrorAdapter
  if (state.engineId === 'monaco') {
    try {
      Adapter = (await import('../editors/monaco')).MonacoAdapter
    } catch {
      state.engineId = 'cm'
      updateSettings({ defaultEngine: 'cm' })
      if (rec.engine !== 'cm') {
        rec.engine = 'cm'
        void store.putNode(toNode(rec))
      }
      updateEngineSeg()
      toast(t('toast.engineFallback'), 'error')
    }
  }

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
      // 用户敲一个字，AI 手上的读票就全部「待复核」：rev 变了就走慢路径比对原文
      docRev += 1
      // 这一版内容还没进草稿，状态栏先别急着说「草稿已存」
      draftAt = null
      updateDirtyDot()
      sb.setCount(v)
      syncSizeBadge()
      schedulePreview()
      scheduleOutline()
      // 检查挂在 app 层而不是面板上：面板关着也照跑（DG-07）
      scheduleDiagnostics()
      scheduleAutosave()
      updateFormatButton()
      findBar?.refresh()
    },
    onCursor: (line, col) => {
      cursorLine = line
      cursorCol = col
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
  // 换文件/换引擎/换语言都会走到这里：先试缓存，命中就秒出，否则排一次检查
  void primeDiagnostics()
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
  // 换文件时先把徽标切到「没结果」，别让上一个文件的计数继续挂着
  syncDiagBadge()
  if (!rec) {
    sb.setLanguage('—')
    return
  }
}

/** 右侧面板的入口显隐；文档视图只对 Markdown 系有意义，大纲与检查任何文件都有 */
function syncPanelButtons() {
  const rec = state.current
  const lang = currentLang()
  const doc = Boolean(rec) && supportsDocView(lang, 'doc')
  const map = Boolean(rec) && supportsDocView(lang, 'mindmap')
  const ppt = Boolean(rec) && supportsDocView(lang, 'ppt')
  el('previewBtn').hidden = !doc
  el('outlineBtn').hidden = !rec
  el('issuesBtn').hidden = !rec
  el('mindmapBtn').hidden = !map
  el('pptBtn').hidden = !ppt
  // 当前这一页在当前文件上不适用时，面板不收起、转到大纲：
  // 切个文件就把侧栏闪没，比留着它更烦
  const active = activeContentId('right')
  const stale = (active === 'preview' && !doc) || (active === 'mindmap' && !map) || (active === 'ppt' && !ppt)
  // 已经换过内容就别再走一遍末尾的刷新，否则同一个内容会被渲染两次
  if (stale && state.previewOpen) {
    void showContent('right', 'outline')
    return
  }
  refreshChrome('right')
  if (state.previewOpen) renderActivePanel()
}

/**
 * 右侧槽位与四个绑定：唯一把「按钮 / 容器 / 内容」连起来的地方。
 * 按钮挪位置改 binding.trigger，内容换容器只改 binding.slot。
 */
function registerPanelSlot() {
  registerSlot({
    id: 'right',
    host: el('panelView'),
    isOpen: () => state.previewOpen,
    setOpen: (open) => {
      state.previewOpen = open
      el('rightPanel').classList.toggle('is-open', open)
    },
    title: el('panelTitle'),
    actionsHost: el('panelHead'),
    onLayout: () => requestAnimationFrame(() => state.editor?.layout()),
  })
  registerBinding({ trigger: 'aiBtn', slot: 'right', content: 'ai', toggle: true })
  registerBinding({ trigger: 'previewBtn', slot: 'right', content: 'preview', toggle: true })
  registerBinding({ trigger: 'outlineBtn', slot: 'right', content: 'outline', toggle: true })
  registerBinding({ trigger: 'issuesBtn', slot: 'right', content: 'issues', toggle: true })
  registerBinding({ trigger: 'mindmapBtn', slot: 'right', content: 'mindmap', toggle: true })
  registerBinding({ trigger: 'pptBtn', slot: 'right', content: 'ppt', toggle: true })
}

function closePanel() {
  closeSlot('right')
}

/**
 * 左侧槽位与四条绑定：四个分区是同级内容，共用一个容器。
 * 按钮位置（竖条 / 快捷键 / 菜单）怎么变都只改这里。
 */
function registerLeftSlot() {
  registerSlot({
    id: 'left',
    host: el('drawerBody'),
    isOpen: () => drawer.isOpen,
    setOpen: (open) => {
      if (open) void drawer.show()
      else void drawer.hide()
    },
    title: el('drawerTitle'),
    actionsHost: el('drawerInner'),
  })
  registerBinding({ trigger: 'railFilesBtn', slot: 'left', content: 'files', toggle: true, aria: true })
  registerBinding({ trigger: 'railSearchBtn', slot: 'left', content: 'search', toggle: true, aria: true })
  registerBinding({ trigger: 'railTrashBtn', slot: 'left', content: 'trash', toggle: true, aria: true })
  registerBinding({
    trigger: 'railSnapshotsBtn',
    slot: 'left',
    content: 'snapshots',
    toggle: true,
    aria: true,
  })
}

/**
 * 右竖条的文档操作（加工、信息、两种对比）没文件就没有意义，空状态一并收起。
 * 面板入口按钮（带 data-panel-trigger）显隐由 syncPanelButtons 按语言能力决定，
 * 这里不能按「有没有文件」一刀切，否则导图按钮会在非 Markdown 文件上冒出来。
 */
function syncDocActions() {
  const has = Boolean(state.current)
  document.querySelectorAll<HTMLElement>('[data-doc-action]').forEach((b) => {
    if (b.hasAttribute('data-panel-trigger')) return
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
  try {
    await mountEditor(value, offset)
  } finally {
    // 无论成功、降级还是抛错，都不能把编辑区留在半透明
    host.style.opacity = '1'
  }
  // 空白页没有文件记录，mountEditor 会提前返回，分段控件得自己刷一次
  updateEngineSeg()
  if (state.current) refreshMeta()
}

/* ---------------------------------------------------------- 离线包（rail 环） */

const prefetcher = createPrefetcher(renderPrefetch)

function renderPrefetch(p: PrefetchProgress) {
  const btn = el<HTMLButtonElement>('railFetch')
  if (!btn) return
  btn.dataset.state = p.phase
  const ring = document.getElementById('railFetchRing')
  if (ring instanceof SVGCircleElement) ring.style.strokeDashoffset = ringOffset(p.ratio)

  const pct = Math.round(p.ratio * 100)
  const tip = btn.disabled
    ? t('rail.prefetchDev')
    : p.phase === 'busy'
      ? t('rail.prefetchBusy', { pct })
      : p.phase === 'paused'
        ? t('rail.prefetchPaused')
        : p.phase === 'error'
          ? p.failed > 0
            ? t('rail.prefetchFailed', { n: p.failed })
            : t('rail.prefetchError')
          : p.phase === 'ready'
            ? t('rail.prefetchReady')
            : t('rail.prefetchIdle')
  btn.title = tip
  btn.setAttribute('aria-label', tip)
  // 括号与感叹号是 SVG，由 data-state 决定显示哪一组，这里不再改文字
}

function wirePrefetch() {
  const btn = el<HTMLButtonElement>('railFetch')
  if (!btn) return

  // dev / 无 Service Worker：环永远停在 idle，但保留显示并置灰，
  // 这样样式改动不用构建就能直接看效果
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
    const tip = t('rail.prefetchDev')
    btn.hidden = false
    btn.disabled = true
    btn.dataset.state = 'idle'
    btn.title = tip
    btn.setAttribute('aria-label', tip)
    return
  }

  btn.hidden = false
  renderPrefetch(prefetcher.state())
  btn.addEventListener('click', () => {
    if (prefetcher.state().phase === 'ready') {
      toast(t('rail.prefetchReady'))
      return
    }
    prefetcher.toggle()
  })
  prefetcher.autoStart()
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

async function loadSnapshots() {
  state.snapshots = state.current ? await store.listSnapshots(state.current.id) : []
  renderSnapshotList(snapshotsContent.root, state.snapshots, {
    restore: (id) => void restoreSnapshot(id),
    compare: (id) => void compareSnapshot(id),
    remove: (id) => void removeSnapshot(id),
  })
}

/** 保存后刷新：只在用户正看着快照页时才重画，别白白重建列表 */
async function refreshSnapshots() {
  if (!snapshotsContent.isVisible()) return
  await loadSnapshots()
}

async function refreshFiles() {
  state.files = await store.listNodes()
  // 回收站与文件树共用同一份 nodes 快照，两个页签都要跟着重绘；
  // 快照页看的是历史不是文件，不用跟着重建
  if (!snapshotsContent.isVisible()) renderLeftContent()
  refreshChrome('left')
  // 会话数只进徽标 tooltip：异步补，不拖慢文件树的这一帧
  void refreshAiSessionCounts()
}

/** 每个工作区的会话数（W-S4 徽标 tooltip），变了才重画左栏 */
let aiSessionCounts: ReadonlyMap<string, number> = new Map()

async function refreshAiSessionCounts(): Promise<void> {
  let next: ReadonlyMap<string, number>
  try {
    const stats = await sessionStatsByWorkspace()
    next = new Map([...stats].map(([id, item]) => [id, item.count] as const))
  } catch {
    return
  }
  // 没变就别重画：`refreshFiles` 会被 AI 的每次写入触发，白重画会让左栏一直闪
  if (next.size === aiSessionCounts.size) {
    let same = true
    for (const [key, value] of next) {
      if (aiSessionCounts.get(key) !== value) {
        same = false
        break
      }
    }
    if (same) return
  }
  aiSessionCounts = next
  if (filesContent.isVisible()) filesContent.render()
}

/** 重画左侧当前内容；要更新别的分区请直接调那个内容的 render */
function renderLeftContent() {
  const id = activeContentId('left')
  syncRailCounts()
  void (id ? contentById(id) : null)?.render()
}

/**
 * 重画右侧当前内容。工作区被删/被清空后要调一次：会话区还挂着已删工作区的记录，
 * 不重画就会停在一条「查不到工作区」的旧会话上（chat 的 align 会自己回落到列表）。
 */
function renderRightContent() {
  const id = activeContentId('right')
  void (id ? contentById(id) : null)?.render()
}

/* -------------------------------------------------------- 树的增删改 */

function toggleFolder(id: string): void {
  if (state.expanded.has(id)) state.expanded.delete(id)
  else state.expanded.add(id)
  saveExpanded()
  clearSelection()
  renderLeftContent()
}

/* -------------------------------------------------------- 多选（§13.2） */

function clearSelection(): void {
  if (!state.selection.size && !state.anchor) return
  state.selection.clear()
  state.anchor = null
  refreshChrome('left')
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

  refreshChrome('left')
  renderLeftContent()
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
  refreshChrome('left')
  renderLeftContent()
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
  renderLeftContent()
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

/** 新建时的预置：模板内容、默认名（演示文稿用），普通新建不传 */
interface CreatePreset {
  /** 预填内容，跟节点一起落库 */
  seed?: string
  /** 用户没写扩展名时补上的后缀（`.md`），免得建出来是纯文本视图 */
  suffix?: string
  /** 弹窗标题 */
  titleKey?: MessageKey
  /** 默认名前缀 */
  prefix?: string
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
  preset: CreatePreset = {},
): Promise<void> {
  // 回到文件页并把选择归位：新节点要能出现在列表里
  state.renamingId = null
  clearSelection()
  await showContent('left', 'files')
  // 建完立刻进重命名，面板收着的话输入框根本看不见
  if (!drawer.isOpen) void drawer.show()

  const taken = takenNames(state.files, parentId)
  const prefix =
    preset.prefix ??
    (kind === 'file' ? `${t('misc.untitled').replace(/\.\w+$/, '')}-` : `${t('misc.newFolder')}-`)
  // 落到子文件夹时把位置写进提示：抽屉可能收着，光看名字看不出建在哪
  const where = parentId ? nodePath(buildTree(state.files), parentId) : ''
  const hint = where ? `${t('dialog.newWhere', { path: where })}\n${t('dialog.newHint')}` : t('dialog.newHint')

  // 用户没写扩展名时补上模板的后缀；重名判断也用补过后缀的名字，否则会建出两个同名的
  const withSuffix = (raw: string) => {
    if (!preset.suffix || /\.[A-Za-z0-9]+$/.test(raw)) return raw
    return `${raw}${preset.suffix}`
  }

  // 默认名是「前缀-N」不代表后缀，而 taken 里存的是全名：把后缀剥掉再比，
  // 否则第二次新建演示文稿会默认到「演示文稿-1」——补成 `.md` 后正好撞上已有文件，
  // 用户一进来就看到重名错误
  const suffixKey = preset.suffix?.toLowerCase() ?? ''
  const baseTaken = new Set(taken)
  if (suffixKey) {
    for (const name of taken) {
      if (name.endsWith(suffixKey)) baseTaken.add(name.slice(0, -suffixKey.length))
    }
  }

  const input = await promptDialog({
    title: t(preset.titleKey ?? (kind === 'file' ? 'action.newFile' : 'action.newFolder')),
    value: nextUntitled(baseTaken, prefix),
    hint,
    submitOnDismiss: true,
    validate: (raw) => {
      const valid = validateName(raw)
      if (!valid.ok) return t(nameErrorKey(valid.reason))
      // 重名挡在窗口里说明，而不是建完再悄悄加 (1)
      if (taken.has(normalizeName(withSuffix(valid.name)))) return t('err.nameDuplicate')
      return null
    },
  })
  if (input === null) return
  const name = withSuffix(input)

  // 后缀说了算：写 a.ts 就该按 TS 高亮，不再一律当纯文本
  const node =
    kind === 'file'
      ? createFileNode({
          name,
          parentId,
          lang: langFromName(name),
          langSource: 'ext',
          engine: state.engineId,
          size: preset.seed ? new Blob([preset.seed]).size : 0,
        })
      : createFolderNode(name, parentId)

  // 新建即落库（D-09），空文件不写 contents；之后再改内容才写。
  // 带模板的（演示文稿）连内容一起写：先建空文件再等编辑器保存会留下一个「空演示文稿」中间态
  await store.putNode(node)
  if (preset.seed) {
    await store.putContent({ id: node.id, blob: new Blob([preset.seed], { type: 'text/plain' }) })
  }
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
    renderLeftContent()
    return false
  }
  if (valid.name === node.name) {
    state.renamingId = null
    renderLeftContent()
    return true
  }

  const taken = takenNames(state.files, node.parentId, id)
  if (taken.has(normalizeName(valid.name))) {
    toast(t('err.nameDuplicate'), 'error')
    state.renamingId = null
    renderLeftContent()
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

/**
 * 授权给**当前 AI 工作区**：把节点加进它的引用列表（`:link`）。
 *
 * 菜单文案与落点由同一个 `aiGrantTarget` 决定，所以点下去加进的一定是
 * 面板此刻停着的那个工作区（激活 A 却写进 B 的情况不存在）。
 * v3（W-08）：普通文件夹不再自动升为工作区 —— 工作区必须由用户显式建立。
 * 没有工作区时只提示，不改动文件树：悄悄改用户的目录结构比报错更糟。
 */
async function grantToAi(id: string): Promise<void> {
  const target = state.files.find((n) => n.id === id)
  if (!target) return
  // 加进哪个工作区见 `aiGrantTarget`：多工作区下猜不了就提示用户去面板里选
  const root = aiGrantTarget(id)
  if (!root) {
    toast(
      t(
        aiWorkspaceList().length
          ? 'ai.grant.err.pick_workspace'
          : 'ai.grant.err.no_workspace',
      ),
    )
    return
  }
  const nodes = new Map(state.files.map((n) => [n.id, n] as const))
  const res = addGrant(root, id, nodes, Date.now())
  if (!res.ok) {
    const reason =
      res.error === 'not_found'
        ? t('ai.grant.err.not_found')
        : res.error === 'in_workspace'
          ? t('ai.grant.err.in_workspace')
          : t('ai.grant.err.already_granted')
    toast(reason)
    return
  }
  await store.putNode(res.root)
  await refreshFiles()
  toast(t('ai.grant.added', { name: target.name, ws: root.name }))
}

/**
 * 取消授权。`workspaceId` 由面板显式给出（它就是列清单的那个工作区）；
 * 树右键不带，走 `aiGrantTarget` —— 两边都不再靠 refId 反推工作区，
 * 否则面板里跨工作区引用的一行点了会没反应（写进的是文件老家那份）。
 */
async function revokeFromAi(id: string, workspaceId?: string): Promise<void> {
  const root = workspaceId ? workspaceById(state.files, workspaceId) : aiGrantTarget(id)
  if (!root) return
  const res = removeGrant(root, id)
  if (!res.ok) return
  const name = state.files.find((n) => n.id === id)?.name ?? ''
  await store.putNode(res.root)
  await refreshFiles()
  toast(t('ai.grant.removed', { name, ws: root.name }))
}

/**
 * 发消息时的自动引用（W-04）：把当前文件加进**指定工作区**的 `:link`。
 *
 * 去重由调用方（chat.ts）先判 inSubtree / isGrantedBy 做完，这里只在真新增时落库。
 * 返回 `true` 表示确实加进去了 —— chat 据此决定要不要回一条事件消息。
 * 工作区不存在就安静地返回 `false`：发消息本身不该因为没工作区就失败。
 */
async function aiAutoReference(refId: string, workspaceId: string): Promise<boolean> {
  const root = workspaceById(state.files, workspaceId)
  if (!root) return false
  const nodes = new Map(state.files.map((n) => [n.id, n] as const))
  const res = addGrant(root, refId, nodes, Date.now())
  if (!res.ok) return false
  await store.putNode(res.root)
  await refreshFiles()
  return true
}

/** 工作区摘要：面板列表 / 切换浮层 / 标题栏都要，形状固定成一份，别让 UI 各自去翻节点 */
export interface AiWorkspaceBrief {
  id: string
  /** 文件夹名，可被用户改名 */
  name: string
  /** 文件夹节点 id（树徽标、删除工作区都用它） */
  nodeId: string
  /** 授权引用 id 列表：切换浮层据此判断「引用过当前文件」 */
  grantIds: string[]
  createdAt: number
}

function aiWorkspaceList(): AiWorkspaceBrief[] {
  const out: AiWorkspaceBrief[] = []
  for (const node of state.files) {
    const workspace = node.kind === 'folder' ? node.aiWorkspace : undefined
    if (!workspace || node.deletedAt !== null) continue
    out.push({
      id: workspace.id,
      name: node.name,
      nodeId: node.id,
      grantIds: workspace.grants.map((grant) => grant.refId),
      createdAt: workspace.createdAt,
    })
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * 「新工作区」（W-08）：**只在用户点的时候**建文件夹，名字取现有最大序号 + 1。
 *
 * 默认名字允许改名（树里双击即可）。建完自动展开父级并选中，用户马上能看到它在哪。
 */
async function createAiWorkspace(name?: string): Promise<AiWorkspaceBrief | null> {
  const siblings = state.files.filter((n) => n.parentId === null && n.kind === 'folder')
  let label = name?.trim() ?? ''
  if (!label) {
    // 序号按「AI 工作区-N」里出现过的最大值 +1：删掉中间某个也不会撞名
    let max = 0
    for (const node of siblings) {
      const hit = /^AI 工作区-(\d+)$/.exec(node.name)
      if (hit) max = Math.max(max, Number(hit[1]))
    }
    label = `AI 工作区-${max + 1}`
  }
  while (siblings.some((n) => n.name === label)) label = `${label} 2`

  // 不走 `createNode`：那个入口会弹输入框让人先想名字，而这里默认名已经定了，
  // 想改名去树里双击（W-08 允许改名）
  const marked = createWorkspace(createFolderNode(label, null), Date.now())
  await store.putNode(marked)
  await refreshFiles()
  toast(t('ai.ws.created', { name: marked.name }))
  return {
    id: marked.aiWorkspace?.id ?? '',
    name: marked.name,
    nodeId: marked.id,
    grantIds: [],
    createdAt: marked.aiWorkspace?.createdAt ?? Date.now(),
  }
}

async function trashNode(id: string): Promise<void> {
  const node = state.files.find((n) => n.id === id)
  if (!node) return

  const workspace = node.kind === 'folder' ? node.aiWorkspace : undefined
  const res = await confirmDialog(
    t('confirm.trashTitle'),
    // 工作区软删只说「会话保留」：真正的清理在回收站彻底删除那一步（W-09）
    workspace
      ? t('ai.ws.trashBody', { name: node.name })
      : node.kind === 'folder'
        ? t('confirm.trashFolderBody', { name: node.name })
        : t('confirm.trashBody', { name: node.name }),
  )
  if (!res.ok) return

  await trash.softDelete([id])
  // 先广播再收尾，避免其它标签页先收到「可以编辑了」又立刻被关闭
  notifyFiles(id, true)
  if (state.current?.id === id) closeCurrent()
  await refreshFiles()
  // 删掉的是工作区：右侧会话区还挂着它的历史，必须重画回落到列表（§8.9「不得白屏」）
  if (workspace) renderRightContent()
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
  const workspace = node.kind === 'folder' ? node.aiWorkspace : undefined
  // 工作区硬删要连会话一起清（W-09）：先把会丢掉多少写进确认框，软删时不提这一句
  const stats = workspace ? await workspaceChatStats(workspace.id) : null
  const res = await confirmDialog(
    t(workspace ? 'ai.ws.purgeTitle' : 'confirm.purgeTitle'),
    workspace && stats
      ? t('ai.ws.purgeBody', {
          name: node.name,
          sessions: stats.sessions,
          messages: stats.messages,
        })
      : t('confirm.purgeBody', { name: node.name }),
  )
  if (!res.ok) return

  const gone = await trash.purge([id])
  if (workspace) await clearWorkspace(workspace.id)
  await forgetDeleted(gone)
  await refreshFiles()
  if (workspace) renderRightContent()
  toast(t('toast.purged', { n: gone.length }))
}

async function emptyTrash(): Promise<void> {
  if (!trash.trashItems(state.files).length) return
  const res = await confirmDialog(t('confirm.emptyTrashTitle'), t('confirm.emptyTrashBody'))
  if (!res.ok) return

  // 先把回收站里的工作区记下来：清空之后节点就查不到了，会话却得跟着一起清（W-09）
  const doomed: Array<{ nodeId: string; workspaceId: string }> = []
  for (const node of state.files) {
    if (node.deletedAt === null || node.kind !== 'folder' || !node.aiWorkspace) continue
    doomed.push({ nodeId: node.id, workspaceId: node.aiWorkspace.id })
  }

  const gone = await trash.emptyTrash()
  const stillGone = new Set(gone)
  for (const item of doomed) {
    if (stillGone.has(item.nodeId)) await clearWorkspace(item.workspaceId)
  }
  await forgetDeleted(gone)
  await refreshFiles()
  if (doomed.length) renderRightContent()
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

/** 面板只有一页可见，刷新都走内容实例，免得几页抢着写 DOM */
function renderActivePanel() {
  if (!state.previewOpen) return
  const id = activeContentId('right')
  const content = id ? contentById(id) : null
  void content?.render()
}

let previewSeq = 0

function currentTheme(): 'dark' | 'light' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

/**
 * 渲染预览。
 * 异步：拿到 HTML 时文档可能已经变了，用 seq 丢弃过期结果。
 * 返回 Promise 供「必须等渲染落地」的场景（打印）await。
 */
async function renderPreviewInto(host: HTMLElement): Promise<void> {
  if (!previewContent.isVisible()) return
  // 预览只画 Markdown：切到日志之类的文件时由 syncPanelButtons 转到大纲，
  // 别把几十 MB 文本丢给 marked
  if (!isMarkdownLike(currentLang())) return
  const seq = ++previewSeq
  const scrollTop = host.scrollTop
  const text = state.text
  const html = await renderMarkdown(text)
  // 渲染是异步的：拿到结果时文档、面板或主题可能已经变了
  if (seq !== previewSeq || !previewContent.isVisible()) return
  host.innerHTML = html
  // 先复原一次滚动位置（没有图表的文档就到此为止），
  // 图表从占位换成 svg 会改变高度，渲染完再校正一次
  if (seq !== previewSeq) return
  host.scrollTop = scrollTop
  await hydrateDiagrams(host, () => seq === previewSeq && previewContent.isVisible())
  if (seq === previewSeq) host.scrollTop = scrollTop
}

/** 预览里的图表语言；新增图表库时只改这一处 */
const DIAGRAM_SELECTOR = '.mermaid-block, .graphviz-block, .plantuml-block'

/**
 * 把占位块画成图。
 *
 * 三个引擎都按「文档里真有才加载」处理：mermaid 4MB、viz 1.2MB，
 * 首屏包不该为没出现的图表付钱。顺序固定 mermaid → graphviz → plantuml，
 * 纯属历史顺序；plantuml 放最后是因为它最慢（要等网络）。
 */
async function hydrateDiagrams(body: HTMLElement, isAlive: () => boolean) {
  const theme = currentTheme()
  if (body.querySelector('.mermaid-block')) {
    const { renderMermaidBlocks } = await import('../ui/mermaid')
    if (!isAlive()) return
    await renderMermaidBlocks(body, theme)
  }
  if (body.querySelector('.graphviz-block')) {
    const { renderGraphvizBlocks } = await import('../ui/graphviz')
    if (!isAlive()) return
    await renderGraphvizBlocks(body, theme)
  }
  if (body.querySelector('.plantuml-block')) {
    const { renderPlantumlBlocks } = await import('../ui/plantuml')
    if (!isAlive()) return
    await renderPlantumlBlocks(body, theme)
  }
}

/** 换主题后图表要按新配色重画，正文本身走 CSS 变量不用重建 */
function refreshPreviewTheme() {
  if (!previewContent.isVisible()) return
  if (!previewContent.root.querySelector(DIAGRAM_SELECTOR)) return
  void renderPreviewInto(previewContent.root)
}

let mindmapTimer = 0

function schedulePreview() {
  // 文本变了：导图、幻灯片和预览是同一份文本的三种画法，一起排队重画
  scheduleMindmap()
  schedulePpt()
  if (!previewContent.isVisible()) return
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => void renderPreviewInto(previewContent.root), 250)
}

/** 导图要建整棵树再布局，比预览重，防抖拉长一点 */
function scheduleMindmap() {
  if (!mindmapContent.isVisible()) return
  window.clearTimeout(mindmapTimer)
  mindmapTimer = window.setTimeout(() => {
    renderMindmapInto(mindmapContent.root)
  }, 350)
}

let pptTimer = 0

/** 幻灯片要先解析成页再逐页渲染，防抖和导图一致 */
function schedulePpt() {
  if (!pptContent.isVisible()) return
  window.clearTimeout(pptTimer)
  pptTimer = window.setTimeout(() => renderDeckInto(pptContent.root), 300)
}

/**
 * 幻灯片的渲染入口。
 *
 * 解析是同步的纯字符串扫描，页内容按需渲染（view 层用 IntersectionObserver
 * 只看视口附近那几页），所以大文档不会一次性把几百页塞进 DOM。
 * 超过 light 上限的文件直接给提示：分页解析要扫全文，这时它和预览一样是负担。
 */
function renderDeckInto(host: HTMLElement): void {
  if (!pptContent.isVisible()) return
  if (!supportsDocView(currentLang(), 'ppt')) return
  // 按钮跟着文档状态走：不是演示文稿、或只有一页时不该亮着
  syncDeckActions()

  if (state.text.length > LIMITS.light) {
    const tip = document.createElement('p')
    tip.className = 'deck-empty'
    tip.textContent = t('deck.tooBig')
    host.replaceChildren(tip)
    return
  }

  renderDeck(host, parseDeck(state.text), {
    // 只有换文件才把缩放与位置归零；打字触发的重画保留当前视野
    viewKey: state.current?.id ?? '',
    onJump: (line) => {
      state.editor?.goToLine(line)
      state.editor?.focus()
    },
    // 图表的三个引擎按需加载，页被换掉或面板收起后就别再画了
    // 返回 Promise：图表 hydrate 完高度会变，视图层要再量一次是否放得下
    onPageRendered: (slot) => hydrateDiagrams(slot, () => slot.isConnected && pptContent.isVisible()),
  })
}

/* ----------------------------------------------------------- 放映与导出 */

/** 单张图片内联上限：再大就不进导出文件，别让一份演示文稿变成几十 MB */
const DECK_IMAGE_MAX = 512 * 1024

/** 放映窗口标题 / 导出文件名：当前文件名去掉扩展名 */
function deckTitle(): string {
  const name = state.current?.name ?? t('action.newDeck')
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * 把页内相对路径的图片换成 `data:`。
 *
 * 播放器在新窗口里没有基址（`about:blank`），导出的 `.html` 也可能被挪到别处，
 * 所以相对路径的图必须内联。工作区是**扁平**节点表，markdown 里的 `img/a.png`
 * 没有目录可依，这里按文件名匹配资产 —— 同名取第一个。找不到就原样留着：
 * 放映时是坏图，但不会把整份文档弄坏。
 */
async function inlineDeckImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img[src]'))
  for (const img of images) {
    const src = img.getAttribute('src') ?? ''
    if (!src || /^(data:|https?:|blob:|\/\/)/i.test(src)) continue

    let name = src.split(/[?#]/)[0]
    try {
      name = decodeURIComponent(name)
    } catch {
      /* 编码坏了就按原样比 */
    }
    name = name.split('/').pop() ?? ''
    const node = state.files.find(
      (item) => item.kind === 'file' && item.asset && item.deletedAt === null && item.name === name,
    )
    if (!node) continue

    const content = await store.getContent(node.id)
    const blob = content?.blob ?? content?.originalBytes
    if (!blob) continue
    if (blob.size > DECK_IMAGE_MAX) {
      const note = document.createElement('span')
      note.className = 'deck-image-note'
      note.textContent = t('deck.imageTooBig', { name })
      img.replaceWith(note)
      continue
    }
    const dataUrl = await blobToDataUrl(blob)
    if (dataUrl) img.setAttribute('src', dataUrl)
  }
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

/**
 * 把当前文档渲染成放映器需要的每页数据。
 *
 * 不在面板 DOM 上抄：面板用 IntersectionObserver 只渲染视口附近那几页，抄出来一半是空槽。
 * 这里逐页 `renderMarkdown()` 再就地 hydrate 图表，拿到的是内联 SVG，放映与面板同源。
 */
async function buildPlayerPages(pages: readonly DeckPage[]): Promise<PlayerPage[]> {
  const out: PlayerPage[] = []
  for (const page of pages) {
    const box = document.createElement('div')
    box.className = 'deck-page-inner markdown-body'
    box.innerHTML = await renderMarkdown(page.source)
    await hydrateDiagrams(box, () => true)
    await inlineDeckImages(box)
    const { classes, background } = page.props
    out.push({
      html: box.innerHTML,
      // 与 `view.ts` 同一套规则：默认居中，`left` / `top` 才关掉
      align: classes.includes('left') ? 'left' : 'center',
      valign: classes.includes('top') ? 'top' : 'middle',
      color: background.color,
      image: background.image,
      size: background.size,
      position: background.position,
      notes: page.notes,
    })
  }
  return out
}

/** 当前文档能否放映：有页、且没过 light 上限 */
function canPlayDeck(): boolean {
  if (!state.current) return false
  if (state.text.length > LIMITS.light) return false
  return parseDeck(state.text).pages.length > 0
}

/**
 * 打开放映：新窗口优先，被拦截就退到本页 iframe 全屏。
 *
 * `window.open()` 必须卡在点击的同一个任务里，所以先开一个占位窗口，
 * 渲染完（视文档大小几百毫秒）再 `document.write` 把整份文档写进去。
 */
async function openDeckPlayer(): Promise<void> {
  const doc = parseDeck(state.text)
  if (doc.pages.length === 0) {
    toast(t('deck.empty'), 'error')
    return
  }
  if (state.text.length > LIMITS.light) {
    toast(t('deck.tooBig'), 'error')
    return
  }

  const title = deckTitle()
  // 先占窗口：这一步之后再 await 多久，都不会被弹窗拦截
  let win: Window | null = null
  try {
    win = window.open('', '_blank')
  } catch {
    win = null
  }
  if (win) {
    win.document.write(playerPlaceholder(title))
    win.document.close()
  }

  try {
    const pages = await buildPlayerPages(doc.pages)
    const html = renderDeckHtml({
      title,
      ratio: doc.ratio,
      theme: currentTheme(),
      pages,
      helpText: specMarkdown(),
    })
    if (win && !win.closed) {
      win.document.open()
      win.document.write(html)
      win.document.close()
      return
    }
    playDeckInline(html)
  } catch (err) {
    win?.close()
    toast((err as Error).message, 'error')
  }
}

/**
 * 新窗口被拦截时的退路：在当前页铺一层全屏 iframe。
 * 播放器里的 Esc 会 `postMessage` 出来 —— iframe 的键盘事件不冒泡到外层。
 */
function playDeckInline(html: string): void {
  const frame = document.createElement('iframe')
  frame.className = 'deck-player-frame'
  frame.title = deckTitle()
  frame.setAttribute('allow', 'fullscreen')
  frame.srcdoc = html
  document.body.appendChild(frame)
  toast(t('deck.player.blocked'))

  const onMessage = (event: MessageEvent) => {
    if ((event.data as { type?: string } | null)?.type !== 'deck-exit') return
    window.removeEventListener('message', onMessage)
    frame.remove()
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  }
  window.addEventListener('message', onMessage)
}

/** 导出：整份演示文稿存成一个自包含的 `.html`，双击就能放 */
async function exportDeckHtml(): Promise<void> {
  const doc = parseDeck(state.text)
  if (doc.pages.length === 0) {
    toast(t('deck.empty'), 'error')
    return
  }
  if (state.text.length > LIMITS.light) {
    toast(t('deck.tooBig'), 'error')
    return
  }
  try {
    const pages = await buildPlayerPages(doc.pages)
    const html = renderDeckHtml({
      title: deckTitle(),
      ratio: doc.ratio,
      theme: currentTheme(),
      pages,
      helpText: specMarkdown(),
    })
    downloadBlob(`${deckTitle()}.html`, new Blob([html], { type: 'text/html;charset=utf-8' }))
    toast(t('deck.exported'))
  } catch (err) {
    toast((err as Error).message, 'error')
  }
}

/** 面板头的放映 / 导出按钮只对「真的能放的演示文稿」亮 */
function syncDeckActions(): void {
  const ok = canPlayDeck()
  el<HTMLButtonElement>('deckOpen').disabled = !ok
  el<HTMLButtonElement>('deckExport').disabled = !ok
}

/**
 * 导图的渲染入口。
 *
 * 数据树由 mindmap.ts 建好交给 markmap，布局/连线/缩放/折叠都由引擎管。
 * 大文件不整块放弃：建树时按节点数截断，截断点之前的偏移和原文一致，点节点仍能跳行。
 */
function renderMindmapInto(host: HTMLElement): void {
  if (!mindmapContent.isVisible()) return
  if (!supportsDocView(currentLang(), 'mindmap')) return
  renderMindmap(host, state.text, {
    // 只有换文件才把视野归零；打字触发的重画保留当前缩放与位置
    viewKey: state.current?.id ?? '',
    // 导出 SVG 用当前文档名，导出面板里显示的原名比「mindmap.svg」有用
    exportName: state.current?.name ?? '',
    onJump: (line) => {
      state.editor?.goToLine(line)
      state.editor?.focus()
    },
  })
}

/* -------------------------------------------------------------- 代码检查 */

/**
 * 调度器（plans/diagnostics.md §7.4）。
 *
 * 关键约束：这里挂在 app 层，**不**挂在面板上。面板只决定画不画，
 * 计算照常进行——否则「面板关了就偷偷不检查」是必然出的事故。
 */

interface DiagCache {
  key: string
  issues: Issue[]
}

let diagIssues: Issue[] = []
/** 当前结果对应的缓存键；内容一变就过期，但旧结果继续显示不清空 */
let diagKey = ''
/** 至少有一项检查跑过。false + 0 条 = 「没查」，不是「干净」 */
let diagRan = false
let diagTimer = 0
/** 递增即作废上一轮结果：编辑中跑完的旧结果不许覆盖新结果 */
let diagSeq = 0
/** 排入队列或正在计算：状态栏据此切 loading */
let diagBusy = false
let issuesOptionsOpen = false

const DIAG_DEBOUNCE = 600

function diagChecks(): ChecksSettings {
  return { ...DEFAULT_CHECKS, ...getSettings().checks }
}

/** 用户自己加的「忽略的单词」，只给拼写两项用 */
function diagIgnore(): string[] {
  const list = getSettings().spellIgnore
  return Array.isArray(list) ? list : []
}

/** Markdown 细则的逐条开关：只存和默认值不同的，缺省由 MD_RULES 决定 */
function diagMdRules(): Record<string, boolean> {
  const rules = getSettings().mdRules
  return rules && typeof rules === 'object' ? rules : {}
}

/** MD013 的行长阈值；坏值一律当默认的 120 */
function diagMdLineLength(): number {
  const width = getSettings().mdLineLength
  return Number.isFinite(width) && width >= 40 ? Math.round(width) : 120
}

function diagKeyFor(text: string, lang: LangId, name: string, checks: ChecksSettings): string {
  // 忽略词变了结果也会变，必须进 key，否则改完设置面板还挂旧波浪线
  const ignore = diagIgnore()
  const ignoreTag = ignore.length > 0 ? contentHash(ignore.join(',')) : ''
  // 细则开关与行长阈值同理：动了就得作废旧结果，不然波浪线跟面板对不上
  const mdRules = diagMdRules()
  const mdTag =
    Object.keys(mdRules).length > 0
      ? contentHash(
          Object.entries(mdRules)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([id, on]) => `${id}:${on ? 1 : 0}`)
            .join(',') + `|${diagMdLineLength()}`,
        )
      : `|${diagMdLineLength()}`
  return `${DIAG_VERSION}|${contentHash(text)}|${lang}|${name}|${checksMask(checks)}|${ignoreTag}|${mdTag}`
}

function isSpellCheck(id: CheckKind): boolean {
  return id === 'spell' || id === 'spellIdent'
}

/** 只有真的要查拼写时才拉词典；拉好之后重跑一次（此前的空结果不算数） */
let dictWatched = false
function watchDictReady(): void {
  ensureDict()
  if (dictWatched) return
  dictWatched = true
  onDictReady(() => {
    diagKey = ''
    scheduleDiagnostics(0)
  })
  // 失败时不重跑（没结果可出），但面板要把空态从「无问题」改成「词典不可用」
  onDictFailed(() => {
    if (issuesContent.isVisible()) renderIssuesPanel(issuesContent.root)
  })
}

/** 偏移 → 行号。只在点击跳转时用一次，不值得为它建索引 */
function lineOfOffset(text: string, offset: number): number {
  let line = 1
  const end = Math.min(Math.max(offset, 0), text.length)
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * 打开文件后先查缓存，命中就秒出（DG-09）。
 * 与内容一起存的还有规则版本、语言、勾选项：任一项变了都必须重跑，
 * 否则用户会看到「旧规则的结果」，那比看到空白更容易被当成 bug。
 */
async function primeDiagnostics(): Promise<void> {
  const seq = ++diagSeq
  window.clearTimeout(diagTimer)
  diagIssues = []
  diagRan = false
  diagKey = ''
  diagBusy = false

  const rec = state.current
  if (!rec) {
    state.editor?.setIssues([])
    syncDiagBadge()
    return
  }

  const text = state.text
  const key = diagKeyFor(text, currentLang(), rec.name, diagChecks())
  syncDiagBadge()

  let cached: DiagCache | undefined
  try {
    cached = await store.getMeta<DiagCache>(`diag:${rec.id}`)
  } catch {
    cached = undefined
  }
  // 等 DB 的这几毫秒里可能已经切了文件、或者又挂了一次编辑器
  if (seq !== diagSeq || state.current?.id !== rec.id) return

  if (cached && cached.key === key) {
    diagIssues = cached.issues
    diagRan = true
    diagKey = key
    applyDiagnostics()
    return
  }
  scheduleDiagnostics(0)
}

/** 内容/配置变了：重排一次检查。`delay` 只给「刚打开」这类可以立刻跑的场合用 0 */
function scheduleDiagnostics(delay = DIAG_DEBOUNCE): void {
  window.clearTimeout(diagTimer)
  if (!state.current) {
    diagBusy = false
    syncDiagBadge()
    return
  }
  // pending 阶段就切 loading：从按下键到出结果之间必须看得出「在做事」
  diagBusy = true
  syncDiagBadge()
  diagTimer = window.setTimeout(() => runDiagnostics(), delay)
}

function runDiagnostics(): void {
  const rec = state.current
  if (!rec) return

  const text = state.text
  const lang = currentLang()
  const checks = diagChecks()
  const key = diagKeyFor(text, lang, rec.name, checks)

  // 内容没变（例如只是切了只读）就别白扫一遍
  if (key === diagKey) {
    diagBusy = false
    syncDiagBadge()
    return
  }

  const seq = ++diagSeq
  diagBusy = true
  syncDiagBadge()

  const commit = () => {
    if (seq !== diagSeq) return
    const result = analyze({
      text,
      lang,
      name: rec.name,
      checks,
      ignore: diagIgnore(),
      mdRules: diagMdRules(),
      mdLineLength: diagMdLineLength(),
    })
    // 幻灯片结构告警：只在真的分了页（≥2 页）的文档上产出
    // （普通 Markdown 里的 `---` 是分隔线，按分页报就是误报）
    const deck = deckWarnings(text, lang, checks)
    // 算的过程中又改了/又切了文件：这一份已经过期，丢掉
    if (seq !== diagSeq || state.current?.id !== rec.id) return
    diagIssues = deck.length > 0 ? [...result.issues, ...deck] : result.issues
    diagRan = result.ran
    diagKey = key
    diagBusy = false
    applyDiagnostics()
    void store.setMeta(`diag:${rec.id}`, { key, issues: diagIssues } as DiagCache)
  }

  // 几十 KB 以上让出一帧再算，别和输入抢同一个任务
  if (text.length > 64 * 1024) window.setTimeout(commit, 0)
  else commit()
}

/**
 * 幻灯片结构告警（`specCheck` → `Issue`）。
 *
 * 挂进 `mdLint` 这一项而不是新开一个 `CheckKind`：它和 Markdown 细则同属"排版写法"，
 * 新开一项要为它补类型、默认值、能力矩阵、设置面板、筛选列表五处，收益不成比例。
 * 所以开关跟着 `mdLint` 走，用户在面板里关掉 Markdown 细则时这些也一起消失。
 */
function deckWarnings(text: string, lang: LangId, checks: ChecksSettings): Issue[] {
  if (!checks.mdLint || !supportsDocView(lang, 'ppt')) return []
  return specCheck(text).map((item) => ({
    from: item.from,
    to: Math.max(item.from + 1, item.to),
    severity: 'warning' as const,
    kind: 'mdLint' as const,
    key: item.key,
    source: 'deckSpec',
  }))
}

/** 结果落地：编辑器波浪线 + 状态栏 + 面板（面板只在看得见时才画） */
function applyDiagnostics(): void {
  state.editor?.setIssues(toRendered(diagIssues))
  syncDiagBadge()
  if (issuesContent.isVisible()) renderIssuesPanel(issuesContent.root)
}

/**
 * 状态栏徽标。六种「没结果」必须分开表达（DG-08）：
 * 全关 / 语言不支持 / 文件太大 / 正在跑，混成一句「无问题」就没人再信它了。
 */
function syncDiagBadge(): void {
  const rec = state.current
  if (!rec) {
    sb.setDiagnostics('idle')
    return
  }

  let errors = 0
  let warnings = 0
  for (const issue of diagIssues) {
    if (issue.severity === 'error') errors++
    else warnings++
  }

  if (state.text.length > MAX_TEXT) {
    sb.setDiagnostics('big', errors, warnings, formatBytes(MAX_TEXT))
    return
  }

  const checks = diagChecks()
  const lang = currentLang()
  if (enabledChecks(checks).length === 0) {
    sb.setDiagnostics('off')
    return
  }
  // 「一项都跑不了」= 无检查。注意这一步必须在 running 之前：
  // 否则一个永远跑不完的转圈会让人以为还在算
  if (!hasRunnable(checks, lang, rec.name)) {
    sb.setDiagnostics('na')
    return
  }

  if (diagBusy || !diagRan) {
    // 转圈，但上一次的计数压暗留着，比整块清空更像「正在更新」
    sb.setDiagnostics('running', errors, warnings)
    return
  }
  sb.setDiagnostics(errors > 0 || warnings > 0 ? 'ok' : 'clean', errors, warnings)
}

/**
 * 每条 Markdown 细则这次报了几条：开关旁边标个数，一眼看出哪条在吵。
 * 数的是**本次报告里**的条数（单条规则有产量上限，见 MAX_PER_RULE），不是全文命中数。
 */
function mdRuleCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const issue of diagIssues) {
    if (issue.kind !== 'mdLint') continue
    // key 形如 `md.MD009`：剥前缀而不是按固定长度切，前缀改了也不会静默串号
    const id = String(issue.key).replace(/^md\./, '')
    counts[id] = (counts[id] ?? 0) + 1
  }
  return counts
}

function renderIssuesPanel(host: HTMLElement): void {
  const rec = state.current
  const checks = diagChecks()
  const lang = currentLang()
  const availability = availabilityFor(lang, rec?.name ?? '')
  const enabled = enabledChecks(checks)

  let phase: IssuesPhase = 'idle'
  if (!rec) phase = 'na'
  else if (state.text.length > MAX_TEXT) phase = 'big'
  else if (enabled.length === 0) phase = 'off'
  else if (!hasRunnable(checks, lang, rec.name)) phase = 'na'
  else if (diagBusy || !diagRan) phase = 'running'

  renderIssues(
    host,
    {
      phase,
      issues: diagIssues,
      stale: diagBusy && diagIssues.length > 0,
      checks,
      optionsOpen: issuesOptionsOpen,
      text: state.text,
      bigLimit: formatBytes(MAX_TEXT),
      availability,
      naReason: rec && phase === 'na' ? dominantReason(checks, lang, rec.name) : null,
      spellIgnore: diagIgnore(),
      mdRules: [...enabledMdRules(diagMdRules())],
      mdCounts: mdRuleCounts(),
      mdLineLength: diagMdLineLength(),
      dictFailed: dictFailed(),
      lang,
    },
    {
      onToggleCheck: (id: CheckKind) => {
        const next: ChecksSettings = { ...checks, [id]: !checks[id] }
        updateSettings({ checks: next })
        // 刚打开拼写：这时候才去下载词典（不打开就永远不下载）
        if (isSpellCheck(id) && next[id]) watchDictReady()
        // 勾选变了，旧结果立刻作废：不能让已经关掉的检查继续挂着波浪线
        diagKey = ''
        diagIssues = []
        diagRan = false
        state.editor?.setIssues([])
        scheduleDiagnostics(0)
        renderIssuesPanel(host)
      },
      onJump: (issue: Issue) => {
        state.editor?.goToLine(lineOfOffset(state.text, issue.from))
        state.editor?.focus()
      },
      onRerun: () => {
        diagKey = ''
        scheduleDiagnostics(0)
        renderIssuesPanel(host)
      },
      onSpellIgnoreChange: (raw: string) => {
        updateSettings({ spellIgnore: parseIgnoreWords(raw) })
        // 词表变了结果就变了：作废旧结果，重跑一次
        diagKey = ''
        diagIssues = []
        diagRan = false
        state.editor?.setIssues([])
        scheduleDiagnostics(0)
        renderIssuesPanel(host)
      },
      onToggleMdRule: (id: string) => {
        // 只写「和默认值不一样」的：关掉默认开的写 false，打开默认关的写 true
        const on = enabledMdRules(diagMdRules())
        updateSettings({ mdRules: { ...diagMdRules(), [id]: !on.has(id) } })
        diagKey = ''
        diagIssues = []
        diagRan = false
        state.editor?.setIssues([])
        scheduleDiagnostics(0)
        renderIssuesPanel(host)
      },
      onMdLineLengthChange: (raw: string) => {
        const width = Number.parseInt(raw, 10)
        // 40 以下中文一段话就超了，400 以上等于关掉这条规则
        updateSettings({ mdLineLength: Number.isFinite(width) ? Math.min(400, Math.max(40, width)) : 120 })
        diagKey = ''
        diagIssues = []
        diagRan = false
        state.editor?.setIssues([])
        scheduleDiagnostics(0)
        renderIssuesPanel(host)
      },
    },
  )
}

/** 「忽略的单词」：逗号/空格/顿号分隔都认，统一小写去重 */
function parseIgnoreWords(raw: string): string[] {
  const seen = new Set<string>()
  for (const piece of raw.split(/[\s,，、;；]+/)) {
    const word = piece.trim().toLowerCase()
    if (word) seen.add(word)
  }
  return [...seen]
}

/* ---------------------------------------------------------------- 大纲 */

let outlineItems: OutlineItem[] = []
let outlineTimer = 0
/** 光标行，用来在大纲里标出「你在哪一节」 */
let cursorLine = 1
/** 光标列（1 基）。AI 的位置块要报「第几行第几列」，只报行会让模型猜错缩进位置 */
let cursorCol = 1

function renderOutlineInto(host: HTMLElement) {
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
  if (!outlineContent.isVisible()) return
  window.clearTimeout(outlineTimer)
  outlineTimer = window.setTimeout(() => renderOutlineInto(outlineContent.root), 350)
}

/** 标出光标所在条目；只在滚出可视范围时才滚动，否则每敲一个字整列都在抖 */
function syncOutlineActive() {
  if (!outlineContent.isVisible()) return
  const host = outlineContent.root
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
      if (filesContent.isVisible()) {
        e.preventDefault()
        selectSiblings()
        return
      }
    }

    // F2：重命名当前文件，顺手把面板切到文件页并展开
    if (e.key === 'F2' && state.current && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      const id = state.current.id
      void showContent('left', 'files').then(() => beginRename(id))
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
      renderLeftContent()
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
  // 这一页的骨架归 searchContent 所有，随时可能不在文档里：一律从自己的树里取
  const pick = <T extends HTMLElement>(id: string) => searchContent.root.querySelector<T>('#' + id)!
  const options = pick('searchOptions')
  const optBtn = pick('searchOptionsBtn')
  const goBtn = pick('searchGo')
  pick('searchClear').hidden = state.search === ''
  pick<HTMLInputElement>('searchDeep').checked = deepSearch
  pick<HTMLInputElement>('searchBig').checked = bigSearch
  // 放大镜按钮只在开了设置时出现；词改过就点亮，提示该按了
  goBtn.hidden = !manualSearch()
  goBtn.classList.toggle('is-ready', searchStale)
  optBtn.classList.toggle('is-on', manualSearch() || !options.hidden)
  optBtn.setAttribute('aria-expanded', String(!options.hidden))
  renderSearchResults(
    pick('searchResults'),
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
      void searchContent.render()
    }
  }
}

/** 命中的是文件夹：切回文件页、展开祖先再定位 —— 搜索页里没有树可展开 */
async function revealSearchHit(id: string) {
  let parent = state.files.find((n) => n.id === id)?.parentId ?? null
  while (parent) {
    state.expanded.add(parent)
    parent = state.files.find((n) => n.id === parent)?.parentId ?? null
  }
  saveExpanded()
  // 祖先先展开再挂载，免得先画一遍收起的树再重画
  await showContent('left', 'files')
  revealNode(id)
}

/** Cmd/Ctrl+P：直接落到搜索页并聚焦输入框，比在文件树里翻快得多 */
function openQuickSwitch() {
  const options = searchContent.root.querySelector<HTMLElement>('#searchOptions')
  if (options) options.hidden = true
  void showContent('left', 'search').then(() => {
    const input = searchContent.root.querySelector<HTMLInputElement>('#searchInput')
    input?.focus()
    input?.select()
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
