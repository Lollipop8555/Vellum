/**
 * Markdown 幻灯片的词法器。
 *
 * Adapted from gnab/remark v0.15.0 — `src/remark/lexer.js`
 * (MIT License, Copyright (c) 2014-2017 Ole Petter Bang)
 * https://github.com/gnab/remark
 *
 * 与上游的差异只有三处，分页 / 围栏 / 备注的判定规则一字未改：
 *   1. CommonJS → ESM + TypeScript（`module.exports` 换成具名导出）；
 *   2. 每个 token 附带 `start`：它在源文本里的字符偏移，供「页 → 源码行号」定位。
 *      上游只关心 token 的顺序，不需要位置；
 *   3. CRLF 归一化交给调用方（上游的 `src.replace('\r', '')` 只去掉第一个 \r，
 *      是 bug，这里不复制它）。
 */
import type { Token } from './types'

const CODE = 1
const INLINE_CODE = 2
const CONTENT = 3
const FENCES = 4
const DEF = 5
const DEF_HREF = 6
const DEF_TITLE = 7
const MACRO = 8
const MACRO_ARGS = 9
const MACRO_OBJ = 10
const SLIDE_SEPARATOR = 11
const FRAGMENT_SEPARATOR = 12
const NOTES_SEPARATOR = 13

const regexByName: Record<string, RegExp> = {
  CODE: /(?:^|\n\n)( {4}[^\n]+\n*)+/,
  INLINE_CODE: /`([^`].*?)`/,
  CONTENT: /(?:\\)?((?:\.[a-zA-Z_\-][a-zA-Z\-_0-9]*)+)\[/,
  // 用字符串构造：`\4` 指向拼接后的第 4 个捕获组（fences 的围栏符），
  // 单看这一条正则是「无效反向引用」，字面量形式会被 TS 静态报错（TS1533）
  FENCES: new RegExp('(?:^|\\n) *(`{3,}|~{3,}) *(?:\\S+)? *\\n(?:[\\s\\S]+?)\\s*\\4 *(?:\\n+|$)'),
  DEF: /(?:^|\n) *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +["(]([^\n]+)[")])? *(?:\n+|$)/,
  MACRO: /!\[:([^\] ]+)([^\]]*)\](?:\(([^\)]*)\))?/,
  SLIDE_SEPARATOR: /(?:^|\n)(---|<!--\s*break\s*-->)(?:\n|$)/,
  FRAGMENT_SEPARATOR: /(?:^|\n)(--)(?![^\n])/,
  NOTES_SEPARATOR: /(?:^|\n)(\?{3})(?:\n|$)/,
}

const block = replace(
  /CODE|INLINE_CODE|CONTENT|FENCES|DEF|MACRO|SLIDE_SEPARATOR|FRAGMENT_SEPARATOR|NOTES_SEPARATOR/,
  regexByName,
)
const inline = replace(
  /CODE|INLINE_CODE|CONTENT|FENCES|DEF|MACRO/,
  regexByName,
)

export function lexer(src: string): Token[] {
  const tokens = lex(src, block, [], 0)

  // 相邻的 text token 合并（上游 lex 内层递归产生的碎片）
  for (let i = tokens.length - 2; i >= 0; i--) {
    if (tokens[i].type === 'text' && tokens[i + 1].type === 'text') {
      tokens[i].text = (tokens[i].text ?? '') + (tokens[i + 1].text ?? '')
      tokens.splice(i + 1, 1)
    }
  }

  return tokens
}

/**
 * 逐段扫描。`base` 是 `src` 在**调用方原始文本**里的起点偏移，
 * 于是 `token.start` 永远指向原始文本，内层递归（内容类）也不例外。
 */
function lex(src: string, regex: RegExp, tokens: Token[], base: number): Token[] {
  let cap: RegExpExecArray | null
  let text: string | undefined

  while ((cap = regex.exec(src)) !== null) {
    const at = base + cap.index
    // 本次匹配连同内容类里被「吃掉」的文本一共推进多少
    let consumed = cap.index + cap[0].length

    if (cap.index > 0) {
      tokens.push({ type: 'text', text: src.substring(0, cap.index), start: base })
    }

    if (cap[CODE]) {
      tokens.push({ type: 'code', text: cap[0], start: at })
    } else if (cap[INLINE_CODE]) {
      tokens.push({ type: 'text', text: cap[0], start: at })
    } else if (cap[FENCES]) {
      tokens.push({ type: 'fences', text: cap[0], start: at })
    } else if (cap[DEF]) {
      tokens.push({
        type: 'def',
        start: at,
        id: cap[DEF].toLowerCase(),
        href: cap[DEF_HREF],
        title: cap[DEF_TITLE],
      })
    } else if (cap[MACRO]) {
      tokens.push({
        type: 'macro',
        start: at,
        name: cap[MACRO],
        args: (cap[MACRO_ARGS] || '').split(',').map(trim),
        obj: cap[MACRO_OBJ],
      })
    } else if (cap[SLIDE_SEPARATOR] || cap[FRAGMENT_SEPARATOR]) {
      tokens.push({
        type: 'separator',
        start: at,
        // 上游这里只存捕获组（`'---'`），丢了前后换行 → 无法知道分隔符的结束位置。
        // 我们存整段 `cap[0]`，捕获组另放 marker，下游要用 start+length 定位下一页首行
        text: cap[0],
        marker: (cap[SLIDE_SEPARATOR] || cap[FRAGMENT_SEPARATOR] || '').trim(),
      })
    } else if (cap[NOTES_SEPARATOR]) {
      tokens.push({ type: 'notes_separator', text: cap[NOTES_SEPARATOR], start: at })
    } else if (cap[CONTENT]) {
      text = getTextInBrackets(src, cap.index + cap[0].length)
      if (text !== undefined) {
        const innerStart = at + cap[0].length
        consumed = cap.index + cap[0].length + text.length + 1

        if (cap[0][0] !== '\\') {
          tokens.push({
            type: 'content_start',
            start: at,
            classes: cap[CONTENT].substring(1).split('.'),
            block: text.indexOf('\n') !== -1,
          })
          lex(text, inline, tokens, innerStart)
          tokens.push({
            type: 'content_end',
            start: innerStart + text.length,
            block: text.indexOf('\n') !== -1,
          })
        } else {
          // `\[.class[text]]`：转义后的内容类，按普通文本处理
          tokens.push({ type: 'text', text: cap[0].substring(1) + text + ']', start: at })
        }
      } else {
        tokens.push({ type: 'text', text: cap[0], start: at })
      }
    }

    src = src.substring(consumed)
    base += consumed
  }

  if (src || tokens.length === 0) {
    tokens.push({ type: 'text', text: src, start: base })
  }

  return tokens
}

function replace(regex: RegExp, replacements: Record<string, RegExp>): RegExp {
  return new RegExp(
    regex.source.replace(/\w{2,}/g, (key) => replacements[key].source),
  )
}

function trim(text: string | undefined): string | undefined {
  if (typeof text === 'string') return text.trim()
  return text
}

function getTextInBrackets(src: string, offset: number): string | undefined {
  let depth = 1
  let pos = offset

  while (depth > 0 && pos < src.length) {
    const chr = src[pos++]
    depth += (chr === '[' && 1) || (chr === ']' && -1) || 0
  }

  if (depth === 0) return src.substr(offset, pos - offset - 1)
  return undefined
}
