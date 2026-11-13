import { t, type MessageKey } from '../i18n'
import { MAX_ISSUES } from '../diagnostics'
import { languageMatrix, type CheckAvailability } from '../diagnostics/registry'
import {
  CHECK_LIST,
  issueText,
  type CheckKind,
  type ChecksSettings,
  type Issue,
} from '../diagnostics/types'
import type { LangId } from '../editors/languages'
import { openDialog } from './dialogs'
import { ENGINE_NAMES, engineIcon } from './icons'

/**
 * 检查面板：只负责把 app 算好的结果画出来。
 *
 * 这里没有任何"要不要检查"的判断——面板显隐、勾选项都不影响检查本身
 * （plans/diagnostics.md §7.4），面板关掉时这个模块根本不会被调用。
 */

export type IssuesPhase = 'idle' | 'running' | 'off' | 'na' | 'big'

export interface IssuesState {
  phase: IssuesPhase
  issues: Issue[]
  /** 结果与当前内容不一致，正在后台重跑 */
  stale: boolean
  checks: ChecksSettings
  optionsOpen: boolean
  text: string
  bigLimit: string
  /** 每个检查项在这个文件上能不能跑；决定复选框是否置灰与置灰理由 */
  availability: Record<CheckKind, CheckAvailability>
  /** 一项都跑不了时该怪谁，用于空态文案 */
  naReason: 'planned' | 'noParser' | 'langOnly' | 'ext' | null
  /** 拼写检查的忽略词，逗号分隔展示 */
  spellIgnore: string[]
  /** 词典加载失败：拼写项一条都报不出来，空态要说清楚而不是「无问题」 */
  dictFailed: boolean
  /** 当前文件的语言，矩阵里置顶并高亮这一行 */
  lang: LangId
}

const REASON_KEY: Record<'planned' | 'noParser' | 'langOnly' | 'ext', MessageKey> = {
  planned: 'issues.naReason.planned',
  noParser: 'issues.naReason.noParser',
  langOnly: 'issues.naReason.langOnly',
  ext: 'issues.naReason.ext',
}

/** 行内只放得下三四个字；完整解释留在 tooltip 里 */
const WHY_KEY: Record<'planned' | 'noParser' | 'langOnly' | 'ext', MessageKey> = {
  planned: 'issues.why.planned',
  noParser: 'issues.why.noParser',
  langOnly: 'issues.why.langOnly',
  ext: 'issues.why.ext',
}

export interface IssuesHandlers {
  onToggleCheck(id: CheckKind): void
  onJump(issue: Issue): void
  onRerun(): void
  /** 忽略词输入框改了（提交时一次性给整串，解析在 app 侧做） */
  onSpellIgnoreChange(raw: string): void
}

/** 行号表只维护一份：面板一次渲染最多 200 条，逐条扫描正文会很浪费 */
let lineCacheText = ''
let lineCacheStarts: number[] = []

function lineStarts(text: string): number[] {
  if (text === lineCacheText) return lineCacheStarts
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  lineCacheText = text
  lineCacheStarts = starts
  return starts
}

