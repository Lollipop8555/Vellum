/**
 * 抽屉两阶段动画：
 * 阶段一 只做 transform 位移（合成器，不重排）
 * 阶段二 动画结束后一次性把编辑区左边距推开，让岛本身变窄，并调用一次 layout()
 * 关闭时顺序相反：先撤销边距并 layout 一次（面板仍盖住该区域），再滑出
 */
export class Drawer {
  private running: Animation | null = null
  private shown = false

  constructor(
    private panel: HTMLElement,
    private editorEl: HTMLElement,
    private onLayout: () => void,
  ) {}

  get isOpen() {
    return this.shown
  }

  private reduceMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /**
   * 抽屉右缘到编辑区左缘需要推开的距离。
   * 用 margin 而不是 padding：岛自身跟着变窄，编辑区的边框和背景不会留出一条空洞。
   */
  private insetFor(width: number): number {
    const host = this.editorEl.parentElement ?? document.body
    const gap = Number.parseFloat(getComputedStyle(host).columnGap) || 0
    const delta = this.editorEl.getBoundingClientRect().left - host.getBoundingClientRect().left
    return Math.max(0, width - delta + gap)
  }

  private commitOpen() {
    const w = this.panel.offsetWidth
    this.editorEl.style.marginLeft = `${this.insetFor(w)}px`
    this.onLayout()
  }

  private commitClosed() {
    this.editorEl.style.marginLeft = '0px'
    this.onLayout()
  }

  async show() {
    if (this.shown) return
    this.shown = true
    this.panel.setAttribute('aria-hidden', 'false')

    if (this.reduceMotion()) {
      this.panel.style.transform = 'translateX(0)'
      this.commitOpen()
      return
    }

    this.running?.cancel()
    this.running = this.panel.animate(
      [{ transform: 'translateX(calc(-100% - 12px))' }, { transform: 'translateX(0)' }],
      { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
    )
    try {
      await this.running.finished
    } catch {
      return
    }
    this.panel.style.transform = 'translateX(0)'
    this.commitOpen()
  }

  async hide() {
    if (!this.shown) return
    this.shown = false
    this.panel.setAttribute('aria-hidden', 'true')

    if (this.reduceMotion()) {
      this.commitClosed()
      this.panel.style.transform = 'translateX(calc(-100% - 12px))'
      return
    }

    // 先撤销占位（面板仍覆盖该区域），再滑出
    this.commitClosed()

    this.running?.cancel()
    this.running = this.panel.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(calc(-100% - 12px))' }],
      { duration: 200, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
    )
    try {
      await this.running.finished
    } catch {
      return
    }
    this.panel.style.transform = 'translateX(-100%)'
  }

  async toggle() {
    if (this.shown) await this.hide()
    else await this.show()
  }
}
