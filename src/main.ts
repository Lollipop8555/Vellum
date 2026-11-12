import './ui/styles.css'
import './ui/tree.css'
import { startApp } from './shell/app'

void startApp()

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* PWA 是增强项，注册失败不影响主流程 */
    })
  })
}
