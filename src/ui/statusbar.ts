import { t } from '../i18n'
import { wordCount } from '../shell/transform'
import { formatBytes } from '../shell/largefile'
import { ENGINE_NAMES, engineIcon } from './icons'
import type { EngineId } from '../types'

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

/** 引擎指示：图标 + 名字，窄窗口里由 CSS 只留图标 */
export function setEngine(id: EngineId) {
  const chip = $('stEngine')
  chip.innerHTML = `${engineIcon(id)}<span class="st-engine-name">${ENGINE_NAMES[id]}</span>`
  chip.title = ENGINE_NAMES[id]
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

/**
 * 大文件的语法高亮开关，点击切换；只在值得提醒时出现。
 * `alt` 是「另一个引擎能着色」时给的那个引擎：徽标上挂它的图标，
 * 看见的是「换过去就行」，而不是一行「当前引擎不支持」的字。
 */
export function setHighlight(state: HighlightState, show: boolean, alt: EngineId | null = null) {
  const chip = $('stHighlight')
  chip.hidden = !show
  const label = t(
    state === 'on' ? 'status.highlight' : state === 'off' ? 'status.highlightOff' : 'status.highlightNa',
  )
  chip.innerHTML = alt ? `${engineIcon(alt)}<span>${label}</span>` : label
  chip.title = t(
    state === 'na' && alt
      ? 'status.highlightNoEngine'
      : state === 'na'
        ? 'status.highlightNaHint'
        : 'status.highlightHint',
  )
  // 「关掉」和「没语法」都不是在着色，样式上一并压暗，别让人以为正开着
  chip.classList.toggle('is-off', state !== 'on')
}
