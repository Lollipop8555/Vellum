/**
 * Markdown 幻灯片的结构解析器。
 *
 * Adapted from gnab/remark v0.15.0 — `src/remark/parser.js`
 * (MIT License, Copyright (c) 2014-2017 Ole Petter Bang)
 * https://github.com/gnab/remark
 *
 * 与上游的差异：
 *   1. CommonJS → ESM + TypeScript；
 *   2. 每张幻灯片多一个 `start`（首个 token 的字符偏移），用于「页 → 源码行号」；
 *   3. 不支持 JS 宏（`![:name](args)`）：宏是上游的扩展点，需要把函数塞进解析器，
 *      与"结构解析器不碰运行时代码"的定位冲突。遇到宏时原样保留文本并记一条 warning。
 *   4. `cleanInput()` 额外导出，调用方要拿它算行号（上游是解析器内部细节）。
 */
import { lexer } from './lexer'
import type { Token } from './types'

/** 一段内容：普通文本，或一个内容类（`[.class[...]]`） */
export type ContentPart = string | ContentClass

export interface ContentClass {
  class: string
  block: boolean
  content: ContentPart[]
}

export interface LinkDef {
  href: string
  title?: string
}

export interface SlideRaw {
  content: ContentPart[]
  notes?: ContentPart[]
  properties: Record<string, string>
  links: Record<string, LinkDef>
  /** 首个 token 在源文本里的字符偏移 */
  start: number
}

export interface ParseResult {
  slides: SlideRaw[]
  warnings: string[]
}

export interface ParseOptions {
  /** 调用方已自己 `cleanInput()` 过（它要拿清洗后的文本算行号），别再洗一遍 */
  clean?: boolean
}

/** 栈元素：幻灯片本身，或一个正在收集内容的内容类 */
type Frame = SlideRaw | ContentClass

export function parseSlides(src: string, options: ParseOptions = {}): ParseResult {
  const warnings: string[] = []
  const tokens = lexer(options.clean === false ? src : cleanInput(src))
  const slides: SlideRaw[] = []
  let stack: Frame[] = [createSlide(0)]

  tokens.forEach((token: Token) => {
    const top = stack[stack.length - 1]

    switch (token.type) {
      case 'text':
      case 'code':
      case 'fences':
        // 文本、缩进代码与围栏代码一律拼回字符串。围栏代码参与分词
        // 只是为了「围栏里的 --- 不算分页」。
        appendText(top, token.text ?? '')
        break
      case 'def':
        asSlide(stack[0]).links[token.id ?? ''] = { href: token.href ?? '', title: token.title }
        break
      case 'macro':
        warnings.push(`不支持宏 ![:${token.name}]，已按原文显示`)
        appendText(top, `![:${token.name ?? ''}${token.args?.join(',') ?? ''}]`)
        break
      case 'content_start':
        stack.push(createContentClass(token))
        break
      case 'content_end': {
        // lexer 保证了括号配对，这里直接出栈挂到外层
        const inner = stack.pop()
        if (inner && inner !== stack[0]) appendPart(stack[stack.length - 1], inner as ContentClass)
        break
      }
      case 'separator': {
        const root = asSlide(stack[0])
        slides.push(root)
        // text 是含前后换行的整段匹配 → start + length 恰好是下一页的第一行起点
        const next = createSlide(token.start + (token.text?.length ?? 0))
        stack = [next]
        // `--` 是增量分页（同一页多帧），P0 不支持，按普通分页处理并记 warning
        const continued = token.marker === '--'
        if (continued) warnings.push('不支持增量分页 --，已按分页处理')
        next.properties.continued = String(continued)
        break
      }
      case 'notes_separator':
        // 备注分隔符之后的内容进入 notes
        asSlide(stack[0]).notes = []
        break
    }
  })

  slides.push(asSlide(stack[0]))

  slides.forEach((slide) => {
    slide.content[0] = extractProperties(slide.content[0] || '', slide.properties)
  })

  const kept = slides.filter((slide) => {
    const exclude = (slide.properties.exclude || '').toLowerCase()
    return exclude !== 'true'
  })

  return { slides: kept, warnings }
}

function createSlide(start: number): SlideRaw {
  return {
    content: [],
    properties: { continued: 'false' },
    links: {},
    start,
  }
}

function createContentClass(token: Token): ContentClass {
  return {
    class: (token.classes ?? []).join(' '),
    block: token.block === true,
    content: [],
  }
}

function asSlide(frame: Frame): SlideRaw {
  return frame as SlideRaw
}

function appendText(element: Frame, text: string): void {
  appendPart(element, text)
}

/**
 * 内容挂到当前帧。处于备注模式（`???` 之后）的幻灯片往 notes 里写，
 * 内容类永远往自己的 content 里写。
 */
function appendPart(element: Frame, content: ContentPart): void {
  const target: ContentPart[] =
    'notes' in element && element.notes !== undefined ? element.notes : element.content

  const lastIdx = target.length - 1
  const last = target[lastIdx]
  if (typeof last === 'string' && typeof content === 'string') {
    target[lastIdx] = last + content
  } else {
    target.push(content)
  }
}

/**
 * 摘掉页属性行（`name: x`、`class: y`、`background-image: z`、`<!-- name: x -->`），
 * 返回剩下的正文源码。属性行可能散落在正文里，全部摘走并写进 properties。
 */
function extractProperties(source: ContentPart, properties: Record<string, string>): ContentPart {
  if (typeof source !== 'string') return source

  // 不加 m：`^` 只认行首位置 0，配合「摘掉匹配后再从头找」实现
  // 「连续若干行页属性」。加上 m 会把正文里 `注意: xxx` 这类行也当属性吃掉
  const propertyFinder =
    /^\n*([-\w]+):([^$\n]*)|^\n*(?:<!--\s*)([-\w]+):([^$\n]*?)(?:\s*-->)/i
  let match: RegExpExecArray | null

  while ((match = propertyFinder.exec(source)) !== null) {
    source =
      source.substr(0, match.index) + source.substr(match.index + match[0].length)

    if (match[1] !== undefined) {
      properties[match[1].trim()] = match[2].trim()
    } else {
      properties[match[3].trim()] = match[4].trim()
    }

    propertyFinder.lastIndex = match.index
  }

  return source
}

/**
 * 所有行共有的前导空白去掉，于是缩进写代码块的人不必从第 0 列开始
 * （上游 GitHub Issue #105）。只删空白不删换行，所以行号口径不变。
 */
export function cleanInput(source: string): string {
  const leadingWhitespacePattern = /^([ \t]*)[^ \t\n]/gm
  const widths: number[] = []
  let match: RegExpExecArray | null

  while ((match = leadingWhitespacePattern.exec(source)) !== null) {
    widths.push(match[1].length)
  }

  // 空文档 / 全空行时不能把 Infinity 塞进正则的 {0,n}
  const minWhitespace = widths.length > 0 ? Math.min(...widths) : 0
  if (minWhitespace === 0) return source

  const trimWhitespacePattern = new RegExp(`^[ \\t]{0,${minWhitespace}}`, 'gm')
  return source.replace(trimWhitespacePattern, '')
}
