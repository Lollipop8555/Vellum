/**
 * 多标签页：IndexedDB 本来就是所有标签页共享的，这里补三件它自己做不到的事。
 * 1. 记住「本标签页」打开的文件。sessionStorage 按标签页隔离，刷新还在，
 *    新开的标签页是空的——不会像以前那样被上一个标签页的文件顶掉。
 * 2. 文件增删时知会其它标签页刷新列表，免得各自盯着一份过期数据。
 * 3. 谁开着哪个文件：右键菜单据此把「在新标签页打开」换成「切过去」。
 */
const CHANNEL = 'vellum-tabs'
const SESSION_KEY = 'vellum.tab.file'
const TAB_ID = crypto.randomUUID()

export type TabsEvent = {
  type: 'files' | 'current' | 'who' | 'here'
  /** 与事件相关的文件 */
  fileId?: string | null
  removed?: boolean
  /** who / here 的配对号，免得两轮探测串线 */
  req?: string
  from: string
}

/** 本标签页现在开着哪个文件；别人问起时靠它回答 */
let current: string | null = null

let ch: BroadcastChannel | null = null
let handler: ((e: TabsEvent) => void) | null = null

/** 本标签页打开的文件；新标签页读不到别的标签页的值 */
export function readTabFile(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

export function rememberTabFile(id: string | null) {
  current = id
  try {
    if (id) sessionStorage.setItem(SESSION_KEY, id)
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* 隐私模式下可能不可写，这只是体验优化，忽略 */
  }
  // 窗口名跟着文件走：别的标签页用同名 window.open 就能定位到这一页
  try {
    window.name = id ? tabWindowName(id) : ''
  } catch {
    /* 个别宿主环境不允许改 window.name，跳转功能降级即可 */
  }
  ch?.postMessage({ type: 'current', fileId: id, from: TAB_ID } satisfies TabsEvent)
}

/** 每个文件对应一个固定窗口名，同名 window.open 会复用已存在的那一页 */
export function tabWindowName(id: string): string {
  return `vellum-${id}`
}

/** 订阅其它标签页的文件变更；自己发的消息会被 from 过滤掉 */
export function initTabs(onEvent: (e: TabsEvent) => void) {
  handler = onEvent
  if (typeof BroadcastChannel === 'undefined') return
  ch = new BroadcastChannel(CHANNEL)
  ch.addEventListener('message', (e) => {
    const msg = e.data as TabsEvent
    if (msg.from === TAB_ID) return
    // 有人问「谁开着这个文件」：开着就应一声，别的不掺和
    if (msg.type === 'who') {
      if (msg.fileId && msg.fileId === current) {
        ch?.postMessage({ type: 'here', fileId: msg.fileId, req: msg.req, from: TAB_ID })
      }
      return
    }
    if (msg.type === 'here' || msg.type === 'current') return
    handler?.(msg)
  })
}

/** 导入、保存、删除后喊一嗓子，别的标签页据此刷新列表 */
export function notifyFiles(fileId?: string, removed = false) {
  ch?.postMessage({ type: 'files', fileId, removed, from: TAB_ID } satisfies TabsEvent)
}

/**
 * 问一圈：有没有别的标签页正开着这个文件。
 * 用超时兜底——没人应答就当没有，不能把菜单卡在这儿。
 */
export function probeOpenElsewhere(fileId: string, timeout = 300): Promise<boolean> {
  const channel = ch
  if (!channel) return Promise.resolve(false)
  const req = crypto.randomUUID()
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (open: boolean) => {
      if (done) return
      done = true
      channel.removeEventListener('message', onMsg)
      resolve(open)
    }
    const onMsg = (e: MessageEvent) => {
      const msg = e.data as TabsEvent
      if (msg.from === TAB_ID) return
      if (msg.type === 'here' && msg.req === req) finish(true)
    }
    channel.addEventListener('message', onMsg)
    channel.postMessage({ type: 'who', fileId, req, from: TAB_ID } satisfies TabsEvent)
    setTimeout(() => finish(false), timeout)
  })
}
