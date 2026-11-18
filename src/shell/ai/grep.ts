/**
 * grep（S6）：在授权可读范围内逐行搜索。纯逻辑，文本由调用方注入。
 *
 * 依据 plans/ai-project-v2.md P-13。
 * - 只搜 `checkRead` 通过的节点，越权节点不会被读取；
 * - 命中行号从 1 开始；单行与总命中数都有上限，超限时 `truncated: true`；
 * - 二进制（`readNodeText` 返回 null）直接跳过。
 */

import type { FolderNode, NodeRecord } from '../../types'
import { checkRead, formatUri, type Zone } from './project'
import { relPath, type NodeMap } from './tree'

export const GREP_MAX_HITS = 100
export const GREP_MAX_LINE = 200

export interface GrepHit {
  uri: string
  line: number
  text: string
}

export interface GrepResult {
  hits: GrepHit[]
  truncated: boolean
  filesScanned: number
}

export interface GrepOptions {
  pattern: string
  regex?: boolean
  limit?: number
}

/** 生成匹配器；非法正则返回 `null`（调用方映射为 bad_arguments） */
export function buildMatcher(opts: GrepOptions): ((line: string) => boolean) | null {
  if (!opts.pattern) return null
  if (opts.regex) {
    try {
      const re = new RegExp(opts.pattern)
      return (line) => re.test(line)
    } catch {
      return null
    }
  }
  const needle = opts.pattern.toLowerCase()
  return (line) => line.toLowerCase().includes(needle)
}

/** 授权可读的文件节点，按区归类（proj 优先，其次 link） */
function readableFiles(
  project: FolderNode,
  nodes: NodeMap,
): Array<{ node: NodeRecord; zone: Zone; rootId: string }> {
  const out: Array<{ node: NodeRecord; zone: Zone; rootId: string }> = []
  for (const node of nodes.values()) {
    if (node.kind !== 'file' || node.deletedAt !== null) continue
    if (node.asset) continue
    if (checkRead('proj', node.id, nodes, project) === null) {
      out.push({ node, zone: 'proj', rootId: project.id })
      continue
    }
    if (checkRead('link', node.id, nodes, project) === null) {
      const rootId = grantRootOf(node.id, project, nodes)
      if (rootId) out.push({ node, zone: 'link', rootId })
    }
  }
  return out
}

function grantRootOf(nodeId: string, project: FolderNode, nodes: NodeMap): string | null {
  const grants = new Set(project.aiWorkspace?.grants.map((g) => g.refId) ?? [])
  let cur: string | null = nodeId
  const seen = new Set<string>()
  while (cur !== null) {
    if (grants.has(cur)) return cur
    if (seen.has(cur)) return null
    seen.add(cur)
    cur = nodes.get(cur)?.parentId ?? null
  }
  return null
}

/**
 * 执行搜索。`readText` 由 app 注入：返回文件规范文本，二进制返回 `null`。
 * 超过 `limit` 或单次文件数上限时停止并标记 truncated。
 */
export async function grepProject(
  workspaceId: string,
  project: FolderNode,
  nodes: NodeMap,
  matcher: (line: string) => boolean,
  readText: (id: string) => Promise<string | null>,
  limit = GREP_MAX_HITS,
): Promise<GrepResult> {
  const hits: GrepHit[] = []
  let filesScanned = 0
  const files = readableFiles(project, nodes).sort((a, b) => {
    if (a.zone !== b.zone) return a.zone === 'proj' ? -1 : 1
    return a.node.name.localeCompare(b.node.name)
  })

  for (const { node, zone, rootId } of files) {
    const text = await readText(node.id)
    if (text === null) continue
    filesScanned += 1
    const rel = relPath(node.id, rootId, nodes)
    if (rel === null) continue
    const relFull = zone === 'link' ? joinRel(nodes.get(rootId)?.name ?? '', rel) : rel
    const uri = formatUri({ workspaceId, zone, rel: relFull })
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (!matcher(lines[i])) continue
      if (hits.length >= limit) return { hits, truncated: true, filesScanned }
      hits.push({ uri, line: i + 1, text: lines[i].slice(0, GREP_MAX_LINE) })
    }
  }
  return { hits, truncated: false, filesScanned }
}

function joinRel(rootName: string, rel: string): string {
  return rel ? `${rootName}/${rel}` : rootName
}
