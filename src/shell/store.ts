import type { FileRecord, SnapshotRecord } from '../types'

const DB_NAME = 'vellum'
const DB_VERSION = 1
const SNAPSHOT_KEEP = 5

let dbPromise: Promise<IDBDatabase> | null = null

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

function writeTx<T>(stores: string[], fn: (s: (n: string) => IDBObjectStore) => Promise<T>): Promise<T> {
  return open().then((db) => {
    const tx = db.transaction(stores, 'readwrite')
    const get = (n: string) => tx.objectStore(n)
    return fn(get).then(
      (v) =>
        new Promise<T>((resolve, reject) => {
          tx.oncomplete = () => resolve(v)
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        }),
    )
  })
}

export function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION)
    r.onupgradeneeded = () => {
      const db = r.result
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('snapshots')) {
        const s = db.createObjectStore('snapshots', { keyPath: 'id' })
        s.createIndex('fileId', 'fileId')
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' })
      }
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  return dbPromise
}

export async function listFiles(): Promise<FileRecord[]> {
  const all = await readTx(['files'], (s) => req<FileRecord[]>(s('files').getAll()))
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getFile(id: string): Promise<FileRecord | undefined> {
  return readTx(['files'], (s) => req<FileRecord | undefined>(s('files').get(id)))
}

export async function putFile(rec: FileRecord): Promise<void> {
  await writeTx(['files'], async (s) => {
    s('files').put(rec)
  })
}

export async function deleteFileCascade(id: string): Promise<void> {
  await writeTx(['files', 'snapshots'], async (s) => {
    const idx = s('snapshots').index('fileId')
    const keys = await req<IDBValidKey[]>(idx.getAllKeys(id))
    keys.forEach((k) => s('snapshots').delete(k))
    s('files').delete(id)
  })
}

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

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const rec = await readTx(['meta'], (s) => req<{ value: T } | undefined>(s('meta').get(key)))
  return rec?.value
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await writeTx(['meta'], async (s) => {
    s('meta').put({ key, value })
  })
}

export interface StorageInfo {
  usage: number
  quota: number
}

export async function storageInfo(): Promise<StorageInfo> {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0 }
  const est = await navigator.storage.estimate()
  return { usage: est.usage ?? 0, quota: est.quota ?? 0 }
}

export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}
