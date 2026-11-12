/**
 * 文件树纯函数层。
 *
 * 铁律（plans/resource-management.md §18）：本文件不得出现 DOM 与 IndexedDB 调用。
 * 所有输入输出都是普通数据，便于单测与推理。
 */
import type { FileNode, FolderNode, NodeRecord } from '../types'

/* --------------------------------------------------------------- 名称 */

/**
 * 拆分主名与后缀。中间点文件名按「最后一个点」切分：
 *   'archive.tar.gz' -> { base: 'archive.tar', ext: 'gz' }
 *   'README'         -> { base: 'README',      ext: '' }
 *   '.gitignore'     -> { base: '.gitignore',  ext: '' }  // 视为无后缀
 */
export function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot + 1) }
}

/** 唯一性比较基准：NFC 归一化 + 小写 */
export function normalizeName(name: string): string {
  return name.normalize('NFC').toLowerCase().trim()
}

/** 由全名派生 ext 列（小写、不含点） */
export function deriveExt(name: string): string {
  return splitName(name).ext.toLowerCase()
}

export type NameError = 'empty' | 'chars' | 'length' | 'reserved'

const ILLEGAL = /[\\/:*?"<>|]/
const CONTROL = /[\u0000-\u001f\u007f]/
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 校验并规整名称。
 * 返回 ok 时 name 已 trim 且去掉结尾的点与空格。
 */
export function validateName(raw: string): { ok: true; name: string } | { ok: false; reason: NameError } {
  const name = raw.trim().replace(/[.\s]+$/, '')
  if (!name) return { ok: false, reason: 'empty' }
  if (CONTROL.test(name)) return { ok: false, reason: 'chars' }
  if (ILLEGAL.test(name)) return { ok: false, reason: 'chars' }
  if (new TextEncoder().encode(name).byteLength > 255) return { ok: false, reason: 'length' }
  if (RESERVED.test(splitName(name).base)) return { ok: false, reason: 'reserved' }
  return { ok: true, name }
}

/** 同级重名时在扩展名前插入 (1)、(2)：a.txt -> a(1).txt */
export function dedupeName(name: string, taken: Set<string>): string {
  if (!taken.has(normalizeName(name))) return name
  const { base, ext } = splitName(name)
  for (let i = 1; i < 10_000; i++) {
    const candidate = ext ? `${base}(${i}).${ext}` : `${base}(${i})`
    if (!taken.has(normalizeName(candidate))) return candidate
  }
  return `${base}-${Date.now()}${ext ? '.' + ext : ''}`
}

/** 生成未被占用的「未命名-N」，taken 需包含软删除节点，避免恢复时撞名 */
export function nextUntitled(taken: Set<string>, prefix = '未命名-'): string {
  for (let i = 1; i < 100_000; i++) {
    const candidate = `${prefix}${i}`
    if (!taken.has(normalizeName(candidate))) return candidate
  }
  return `${prefix}${Date.now()}`
}

/* --------------------------------------------------------------- 结构 */

export interface TreeIndex {
  /** 根级节点（已按 sortSiblings 排序） */
  roots: NodeRecord[]
  /** parentId(null 表示根) -> 子节点（已排序） */
  children: Map<string | null, NodeRecord[]>
  /** 全部节点，含软删除的（物理删除、路径回溯需要） */
  byId: Map<string, NodeRecord>
}

/**
 * 构建树索引。
 * 软删除的节点不会进入 children，因此其整棵子树从根不可达 —— 无需二次剪枝。
 */
export function buildTree(nodes: NodeRecord[]): TreeIndex {
  const byId = new Map<string, NodeRecord>()
  for (const n of nodes) byId.set(n.id, n)

  const live = nodes.filter((n) => n.deletedAt === null)
  const children = new Map<string | null, NodeRecord[]>()
  for (const n of live) {
    const list = children.get(n.parentId)
    if (list) list.push(n)
    else children.set(n.parentId, [n])
  }
  for (const list of children.values()) list.sort(sortSiblings)

  return { roots: children.get(null) ?? [], children, byId }
}

/** 文件夹在前，同级按名称字典序 */
export function sortSiblings(a: NodeRecord, b: NodeRecord): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

/** 直接子项（含软删除），用于级联删除与计数 */
export function childrenOf(index: TreeIndex, parentId: string | null, includeDeleted = false): NodeRecord[] {
  if (includeDeleted) {
    const out: NodeRecord[] = []
    for (const n of index.byId.values()) if (n.parentId === parentId) out.push(n)
    return out.sort(sortSiblings)
  }
  return index.children.get(parentId) ?? []
}

/** 自身 + 全部后代 id（含软删除），用于物理删除 */
export function collectSubtree(index: TreeIndex, id: string): string[] {
  const kids = new Map<string, string[]>()
  for (const n of index.byId.values()) {
    if (n.parentId === null) continue
    const arr = kids.get(n.parentId)
    if (arr) arr.push(n.id)
    else kids.set(n.parentId, [n.id])
  }
  const out: string[] = []
  const seen = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    out.push(cur)
    for (const k of kids.get(cur) ?? []) stack.push(k)
  }
  return out
}

export function isDescendant(index: TreeIndex, ancestorId: string, nodeId: string): boolean {
  let cur = index.byId.get(nodeId)
  let guard = 0
  while (cur && cur.parentId !== null && guard++ < 10_000) {
    if (cur.parentId === ancestorId) return true
    cur = index.byId.get(cur.parentId)
  }
  return false
}

/** 能否把 nodeId 移到 targetParentId（null = 根）下 */
export function canMoveInto(
  index: TreeIndex,
  nodeId: string,
  targetParentId: string | null,
): boolean {
  if (targetParentId === nodeId) return false
  if (targetParentId === null) return true
  const target = index.byId.get(targetParentId)
  if (!target || target.kind !== 'folder') return false
  return !isDescendant(index, nodeId, targetParentId)
}

/** 从根到该节点的显示路径，如 'docs/api/readme.md' */
export function nodePath(index: TreeIndex, id: string, sep = '/'): string {
  const parts: string[] = []
  let cur = index.byId.get(id)
  let guard = 0
  while (cur && guard++ < 10_000) {
    parts.unshift(cur.name)
    if (cur.parentId === null) break
    cur = index.byId.get(cur.parentId)
  }
  return parts.join(sep)
}

/** 同一父级下已被占用的 nameKey 集合（含软删除） */
export function takenNames(nodes: NodeRecord[], parentId: string | null, exceptId?: string): Set<string> {
  const set = new Set<string>()
  for (const n of nodes) {
    if (n.parentId !== parentId) continue
    if (n.id === exceptId) continue
    set.add(n.nameKey)
  }
  return set
}

/** 跨级同名（仅用于软提示） */
export function hasNameElsewhere(nodes: NodeRecord[], nameKey: string, exceptId?: string): boolean {
  return nodes.some((n) => n.nameKey === nameKey && n.id !== exceptId)
}

export function isFile(n: NodeRecord): n is FileNode {
  return n.kind === 'file'
}

export function isFolder(n: NodeRecord): n is FolderNode {
  return n.kind === 'folder'
}
