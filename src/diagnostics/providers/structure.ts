import type { SyntaxNode, Tree } from '@lezer/common'
import type { LangId } from '../../editors/languages'
import { extOf } from '../registry'
import type { Issue } from '../types'

/**
 * 结构层：数据与文档的「形状」错误。
 *
 * 与格式层的分工：格式层问「这份文本合法吗」（JSON.parse / DOMParser 说了算），
 * 结构层问「合法但明显写错了」（同一个键出现两次、表格这一行少一列）。
 * 都必须是**能确定**的错，判不了就不报（plans/diagnostics.md §5）。
 */

const MAX_DUP_KEY = 10
const MAX_TABLE = 5
const MAX_HEADING_JUMP = 3
const MAX_DEAD_LINK = 3
const MAX_HTML_UNCLOSED = 2

/* ------------------------------------------------------------ 重复键 */

/** JSON 的键要按「解析后的字符串」比，`"a"` 与 `"\u0061"` 是同一个键 */
function normalizeJsonKey(raw: string): string {
  try {
    return String(JSON.parse(raw))
  } catch {
    return raw
  }
}

function normalizeYamlKey(raw: string): string {
  const text = raw.trim()
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * 同一映射里重复的键。JSON / YAML 的树都把「映射」与「键值对」分得很干净：
 * JSON `Object > Property > PropertyName`，YAML `BlockMapping|FlowMapping > Pair > Key`。
 *
 * YAML 的 `<<` 合并键重复是合法的，必须放过。
 */
export function duplicateKeyIssues(tree: Tree, text: string, lang: LangId): Issue[] {
  const isJson = lang === 'json'
  const mapNames = isJson ? ['Object'] : ['BlockMapping', 'FlowMapping']
  const pairName = isJson ? 'Property' : 'Pair'
  const keyName = isJson ? 'PropertyName' : 'Key'

  const issues: Issue[] = []
  tree.iterate({
    enter(node) {
      if (issues.length >= MAX_DUP_KEY) return false
      if (!mapNames.includes(node.name)) return
      const seen = new Set<string>()
      let child: SyntaxNode | null = node.node.firstChild
      while (child) {
        if (child.name === pairName) {
          const key = child.getChild(keyName)
          if (key) {
            const raw = text.slice(key.from, key.to)
            const name = isJson ? normalizeJsonKey(raw) : normalizeYamlKey(raw)
            if (name && name !== '<<') {
              if (seen.has(name)) {
                issues.push({
                  from: key.from,
                  to: key.to,
                  severity: 'error',
                  kind: 'structure',
                  key: 'issues.dupKey',
                  params: { key: name },
                  source: 'structure',
                })
              } else {
                seen.add(name)
              }
            }
          }
        }
        child = child.nextSibling
      }
      return
    },
  })
  return issues
}

/* --------------------------------------------------------- Markdown */

interface Line {
  start: number
  text: string
}

function toLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  while (start <= text.length) {
    const nl = text.indexOf('\n', start)
    const end = nl < 0 ? text.length : nl
    lines.push({ start, text: text.slice(start, end).replace(/\r$/, '') })
    if (nl < 0) break
    start = nl + 1
  }
  return lines
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/

/**
 * 逐行标出「这一行是不是代码块/前置元数据」。
 * 死链、标题跳级、表格列数这三条规则都必须在代码块外才成立：
 * 文档里贴一段示例 Markdown 是常态，那里面什么奇怪写法都有。
 */
function maskLines(lines: Line[]): boolean[] {
  const skip = new Array<boolean>(lines.length).fill(false)
  let fence: string | null = null
  // 前置元数据只在文件最开头成立
  if (lines.length > 1 && /^---\s*$/.test(lines[0].text)) {
    const end = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line.text))
    if (end > 0) for (let i = 0; i <= end; i++) skip[i] = true
  }
  lines.forEach((line, i) => {
    if (skip[i]) return
    const match = FENCE.exec(line.text)
    if (fence) {
      skip[i] = true
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = null
      return
    }
    if (match) {
      fence = match[1]
      skip[i] = true
    }
  })
  return skip
}

