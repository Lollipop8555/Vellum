import './ui/styles.css'
import './ui/tree.css'
import { startApp } from './shell/app'

// 两个样式表到这里已经注入完毕，摘掉首帧兜底类，
// 内联 SVG 的尺寸重新交回组件样式（见 index.html 里那段 .is-booting 规则）
document.documentElement.classList.remove('is-booting')

void startApp()

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* PWA 是增强项，注册失败不影响主流程 */
    })
  })
}
