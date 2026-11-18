/**
 * AI 工作区模式：虚拟地址与授权判定。纯函数，不碰 IndexedDB。
 *
 * 依据 plans/ai-project-v2.md §2（P-01 ~ P-04）、§8（W-01 / W-07）。
 *
 * 虚拟地址：`[workspaceId]:[proj|link]/rel/path`
 * - `:proj` 工作区内，可读可写；
 * - `:link` 授权引用，只读；写入前必须先 `cp` 进 `:proj`。
 * AI 只见虚拟地址，不见底层节点 id。
 *
 * 前缀是**工作区 id**（`ws_xxx`），与会话无关：同一工作区的多个会话共享同一份
 * `:proj` 与 `:link`，也共享 `cp` 出来的副本（W-03）。
 */

import type { FolderNode, NodeRecord } from '../../types'

export type Zone = 'proj' | 'link'

export interface VirtualUri {
  workspaceId: string
  zone: Zone
  /** 不含前导 `/`，用 `/` 分隔；空串表示区根 */
  rel: string
}

export type UriError = 'bad_uri'

const URI_RE = /^([^:/]+):(proj|link)(?:\/(.*))?$/

/** 解析虚拟地址；格式不对返回 `null`（调用方映射为 `bad_uri`） */
export function parseUri(raw: string): VirtualUri | null {
  const m = URI_RE.exec(raw.trim())
  if (!m) return null
  const rel = (m[3] ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (rel.split('/').some((seg) => seg === '..' || seg === '.')) return null
  return { workspaceId: m[1], zone: m[2] as Zone, rel }
}

export function formatUri(u: VirtualUri): string {
  return u.rel ? `${u.workspaceId}:${u.zone}/${u.rel}` : `${u.workspaceId}:${u.zone}`
}

/**
 * 容错解析：允许模型省略工作区前缀。
 *
 * 为什么需要：前缀是一串随机字符，模型只能从提示词里抄一次，抄错一位就是 `bad_uri`；
 * 实测真实模型会写 `:proj/a.md` 或 `proj/a.md`。这里把 `[:]proj/...`、`[:]link/...`
 * 补上当前工作区前缀，纯相对路径**不猜**（指 proj 还是 link 有歧义，宁可报错）。
 * 完整前缀仍必须与当前工作区一致 —— 校验在调用方（INV-13）。
 */
export function normalizeUri(raw: string, workspaceId: string): VirtualUri | null {
  const text = raw.trim()
  if (!text) return null
  const direct = parseUri(text)
  if (direct) return direct
  const m = /^:?(proj|link)(?:\/(.*))?$/.exec(text)
  if (!m) return null
  const rest = (m[2] ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (rest.split('/').some((seg) => seg === '..' || seg === '.')) return null
  return { workspaceId, zone: m[1] as Zone, rel: rest }
}

export type AccessError = 'forbidden' | 'not_granted' | 'not_project'

/**
 * 读取判定（P-03）。
 * - `:proj` 节点必须位于工作区子树内；
 * - `:link` 节点必须在授权列表中（自身或任一祖先被授权）。
 * 返回 `null` 表示通过，否则返回错误码。
 */
export function checkRead(
  zone: Zone,
  nodeId: string,
  nodes: ReadonlyMap<string, NodeRecord>,
  workspace: FolderNode,
): AccessError | null {
  if (!workspace.aiWorkspace) return 'not_project'
  if (zone === 'proj') return inSubtree(nodeId, workspace.id, nodes) ? null : 'forbidden'
  const grants = workspace.aiWorkspace.grants.map((g) => g.refId)
  return isGrantedBy(nodeId, grants, nodes) ? null : 'not_granted'
}

/**
 * 写入判定（P-04）。只允许 `:proj` 子树内的节点；`:link` 永远拒绝。
 */
export function checkWrite(
  zone: Zone,
  nodeId: string | null,
  nodes: ReadonlyMap<string, NodeRecord>,
  workspace: FolderNode,
): AccessError | null {
  if (!workspace.aiWorkspace) return 'not_project'
  if (zone === 'link') return 'forbidden'
  if (nodeId === null) return null
  return inSubtree(nodeId, workspace.id, nodes) ? null : 'forbidden'
}

export type CopyError = 'bad_source' | 'bad_target' | 'forbidden' | 'not_granted'

/**
 * cp 的源判定（P-05）：源必须是未删除的文本文件，且对 AI 可读。
 * 二进制资产不能 cp（AI 只能读元信息，不能复制内容）。
 */
export function checkCopySource(
  zone: Zone,
  nodeId: string,
  nodes: ReadonlyMap<string, NodeRecord>,
  workspace: FolderNode,
): CopyError | null {
  const node = nodes.get(nodeId)
  if (!node || node.deletedAt !== null || node.kind !== 'file' || node.asset) return 'bad_source'
  const read = checkRead(zone, nodeId, nodes, workspace)
  if (read === 'forbidden') return 'forbidden'
  if (read === 'not_granted') return 'not_granted'
  return null
}

/**
 * cp 的目标判定：目标文件夹必须位于 `:proj` 子树内（写入只能进工作区）。
 * `nodeId` 为 `null` 表示工作区根，直接放行。
 */
export function checkCopyTarget(
  nodeId: string | null,
  nodes: ReadonlyMap<string, NodeRecord>,
  workspace: FolderNode,
): CopyError | null {
  if (nodeId === null) return null
  const node = nodes.get(nodeId)
  if (!node || node.deletedAt !== null || node.kind !== 'folder') return 'bad_target'
  return inSubtree(nodeId, workspace.id, nodes) ? null : 'bad_target'
}

/** 沿 parentId 上溯，判断 nodeId 是否在 rootId 子树内（含自身） */
export function inSubtree(
  nodeId: string,
  rootId: string,
  nodes: ReadonlyMap<string, NodeRecord>,
): boolean {
  let cur: string | null = nodeId
  const seen = new Set<string>()
  while (cur !== null) {
    if (cur === rootId) return true
    if (seen.has(cur)) return false
    seen.add(cur)
    cur = nodes.get(cur)?.parentId ?? null
  }
  return false
}

/** 沿祖先链判断是否被任一授权节点覆盖（含自身） */
export function isGrantedBy(
  nodeId: string,
  grantIds: readonly string[],
  nodes: ReadonlyMap<string, NodeRecord>,
): boolean {
  if (grantIds.length === 0) return false
  const set = new Set(grantIds)
  let cur: string | null = nodeId
  const seen = new Set<string>()
  while (cur !== null) {
    if (set.has(cur)) return true
    if (seen.has(cur)) return false
    seen.add(cur)
    cur = nodes.get(cur)?.parentId ?? null
  }
  return false
}
