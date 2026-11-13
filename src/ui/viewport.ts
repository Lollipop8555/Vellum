/**
 * 真实可见高度。
 *
 * 100vh 在移动端取的是「大视口」：顶部标题栏、浏览器地址栏占掉的那段不算在
 * 内容里，但页面照它铺满，底部状态栏和编辑区最后一行就被挤出屏幕。dvh 能跟着
 * 工具栏收放变化，可在内嵌 WebView 里仍然可能偏大，所以最终以这里量到的
 * visualViewport 高度为准，写进 --app-height 交给 styles.css 使用。
 */

/** 可见高度（CSS 像素）：没有 visualViewport 的老内核退回 innerHeight */
export function visibleHeight(): number {
  const vv = window.visualViewport
  if (!vv) return window.innerHeight
  // 捏合缩放时 visualViewport 只算放大后那一块，乘回 scale 还原成布局用的高度
  return Math.round(vv.height * (vv.scale || 1))
}

/** 可见宽度，作用同上：fixed 浮层的横向夹取要用它，不能用 innerWidth */
export function visibleWidth(): number {
  const vv = window.visualViewport
  if (!vv) return window.innerWidth
  return Math.round(vv.width * (vv.scale || 1))
}

/**
 * 跟踪可见高度并同步到 --app-height。
 *
 * onChange 在高度或宽度变化后各触发一次（rAF 合并，连续拖动只排一次），
 * 调用方拿它去重新 measure 编辑器——布局按容器算，不跟着变就会量出旧尺寸。
 */
export function trackViewportHeight(onChange: () => void): void {
  const root = document.documentElement
  const vv = window.visualViewport
  let lastH = 0
  let lastW = 0
  let raf = 0

  const sync = () => {
    const h = visibleHeight()
    const w = visibleWidth()
    if (!h) return
    const changed = h !== lastH || w !== lastW
    if (h !== lastH) {
      lastH = h
      root.style.setProperty('--app-height', `${h}px`)
    }
    lastW = w
    // 宽高都没变（例如只是页面滚动导致 visualViewport 派发事件）就不惊动编辑器
    if (changed) onChange()
  }

  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      sync()
    })
  }

  // 首帧就写值：编辑器初始化时会读容器高度，晚一帧就会按错误高度量一次
  sync()

  window.addEventListener('resize', schedule, { passive: true })
  window.addEventListener('orientationchange', schedule, { passive: true })
  // 地址栏收放、软键盘弹起只派发 visualViewport 的 resize，不冒泡到 window
  vv?.addEventListener('resize', schedule, { passive: true })
  vv?.addEventListener('scroll', schedule, { passive: true })
}
