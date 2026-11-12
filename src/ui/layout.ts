/**
 * 左侧面板：只有「展开 / 收起」两态。
 *
 * 面板是 flex 流里的一张岛，展开就把编辑区挤窄，不再是覆盖用的浮层；
 * 宽度做 170ms 过渡，动画结束后才重排一次编辑器 ——
 * 每帧 measure 会让 CodeMirror/Monaco 反复重算，代价远大于这点动画。
 * 内容宽度锁在 --drawer-w 上（见 .drawer-inner），动画只改外层宽度，
 * 树里的几百行不会跟着每帧重排。
 */
export class Drawer {
  private open: boolean
  private settleTimer = 0

  /** 开合后的通知，供外部同步图标状态 */
  onChange: (open: boolean) => void = () => {}

  constructor(
    private panel: HTMLElement,
    private onLayout: () => void,
  ) {
    // 初始态由 HTML 给出（默认展开），读回来避免第一次同步时图标与面板错位
    this.open = panel.dataset.state !== 'closed'
    panel.setAttribute('aria-hidden', String(!this.open))
    panel.toggleAttribute('inert', !this.open)

    // 宽度过渡收尾 = 这一轮几何变化的终点，只在这里 measure 一次
    panel.addEventListener('transitionend', (e) => {
      if (e.target !== panel || e.propertyName !== 'width') return
      this.clearSettle()
      this.onLayout()
    })
  }

  get isOpen() {
    return this.open
  }

  /**
   * 逻辑宽度以 --drawer-w 为准。
   * 外层宽度在动画中会变，offsetWidth 拿不到稳定值，拖拽/键盘微调会一路丢像素。
   */
  get width() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--drawer-w')
    return Number.parseFloat(raw) || this.panel.offsetWidth
  }

  private clearSettle() {
    if (this.settleTimer) window.clearTimeout(this.settleTimer)
    this.settleTimer = 0
  }

  /** 过渡没跑起来（系统关了动画、标签页在后台）时的兜底，保证 layout 一定发生 */
  private scheduleLayout() {
    this.clearSettle()
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = 0
      this.onLayout()
    }, 240)
  }

  private setOpen(next: boolean) {
    if (this.open === next) return
    this.open = next
    this.panel.dataset.state = next ? 'open' : 'closed'
    this.panel.setAttribute('aria-hidden', String(!next))
    // 收起后宽度为 0，但里面的按钮仍能被 Tab 命中，inert 一并挡掉
    this.panel.toggleAttribute('inert', !next)
    this.scheduleLayout()
    this.onChange(next)
  }

  async show() {
    this.setOpen(true)
  }

  async hide() {
    this.setOpen(false)
  }

  async toggle() {
    this.setOpen(!this.open)
  }

  /** 拖动调宽度：只改 --drawer-w；松手后由 settle 补一次重排 */
  setWidth(px: number) {
    document.documentElement.style.setProperty('--drawer-w', `${px}px`)
  }

  settle(px: number) {
    this.setWidth(px)
    if (this.open) this.onLayout()
  }
}
