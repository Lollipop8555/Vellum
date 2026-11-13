import type { Root } from 'hast'
import type { Schema } from 'hast-util-sanitize'
import { defaultSchema } from 'rehype-sanitize'
import { visit } from 'unist-util-visit'

/**
 * 预览的白名单。
 *
 * 取代原来的黑名单（`src/ui/markdown.ts` 的 BLOCKED 集合）：
 * 黑名单每漏一个标签就是一次 XSS，白名单默认全拒。
 * 基底用 GitHub schema，再按「语料里真实出现的东西」逐项放开。
 */

/** KaTeX 的 MathML 输出；删掉也能显示，但无障碍与复制体验会退步 */
const MATH_TAGS = [
  'math',
  'semantics',
  'annotation',
  'mrow',
  'mi',
  'mo',
  'mn',
  'ms',
  'mtext',
  'mspace',
  'mfrac',
  'msqrt',
  'mroot',
  'mstyle',
  'munder',
  'mover',
  'mtable',
  'mtr',
  'mtd',
  'menclose',
  'mpadded',
  'mphantom',
  'msub',
  'msup',
  'msubsup',
  'munderover',
  'mmultiscripts',
  'none',
  'mprescripts',
  'merror',
]

type AttrList = NonNullable<Schema['attributes']>
type AttrValue = AttrList[string]

const base = defaultSchema

function add(list: AttrValue | undefined, extra: string[]): AttrValue {
  const existing = Array.isArray(list) ? (list as string[]) : []
  return [...new Set([...existing, ...extra])]
}

const attributes: AttrList = {
  ...base.attributes,
  // className 是高亮与 KaTeX 的唯一凭据；style 是 KaTeX 排版上下标的唯一手段
  '*': add(base.attributes?.['*'], ['className', 'style']),
  div: add(base.attributes?.div, ['className', 'style', 'dataMermaid']),
  span: add(base.attributes?.span, ['className', 'style']),
  pre: add(base.attributes?.pre, ['className']),
  code: add(base.attributes?.code, ['className']),
  a: add(base.attributes?.a, ['href', 'title', 'className']),
  img: add(base.attributes?.img, ['src', 'alt', 'title', 'width', 'height']),
  details: add(base.attributes?.details, ['open', 'className']),
  summary: add(base.attributes?.summary, ['className']),
  math: ['xmlns', 'display', 'className', 'style'],
  annotation: ['encoding'],
}

export const schema: Schema = {
  ...base,
  // details/summary 是语料里真实在用的折叠块（各 15 处）
  tagNames: [...(base.tagNames ?? []), 'details', 'summary', ...MATH_TAGS],
  attributes,
  protocols: {
    ...base.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
}

/** `style` 是白名单里唯一的活口：放行排版，但拦掉能外联或执行的值 */
const RISKY_STYLE = /url\s*\(|expression\s*\(|javascript:|behaviour\s*:|@import/i

/** 在 sanitize 之后跑：白名单管「留不留」，这里管「值干不干净」 */
export function harden() {
  return (tree: Root) => {
    visit(tree, 'element', (node) => {
      const properties = node.properties
      if (!properties) return
      if (typeof properties.style === 'string' && RISKY_STYLE.test(properties.style)) {
        delete properties.style
      }
      for (const key of Object.keys(properties)) {
        if (key.startsWith('on')) delete properties[key]
      }
    })
  }
}
