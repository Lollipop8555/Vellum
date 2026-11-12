/**
 * 节点工厂与属性计算。所有节点写库前都必须经过这里，
 * 以保证 name / ext / nameKey 三者永远同步（不变式 5）。
 */
import type {
  ContentRecord,
  EncodingId,
  EngineId,
  FileNode,
  FolderNode,
  OpenFile,
} from '../types'
import type { LangId } from '../editors/lang-registry'
import { deriveExt, normalizeName } from './tree'

export interface NewFileInput {
  name: string
  parentId?: string | null
  lang: LangId
  langSource?: FileNode['langSource']
  encoding?: EncodingId
  sourceEncoding?: EncodingId
  eol?: 'lf' | 'crlf'
  engine: EngineId
  size?: number
  readOnlyUser?: boolean
}

export function createFileNode(input: NewFileInput): FileNode {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    kind: 'file',
    name: input.name,
    ext: deriveExt(input.name),
    nameKey: normalizeName(input.name),
    parentId: input.parentId ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    size: input.size ?? 0,
    langOverride: null,
    lang: input.lang,
    langSource: input.langSource ?? 'ext',
    encoding: input.encoding ?? 'utf-8',
    ...(input.sourceEncoding ? { sourceEncoding: input.sourceEncoding } : {}),
    eol: input.eol ?? 'lf',
    engine: input.engine,
    readOnlyUser: input.readOnlyUser ?? false,
  }
}

export function createFolderNode(name: string, parentId: string | null = null): FolderNode {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    kind: 'folder',
    name,
    ext: deriveExt(name),
    nameKey: normalizeName(name),
    parentId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }
}

/** 改名：只动 name 与派生列，id / 内容 / updatedAt 全不变（D-11） */
export function applyName<T extends FileNode | FolderNode>(node: T, name: string): T {
  return {
    ...node,
    name,
    ext: deriveExt(name),
    nameKey: normalizeName(name),
  }
}

/** 从运行时视图剥离会话态，得到可落库的节点 */
export function toNode(open: OpenFile): FileNode {
  return {
    id: open.id,
    kind: 'file',
    name: open.name,
    ext: open.ext,
    nameKey: open.nameKey,
    parentId: open.parentId,
    createdAt: open.createdAt,
    updatedAt: open.updatedAt,
    deletedAt: open.deletedAt,
    size: open.size,
    langOverride: open.langOverride,
    lang: open.lang,
    langSource: open.langSource,
    encoding: open.encoding,
    ...(open.sourceEncoding ? { sourceEncoding: open.sourceEncoding } : {}),
    eol: open.eol,
    engine: open.engine,
    readOnlyUser: open.readOnlyUser,
  }
}

/**
 * 由节点与内容拼出运行时视图。
 * blob 缺失（空文件或未编辑且尚未物化）时按空内容处理。
 */
export function toOpen(
  node: FileNode,
  content: ContentRecord | undefined,
  opts: { locked?: boolean; mode?: 'full' | 'light' | 'readonly' } = {},
): OpenFile {
  const readOnly =
    node.readOnlyUser || Boolean(opts.locked) || opts.mode === 'readonly'
  return {
    ...node,
    blob: content?.blob ?? null,
    dirty: false,
    readOnly,
  }
}

/** 内容变更：更新 size 与 updatedAt，并按不变式 2 丢弃原始字节 */
export function bumpContent(
  node: FileNode,
  size: number,
  at = Date.now(),
): FileNode {
  const { sourceEncoding: _drop, ...rest } = node
  return { ...rest, size, updatedAt: at }
}
