/**
 * 回收站：软删除 / 恢复 / 彻底删除。
 *
 * 不变式 4（D-12）：软删除只给顶层节点打 deletedAt，子节点不继承。
 * 隐藏效果由 buildTree 保证 —— 被删节点不进 children，整棵子树从根不可达。
 */
import type { NodeRecord } from '../types'
import { applyName } from './nodes'
import * as store from './store'
import { buildTree, collectSubtree, dedupeName, normalizeName, takenNames } from './tree'

export interface RestoreResult {
  restored: number
  /** 原父级已不在（或仍在回收站）而被迫落到根目录的名字 */
  relocated: string[]
}

/** 软删除：只标记传入的节点本身，返回实际标记的数量 */
export async function softDelete(ids: string[]): Promise<number> {
  const now = Date.now()
  let count = 0
  for (const id of ids) {
    const node = await store.getNode(id)
    if (!node || node.deletedAt !== null) continue
    await store.putNode({ ...node, deletedAt: now })
    count++
  }
  return count
}

/**
 * 恢复。父级不存在（或仍在回收站）时落到根目录，同级重名自动追加 (n)，
 * 并把被迫改层级/改名的名字回传，供调用方提示。
 */
export async function restore(ids: string[]): Promise<RestoreResult> {
  const result: RestoreResult = { restored: 0, relocated: [] }

  for (const id of ids) {
    const node = await store.getNode(id)
    if (!node || node.deletedAt === null) continue

    let parentId = node.parentId
    if (parentId !== null) {
      const parent = await store.getNode(parentId)
      if (!parent || parent.deletedAt !== null) {
        parentId = null
        result.relocated.push(node.name)
      }
    }

    // takenNames 含软删除节点，避免恢复后与回收站里的同名项撞车
    const taken = takenNames(await store.listNodes(), parentId, id)
    const name =
      taken.has(normalizeName(node.name)) || taken.has(node.nameKey)
        ? dedupeName(node.name, taken)
        : node.name

    await store.putNode(applyName({ ...node, parentId, deletedAt: null }, name))
    result.restored++
  }

  return result
}

/** 彻底删除：顶层 + 全部后代，连同内容与快照；返回真正被删掉的 id */
export async function purge(ids: string[]): Promise<string[]> {
  if (!ids.length) return []
  const index = buildTree(await store.listNodes())
  const targets = new Set<string>()
  for (const id of ids) {
    for (const x of collectSubtree(index, id)) targets.add(x)
  }
  await store.deleteNodesCascade([...targets])
  return [...targets]
}

/**
 * 清空回收站，返回被删掉的 id。
 * 软删除只标记顶层（不变式 4），所以这里必须按子树展开：
 * 否则被删文件夹里的子节点会变成永远无法触达的孤儿行与孤儿内容。
 */
export async function emptyTrash(): Promise<string[]> {
  const all = await store.listNodes()
  const trash = all.filter((n) => n.deletedAt !== null)
  if (!trash.length) return []

  const index = buildTree(all)
  const targets = new Set<string>()
  for (const n of trash) for (const x of collectSubtree(index, n.id)) targets.add(x)
  await store.deleteNodesCascade([...targets])
  return [...targets]
}

/** 回收站顶层条目（按删除时间降序） */
export function trashItems(nodes: NodeRecord[]): NodeRecord[] {
  return nodes
    .filter((n) => n.deletedAt !== null)
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
}
