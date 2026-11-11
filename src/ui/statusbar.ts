import { t } from '../i18n'
import { wordCount } from '../shell/transform'
import { formatBytes } from '../shell/largefile'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

export function setCursor(line: number, col: number) {
  $('stCursor').textContent = t('status.line', { line, col })
}

export function setCount(text: string) {
  const lines = text === '' ? 0 : text.split('\n').length
  $('stCount').textContent = t('status.count', {
    lines,
    chars: text.length,
    words: wordCount(text),
  })
}

export function setCache(used: number, quota: number) {
  $('stCache').textContent = t('status.cache', {
    used: formatBytes(used),
    quota: quota ? formatBytes(quota) : '—',
  })
}

export function setEncoding(label: string) {
  $('stEncoding').textContent = label
}

export function setLanguage(label: string) {
  $('stLang').textContent = label
}

export function setEol(eol: 'lf' | 'crlf') {
  $('stEol').textContent = eol === 'crlf' ? 'CRLF' : 'LF'
}

export function setEngineLabel(label: string) {
  $('stEngine').textContent = label
}

/**
 * 只读徽标。
 * - locked：当前是否只读
 * - big：大文件档位（默认锁，但允许点开编辑，解锁后徽标也留着方便改回去）
 * - toggleable：点了是否生效（被别的标签页占着写锁时就不该给点）
 */
export function setReadonly(locked: boolean, big = false, toggleable = false) {
  const chip = $('stReadonly')
  chip.hidden = !(locked || big)
  chip.textContent = t(locked ? 'status.readonly' : 'status.editable')
  chip.title = t(locked ? 'status.readonlyHint' : 'status.editableHint')
  chip.classList.toggle('clickable', toggleable)
}

/** 轻量模式：高亮还在，但预览、自动换行、格式化被关掉 */
export function setLight(v: boolean) {
  $('stLight').hidden = !v
}

/** on：正在上色；off：用户关掉了；na：这文件没语法可挂（纯文本），开关没有意义 */
export type HighlightState = 'on' | 'off' | 'na'

/** 大文件的语法高亮开关，点击切换；只在值得提醒时出现 */
export function setHighlight(state: HighlightState, show: boolean) {
  const chip = $('stHighlight')
  chip.hidden = !show
  chip.textContent = t(
    state === 'on' ? 'status.highlight' : state === 'off' ? 'status.highlightOff' : 'status.highlightNa',
  )
  chip.title = t(state === 'na' ? 'status.highlightNaHint' : 'status.highlightHint')
  // 「关掉」和「没语法」都不是在着色，样式上一并压暗，别让人以为正开着
  chip.classList.toggle('is-off', state !== 'on')
}
