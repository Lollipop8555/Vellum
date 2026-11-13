/**
 * 英文词典：**懒加载**。
 *
 * 词表是 2 万词的纯文本（155KB，gzip 后 ~73KB），只有真的勾了拼写检查才会下载，
 * 所以「不勾拼写」的代价是零。加载失败（离线首次打开、文件被删）就永远停在
 * 「未就绪」，拼写项自动一条都不报——宁可不出结果，也不能拿半张表去误报。
 *
 * 词表由 scripts/vendor-dict.mjs 生成，不要手改 en.txt。
 */
import { EXTRA_WORDS } from './extra'

let words: Set<string> | null = null
let pending = false
let failed = false
const waiting: Array<() => void> = []
const failedWaiting: Array<() => void> = []

/** 词表；null = 还没加载好 */
export function dictWords(): Set<string> | null {
  return words
}

/** 加载失败了（面板据此提示「词典不可用」，而不是「无问题」） */
export function dictFailed(): boolean {
  return failed
}

export function onDictReady(fn: () => void): void {
  if (words) fn()
  else if (!failed) waiting.push(fn)
}

/** 加载失败时通知一次：面板要能把「无问题」换成「词典不可用」 */
export function onDictFailed(fn: () => void): void {
  if (failed) fn()
  else if (!words) failedWaiting.push(fn)
}

/** 幂等：重复调用只会真正加载一次 */
export function ensureDict(): void {
  if (words || pending || failed) return
  pending = true
  // `?raw` + 动态 import：Vite 会把它拆成独立 chunk，用到才下载
  void import('./en.txt?raw')
    .then((mod) => {
      const set = new Set<string>()
      for (const word of mod.default.split('\n')) if (word) set.add(word)
      for (const word of EXTRA_WORDS) set.add(word)
      words = set
      pending = false
      for (const fn of waiting) fn()
      waiting.length = 0
    })
    .catch(() => {
      pending = false
      failed = true
      for (const fn of failedWaiting) fn()
      failedWaiting.length = 0
    })
}
