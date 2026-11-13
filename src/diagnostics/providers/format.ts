import type { LangId } from '../../editors/languages'
import type { Issue } from '../types'

/**
 * 格式层：用平台自带的解析器判「合法/不合法」。
 *
 * JSON 走 `JSON.parse`（消息比语法树精确得多），XML 走 `DOMParser`（能发现
 * 未声明的命名空间前缀这类良构问题）。两者都是原生 API，成本可以忽略。
 */

/** DOMParser 在 1MB 以上会明显拖慢主线程；超过就只靠 lezer 的 error 节点 */
const XML_DOM_LIMIT = 1024 * 1024

/**
 * 从浏览器给的消息里挖出偏移；挖不到返回 null。
 *
 * V8 有一部分消息是不带位置的（`Unexpected token '}', ... is not valid JSON`），
 * 这种时候宁可交给语法层指位置，也不要瞎指一个开头——指错位置比没有位置更伤。
 */
function offsetFromMessage(message: string, text: string): number | null {
  const byPos = /position (\d+)/.exec(message)
  if (byPos) return Math.max(0, Math.min(Number(byPos[1]), text.length))

  const byLine = /line (\d+)[ ,]+(?:at )?column (\d+)/i.exec(message)
  if (byLine) {
    const line = Number(byLine[1])
    const column = Number(byLine[2])
    let offset = 0
    let current = 1
    while (current < line && offset < text.length) {
      const nl = text.indexOf('\n', offset)
      if (nl < 0) break
      offset = nl + 1
      current++
    }
    return Math.min(offset + Math.max(0, column - 1), text.length)
  }
  return null
}

/** 把区间撑到一个 token 的宽度，否则波浪线只有一像素 */
function widen(text: string, pos: number): { from: number; to: number } {
  if (text.length === 0) return { from: 0, to: 0 }
  let from = Math.max(0, Math.min(pos, text.length - 1))
  let to = from + 1
  while (to < text.length && to - from < 40 && !/[\s,;:{}[\]()"'`]/.test(text[to])) to++
  if (to <= from) {
    from = Math.max(0, text.length - 1)
    to = text.length
  }
  return { from, to }
}

/* --------------------------------------------------------------- JSON */

function jsonIssues(text: string): Issue[] {
  if (text.trim() === '') return []
  try {
    JSON.parse(text)
    return []
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const pos = offsetFromMessage(message, text)
    // 位置不明的 JSON 错误交给 lezer 的 error 节点：它有位置，只是消息糙
    if (pos === null) return []
    const { from, to } = widen(text, pos)
    return [
      {
        from,
        to,
        severity: 'error',
        kind: 'format',
        key: 'issues.jsonParse',
        params: {
          // 去掉 "in JSON at position 42" 这类尾巴，位置已经在波浪线上体现了
          detail: message.replace(/\s*in JSON at position.*$/i, '').trim(),
        },
        source: 'json',
      },
    ]
  }
}

/* ---------------------------------------------------------------- XML */

function xmlIssues(text: string): Issue[] {
  if (text.trim() === '') return []
  if (text.length > XML_DOM_LIMIT) return []

  let doc: Document
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml')
  } catch {
    return []
  }

  const byTag = doc.getElementsByTagName('parsererror')[0]
  const root = doc.documentElement
  const errEl = byTag ?? (root && root.nodeName.toLowerCase() === 'parsererror' ? root : null)
  if (!errEl) return []

  const raw = errEl.textContent ?? ''
  // 连位置都挖不出来时交给 lezer，自己瞎指一个位置只会误导
  const pos = offsetFromMessage(raw, text)
  if (pos === null) return []

  const detail = raw
    .replace(/^[\s\S]*?(?:error on line|XML Parsing Error:)/i, '')
    .replace(/Below is a rendering[\s\S]*$/i, '')
    .replace(/^\s*(?:error on line \d+ (?:at|,) ?column \d+:\s*)/i, '')
    .replace(/^\s*[\d ]*:?\s*/, '')
    .trim()

  const { from, to } = widen(text, pos)
  return [
    {
      from,
      to,
      severity: 'error',
      kind: 'format',
      key: 'issues.xmlParse',
      params: { detail: detail || raw.trim() },
      source: 'xml',
    },
  ]
}

/* -------------------------------------------------------------- 入口 */

/**
 * 「这个语言/扩展名该不该跑格式层」由能力矩阵（registry.ts）判，这里只管跑。
 * 两处都判会活成两份真相，早晚打架。
 */
export function formatIssues(text: string, lang: LangId): Issue[] {
  if (lang === 'json') return jsonIssues(text)
  if (lang === 'xml') return xmlIssues(text)
  return []
}
