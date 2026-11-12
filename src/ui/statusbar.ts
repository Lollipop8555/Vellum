import { t } from '../i18n'
import { wordCount } from '../shell/transform'
import { formatBytes } from '../shell/largefile'
import { ENCODING_LABELS, ENCODING_SHORT } from '../shell/codec'
import { ENGINE_NAMES, engineIcon } from './icons'
import type { EncodingId, EngineId } from '../types'

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

/**
 * 编码格。库内一律 UTF-8，但「导入时按什么解码」是这个文件的一段历史，
 * 只写在弹窗里没人看得到，所以状态栏直接说「GBK → UTF-8」。
 */
export function setEncoding(encoding: EncodingId, source: EncodingId | null = null) {
  const chip = $('stEncoding')
  const label = ENCODING_LABELS[encoding]
  const from = source && source !== encoding ? source : null

  if (!from) {
    chip.textContent = label
    chip.title = t('status.encodingHint')
    return
  }
  chip.textContent = `${ENCODING_SHORT[from]} → ${label}`
  chip.title = t('status.encodingSourceHint', { from: ENCODING_LABELS[from], to: label })
}

const clock = (ts?: number) =>
  new Date(ts ?? Date.now()).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * 保存状态（O15）：Ctrl/Cmd+S 只落库，落库与否要有地方看得见。
 * 但「没按保存键」有三种完全不同的处境，合成一句「未保存」等于什么都没说：
 * - saved：已提交版本（同时留了快照）
 * - draft：自动写成了本地草稿，刷新/关页面不会丢，但还没成为一个版本
 * - unsaved：刚改完，草稿还在防抖窗口里，最多两秒后落盘
 * - nodraft：大文件、只读文件不写草稿，这时候关页面是真的会丢
 * idle 表示没有打开文件，不显示任何字。
 */
export type SaveState = 'idle' | 'saved' | 'draft' | 'unsaved' | 'nodraft'

export function setSaved(state: SaveState, at?: number) {
  const chip = $('stSaved')
  chip.hidden = state === 'idle'
  if (state === 'idle') return

  const time = clock(at)
  const label = t(state === 'saved' ? 'status.saved' : 'status.unsaved')
  const extra =
    state === 'draft'
      ? t('status.draftSuffix', { time })
      : state === 'nodraft'
        ? t('status.noDraftSuffix')
        : ''
  // 拆两段：窄窗口下 CSS 只留「未保存」，原因退到 tooltip 里
  chip.innerHTML = extra ? `${label}<span class="st-extra">${extra}</span>` : label
  chip.title =
    state === 'saved'
      ? t('status.savedHint')
      : state === 'draft'
        ? t('status.draftHint', { time })
        : state === 'nodraft'
          ? t('status.noDraftHint')
          : t('status.unsavedHint')
  chip.classList.toggle('is-dirty', state !== 'saved')
  // 无草稿是唯一真的会丢改动的一档，用告警色而不是强调色
  chip.classList.toggle('is-warn', state === 'nodraft')
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

/** 只读的三种成因：说法不一样，用户才知道该点、该关别的标签页，还是该接受 */
export type ReadonlyReason = 'manual' | 'big' | 'locked'

/**
 * 只读徽标。
 * - locked：当前是否只读
 * - big：大文件档位（默认锁，解锁后徽标也留着，提醒这是大文件）
 * - toggleable：点了是否生效（被别的标签页占着写锁时就不该给点）
 * - reason：为什么只读；大文件解锁后点击没有意义，也不给手型
 */
export function setReadonly(
  locked: boolean,
  big = false,
  toggleable = false,
  reason: ReadonlyReason = 'manual',
) {
  const chip = $('stReadonly')
  chip.hidden = !(locked || big)
  chip.classList.toggle('clickable', toggleable && locked)

  if (!locked) {
    chip.textContent = t('status.editable')
    chip.title = t(big ? 'status.editableBigHint' : 'status.editableHint')
    return
  }

  const suffix =
    reason === 'locked'
      ? t('status.readonlyLockedSuffix')
      : reason === 'big'
        ? t('status.readonlyBigSuffix')
        : ''
  const base = t('status.readonly')
  chip.innerHTML = suffix ? `${base}<span class="st-extra">${suffix}</span>` : base
  chip.title = t(
    reason === 'locked'
      ? 'status.readonlyLockedHint'
      : reason === 'big'
        ? 'status.readonlyBigHint'
        : 'status.readonlyHint',
  )
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
