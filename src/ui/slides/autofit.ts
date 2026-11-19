/**
 * 把一页内容当成**一个块**塞进页卡：块按内容自然排版，量一次尺寸，
 * 再用 `transform: scale()` 整体缩放到页面可用区域里，不裁切。
 *
 * 为什么是整体缩放而不是缩字号：页内尺寸（标题、行高、代码、表格）几乎都写成
 * `em`，缩字号确实也等于等比排版，但**换行会变**——字号小一点，同一段文字少占
 * 一行，高度不再随字号线性变化，只能反复试探（上一版迭代 6 次还在逼近）；
 * 图片、SVG 图表更是完全不跟字号缩，缩到下限仍会溢出。
 * `transform` 不触发重排，量一次就结束，图片和图表的比例也天然一致。
 *
 * 块宽度必须是 `fit-content`（CSS 见 `.deck-page-inner`）：宽度若固定 100%，
 * 一行标题的块宽就等于页宽，`ratio` 被宽度卡死在 1，**永远放大不了**。
 * 让内容自己决定宽度之后，`min(可用宽/块宽, 可用高/块高)` 才是「刚好塞满一页」。
 *
 * 缩放比例存在 `--deck-fit`（CSS 里是 `.deck-page-inner` 的 `transform: scale`），
 * 同时记在 `data-fit`（百分比）与 `data-overflow`（缩到下限仍放不下）上，供样式与测试读取。
 *
 * **这个函数必须自包含**：放映器（`player.ts`）用 `String(fitPageContent)`
 * 把源码注入独立窗口，那里没有模块作用域，引用任何外部变量都会 ReferenceError。
 */
export function fitPageContent(inner: HTMLElement): void {
  /** 再小就不像幻灯片了：正文 28px × 0.4 = 11.2px，实际只有内容失控的页会撞到 */
  const MIN_FIT = 0.4
  /** 极简页放大到 1.8 倍为止：h1 约 100px，有存在感又不至于变成标语 */
  const MAX_FIT = 1.8
  /** 自然高度已经占到大半页，就不再放大，免得「刚好半页」被撑成贴边 */
  const GROW_LIMIT = 0.6

  const page = inner.parentElement
  if (!page) return
  const cs = getComputedStyle(page)
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
  const availW = page.clientWidth - padX
  const availH = page.clientHeight - padY
  if (availW <= 0 || availH <= 0) return

  // 量的必须是「没缩放过的块」：offsetWidth/offsetHeight 是布局尺寸，
  // 不受页卡上 `--deck-scale` 和这里 `--deck-fit` 的影响，不用像量 rect 那样除掉缩放系数
  inner.style.setProperty('--deck-fit', '1')
  const blockW = inner.offsetWidth
  const blockH = inner.offsetHeight
  if (!blockW || !blockH) return

  let fit = Math.min(availW / blockW, availH / blockH)
  // 图表不是文字：纵向流程图天然又窄又高，一上来就超过 GROW_LIMIT，
  // 「别放大」的规则会让它缩在页中央一小条。整页以图为主时按可用区域铺满。
  const diagramFirst = !!inner.querySelector('.mermaid-block, .graphviz-block, .plantuml-block')
  if (!diagramFirst && blockH > availH * GROW_LIMIT) fit = Math.min(fit, 1)
  fit = Math.min(MAX_FIT, Math.max(MIN_FIT, fit))
  // 亚像素误差不值得写进变量：0.998 和 1 视觉上没差别
  fit = Math.round(fit * 1000) / 1000

  inner.style.setProperty('--deck-fit', String(fit))
  inner.dataset.fit = String(Math.round(fit * 100))

  // 缩到下限还是放不下：内容量确实失控了，页角点一个提示（样式见 `.deck-page::after`）
  if (blockH * fit > availH + 0.5 || blockW * fit > availW + 0.5) {
    inner.dataset.overflow = '1'
  } else {
    delete inner.dataset.overflow
  }
}
