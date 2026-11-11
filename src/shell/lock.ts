/**
 * 同一文件被多个标签页同时编辑会互相覆盖草稿，这里用 BroadcastChannel 做单写者仲裁。
 * 新标签页 claim 时广播 probe，若已有标签页持有同一文件则回复 busy，新页面转为只读。
 */
const CHANNEL = 'vellum-file-lock'
const TAB_ID = crypto.randomUUID()

type Msg = { type: 'probe' | 'busy' | 'release'; fileId: string; from: string }

export class FileLock {
  private ch: BroadcastChannel | null
  private held: string | null = null
  private busyHandler: ((fileId: string) => void) | null = null

  constructor() {
    this.ch = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null
    this.ch?.addEventListener('message', (e) => {
      const msg = e.data as Msg
      if (msg.from === TAB_ID) return
      if (msg.type === 'probe' && this.held === msg.fileId) {
        this.post({ type: 'busy', fileId: msg.fileId, from: TAB_ID })
      }
      if (msg.type === 'busy' && msg.fileId === this.pending) {
        this.conflict = true
      }
    })
  }

  private pending: string | null = null
  private conflict = false

  onBusy(fn: (fileId: string) => void) {
    this.busyHandler = fn
  }

  async claim(fileId: string): Promise<boolean> {
    if (!this.ch) return true
    this.pending = fileId
    this.conflict = false
    this.post({ type: 'probe', fileId, from: TAB_ID })
    await new Promise((r) => setTimeout(r, 90))
    this.pending = null
    if (this.conflict) {
      this.busyHandler?.(fileId)
      return false
    }
    this.held = fileId
    return true
  }

  release() {
    if (this.held) this.post({ type: 'release', fileId: this.held, from: TAB_ID })
    this.held = null
  }

  private post(msg: Msg) {
    this.ch?.postMessage(msg)
  }
}
