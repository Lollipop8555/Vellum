/**
 * AI 授权的数据操作：工作区创建、按 id 查找、增删引用。纯逻辑，落库由调用方注入。
 *
 * 依据 plans/ai-project-v2.md §3、§8（W-05 / W-07 / W-08）。
 * - 授权记在工作区根的 `aiWorkspace.grants` 上，AI 不可修改；
 * - 授权对象必须是未删除的节点，且不能是工作区根本身或其子树内的节点（那已经是 proj）；
 * - 已被授权的祖先覆盖的子节点不重复添加；
 * - 已 `cp` 进工作区的副本不在授权列表里，本模块不处理；
 * - **工作区必须由用户显式建立**（W-08）：授权流程遇到没有工作区时只会提示，不会偷偷把父文件夹升为工作区。
 */

import type { FolderNode, NodeRecord } from '../../types'
import { inSubtree } from './project'

export type AddGrantError = 'not_found' | 'in_workspace' | 'already_granted'
export type RemoveGrantError = 'not_granted'

export type AddGrantResult = { ok: true; root: FolderNode } | { ok: false; error: AddGrantError }
export type RemoveGrantResult = { ok: true; root: FolderNode } | { ok: false; error: RemoveGrantError }

/**
 * 按工作区 id 取（W-07）：URI 前缀就是它，所以读写入口都走这一个函数。
 *
 * 不提供「取第一个」的版本 —— 那正是 v2 的全局唯一假设，多工作区下会张冠李戴。
 */
export function workspaceById(nodes: Iterable<NodeRecord>, id: string): FolderNode | null {
  if (!id) return null
  for (const node of nodes) {
    if (node.kind === 'folder' && node.deletedAt === null && node.aiWorkspace?.id === id) return node
  }
  return null
}

/**
 * 工作区 id：`ws_` + 8 位 base36，随机源 48 位（W-06）。
 *
 * 离散生成、不可枚举；本函数只负责生成，查重由调用方在落库前做（W-S2）。
 */
export function makeWorkspaceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let n = 0
  for (const b of bytes) n = n * 256 + b
  return `ws_${n.toString(36).slice(0, 8).padStart(8, '0')}`
}

/** 把 refId 加入授权。`root` 必须已是工作区（由 `createWorkspace` 显式建立） */
export function addGrant(
  root: FolderNode,
  refId: string,
  nodes: ReadonlyMap<string, NodeRecord>,
  now: number,
): AddGrantResult {
  const target = nodes.get(refId)
  if (!target || target.deletedAt !== null) return { ok: false, error: 'not_found' }
  if (inSubtree(refId, root.id, nodes)) return { ok: false, error: 'in_workspace' }
  const ws = root.aiWorkspace
  const grants = ws?.grants ?? []
  if (grants.some((g) => g.refId === refId)) return { ok: false, error: 'already_granted' }
  return {
    ok: true,
    root: {
      ...root,
      aiWorkspace: {
        id: ws?.id ?? makeWorkspaceId(),
        createdAt: ws?.createdAt ?? now,
        grants: [...grants, { refId, addedAt: now }],
      },
    },
  }
}

export function removeGrant(root: FolderNode, refId: string): RemoveGrantResult {
  const ws = root.aiWorkspace
  const grants = ws?.grants ?? []
  if (!grants.some((g) => g.refId === refId)) return { ok: false, error: 'not_granted' }
  return {
    ok: true,
    root: {
      ...root,
      aiWorkspace: {
        id: ws?.id ?? makeWorkspaceId(),
        createdAt: ws?.createdAt ?? Date.now(),
        grants: grants.filter((g) => g.refId !== refId),
      },
    },
  }
}

/**
 * 显式创建：把给定文件夹标记为工作区（不改目录结构、不动内容）。
 *
 * 已有工作区就原样返回。调用方只有「用户点新建工作区」这一处（W-08）——
 * 不要再从授权流程里调它，那会让普通文件夹悄悄变成工作区。
 */
export function createWorkspace(folder: FolderNode, now: number): FolderNode {
  if (folder.aiWorkspace) return folder
  return { ...folder, aiWorkspace: { id: makeWorkspaceId(), createdAt: now, grants: [] } }
}
