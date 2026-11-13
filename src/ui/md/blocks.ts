import type { Element } from 'hast'
import type { Code } from 'mdast'

/**
 * 围栏块注册表。
 *
 * 每加一种图表/特殊块，只在这里加一条，不在管线里散落 `if (lang === ...)`。
 * 渲染器只负责产出「占位 + 源码」，真正的绘制由浏览器端按 data-* 属性接管，
 * 这样预览的 HTML 生成保持同步、可测，也不必让图表库进入首屏包。
 */
export interface BlockRenderer {
  /** 已归一化的语言名 */
  langs: readonly string[]
  render(node: Code): Element
}

const mermaid: BlockRenderer = {
  langs: ['mermaid'],
  render(node) {
    // 源码同时留在 data 属性（换主题要重画）和正文里（图还没画出来时先看到代码）
    return {
      type: 'element',
      tagName: 'div',
      properties: {
        className: ['mermaid-block'],
        dataMermaid: encodeURIComponent(node.value),
      },
      children: [
        {
          type: 'element',
          tagName: 'pre',
          properties: { className: ['mermaid-source'] },
          children: [{ type: 'text', value: node.value }],
        },
      ],
    }
  },
}

const graphviz: BlockRenderer = {
  // `dot` 是 Graphviz 的语法名，`graphviz` 是工具名，`gv` 是另一套常见扩展名：
  // 三个都收，免得用户按习惯写哪个都得试一遍
  langs: ['dot', 'graphviz', 'gv'],
  render(node) {
    return {
      type: 'element',
      tagName: 'div',
      properties: {
        className: ['graphviz-block'],
        dataDot: encodeURIComponent(node.value),
      },
      children: [
        {
          type: 'element',
          tagName: 'pre',
          properties: { className: ['graphviz-source'] },
          children: [{ type: 'text', value: node.value }],
        },
      ],
    }
  },
}

const RENDERERS: readonly BlockRenderer[] = [mermaid, graphviz]

const INDEX = new Map<string, BlockRenderer>()
for (const renderer of RENDERERS) {
  for (const lang of renderer.langs) INDEX.set(lang, renderer)
}

export function lookupBlock(lang: string): BlockRenderer | undefined {
  return INDEX.get(lang)
}

/** 供补全等场景列出所有「能被渲染成图表」的语言 */
export function blockLangs(): string[] {
  return [...INDEX.keys()].sort()
}
