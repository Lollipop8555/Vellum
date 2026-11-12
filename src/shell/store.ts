import type { ContentRecord, NodeRecord, SnapshotRecord } from '../types'

const DB_NAME = 'vellum'
/**
 * v2：files 表拆成 nodes（纯元信息）+ contents（按需读取）。
 * 按 D-03 不做历史迁移 —— 升级时直接删表重建。
 */
const DB_VERSION = 2
const SNAPSHOT_KEEP = 5

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * 打开数据库最多等这么久。
 * 浏览器的 IDB 请求队列被卡住时是「一个事件都不发」的静默挂起，
 * 没有超时兜底的话调用方会永远悬着，界面上则是「什么都没发生」。
 */
const OPEN_TIMEOUT = 10_000

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

function readTx<T>(stores: string[], fn: (s: (n: string) => IDBObjectStore) => Promise<T>): Promise<T> {
  return open().then((db) => {
    const tx = db.transaction(stores, 'readonly')
    const get = (n: string) => tx.objectStore(n)
    return fn(get).then((v) => {
      if (tx.error) throw tx.error
      return v
    })
  })
}

/**
 * 写事务。
 *
 * 关键点：oncomplete / onerror / onabort 必须在**发请求之前**就挂上。
 * 之前是 `fn(...)` resolve 之后在微任务里才挂，只要某个引擎在微任务之前
 * 就把事务结束掉（中止、配额超限、索引键非法等都可能导致），这些回调就永远不会触发，
 * 表现是 Promise 既不 resolve 也不 reject —— 调用方卡死、无报错、无提示。
 */
function writeTx<T>(stores: string[], fn: (s: (n: string) => IDBObjectStore) => Promise<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction
        try {
          tx = db.transaction(stores, 'readwrite')
        } catch (err) {
          reject(err)
          return
        }

        let value!: T
        let settled = false
        const fail = (err: unknown) => {
          if (settled) return
          settled = true
          reject(err instanceof Error ? err : new Error(String(err ?? '事务失败')))
        }

        tx.oncomplete = () => {
          if (settled) return
          settled = true
          resolve(value)
        }
        tx.onerror = () => fail(tx.error)
        tx.onabort = () => fail(tx.error ?? new Error('事务被中止'))

        // fn 里只发请求；它抛错（比如 DataError）时把事务一并收掉，别留下悬空事务
        let ret: Promise<T>
        try {
          ret = Promise.resolve(fn((n) => tx.objectStore(n)))
        } catch (err) {
          try {
            tx.abort()
          } catch {
            /* 事务可能已经结束 */
          }
          fail(err)
          return
        }
        ret.then(
          (v) => {
            value = v
          },
          (err) => {
            try {
              tx.abort()
            } catch {
              /* 事务可能已经结束 */
            }
            fail(err)
          },
        )
      }),
  )
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err ?? '打开数据库失败')))
    }
    timer = setTimeout(() => {
      fail(
        new Error(
          `${OPEN_TIMEOUT / 1000}s 内没有响应：可能有其它标签页占着这个库，或浏览器存储卡住了，关掉本应用的其他标签页后刷新重试`,
        ),
      )
    }, OPEN_TIMEOUT)

    const r = indexedDB.open(DB_NAME, DB_VERSION)

    r.onupgradeneeded = () => {
      const db = r.result
      // 无迁移（D-03）：清空旧结构与旧数据，避免带着历史包袱
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name)

      const nodes = db.createObjectStore('nodes', { keyPath: 'id' })
      nodes.createIndex('parentId', 'parentId')
      nodes.createIndex('parent_name', ['parentId', 'nameKey'])
      nodes.createIndex('deletedAt', 'deletedAt')
      nodes.createIndex('ext', 'ext')

      db.createObjectStore('contents', { keyPath: 'id' })

      const snaps = db.createObjectStore('snapshots', { keyPath: 'id' })
      snaps.createIndex('fileId', 'fileId')

      db.createObjectStore('meta', { keyPath: 'key' })
    }

    r.onsuccess = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const db = r.result
      // 其它标签页要升级版本时主动让路，否则对方会一直卡在 blocked 上
      db.onversionchange = () => db.close()
      // 连接被浏览器底层关掉（清理、权限变化）时丢掉缓存，下次操作重新打开
      db.onclose = () => {
        dbPromise = null
      }
      resolve(db)
    }

    r.onerror = () => fail(r.error ?? new Error('打开数据库失败'))
    // 旧版本标签页还占着库时 Firefox 会一直等，这里必须表态，不然永远不返回
    r.onblocked = () =>
      fail(new Error('数据库被其它标签页占用，请关闭本应用的其他标签页后刷新重试'))
  })
}

export function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDb().catch((err) => {
      // 失败不缓存：恢复条件（关掉占用页、配额释放）满足后还能自己好起来
      dbPromise = null
      throw err
    })
  }
  return dbPromise
}

