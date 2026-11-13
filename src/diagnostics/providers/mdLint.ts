import type { MessageKey } from '../../i18n'
import { isBlank, isIndentedCode, maskLines, toLines, type Line } from '../lines'
import type { Issue } from '../types'

/**
 * Markdown 风格检查（plans/markdown.md §8）。
 *
 * 规则号沿用 markdownlint 的 MD0xx：用户在其他编辑器里见过的提示能直接对上，
 * 不必再学一套命名。与 `structure` 的分工：
 * - `structure` 留语义型（标题跳级、同文件死链），本文件只管排版型；
 * - 所以这里**不实现** MD001（标题跳级）与 MD051（锚点失效），否则同一处报两遍。
 *
 * 为什么自己写而不是引 remark-lint：诊断管线是同步的（`analyze()` 被输入即调用），
 * remark-lint 是一整套 unified 插件（十几个包），而这里的规则都是逐行判断，
 * 位置精度不依赖语法树——行首偏移 + 列偏移与原文字符偏移一一对应。
 */

export interface MdRule {
  /** markdownlint 规则号 */
  id: string
  /** 默认开？关掉的是「对中文写作有害」或与本文档特性冲突的 */
  defaultOn: boolean
}

/**
 * 默认值依据 plans/markdown.md §8.2：
 * 关掉的四条分别是行长（中文写作有害）、内联 HTML（本文档明确支持）、
 * 围栏语言（语料 10% 命中）、首行 H1（大量文档从 H2 起）。
 */
export const MD_RULES: readonly MdRule[] = [
  { id: 'MD009', defaultOn: true }, // 行尾空格
  { id: 'MD010', defaultOn: true }, // 硬 Tab
  { id: 'MD012', defaultOn: true }, // 连续空行
  { id: 'MD013', defaultOn: false }, // 行长
  { id: 'MD018', defaultOn: true }, // # 后缺空格
  { id: 'MD019', defaultOn: true }, // # 后多空格
  { id: 'MD020', defaultOn: true }, // 闭合标题缺空格
  { id: 'MD021', defaultOn: true }, // 闭合标题多空格
  { id: 'MD022', defaultOn: true }, // 标题前后空行
  { id: 'MD023', defaultOn: true }, // 标题缩进
  { id: 'MD029', defaultOn: true }, // 有序列表编号
  { id: 'MD031', defaultOn: true }, // 围栏前后空行
  { id: 'MD032', defaultOn: true }, // 列表前后空行
  { id: 'MD037', defaultOn: true }, // 强调符号内侧空格
  { id: 'MD038', defaultOn: true }, // 行内代码内侧空格
  { id: 'MD039', defaultOn: true }, // 链接文字两侧空格
  { id: 'MD040', defaultOn: false }, // 围栏语言标记
  { id: 'MD041', defaultOn: false }, // 首行 H1
  { id: 'MD045', defaultOn: true }, // 图片 alt
  { id: 'MD047', defaultOn: true }, // 文件末尾换行
]

const DEFAULT_ON = new Set(MD_RULES.filter((rule) => rule.defaultOn).map((rule) => rule.id))

/** 单条规则的产量上限：一条规则刷满整个面板等于没有面板 */
const MAX_PER_RULE = 20

const MAX_LINE = 120

/* ------------------------------------------------------------ 正则 */

