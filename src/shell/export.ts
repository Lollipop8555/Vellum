/**
 * 批量导出（zip）。
 *
 * 设计依据：plans/resource-management.md §14
 * - 压缩用 fflate，deflate level 2；串行逐文件读取，逐文件释放。
 * - 基础层（全平台）：chunk 聚合 → Blob → 下载；峰值内存只有 zip 本身。
 * - 增强层（Chromium）：`showSaveFilePicker` + 可写流边压边写，内存恒定。
 * - 空文件夹必须写目录条目（路径以 `/` 结尾），否则解压后层级丢失（D-18）。
 * - 文件名统一 UTF-8，fflate 会置 UTF-8 标志位，中文名不乱码（O19）。
 */
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import * as store from './store'
import { openSaveTarget, downloadBlob } from './save'
import type { NodeRecord } from '../types'
import type { TreeIndex } from './tree'

/** 归档内的一条记录；文件夹的 path 以 `/` 结尾 */
export interface ExportEntry {
  path: string
  kind: 'file' | 'folder'
  node: NodeRecord
}

export interface ExportProgress {
  done: number
  total: number
  name: string
}

export type ExportOutcome = 'picker' | 'download' | 'cancelled'

export interface ExportResult {
  outcome: ExportOutcome
  /** 真正写进去的文件数（不含目录条目） */
  files: number
  /** 归档字节数（基础层能给出精确值，流式层为写入总量） */
  bytes: number
}

export interface ExportRequest {
  /** 要导出的顶层节点；整库导出时传根级全部节点 */
  rootIds: string[]
  /** 归档内的统一前缀，如 `vellum-export-20261112/`；无则不留外层目录 */
  prefix?: string
  /** 多选导出：每个根按相对库根的路径展开（O21），与 prefix 互斥 */
  preservePaths?: boolean
  /** 建议的 zip 文件名 */
  fileName: string
  onProgress?(p: ExportProgress): void
  /** 返回 true 表示用户放弃 */
  isCancelled?(): boolean
}

const LEVEL = 2 // §14.1：1~3 级，文本通常 3~5 倍压缩

/**
 * 把若干子树摊平成「路径 + 节点」清单。
 * 深度优先、同级按树里的顺序，保证 zip 内目录结构与界面一致（O18）。
 */
export function collectEntries(index: TreeIndex, rootIds: string[], prefix = ''): ExportEntry[] {
  const out: ExportEntry[] = []
  const takenPaths = new Set<string>()

  const uniquePath = (path: string): string => {
    if (!takenPaths.has(path)) {
      takenPaths.add(path)
      return path
    }
    // §14.3：同级重名只可能来自软删除残留，追加 (1)、(2)
    const suffix = path.endsWith('/') ? '/' : ''
    const body = suffix ? path.slice(0, -1) : path
    const dot = body.lastIndexOf('.')
    const slash = body.lastIndexOf('/')
    for (let i = 1; i < 10_000; i++) {
      const next =
        dot > slash && !suffix
          ? `${body.slice(0, dot)}(${i})${body.slice(dot)}`
          : `${body}(${i})`
      const candidate = next + suffix
      if (!takenPaths.has(candidate)) {
        takenPaths.add(candidate)
        return candidate
      }
    }
    const fallback = `${body}-${Date.now()}${suffix}`
    takenPaths.add(fallback)
    return fallback
  }

  const walk = (node: NodeRecord, parentPath: string) => {
    if (node.deletedAt !== null) return
    if (node.kind === 'folder') {
      const path = uniquePath(`${parentPath}${node.name}/`)
      out.push({ path, kind: 'folder', node })
      for (const child of index.children.get(node.id) ?? []) walk(child, path)
      return
    }
    out.push({ path: uniquePath(`${parentPath}${node.name}`), kind: 'file', node })
  }

  for (const id of rootIds) {
    const node = index.byId.get(id)
    if (node) walk(node, prefix)
  }
  return out
}

/**
 * 多选导出（O21）：每个根节点按「相对库根的路径」展开，
 * 否则不同文件夹里的同名文件会在 zip 根上撞车（只能靠 (1) 后缀区分）。
 */