/* --------------------------------------------------------------- 节点 */

/** 只读元信息，绝不触碰 contents —— 树渲染的唯一数据来源 */
export async function listNodes(): Promise<NodeRecord[]> {
  return readTx(['nodes'], (s) => req<NodeRecord[]>(s('nodes').getAll()))
}

export async function getNode(id: string): Promise<NodeRecord | undefined> {
  return readTx(['nodes'], (s) => req<NodeRecord | undefined>(s('nodes').get(id)))
}

export async function putNode(node: NodeRecord): Promise<void> {
  await writeTx(['nodes'], async (s) => {
    s('nodes').put(node)
  })
}

export async function putNodes(nodes: NodeRecord[]): Promise<void> {
  if (!nodes.length) return
  await writeTx(['nodes'], async (s) => {
    for (const n of nodes) s('nodes').put(n)
  })
}

/* --------------------------------------------------------------- 内容 */

export async function getContent(id: string): Promise<ContentRecord | undefined> {
  return readTx(['contents'], (s) => req<ContentRecord | undefined>(s('contents').get(id)))
}

export async function putContent(rec: ContentRecord): Promise<void> {
  await writeTx(['contents'], async (s) => {
    s('contents').put(rec)
  })
}

export async function deleteContent(id: string): Promise<void> {
  await writeTx(['contents'], async (s) => {
    s('contents').delete(id)
  })
}

/**
 * 深度搜索的入口：只取键名，不碰 blob。
 * 一次性 getAll() 会把整个库的正文读进内存，改成「先拿 id，再逐条 getContent」，
 * 每份正文解完就能丢，调用方也能随时停下（用户换词或切走）。
 */
export async function listContentIds(): Promise<string[]> {
  const keys = await readTx(['contents'], (s) => req<IDBValidKey[]>(s('contents').getAllKeys()))
  return keys.map(String)
}

/* --------------------------------------------------------------- 物理删除 */

/**
 * 物理删除：nodes + contents + 该批文件的所有快照。
 * 快照键先在只读事务里取全，避免在同一写事务中 await 导致事务提前提交。
 */
export async function deleteNodesCascade(ids: string[]): Promise<void> {
  if (!ids.length) return
  const wanted = new Set(ids)
  const snapKeys = await readTx(['snapshots'], async (s) => {
    const all = await req<SnapshotRecord[]>(s('snapshots').getAll())
    return all.filter((snap) => wanted.has(snap.fileId)).map((snap) => snap.id)
  })

  await writeTx(['nodes', 'contents', 'snapshots'], async (s) => {
    for (const id of ids) {
      s('nodes').delete(id)
      s('contents').delete(id)
    }
    for (const k of snapKeys) s('snapshots').delete(k)
  })
}

/* --------------------------------------------------------------- 快照 */

export async function addSnapshot(fileId: string, blob: Blob, note = ''): Promise<void> {
  const rec: SnapshotRecord = {
    id: crypto.randomUUID(),
    fileId,
    blob,
    createdAt: Date.now(),
    note,
  }
  await writeTx(['snapshots'], async (s) => {
    s('snapshots').put(rec)
  })
  await trimSnapshots(fileId)
}

async function trimSnapshots(fileId: string): Promise<void> {
  const list = await listSnapshots(fileId)
  if (list.length <= SNAPSHOT_KEEP) return
  const drop = list.slice(SNAPSHOT_KEEP)
  await writeTx(['snapshots'], async (s) => {
    drop.forEach((d) => s('snapshots').delete(d.id))
  })
}

export async function listSnapshots(fileId: string): Promise<SnapshotRecord[]> {
  const all = await readTx(['snapshots'], (s) =>
    req<SnapshotRecord[]>(s('snapshots').index('fileId').getAll(fileId)),
  )
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export async function deleteSnapshot(id: string): Promise<void> {
  await writeTx(['snapshots'], async (s) => {
    s('snapshots').delete(id)
  })
}

/* --------------------------------------------------------------- meta */

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const rec = await readTx(['meta'], (s) => req<{ value: T } | undefined>(s('meta').get(key)))
  return rec?.value
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await writeTx(['meta'], async (s) => {
    s('meta').put({ key, value })
  })
}

/* --------------------------------------------------------------- 空间 */

export interface StorageInfo {
  usage: number
  quota: number
}

/** 浏览器侧配额信息（含整站 origin，不等于库内净值） */
export async function storageInfo(): Promise<StorageInfo> {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0 }
  const est = await navigator.storage.estimate()
  return { usage: est.usage ?? 0, quota: est.quota ?? 0 }
}

/** 库内文件总计：只累加元信息里的 size，不读任何内容 */
export async function totalSize(): Promise<number> {
  const nodes = await listNodes()
  let sum = 0
  for (const n of nodes) if (n.kind === 'file' && n.deletedAt === null) sum += n.size
  return sum
}

export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}