function locate(text: string, offset: number): { line: number; column: number } {
  const starts = lineStarts(text)
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return { line: low + 1, column: offset - starts[low] + 1 }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function buildOptions(state: IssuesState, handlers: IssuesHandlers): HTMLElement {
  const box = el('div', 'issues-options')
  const groups: Array<{ id: 'syntax' | 'semantic' | 'text'; title: string }> = [
    { id: 'syntax', title: t('issues.group.syntax') },
    { id: 'semantic', title: t('issues.group.semantic') },
    { id: 'text', title: t('issues.group.text') },
  ]
  for (const group of groups) {
    const section = el('div', 'issues-check-group')
    section.append(el('div', 'issues-check-title', group.title))
    for (const def of CHECK_LIST.filter((d) => d.group === group.id)) {
      const row = el('label', 'issues-check')
      const input = el('input')
      input.type = 'checkbox'
      input.checked = state.checks[def.id]
      const availability = state.availability[def.id]
      // 两种「不能查」要分开说：还没实现 vs 这个文件用不上
      input.disabled = !def.ready || !availability.ok
      input.addEventListener('change', () => handlers.onToggleCheck(def.id))
      row.append(input, el('span', 'issues-check-label', t(`check.${def.id}` as MessageKey)))
      // 原因不能只塞在 tooltip 里：鼠标不悬停就永远看不到，用户会以为这项坏了
      if (!def.ready) {
        row.classList.add('is-disabled')
        row.title = t('issues.planned')
        row.append(el('span', 'issues-check-why', t('issues.why.planned')))
      } else if (!availability.ok) {
        row.classList.add('is-disabled')
        row.title = t(REASON_KEY[availability.reason])
        row.append(el('span', 'issues-check-why', t(WHY_KEY[availability.reason])))
      }
      section.append(row)
    }
    box.append(section)
  }

  // 拼写的「忽略的单词」：只在勾了拼写时才值得占地方
  if (state.checks.spell || state.checks.spellIdent) {
    const section = el('div', 'issues-check-group')
    section.append(el('div', 'issues-check-title', t('issues.spellIgnore')))
    const input = el('input', 'issues-check-input')
    input.type = 'text'
    input.placeholder = t('issues.spellIgnoreHint')
    input.value = state.spellIgnore.join(', ')
    input.spellcheck = false
    // change 而不是 input：每敲一个字母就重跑一次全量检查太浪费
    input.addEventListener('change', () => handlers.onSpellIgnoreChange(input.value))
    section.append(input)
    box.append(section)
  }

  const rerun = el('button', 'btn btn-ghost issues-rerun', t('issues.rerun'))
  rerun.addEventListener('click', () => handlers.onRerun())
  // 支持矩阵是「查资料」，不是常驻信息——十几列 × 100 多行塞进侧栏会把检查结果整个挤下去
  const support = el('button', 'btn btn-ghost issues-support-btn', t('issues.support'))
  support.addEventListener('click', () => openSupportDialog(state.lang))
  const actions = el('div', 'issues-actions')
  actions.append(rerun, support)
  box.append(actions)
  return box
}

/**
 * 图例把三种状态摊开说：两个引擎都行 / 只有一个引擎行 / 不行。
 * 中间那种直接用引擎图标，和表格里的单元格长得一样，不用再解释「那个小图标是啥」。
 */
function buildLegend(): HTMLElement {
  const legend = el('div', 'support-legend')
  const engineMarks = el('span', 'support-legend-engines')
  engineMarks.innerHTML = engineIcon('cm') + engineIcon('monaco')
  legend.append(
    el('span', 'support-legend-mark is-yes', '✓'),
    el('span', undefined, t('issues.supportLegendYes')),
    engineMarks,
    el('span', undefined, t('issues.supportLegendEngine')),
    el('span', 'support-legend-mark is-no', '×'),
    el('span', undefined, t('issues.supportLegendNo')),
  )
  return legend
}

/**
 * 「语言 × 检查项」矩阵，弹窗展示。
 *
 * 数据来自 `languageMatrix()`，即同一套 `checkAvailability`——不另外维护一张表，
 * 否则加了新解析器、改了门槛，这张表就会开始撒谎。
 */
function openSupportDialog(lang: LangId): void {
  const wrap = el('div', 'support-wrap')
  wrap.append(buildLegend())

  const scroll = el('div', 'support-scroll')
  const table = el('table', 'support-table')

  const headRow = el('tr')
  const corner = el('th', 'support-lang', t('issues.supportLang'))
  headRow.append(corner)
  for (const def of CHECK_LIST) {
    const th = el('th', 'support-col', t(`checkShort.${def.id}` as MessageKey))
    th.title = t(`check.${def.id}` as MessageKey)
    headRow.append(th)
  }
  const thead = el('thead')
  thead.append(headRow)

  const tbody = el('tbody')
  const all = languageMatrix()
  // 当前文件的语言置顶：用户来这儿就是查它，不该在 110 行里翻
  const current = all.find((l) => l.id === lang)
  const rows = current ? [current, ...all.filter((l) => l !== current)] : all

  for (const row of rows) {
    const tr = el('tr')
    if (row.id === lang) tr.classList.add('is-here')

    const name = el('td', 'support-lang')
    name.append(el('span', 'support-lang-label', row.label))
    if (row.id === lang) name.append(el('span', 'support-lang-tag', t('issues.supportHere')))
    name.title = row.label
    tr.append(name)

    CHECK_LIST.forEach((_, i) => {
      const ok = row.ok[i]
      const cell = el('td', 'support-cell')
      if (!ok) {
        cell.classList.add('is-no')
        cell.textContent = '×'
        const reason = row.reasons[i]
        cell.title = reason ? t(REASON_KEY[reason]) : t('issues.planned')
      } else if (row.engine) {
        // 只有一侧引擎认得这门语言：把 ✓ 换成那家的图标。检查是纯文本分析、
        // 两个引擎都跑，但用户切过去会发现满屏黑白，得知道自己押在哪个引擎上
        cell.classList.add('is-engine')
        cell.innerHTML = engineIcon(row.engine)
        cell.title = t('issues.supportEngine', {
          engine: ENGINE_NAMES[row.engine],
          lang: row.label,
        })
      } else {
        cell.classList.add('is-yes')
        cell.textContent = '✓'
      }
      tr.append(cell)
    })
    tbody.append(tr)
  }

  table.append(thead, tbody)
  scroll.append(table)
  wrap.append(scroll)
  openDialog({ title: t('issues.supportTitle'), body: wrap, wide: true })
}

function emptyText(state: IssuesState): { title: string; hint: string } {
  switch (state.phase) {
    case 'off':
      return { title: t('issues.off'), hint: t('issues.offHint') }
    case 'na':
      return {
        // 「这门语言查不了」和「当前勾选的都用不上」是两回事，别用同一句话糊过去
        title: t(state.naReason === 'noParser' ? 'issues.naLang' : 'issues.naCheck'),
        hint: state.naReason ? t(REASON_KEY[state.naReason]) : t('issues.naLangHint'),
      }
    case 'big':
      return { title: t('issues.tooBig'), hint: t('issues.tooBigHint', { size: state.bigLimit }) }
    case 'running':
      return { title: t('issues.running'), hint: '' }
    default:
      // 「勾了拼写但词典没下载下来」不能被说成「无问题」
      if (state.dictFailed && (state.checks.spell || state.checks.spellIdent)) {
        return { title: t('issues.dictFailed'), hint: t('issues.dictFailedHint') }
      }
      return { title: t('issues.clean'), hint: t('issues.cleanHint') }
  }
}

export function renderIssues(root: HTMLElement, state: IssuesState, handlers: IssuesHandlers): void {
  root.replaceChildren()

  if (state.optionsOpen) root.append(buildOptions(state, handlers))

  if (state.stale) {
    const bar = el('div', 'issues-stale', t('issues.stale'))
    root.append(bar)
  }

  if (state.issues.length === 0) {
    const empty = el('div', 'issues-empty')
    const info = emptyText(state)
    empty.append(el('div', 'issues-empty-title', info.title))
    if (info.hint) empty.append(el('div', 'issues-empty-hint', info.hint))
    root.append(empty)
    return
  }

  const list = el('div', 'issues-list')
  const groups: Array<{ severity: 'error' | 'warning'; title: string }> = [
    { severity: 'error', title: t('status.diagErrors', { n: count(state.issues, 'error') }) },
    { severity: 'warning', title: t('status.diagWarnings', { n: count(state.issues, 'warning') }) },
  ]
  for (const group of groups) {
    const items = state.issues.filter((i) => i.severity === group.severity)
    if (items.length === 0) continue
    list.append(el('div', `issues-group issues-group-${group.severity}`, group.title))
    for (const issue of items) {
      const { line, column } = locate(state.text, issue.from)
      const row = el('button', `issue-item issue-item-${issue.severity}`)
      row.title = t('issues.jump')
      row.append(el('span', 'issue-dot'))
      row.append(el('span', 'issue-msg', issueText(issue)))
      row.append(el('span', 'issue-loc', `${line}:${column}`))
      row.addEventListener('click', () => handlers.onJump(issue))
      list.append(row)
    }
  }
  if (state.issues.length >= MAX_ISSUES) {
    list.append(el('div', 'issues-truncated', t('issues.truncated')))
  }
  root.append(list)
}

function count(issues: Issue[], severity: 'error' | 'warning'): number {
  return issues.filter((i) => i.severity === severity).length
}
