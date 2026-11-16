/**
 * 后台离线包预取。
 *
 * 首屏只有外壳（入口 chunk 里的 CodeMirror、shell、i18n、存储），打开即可用；
 * 之后按 engine → editor → preview 三段把大块补进 Service Worker 的 runtime 缓存，
 * 补完就断网可用。
 *
 * 为什么用 fetch 而不是 import()：import() 会真的执行模块，Monaco 那 3.5MB 的解析
 * 会卡主线程；这里只要字节落进 CacheStorage，真正的 import() 留给用户切引擎/开预览时
 * 发生，那时直接命中缓存。顺带还能拿到每项的字节数，进度不用猜。
 */

const SEGMENTS = ['engine', 'editor', 'preview'] as const
export type Segment = (typeof SEGMENTS)[number]
export type Phase = 'idle' | 'busy' | 'paused' | 'ready' | 'error'

export interface PrefetchProgress {
  phase: Phase
  /** 0..1，按段等分：engine 0→1/3，editor 1/3→2/3，preview 2/3→1 */
  ratio: number
  segment: Segment
  doneFiles: number
  totalFiles: number
  doneBytes: number
  totalBytes: number
  /** error 态里没下载成功的项数 */
  failed: number
}

interface Item {
  /** 相对路径，如 './assets/monaco-xxx.js' */
  u: string
  /** 未压缩字节数，只用于进度与展示 */
  b: number
}

interface Manifest {
  segments: Record<Segment, Item[]>
}

const SEEN_KEY = 'vellum.prefetch.seen'
/** 等 Service Worker 接管的最长时间：超过就先不跑，免得下载的字节只落在 HTTP 缓存里 */
const SW_TIMEOUT = 8000
const RETRY_DELAY = 600
const CIRCUMFERENCE = 94.25

const ABORT = Symbol('prefetch-aborted')

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function urlOf(rel: string): string {
  return new URL(rel.replace(/^\.\//, ''), new URL(import.meta.env.BASE_URL, location.origin)).href
}

/** 省流量 / 慢网不自动预取；桌面 Safari 没有 connection API，无禁止即默许 */
export function networkAllowsPrefetch(): boolean {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
    .connection
  if (!conn) return true
  if (conn.saveData) return false
  return !['slow-2g', '2g', '3g'].includes(conn.effectiveType ?? '')
}

function ringOffset(ratio: number): string {
  return String(CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, ratio))))
}

export { ringOffset }

async function cachedUrls(): Promise<Set<string>> {
  const urls = new Set<string>()
  for (const name of await caches.keys()) {
    const cache = await caches.open(name)
    for (const req of await cache.keys()) urls.add(req.url)
  }
  return urls
}

async function serviceWorkerReady(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false
  if (navigator.serviceWorker.controller) return true
  const ready = navigator.serviceWorker.ready.then(() => true)
  return Promise.race([
    ready,
    sleep(SW_TIMEOUT).then(() => Boolean(navigator.serviceWorker.controller)),
  ])
}

async function readManifest(): Promise<Manifest | null> {
  try {
    const res = await fetch(urlOf('./prefetch.json'), { cache: 'no-cache' })
    if (!res.ok) return null
    const data = (await res.json()) as Manifest
    return data?.segments ? data : null
  } catch {
    return null
  }
}

/** 必须和 public/sw.js 里的 RUNTIME 一致，否则「环走完」不等于「离线可用」 */
const RUNTIME = 'vellum-runtime'

async function pull(url: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { cache: 'no-store', signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  // 响应体读空：SW 存的是 clone，页面侧不读完，原始流可能被回收
  const body = await res.clone().arrayBuffer()

  // SW 的 runtime.put 是 fire-and-forget（没有 await），不能赌它一定写完。
  // 这里补一次确认：没落盘就自己写，保证环走到 100% 时文件真的在缓存里。
  if (await caches.match(url)) return

  const headers = new Headers(res.headers)
  // 存的是已解码的 body，保留这两个头会让浏览器再解一次
  headers.delete('content-encoding')
  headers.delete('content-length')
  const cache = await caches.open(RUNTIME)
  await cache.put(url, new Response(body, { status: 200, headers }))
}

/** 失败静默重试一次；仍失败只记账，不打断后面的项 */
async function pullWithRetry(url: string, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await pull(url, signal)
      return true
    } catch {
      if (signal.aborted) throw ABORT
      if (attempt === 0) await sleep(RETRY_DELAY)
    }
  }
  return false
}

