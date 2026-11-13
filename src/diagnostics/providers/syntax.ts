import type { Tree } from '@lezer/common'
import type { Issue } from '../types'

/**
 * 语法层：lezer 树的 error 节点 + 无解析器语言的括号配平。
 *
 * 设计依据：plans/diagnostics.md §4（轻量的开）、§5（判断不了的不报）
 */

/** 括号配平只报最内层这几个，报多了就是噪音 */
const MAX_UNCLOSED = 3
const MAX_STRAY = 5

const CLOSER_OF: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const OPENER_OF: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/**
 * 遍历 error 节点。lezer 是容错解析器：缺一个右括号照样出树，
 * 只是树里埋了 error 节点，位置通常正好落在出问题的那一段。
 */
export function treeIssues(tree: Tree, textLength: number): Issue[] {
  const raw: Array<{ from: number; to: number }> = []
  tree.iterate({
    enter(node) {
      if (node.type.isError) raw.push({ from: node.from, to: node.to })
    },
  })
  if (raw.length === 0) return []

  // error 节点会嵌套、也会相邻，合并成一段再报，否则同一处会冒出好几条
  raw.sort((a, b) => a.from - b.from || a.to - b.to)
  const merged: Array<{ from: number; to: number }> = []
  for (const range of raw) {
    const last = merged[merged.length - 1]
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to)
    } else {
      merged.push({ ...range })
    }
  }

  const issues: Issue[] = []
  for (const range of merged) {
    // 单点错误（EOF 处的「缺少 }」经常是零长度）也要有可见区间，否则画不出波浪线
    let from = Math.min(range.from, Math.max(0, textLength - 1))
    let to = Math.max(range.to, from + 1)
    if (from >= textLength) {
      from = Math.max(0, textLength - 1)
      to = textLength
    }
    if (to <= from) continue
    issues.push({
      from,
      to,
      severity: 'error',
      kind: 'syntax',
      key: 'issues.syntax',
      source: 'syntax',
    })
  }
  return issues
}

/**
 * 括号配平：只给「没有解析器」的语言兜底，且有解析器时绝不启用——
 * 解析器已经知道哪里不合法，再叠一层朴素扫描只会自相矛盾。
 *
 * 朴素扫描绕不开字符串与注释，所以策略是「宁可不报」：认不出的引号直接放弃整段，
 * 未闭合只报最内层几个。
 */
export function balanceIssues(text: string): Issue[] {
  const stack: Array<{ char: string; pos: number }> = []
  const stray: Issue[] = []
  let i = 0
  let lineComment = false
  let blockComment = false
  let quote = ''

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]

    if (lineComment) {
      if (ch === '\n') lineComment = false
      i++
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (quote) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === quote) quote = ''
      i++
      continue
    }
    if (ch === '/' && next === '/') {
      lineComment = true
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      blockComment = true
      i += 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      i++
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ char: ch, pos: i })
      i++
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack[stack.length - 1]
      if (top && top.char === OPENER_OF[ch]) {
        stack.pop()
      } else if (stray.length < MAX_STRAY) {
        stray.push(
          top
            ? {
                from: i,
                to: i + 1,
                severity: 'error',
                kind: 'syntax',
                key: 'issues.balanceMismatch',
                params: { char: ch, expected: CLOSER_OF[top.char] },
                source: 'balance',
              }
            : {
                from: i,
                to: i + 1,
                severity: 'error',
                kind: 'syntax',
                key: 'issues.balanceStray',
                params: { char: ch },
                source: 'balance',
              },
        )
      }
      i++
      continue
    }
    i++
  }

  const unclosed: Issue[] = []
  for (let k = stack.length - 1; k >= 0 && unclosed.length < MAX_UNCLOSED; k--) {
    const item = stack[k]
    unclosed.push({
      from: item.pos,
      to: item.pos + 1,
      severity: 'error',
      kind: 'syntax',
      key: 'issues.balanceOpen',
      params: { char: item.char },
      source: 'balance',
    })
  }
  return [...stray, ...unclosed]
}
