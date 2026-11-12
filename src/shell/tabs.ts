/**
 * 多标签页：IndexedDB 本来就是所有标签页共享的，这里补两件它自己做不到的事。
 * 1. 记住「本标签页」打开的文件。sessionStorage 按标签页隔离，刷新还在，
 *    新开的标签页是空的——不会像以前那样被上一个标签页的文件顶掉。
 * 2. 文件增删时知会其它标签页刷新列表，免得各自盯着一份过期数据。
 */
const CHANNEL = 'vellum-tabs'
const SESSION_KEY = 'vellum.tab.file'
const TAB_ID = crypto.randomUUID()

export type TabsEvent = {
  type: 'files'
  /** 与事件相关的文件，删除事件靠它判断本页是否正开着 */
  fileId?: string
  removed?: boolean
  from: string
}

/** 本标签页打开的文件；新标签页读不到别的标签页的值 */
export function readTabFile(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

export function rememberTabFile(id: string | null) {
  try {
    if (id) sessionStorage.setItem(SESSION_KEY, id)
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* 隐私模式下可能不可写，这只是体验优化，忽略 */
  }
}

let ch: BroadcastChannel | null = null
let handler: ((e: TabsEvent) => void) | null = null

/** 订阅其它标签页的文件变更；自己发的消息会被 from 过滤掉 */
export function initTabs(onEvent: (e: TabsEvent) => void) {
  handler = onEvent
  if (typeof BroadcastChannel === 'undefined') return
  ch = new BroadcastChannel(CHANNEL)
  ch.addEventListener('message', (e) => {
    const msg = e.data as TabsEvent
    if (msg.from === TAB_ID) return
    handler?.(msg)
  })
}

/** 导入、保存、删除后喊一嗓子，别的标签页据此刷新列表 */
export function notifyFiles(fileId?: string, removed = false) {
  ch?.postMessage({ type: 'files', fileId, removed, from: TAB_ID } satisfies TabsEvent)
}
