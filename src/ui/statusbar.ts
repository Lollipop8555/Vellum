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

/**
 * 当前文件大小（D-22）。整站缓存的占用口径放在抽屉底部，
 * 状态栏只说「这个文件多大」，两处数字对不上时不会互相误导。
 */
export function setSize(bytes: number | null) {
  const chip = $('stCache')
  chip.hidden = bytes === null
  if (bytes === null) return
  chip.textContent = t('status.size', { size: formatBytes(bytes) })
}

export function setEncoding(label: string) {
  $('stEncoding').textContent = label
}

/**
 * 保存状态（O15）：Ctrl/Cmd+S 只落库，落库与否要有地方看得见。
 * idle 表示没有打开文件，不显示任何字。
 */
export function setSaved(state: 'saved' | 'unsaved' | 'idle') {
  const chip = $('stSaved')
  chip.hidden = state === 'idle'
  chip.textContent = state === 'saved' ? t('status.saved') : t('status.unsaved')
  chip.classList.toggle('is-dirty', state === 'unsaved')
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
 * 文案也跟着说「换 Monaco 着色」——只写「无语法」会让人以为文件没救，
 * 也容易把对方引擎的图标误读成当前引擎。
 */
export function setHighlight(state: HighlightState, show: boolean, alt: EngineId | null = null) {
  const chip = $('stHighlight')
  chip.hidden = !show
  const label =
    state === 'na' && alt
      ? t('status.highlightSwitch', { engine: ENGINE_NAMES[alt] })
      : t(
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