export function collectEntriesWithParents(index: TreeIndex, rootIds: string[]): ExportEntry[] {
  const out: ExportEntry[] = []
  for (const id of rootIds) {
    const node = index.byId.get(id)
    if (!node) continue
    const parents: string[] = []
    let cur = node.parentId ? index.byId.get(node.parentId) : undefined
    let guard = 0
    while (cur && guard++ < 256) {
      parents.unshift(cur.name)
      cur = cur.parentId ? index.byId.get(cur.parentId) : undefined
    }
    out.push(...collectEntries(index, [id], parents.length ? `${parents.join('/')}/` : ''))
  }
  return out
}

/** 导出前估算总体积（§14.4） */export function estimateBytes(entries: ExportEntry[]): number {
  return entries.reduce((sum, e) => sum + (e.kind === 'file' && e.node.kind === 'file' ? e.node.size : 0), 0)
}

/** 读一条文件内容：编辑过的用规范化 blob，没编辑过的按原始字节保真 */
async function readBytes(node: NodeRecord): Promise<Uint8Array> {
  if (node.kind !== 'file') return new Uint8Array(0)
  const rec = await store.getContent(node.id)
  const blob = rec?.blob ?? rec?.originalBytes
  if (!blob) return new Uint8Array(0)
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * 打包并送出。
 * 串行处理，读完一个就丢掉一个，不保留 bytes 引用。
 */
export async function exportZip(index: TreeIndex, req: ExportRequest): Promise<ExportResult> {
  const entries = req.preservePaths
    ? collectEntriesWithParents(index, req.rootIds)
    : collectEntries(index, req.rootIds, req.prefix ?? '')
  const files = entries.filter((e) => e.kind === 'file')
  const total = files.length

  let done = 0
  let written = 0
  let cancelled = false

  const writable = await openSaveTarget(req.fileName)
  if (writable === 'cancelled') return { outcome: 'cancelled', files: 0, bytes: 0 }

  // 增强层：边压边写；基础层：聚合到内存
  const chunks: Uint8Array[] = []
  const zip = new Zip((err, chunk) => {
    if (err) throw err
    written += chunk.length
    // 回调是同步的，先入队；需要落盘时由下面的 flush 按序 await 写出去
    chunks.push(chunk)
  })

  const flush = async () => {
    if (!writable || !chunks.length) return
    const pending = chunks.splice(0, chunks.length)
    for (const c of pending) await writable.write(c as unknown as BufferSource)
  }

  try {
    for (const entry of entries) {
      if (req.isCancelled?.()) {
        cancelled = true
        break
      }
      if (entry.kind === 'folder') {
        const dir = new ZipPassThrough(entry.path)
        zip.add(dir)
        dir.push(new Uint8Array(0), true)
        continue
      }

      const bytes = await readBytes(entry.node)
      const file = new ZipDeflate(entry.path, { level: LEVEL })
      zip.add(file)
      file.push(bytes, true)
      done += 1
      req.onProgress?.({ done, total, name: entry.node.name })
      // 流式模式下把已经压出来的 chunk 落盘，保持内存恒定
      await flush()
    }

    if (cancelled) {
      await flush()
      if (writable) await writable.close()
      return { outcome: 'cancelled', files: done, bytes: written }
    }

    zip.end()
    await flush()

    if (writable) {
      await writable.close()
      return { outcome: 'picker', files: total, bytes: written }
    }

    const blob = new Blob(chunks as unknown as BlobPart[], { type: 'application/zip' })
    downloadBlob(req.fileName, blob)
    return { outcome: 'download', files: total, bytes: blob.size }
  } catch (err) {
    try {
      if (writable) await writable.close()
    } catch {
      /* 写盘失败时 close 也可能抛，忽略 */
    }
    throw err
  }
}

/** zip 文件名：`<节点名>-YYYYMMDD.zip`（§14.3） */
export function zipName(base: string, at = new Date()): string {
  const y = at.getFullYear()
  const m = `${at.getMonth() + 1}`.padStart(2, '0')
  const d = `${at.getDate()}`.padStart(2, '0')
  return `${base}-${y}${m}${d}.zip`
}