const ATX = /^( {0,3})(#{1,6})([ \t]*)(.*)$/
const CLOSED_ATX = /^( {0,3}#{1,6}[ \t]+.*?)([ \t]*)(#+)[ \t]*$/
const OL_ITEM = /^( {0,3})(\d{1,9})([.)])([ \t]+)/
const UL_ITEM = /^( {0,3})([-*+])([ \t]+)/
const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const EMPHASIS = /(\*{1,3})([^*\n]+?)\1/g
const CODE_SPAN = /(`+)([^`\n]+?)\1/g
const LINK_TEXT = /\[([^\]\n]*)\]\(/g
const IMAGE = /!\[([^\]\n]*)\]\(/g
const TRAILING_SPACE = /[ ]+$/
/** 只有引用符号的行（`>` / `> >`）：行尾那个空格是标记分隔，不是多余空白 */
const QUOTE_ONLY = /^[ \t]*(?:>[ \t]*)+$/

const isHeading = (text: string): boolean => ATX.test(text)

/* ------------------------------------------------------------ 实现 */

interface FenceAt {
  index: number
  open: boolean
  indent: number
  info: string
}

function collectFences(lines: Line[]): FenceAt[] {
  const out: FenceAt[] = []
  let cur: { ch: string; len: number } | null = null
  lines.forEach((line, index) => {
    const match = FENCE_LINE.exec(line.text)
    if (!cur) {
      if (match) {
        cur = { ch: match[2][0], len: match[2].length }
        out.push({ index, open: true, indent: match[1].length, info: match[3].trim() })
      }
      return
    }
    // 闭合围栏：同一种字符、不短于开启处，且后面不能有内容（CommonMark）
    if (match && match[2][0] === cur.ch && match[2].length >= cur.len && match[3].trim() === '') {
      out.push({ index, open: false, indent: match[1].length, info: '' })
      cur = null
    }
  })
  return out
}

/** 列表块：返回每个块的 [首行号, 末行号]，供 MD032 判前后空行 */
function listBlocks(lines: Line[], skip: boolean[]): Array<[number, number]> {
  const blocks: Array<[number, number]> = []
  let start = -1
  let end = -1
  const flush = () => {
    if (start >= 0) blocks.push([start, end])
    start = -1
    end = -1
  }
  lines.forEach((line, i) => {
    if (skip[i]) return flush()
    const text = line.text
    if (isBlank(text)) return // 松散列表中间允许空行，不清状态
    const isItem = UL_ITEM.test(text) || OL_ITEM.test(text)
    const isContinuation = /^[ \t]{2,}\S/.test(text)
    if (isItem) {
      if (start < 0) start = i
      end = i
      return
    }
    if (isContinuation && start >= 0) {
      end = i
      return
    }
    flush()
  })
  flush()
  return blocks
}

interface Reporter {
  (id: string, from: number, to: number, params?: Record<string, string | number>): void
}

export function mdLintIssues(text: string, enabled: ReadonlySet<string> = DEFAULT_ON): Issue[] {
  const lines = toLines(text)
  const skip = maskLines(lines)
  const issues: Issue[] = []
  const count = new Map<string, number>()

  const report: Reporter = (id, from, to, params) => {
    const used = count.get(id) ?? 0
    if (used >= MAX_PER_RULE) return
    count.set(id, used + 1)
    const start = Math.max(0, Math.min(from, text.length))
    const end = Math.max(start + 1, Math.min(to, text.length))
    issues.push({
      from: start,
      to: end,
      severity: 'warning',
      kind: 'mdLint',
      key: `md.${id}` as MessageKey,
      params,
      source: 'mdLint',
    })
  }

  const on = (id: string): boolean => enabled.has(id)

  /* ---- MD009 行尾空格 / MD010 硬 Tab：逐行扫，跳过代码与缩进代码 */
  lines.forEach((line, i) => {
    if (skip[i] || isIndentedCode(line.text)) return
    const base = line.start
    if (on('MD009') && !QUOTE_ONLY.test(line.text)) {
      const match = TRAILING_SPACE.exec(line.text)
      if (match) {
        const size = match[0].length
        // 恰好两个空格是 Markdown 的硬换行，合法
        const hardBreak = size === 2 && line.text.trim() !== ''
        if (!hardBreak) {
          report('MD009', base + line.text.length - size, base + line.text.length, { n: size })
        }
      }
    }
    if (on('MD010')) {
      const tab = line.text.indexOf('\t')
      if (tab >= 0) report('MD010', base + tab, base + tab + 1)
    }
  })

  /* ---- MD012 连续空行 */
  if (on('MD012')) {
    let run = 0
    lines.forEach((line, i) => {
      if (skip[i]) {
        run = 0
        return
      }
      if (!isBlank(line.text)) {
        run = 0
        return
      }
      run++
      // 一段连续空行只报一次：十行空行报九条，面板会被同一条规则灌满
      if (run === 2) report('MD012', line.start, line.start + 1)
    })
  }

  /* ---- MD018 / MD019 / MD020 / MD021 / MD023 标题写法 */
  const fences = collectFences(lines)
  const fenceLines = new Set(fences.map((f) => f.index))
  /**
   * 「这一行是代码内容」。围栏本身要算可见行：
   * 判断标题/段落后有没有空行时，``` 就是紧邻的那个块，必须能被看见。
   */
  const isCode = (i: number): boolean => skip[i] === true && !fenceLines.has(i)

  lines.forEach((line, i) => {
    if (skip[i]) return
    const text = line.text
    const base = line.start

    if (on('MD023') && /^ {1,3}#{1,6}(\s|$)/.test(text)) {
      const indent = text.length - text.trimStart().length
      report('MD023', base, base + indent)
      return
    }

    const atx = ATX.exec(text)
    if (!atx) return
    const [, indent, hashes, gap, rest] = atx
    const hashFrom = base + indent.length

    if (gap.length === 0) {
      // `#标题`：这行其实是个列表外的手写错误，报在 # 上
      if (on('MD018') && rest.trim() !== '') {
        report('MD018', hashFrom, hashFrom + hashes.length + 1)
        return
      }
      return
    }
    if (on('MD019') && gap.length > 1) {
      report('MD019', hashFrom, hashFrom + hashes.length + gap.length)
    }

    const closed = CLOSED_ATX.exec(text)
    if (closed) {
      const [, body, space, marks] = closed
      const markFrom = base + body.length
      // 闭合符号紧贴在正文后面（`# 标题#`）或多空格（`# 标题  ##`）
      if (space.length === 0) report('MD020', markFrom, markFrom + marks.length)
      else if (space.length > 1 && on('MD021')) report('MD021', markFrom, markFrom + space.length + marks.length)
    }
  })

  /* ---- MD022 标题前后空行 */
  if (on('MD022')) {
    lines.forEach((line, i) => {
      if (skip[i] || !isHeading(line.text)) return
      const prev = i > 0 ? lines[i - 1] : null
      if (prev && !isCode(i - 1) && !isBlank(prev.text) && !isHeading(prev.text)) {
        report('MD022', line.start, line.start + 1)
      }
      const next = i + 1 < lines.length ? lines[i + 1] : null
      if (!next || isCode(i + 1) || isBlank(next.text)) return
      // 后面跟围栏/列表也算 MD022：那两条规则的「前侧」检查会让位给这里，
      // 否则标题紧跟代码块会两边都不报
      report('MD022', line.start + line.text.length, line.start + line.text.length + 1)
    })
  }

  /* ---- MD031 围栏前后空行 */
  if (on('MD031')) {
    for (const fence of fences) {
      if (fence.indent !== 0) continue // 列表里的围栏由列表规则负责
      const line = lines[fence.index]
      if (fence.open) {
        const prev = fence.index > 0 ? lines[fence.index - 1] : null
        if (!prev || isCode(fence.index - 1)) continue
        // 紧跟在标题后面由 MD022 报，这里让位，避免同一处两条
        if (isBlank(prev.text) || isHeading(prev.text)) continue
        report('MD031', line.start, line.start + line.text.length)
      } else {
        const next = fence.index + 1 < lines.length ? lines[fence.index + 1] : null
        if (!next || isCode(fence.index + 1) || isBlank(next.text)) continue
        report('MD031', line.start, line.start + line.text.length)
      }
    }
  }

  /* ---- MD032 列表前后空行 */
  if (on('MD032')) {
    for (const [first, last] of listBlocks(lines, skip)) {
      const prev = first > 0 ? lines[first - 1] : null
      if (prev && !skip[first - 1] && !isBlank(prev.text) && !isHeading(prev.text)) {
        report('MD032', lines[first].start, lines[first].start + 1)
      }
      const next = last + 1 < lines.length ? lines[last + 1] : null
      if (next && !skip[last + 1] && !isBlank(next.text) && !isHeading(next.text)) {
        report('MD032', lines[last].start, lines[last].start + lines[last].text.length)
      }
    }
  }

  /* ---- MD029 有序列表编号：全 1 或 1,2,3… 两种风格都放过 */
  if (on('MD029')) {
    let run: Array<{ num: number; from: number; to: number }> = []
    let indent = -1
    const flush = () => {
      if (run.length > 1 && !run.every((item) => item.num === 1)) {
        const start = run[0].num
        run.forEach((item, k) => {
          const expect = start + k
          if (item.num !== expect) report('MD029', item.from, item.to, { expect })
        })
      }
      run = []
      indent = -1
    }
    lines.forEach((line, i) => {
      if (skip[i]) return flush()
      const match = OL_ITEM.exec(line.text)
      if (match) {
        const nextIndent = match[1].length
        if (run.length > 0 && nextIndent !== indent) flush()
        indent = nextIndent
        const from = line.start + match[1].length
        run.push({ num: Number(match[2]), from, to: from + match[2].length })
        return
      }
      if (isBlank(line.text)) return // 松散列表：空行不断开编号
      if (/^[ \t]{2,}\S/.test(line.text) && run.length > 0) return // 续行
      flush()
    })
    flush()
  }

  /* ---- MD037 / MD038 / MD039 / MD045 行内元素 */
  lines.forEach((line, i) => {
    if (skip[i]) return
    const text = line.text
    const base = line.start

    if (on('MD037')) {
      // 行首 `* ` 是列表符号：从它开始匹配到的「强调」全是假象
      const bullet = /^( {0,3})[*+-][ \t]/.exec(text)
      const bulletAt = bullet ? bullet[1].length : -1
      EMPHASIS.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = EMPHASIS.exec(text))) {
        const inner = match[2]
        if (!/^\s|\s$/.test(inner)) continue
        // 行首的 `* ` 是列表符号，不是强调
        if (match.index === bulletAt) continue
        const marker = match[1][0]
        const before = text[match.index - 1] ?? ' '
        const after = text[match.index + match[0].length] ?? ' '
        // 只吃到 `**粗体**` 半个标记时，前后会紧贴同类符号，那属于另一个强调块
        if (before === marker || after === marker) continue
        // `_` 夹在词中间（snake_case）不是强调
        if (marker === '_' && (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after))) continue
        report('MD037', base + match.index, base + match.index + match[0].length)
      }
    }

    if (on('MD038')) {
      CODE_SPAN.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = CODE_SPAN.exec(text))) {
        const inner = match[2]
        if (inner.trim() === '') continue
        if (!/^\s|\s$/.test(inner)) continue
        report('MD038', base + match.index, base + match.index + match[0].length)
      }
    }

    if (on('MD039')) {
      LINK_TEXT.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = LINK_TEXT.exec(text))) {
        // `![alt](x)` 是图片，alt 交给 MD045
        if (match.index > 0 && text[match.index - 1] === '!') continue
        const inner = match[1]
        if (inner.trim() === '' || !/^\s|\s$/.test(inner)) continue
        report('MD039', base + match.index, base + match.index + match[0].length)
      }
    }

    if (on('MD045')) {
      IMAGE.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = IMAGE.exec(text))) {
        if (match[1].trim() !== '') continue
        report('MD045', base + match.index, base + match.index + match[0].length)
      }
    }
  })

  /* ---- MD013 行长（默认关） */
  if (on('MD013')) {
    lines.forEach((line, i) => {
      if (skip[i] || isIndentedCode(line.text)) return
      const width = Array.from(line.text).length
      if (width > MAX_LINE) report('MD013', line.start, line.start + line.text.length, { n: width })
    })
  }

  /* ---- MD040 围栏缺语言（默认关） */
  if (on('MD040')) {
    for (const fence of fences) {
      if (!fence.open || fence.info !== '') continue
      const line = lines[fence.index]
      report('MD040', line.start, line.start + line.text.length)
    }
  }

  /* ---- MD041 首行 H1（默认关） */
  if (on('MD041')) {
    const first = lines.findIndex((line, i) => !skip[i] && !isBlank(line.text))
    if (first >= 0 && !/^ {0,3}#[ \t]/.test(lines[first].text)) {
      report('MD041', lines[first].start, lines[first].start + 1)
    }
  }

  /* ---- MD047 文件末尾恰好一个换行 */
  if (on('MD047') && text.length > 0) {
    const tail = /\n*$/.exec(text)?.[0].length ?? 0
    if (tail === 0) report('MD047', text.length - 1, text.length)
    else if (tail > 1) report('MD047', text.length - tail, text.length - 1)
  }

  return issues
}
