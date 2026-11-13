import type { ElementContent } from 'hast'
import katex from 'katex'

/**
 * 公式：remark-math 只负责解析出 `math` / `inlineMath` 节点，
 * 这里把节点值交给 KaTeX 输出 HTML，再由 rehype-raw 接回语法树。
 *
 * 不用 rehype-katex：它锁 katex ^0.16，而 mermaid 要 ^0.18，
 * 两个区间互斥会导致 node_modules 里出现两份 katex。自己接 30 行即可避开。
 */
export function renderMath(value: string, display: boolean): ElementContent {
  try {
    const html = katex.renderToString(value, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
      errorColor: 'currentColor',
    })
    return { type: 'raw', value: html } as unknown as ElementContent
  } catch {
    // 语法错误时保留原始写法，不让整篇预览挂掉
    return {
      type: 'element',
      tagName: 'code',
      properties: { className: ['math-error'] },
      children: [{ type: 'text', value }],
    }
  }
}
