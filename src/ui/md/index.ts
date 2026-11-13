import 'katex/dist/katex.min.css'
import { processor } from './pipeline'

export { blockLangs } from './blocks'
export { normalizeLang } from './langs'
export { slugify } from './slug'

/**
 * Markdown 预览的唯一入口。
 * 异步是 remark 管线的固有形态，调用方需要自己处理「渲染完成时文档已经变了」。
 */
export async function renderMarkdown(text: string): Promise<string> {
  const file = await processor.process(text)
  return String(file)
}
