/**
 * AI 项目树（S2）：把节点表翻译成虚拟地址列表。纯函数，不碰 IndexedDB。
 *
 * 依据 plans/ai-project-v2.md §4 S2。
 * - `:proj` 下列出项目根子树；
 * - `:link` 下列出授权引用（文件与文件夹递归展开）；
 * - 已删除（deletedAt 非空）的节点不出现。
 */

import type { FileNode, FolderNode, NodeRecord } from '../../types'
import { checkRead, formatUri, type VirtualUri, type Zone } from './project'

export interface TreeEntry {
  uri: string
  type: 'file' | 'folder'
  size?: number
  lang?: string
  asset?: boolean
  writable: boolean
}

export interface TreeResult {
  entries: TreeEntry[]
  truncated: boolean
}

export const MAX_TREE_ENTRIES = 300

/** 节点 id → 节点；由调用方从 state.files 构造一次，复用于整次调用 */
export type NodeMap = ReadonlyMap<string, NodeRecord>

/** 节点在某区内的相对路径（不含区根名）；区根本身返回 '' */
export function relPath(nodeId: string, rootId: string, nodes: NodeMap): string | null {
  const parts: string[] = []
  let cur: string | null = nodeId
  const seen = new Set<string>()
  while (cur !== null) {
    if (seen.has(cur)) return null
    seen.add(cur)
    if (cur === rootId) return parts.reverse().join('/')
    const node = nodes.get(cur)
    if (!node) return null
    parts.push(node.name)
    cur = node.parentId
  }
  return null
}

function alive(node: NodeRecord): boolean {
  return node.deletedAt === null
}

/**
 * 虚拟地址 → 节点 id（与 `relPath` 互逆）。
 * - `proj`：rel 从项目根起算；
 * - `link`：rel 首段为授权根的名字，之后是相对路径。
 * 找不到或同名歧义时返回 `null`（调用方映射为 not_found）。
 */
export function resolveUriToId(
  uri: VirtualUri,
  project: FolderNode,
  nodes: NodeMap,
): string | null {
  if (uri.zone === 'proj') return walkDown(project.id, uri.rel, nodes)
  const grants = project.aiWorkspace?.grants.map((g) => g.refId) ?? []
  const [head, ...rest] = uri.rel.split('/')
  for (const grantId of grants) {
    const root = nodes.get(grantId)
    if (!root || !alive(root) || root.name !== head) continue
    return walkDown(grantId, rest.join('/'), nodes)
  }
  return null
}

function walkDown(rootId: string, rel: string, nodes: NodeMap): string | null {
  let cur = rootId
  if (!rel) return cur
  for (const seg of rel.split('/')) {
    const next = [...nodes.values()].find(
      (n) => n.parentId === cur && alive(n) && n.name === seg,
    )
    if (!next) return null
    cur = next.id
  }
  return cur
}

function toEntry(
  node: NodeRecord,
  uri: VirtualUri,
  writable: boolean,
): TreeEntry {
  const common = { uri: formatUri(uri), type: node.kind, writable }
  if (node.kind === 'folder') return common
  const f = node as FileNode
  return {
    ...common,
    size: f.size,
    lang: f.lang,
    ...(f.asset ? { asset: true } : {}),
  }
}

/** 收集某区（proj 或 link）内全部活节点的虚拟地址 */
function collectZone(
  workspaceId: string,
  zone: Zone,
  rootIds: readonly string[],
  nodes: NodeMap,
  writable: boolean,
  out: TreeEntry[],
  limit: number,
): boolean {
  for (const rootId of rootIds) {
    const root = nodes.get(rootId)
    if (!root || !alive(root)) continue
    const stack: NodeRecord[] = [root]
    while (stack.length) {
      const node = stack.pop() as NodeRecord
      const rel = relPath(node.id, rootId, nodes)
      if (rel === null) continue
      const rel2 = zone === 'proj' ? rel : joinRel(root.name, rel)
      if (out.length >= limit) return true
      out.push(toEntry(node, { workspaceId, zone, rel: rel2 }, writable))
      if (node.kind === 'folder') {
        const kids = [...nodes.values()].filter((n) => n.parentId === node.id && alive(n))
        kids.sort((a, b) => a.name.localeCompare(b.name))
        for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i])
      }
    }
  }
  return false
}

function joinRel(rootName: string, rel: string): string {
  return rel ? `${rootName}/${rel}` : rootName
}

/**
 * 生成整棵授权树。
 * - 授权的 `:link` 根若已失效（被删）则跳过，不报错；
 * - `:proj` 的写权限：项目子树内全部可写；`:link` 恒只读（P-04）。
 */
export function buildTree(
  workspaceId: string,
  project: FolderNode,
  nodes: NodeMap,
  limit = MAX_TREE_ENTRIES,
): TreeResult {
  const entries: TreeEntry[] = []
  const grants = project.aiWorkspace?.grants.map((g) => g.refId) ?? []
  let truncated = collectZone(workspaceId, 'proj', [project.id], nodes, true, entries, limit)
  if (!truncated) {
    truncated = collectZone(workspaceId, 'link', grants, nodes, false, entries, limit)
  }
  return { entries, truncated }
}

export interface FindHit {
  uri: string
  type: 'file' | 'folder'
  zone: Zone
}

/**
 * 按名称子串查找（大小写不敏感）。只在 `checkRead` 通过的节点里找，越权节点不会出现。
 */
export function findFiles(
  workspaceId: string,
  project: FolderNode,
  nodes: NodeMap,
  query: string,
  limit = 100,
): { hits: FindHit[]; truncated: boolean } {
  const q = query.trim().toLowerCase()
  if (!q) return { hits: [], truncated: false }
  const hits: FindHit[] = []
  for (const node of nodes.values()) {
    if (!alive(node)) continue
    if (!node.nameKey.includes(q)) continue
    const zone: Zone | null = pickZone(node.id, project, nodes)
    if (!zone) continue
    const rootId = zone === 'proj' ? project.id : grantOf(node.id, project, nodes)
    if (!rootId) continue
    const rel = relPath(node.id, rootId, nodes)
    if (rel === null) continue
    const relFull = zone === 'link' ? joinRel(nodes.get(rootId)?.name ?? '', rel) : rel
    if (hits.length >= limit) return { hits, truncated: true }
    hits.push({
      uri: formatUri({ workspaceId, zone, rel: relFull }),
      type: node.kind,
      zone,
    })
  }
  return { hits, truncated: false }
}

function pickZone(nodeId: string, project: FolderNode, nodes: NodeMap): Zone | null {
  if (checkRead('proj', nodeId, nodes, project) === null) return 'proj'
  if (checkRead('link', nodeId, nodes, project) === null) return 'link'
  return null
}

function grantOf(nodeId: string, project: FolderNode, nodes: NodeMap): string | null {
  const grants = project.aiWorkspace?.grants.map((g) => g.refId) ?? []
  let cur: string | null = nodeId
  const seen = new Set<string>()
  while (cur !== null) {
    if (grants.includes(cur)) return cur
    if (seen.has(cur)) return null
    seen.add(cur)
    cur = nodes.get(cur)?.parentId ?? null
  }
  return null
}
