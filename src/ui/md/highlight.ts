import type { ElementContent } from 'hast'
import groovy from 'highlight.js/lib/languages/groovy'
import { common, createLowlight } from 'lowlight'

/**
 * 高亮器。
 *
 * 用 lowlight（同步）而不是 shiki：预览是「每次输入后全文重渲染」，
 * 异步高亮器会让这块变成排队渲染。lowlight 的语言集按需注册，
 * 未注册的语言安全降级为纯文本，不抛错。
 */
const lowlight = createLowlight(common)

// common 之外的口子：Android 工程里 gradle 与 properties/toml 很常见
lowlight.register('groovy', groovy)

export function isHighlightable(lang: string): boolean {
  return Boolean(lang) && lowlight.registered(lang)
}

/** 返回 hast 子节点；未知语言原样返回文本 */
export function highlightToHast(lang: string, value: string): ElementContent[] {
  if (!isHighlightable(lang)) return [{ type: 'text', value }]
  try {
    return lowlight.highlight(lang, value).children as ElementContent[]
  } catch {
    return [{ type: 'text', value }]
  }
}
