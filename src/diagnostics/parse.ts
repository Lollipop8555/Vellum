import type { Parser, Tree } from '@lezer/common'
import {
  javascriptLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
} from '@codemirror/lang-javascript'
import { jsonLanguage } from '@codemirror/lang-json'
import { htmlLanguage } from '@codemirror/lang-html'
import { cssLanguage } from '@codemirror/lang-css'
import { yamlLanguage } from '@codemirror/lang-yaml'
import { xmlLanguage } from '@codemirror/lang-xml'
import { pythonLanguage } from '@codemirror/lang-python'
import { javaLanguage } from '@codemirror/lang-java'
import { cppLanguage } from '@codemirror/lang-cpp'
import { rustLanguage } from '@codemirror/lang-rust'
import { goLanguage } from '@codemirror/lang-go'
import { phpLanguage } from '@codemirror/lang-php'
import type { LangId } from '../editors/languages'

/**
 * 独立的 lezer 解析器表：只喂检查用，不参与高亮。
 *
 * 为什么不去复用编辑器里的语法树：Monaco 那边根本没有树，检查必须自己解析一遍，
 * 两个引擎才可能给出同一份结果。这些包本来就在主包里（高亮要用），这里没有新增体积。
 *
 * 方言按扩展名选（见 `parserFor`）：TS 的 TSX 方言不认 `<Foo>bar` 这种尖括号断言，
 * 拿它解析 `.ts` 会把合法代码报成语法错误；反过来用纯 TS 方言解析 `.tsx` 又会误判 JSX。
 */
const PARSERS: Partial<Record<LangId, Parser>> = {
  java: javaLanguage.parser,
  python: pythonLanguage.parser,
  cpp: cppLanguage.parser,
  go: goLanguage.parser,
  rust: rustLanguage.parser,
  php: phpLanguage.parser,
  json: jsonLanguage.parser,
  html: htmlLanguage.parser,
  css: cssLanguage.parser,
  yaml: yamlLanguage.parser,
  xml: xmlLanguage.parser,
}

/**
 * 只有 stream 模式、没有解析器的语言里，括号结构足够单调、可以做配平兜底的那几个。
 * Ruby / Shell 故意不收：他们的 `#{...}`、heredoc、正则字面量会让朴素扫描误报。
 */
export const BALANCE_LANGS = new Set<LangId>([
  'csharp',
  'kotlin',
  'swift',
  'dart',
  'scala',
])

/**
 * JS/TS 的方言靠扩展名决定，其余语言一个语言一个方言。
 * 文件名缺省时取宽松的那个（JSX/TSX 能接受纯 JS/TS 的绝大多数写法，反之不行）。
 */
export function parserFor(lang: LangId, name = ''): Parser | null {
  if (lang === 'javascript') {
    return /\.jsx$/i.test(name) ? jsxLanguage.parser : javascriptLanguage.parser
  }
  if (lang === 'typescript') {
    return /\.tsx$/i.test(name) ? tsxLanguage.parser : typescriptLanguage.parser
  }
  return PARSERS[lang] ?? null
}

/* ------------------------------------------------------------ 内容哈希 */

function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 32 位哈希 + 长度。只用来判断「这两份内容是不是同一份」，
 * 不做安全用途；碰撞概率在这个场景下可以忽略（真撞了最多是把上一份检查结果当成这份）。
 */
export function contentHash(text: string): string {
  return `${text.length.toString(36)}-${fnv1a(text).toString(36)}`
}

/* ------------------------------------------------------------ 解析缓存 */

interface Cached {
  key: string
  tree: Tree
}

/** 一次解析喂五个消费者（plans/diagnostics.md §7.3），只留最近几份 */
const CACHE_LIMIT = 4
let cached: Cached | null = null
const spare: Cached[] = []

export function parseTree(lang: LangId, text: string, name = ''): Tree | null {
  const parser = parserFor(lang, name)
  if (!parser) return null
  // 方言进了 key：同名内容在不同扩展名下可能是两棵树
  const key = `${lang}:${lang === 'javascript' || lang === 'typescript' ? name : ''}:${contentHash(text)}`
  if (cached?.key === key) return cached.tree
  const hit = spare.findIndex((c) => c.key === key)
  if (hit >= 0) {
    const [found] = spare.splice(hit, 1)
    if (cached) spare.push(cached)
    cached = found
    return found.tree
  }
  const tree = parser.parse(text)
  if (cached) spare.push(cached)
  cached = { key, tree }
  while (spare.length > CACHE_LIMIT) spare.shift()
  return tree
}