export function createPrefetcher(onChange: (progress: PrefetchProgress) => void) {
  let state: PrefetchProgress = {
    phase: 'idle',
    ratio: 0,
    segment: 'engine',
    doneFiles: 0,
    totalFiles: 0,
    doneBytes: 0,
    totalBytes: 0,
    failed: 0,
  }
  let controller: AbortController | null = null
  let busy = false

  const emit = (patch: Partial<PrefetchProgress>) => {
    state = { ...state, ...patch }
    onChange(state)
  }

  async function run(): Promise<void> {
    if (busy) return
    busy = true
    const ctrl = new AbortController()
    controller = ctrl
    emit({ phase: 'busy', failed: 0 })

    try {
      if (!(await serviceWorkerReady())) {
        busy = false
        controller = null
        emit({ phase: 'idle' })
        return
      }

      const manifest = await readManifest()
      if (!manifest) throw new Error('prefetch.json 读不到')

      const cached = await cachedUrls()
      const queue = SEGMENTS.map((segment) => ({ segment, items: manifest.segments[segment] ?? [] }))
      const totalFiles = queue.reduce((n, q) => n + q.items.length, 0)
      const totalBytes = queue.reduce((n, q) => n + q.items.reduce((m, i) => m + i.b, 0), 0)

      // 回访时整包已在缓存里：直接进就绪，别让环闪一下满格
      const cachedCount = queue.reduce(
        (n, q) => n + q.items.filter((item) => cached.has(urlOf(item.u))).length,
        0,
      )
      if (totalFiles > 0 && cachedCount === totalFiles) {
        busy = false
        controller = null
        emit({ phase: 'ready', ratio: 1, totalFiles, totalBytes, doneFiles: totalFiles, doneBytes: totalBytes })
        return
      }

      let doneFiles = 0
      let doneBytes = 0
      let failed = 0
      emit({ totalFiles, totalBytes, doneFiles: 0, doneBytes: 0 })

      for (let s = 0; s < queue.length; s += 1) {
        const { segment, items } = queue[s]
        emit({ segment })

        for (let i = 0; i < items.length; i += 1) {
          if (ctrl.signal.aborted) throw ABORT
          const item = items[i]
          let ok = cached.has(urlOf(item.u))
          if (!ok) ok = await pullWithRetry(urlOf(item.u), ctrl.signal)
          if (!ok) failed += 1
          doneFiles += 1
          doneBytes += item.b
          emit({
            doneFiles,
            doneBytes,
            failed,
            ratio: (s + (i + 1) / items.length) / queue.length,
          })
        }
      }

      busy = false
      controller = null
      emit({ phase: failed ? 'error' : 'ready', ratio: 1, failed })
    } catch (err) {
      busy = false
      controller = null
      if (err === ABORT) emit({ phase: 'paused' })
      else emit({ phase: 'error' })
    }
  }

  /** idle / paused / error 都从这里继续；busy 时则是暂停 */
  function toggle(): void {
    if (state.phase === 'busy') {
      controller?.abort()
      return
    }
    void run()
  }

  /**
   * 首访不自动跑：它和首屏抢带宽，第一次进来先让用户看到编辑区。
   * 省流量 / 慢网同样不跑，但环留在 rail 上，用户想下就点。
   */
  function autoStart(): void {
    let seen = false
    try {
      seen = localStorage.getItem(SEEN_KEY) === '1'
      localStorage.setItem(SEEN_KEY, '1')
    } catch {
      // 隐私模式禁写：当作首访处理，用户想下就点
    }
    if (!seen || !networkAllowsPrefetch()) return

    // 回访也别和首屏抢带宽：等 load 完、浏览器空闲了再默默开始
    const kick = () => {
      const ric = window.requestIdleCallback?.bind(window)
      if (ric) ric(() => void run(), { timeout: 2000 })
      else window.setTimeout(() => void run(), 1200)
    }
    if (document.readyState === 'complete') kick()
    else window.addEventListener('load', kick, { once: true })
  }

  return { state: () => state, toggle, autoStart }
}

export type Prefetcher = ReturnType<typeof createPrefetcher>
