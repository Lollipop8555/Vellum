import type { LangId } from './editors/lang-registry'

export type EngineId = 'cm' | 'monaco'

export type EncodingId =
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  | 'gb18030'
  | 'big5'
  | 'shift_jis'
  | 'windows-1252'

export type NodeKind = 'file' | 'folder'

/**
 * 文件与文件夹共享的元信息。内容不在这里——见 ContentRecord。
 * 设计依据：plans/resource-management.md §3
 */
export interface NodeBase {
  id: string
  kind: NodeKind
  /** 权威全名，含后缀。重命名只改这里 */
  name: string
  /** 派生冗余：小写、不含点、无后缀为 ''。由 splitName(name) 计算，禁止手写 */
  ext: string
  /** NFC + toLowerCase(name)，用于唯一性比较与搜索 */
  nameKey: string
  /** null = 根目录下 */
  parentId: string | null
  createdAt: number
  /** 仅内容变更时更新；重命名、移动、改属性一律不改 */
  updatedAt: number
  /** 软删除时间；null = 未删除。只有「删除动作的顶层节点」带值 */
  deletedAt: number | null
}

export interface FileNode extends NodeBase {
  kind: 'file'
  size: number
  /** 用户手动指定的语言；null = 自动 */
  langOverride: LangId | null
  /** 有效语言，落库定值。运行时直接使用，不嗅探 */
  lang: LangId
  /** 仅用于属性面板展示语言来源 */
  langSource: 'ext' | 'sniff' | 'manual'
  /** 当前存储编码。规范化导入后恒为 'utf-8' */
  encoding: EncodingId
  /** 导入时探测到的源编码，仅用于展示；首次内容变更后清空 */
  sourceEncoding?: EncodingId
  eol: 'lf' | 'crlf'
  engine: EngineId
  /** 用户主动锁定（跨标签页生效，落库） */
  readOnlyUser: boolean
}

export interface FolderNode extends NodeBase {
  kind: 'folder'
}

export type NodeRecord = FileNode | FolderNode

/** 文件内容，按需读取。缺失 = 空文件 */
export interface ContentRecord {
  /** === FileNode.id */
  id: string
  /** 规范形态字节（UTF-8，已应用 eol）；未编辑文件可能不存在 */
  blob?: Blob
  /** 原始字节，供「以其他编码重新解码」与逐字节保真导出 */
  originalBytes?: Blob
}

/**
 * 运行时打开视图：节点元信息 + 内容 + 会话态。
 * blob/dirty/readOnly 都是会话态，永远不落库。
 */
export interface OpenFile extends FileNode {
  blob: Blob | null
  dirty: boolean
  /** 合成值：readOnlyUser || 他人持锁 || 大文件只读模式 */
  readOnly: boolean
}

export interface SnapshotRecord {
  id: string
  fileId: string
  blob: Blob
  createdAt: number
  note: string
}

export interface MetaRecord {
  key: string
  value: unknown
}

export type FileMode = 'full' | 'light' | 'readonly'

export interface OpenResult {
  text: string
  encoding: EncodingId
  eol: 'lf' | 'crlf'
  size: number
}

export interface Settings {
  theme: 'dark' | 'light'
  language: 'zh' | 'en' | 'auto'
  fontSize: number
  accentOn: boolean
  defaultEngine: EngineId
  wordWrap: boolean
  /** Markdown 预览面板宽度，单位 px */
  panelWidth: number
  /** 左侧抽屉宽度，单位 px；层级深的目录树靠它撑开 */
  drawerWidth: number
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  language: 'auto',
  fontSize: 13,
  accentOn: true,
  defaultEngine: 'cm',
  wordWrap: false,
  panelWidth: 440,
  drawerWidth: 264,
}