/** GitHub 风格的锚点：小写、去标点、空格换连字符。用途只是「能不能对上」 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[`*_~[\](){}<>#!.,:;'"?!+=|\\/@^$%]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+$/, '')
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/
const LINK = /\[[^\]]*\]\(#([^)\s]+)\)/g

function markdownIssues(text: string): Issue[] {
  const lines = toLines(text)
  const skip = maskLines(lines)
  const issues: Issue[] = []

  // ---- 标题：跳级 + 收集锚点
  const anchors = new Set<string>()
  let prevLevel = 0
  let jumps = 0
  for (let i = 0; i < lines.length; i++) {
    if (skip[i]) continue
    const match = HEADING.exec(lines[i].text)
    if (!match) continue
    const level = match[1].length
    const title = match[2]
    anchors.add(slugify(title))
    // 从 H1 直接跳到 H3 才是错；首个标题是 H2/H3 的文档很常见，不追究
    if (prevLevel > 0 && level > prevLevel + 1 && jumps < MAX_HEADING_JUMP) {
      jumps++
      const from = lines[i].start + lines[i].text.indexOf(match[1])
      issues.push({
        from,
        to: Math.max(from + 1, from + level),
        severity: 'warning',
        kind: 'structure',
        key: 'issues.headingJump',
        params: { from: prevLevel, to: level },
        source: 'structure',
      })
    }
    prevLevel = level
  }

  // ---- 同文件锚点链接
  let dead = 0
  for (let i = 0; i < lines.length && dead < MAX_DEAD_LINK; i++) {
    if (skip[i]) continue
    LINK.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = LINK.exec(lines[i].text))) {
      const raw = match[1]
      let anchor = raw
      try {
        anchor = decodeURIComponent(raw)
      } catch {
        // 保持原样，按原文比对
      }
      // 忽略 "L10"、"L10-L20" 这类行号锚点，那是别家工具的约定
      if (/^L\d+(-L?\d+)?$/i.test(anchor)) continue
      if (anchors.has(slugify(anchor)) || anchors.has(anchor.toLowerCase())) continue
      if (dead >= MAX_DEAD_LINK) break
      dead++
      const from = lines[i].start + (match.index ?? 0)
      issues.push({
        from,
        to: from + match[0].length,
        severity: 'warning',
        kind: 'structure',
        key: 'issues.deadAnchor',
        params: { anchor: raw },
        source: 'structure',
      })
    }
  }

  // ---- 表格列数
  let tables = 0
  for (let i = 0; i + 1 < lines.length; i++) {
    if (skip[i] || skip[i + 1]) continue
    if (!isTableRow(lines[i].text) || !isTableSeparator(lines[i + 1].text)) continue
    const expect = cellCount(lines[i].text)
    if (expect < 2) continue
    let j = i + 2
    while (j < lines.length && !skip[j] && isTableRow(lines[j].text)) {
      const actual = cellCount(lines[j].text)
      if (actual !== expect && tables < MAX_TABLE) {
        tables++
        const from = lines[j].start + (lines[j].text.length - lines[j].text.trimStart().length)
        issues.push({
          from,
          to: Math.max(from + 1, lines[j].start + lines[j].text.trimEnd().length),
          severity: 'warning',
          kind: 'structure',
          key: 'issues.tableCols',
          params: { actual, expect },
          source: 'structure',
        })
      }
      j++
    }
    i = j - 1
  }

  return issues
}

function isTableRow(text: string): boolean {
  return /\|/.test(text) && /^\s*\|/.test(text)
}

function isTableSeparator(text: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(text) && /-/.test(text) && (text.match(/\|/g)?.length ?? 0) >= 1
}

/** 单元格数：先抹掉代码片段里的 `|`，再抹掉转义的 `\|`，最后按分隔符数点位 */
function cellCount(text: string): number {
  const cleaned = text.replace(/`[^`]*`/g, '``').replace(/\\\|/g, '__')
  const inner = cleaned.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').length
}

/* -------------------------------------------------------- 分隔符文件 */

function dsvCellCount(line: string, delim: string): number {
  let count = 1
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') i++
      else quoted = !quoted
      continue
    }
    if (!quoted && ch === delim) count++
  }
  return count
}

/**
 * CSV / TSV 的列数一致性。
 *
 * 降噪闸门：只要不匹配的行超过 10%，就认为「这大概不是真的表格」整条不报。
 * 拿一堆文本文件误判成 CSV 再标满黄线，比什么都不查更糟。
 */
function dsvIssues(text: string, name: string): Issue[] {
  const delim = extOf(name) === 'tsv' ? '\t' : ','
  const lines = toLines(text).filter((line) => line.text.trim() !== '')
  if (lines.length < 2) return []

  const expect = dsvCellCount(lines[0].text, delim)
  if (expect < 2) return []

  const bad = lines.slice(1).filter((line) => dsvCellCount(line.text, delim) !== expect)
  if (bad.length === 0 || bad.length > Math.max(1, lines.length * 0.1)) return []

  return bad.slice(0, MAX_TABLE).map((line) => {
    const from = line.start + (line.text.length - line.text.trimStart().length)
    return {
      from,
      to: Math.max(from + 1, line.start + line.text.trimEnd().length),
      severity: 'warning' as const,
      kind: 'structure' as const,
      key: 'issues.tableCols' as const,
      params: { actual: dsvCellCount(line.text, delim), expect },
      source: 'structure',
    }
  })
}

/* ------------------------------------------------------------- HTML */

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g

/**
 * 只在「完整 HTML 文档」上报未闭合标签，且只报文件末尾还开着的。
 *
 * lezer 的 HTML 语法只标「闭合标签对不上」，对末尾忘了闭合一律沉默——
 * 那恰好是手写 HTML 最常见的错。这里补上这一半，闭合错位仍然交给语法层，
 * 两边不重叠，不会一个错报两遍。
 */
function htmlUnclosedIssues(text: string): Issue[] {
  // 片段（partial）里不闭合是常态：没有 doctype/html/body 就当片段，整条跳过
  if (!/<!doctype|<html[\s>]|<body[\s>]/i.test(text.slice(0, 4096))) return []

  const stack: Array<{ name: string; from: number; to: number }> = []
  const unclosed: Array<{ name: string; from: number; to: number }> = []

  const remember = (item: { name: string; from: number; to: number }) => {
    if (unclosed.length >= MAX_HTML_UNCLOSED) return
    unclosed.push(item)
  }

  TAG.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG.exec(text))) {
    const closing = match[1] === '/'
    const name = match[2].toLowerCase()
    const selfClosing = match[4] === '/'
    if (closing) {
      const at = findLast(stack, name)
      if (at >= 0) {
        // 关到更外层的标签时，中间那些还开着的是真的没闭合：在开标签处报，
        // 位置比语法层指着的那个「关错地方的标签」更接近病根
        while (stack.length - 1 > at) remember(stack.pop()!)
        stack.pop()
      }
      continue
    }
    if (selfClosing || VOID_TAGS.has(name)) continue
    if (name === 'script' || name === 'style') {
      // 脚本与样式里的 `<` 不是标签；直接跳到闭合标签之后
      const close = new RegExp(`</${name}\\s*>`, 'i')
      const rest = text.slice(match.index)
      const found = close.exec(rest)
      if (found) TAG.lastIndex = match.index + found.index + found[0].length
      continue
    }
    stack.push({ name, from: match.index, to: match.index + match[0].length })
  }
  // 到文件末尾还开着的（嵌套时只报最内层几层）
  while (stack.length > 0 && unclosed.length < MAX_HTML_UNCLOSED) remember(stack.pop()!)

  return unclosed.map((item) => ({
    from: item.from,
    to: Math.max(item.from + 1, Math.min(item.to, text.length)),
    severity: 'warning' as const,
    kind: 'structure' as const,
    key: 'issues.htmlUnclosed' as const,
    params: { tag: item.name },
    source: 'structure',
  }))
}

function findLast(stack: Array<{ name: string }>, name: string): number {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name === name) return i
  return -1
}

/* -------------------------------------------------------------- 入口 */

export function structureIssues(
  text: string,
  lang: LangId,
  name: string,
  tree: Tree | null,
): Issue[] {
  const ext = extOf(name)
  const issues: Issue[] = []

  if (tree && (lang === 'json' || lang === 'yaml')) {
    issues.push(...duplicateKeyIssues(tree, text, lang))
  }
  if (lang === 'markdown') {
    issues.push(...markdownIssues(text))
  } else if (ext === 'csv' || ext === 'tsv') {
    issues.push(...dsvIssues(text, name))
  }
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') {
    issues.push(...htmlUnclosedIssues(text))
  }
  return issues
}
