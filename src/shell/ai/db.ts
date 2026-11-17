/**
 * AI 两个库（`vellum-ai` / `vellum-chat`）共用的 IndexedDB 样板。
 *
 * 设计依据：plans/ai-assistant.md §5.1（库隔离）、§14.5（不引 `idb`）。
 * 与 `src/shell/store.ts` 的差别只有一处：那边是单例（文件库只有一个），
 * 这边是工厂（凭据库与会话库要各自独立打开、独立超时、独立让路）。
 *
 * 不变式：**文件库 `vellum` 的版本与结构一律不碰**（INV-8）。本模块只开自己的库。
 */

/** 打开数据库最多等这么久；IDB 被别的标签页卡住时是「一个事件都不发」的静默挂起 */
const OPEN_TIMEOUT = 10_000

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

export interface DbHandle {
  open(): Promise<IDBDatabase>
  read<T>(stores: string[], fn: (s: (n: string) => IDBObjectStore) => Promise<T>): Promise<T>
  write<T>(stores: string[], fn: (s: (n: string) => IDBObjectStore) => Promise<T>): Promise<T>
  /** 浏览器把底层连接关掉后丢掉缓存，下次操作重新打开 */
  reset(): void
}

export function database(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
): DbHandle {
  let cached: Promise<IDBDatabase> | null = null

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

      const r = indexedDB.open(name, version)

      r.onupgradeneeded = () => {
        upgrade(r.result)
      }

      r.onsuccess = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const db = r.result
        // 其它标签页要升级版本时主动让路，否则对方会一直卡在 blocked 上
        db.onversionchange = () => db.close()
        db.onclose = () => {
          cached = null
        }
        resolve(db)
      }

      r.onerror = () => fail(r.error ?? new Error('打开数据库失败'))
      r.onblocked = () =>
        fail(new Error('数据库被其它标签页占用，请关闭本应用的其他标签页后刷新重试'))
    })
  }

  function open(): Promise<IDBDatabase> {
    if (!cached) {
      cached = openDb().catch((err) => {
        // 失败不缓存：恢复条件满足后还能自己好起来
        cached = null
        throw err
      })
    }
    return cached
  }

  function read<T>(
    stores: string[],
    fn: (s: (n: string) => IDBObjectStore) => Promise<T>,
  ): Promise<T> {
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
   * 写事务：`oncomplete` / `onerror` / `onabort` 必须在**发请求之前**挂上。
   * 只要某个引擎在微任务之前就把事务结束掉（中止、配额超限、索引键非法），
   * 后挂的回调永远不触发，Promise 既不 resolve 也不 reject —— 调用方无报错地卡死。
   */
  function write<T>(
    stores: string[],
    fn: (s: (n: string) => IDBObjectStore) => Promise<T>,
  ): Promise<T> {
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

  return {
    open,
    read,
    write,
    reset: () => {
      cached = null
    },
  }
}
