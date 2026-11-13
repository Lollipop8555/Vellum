import type { ElementContent } from 'hast'
import type { Code } from 'mdast'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import rehypeSlug from 'rehype-slug'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { lookupBlock } from './blocks'
import { highlightToHast } from './highlight'
import { normalizeLang } from './langs'
import { renderMath } from './math'
import { harden, schema } from './sanitize'

/**
 * 管线顺序有讲究：
 * parse → gfm/math（改 mdast）→ rehype（mdast→hast，允许原始 HTML 通过）
 * → raw（把 HTML 解析成真节点）→ sanitize（一次白名单）
 * → harden（清理 style 值）→ slug（生成标题 id）→ stringify。
 *
 * slug 必须排在 sanitize 之后：白名单不放行 `id`，锚点只能由 slug 生成，
 * 这样也不用担心 DOM clobbering 的前缀篡改。
 */
function codeBlock(node: Code): ElementContent {
  const lang = normalizeLang(node.lang)
  const block = lookupBlock(lang)
  if (block) return block.render(node)

  return {
    type: 'element',
    tagName: 'pre',
    properties: {},
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { className: lang ? [`language-${lang}`, 'hljs'] : ['hljs'] },
        children: highlightToHast(lang, node.value),
      },
    ],
  }
}

export const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype, {
    // 语料里 <br>/<details> 是既成习惯，必须原样交给后面的 rehype-raw 解析
    allowDangerousHtml: true,
    handlers: {
      code: (_state, node) => codeBlock(node as Code),
      math: (_state, node) => renderMath((node as { value: string }).value, true),
      inlineMath: (_state, node) => renderMath((node as { value: string }).value, false),
    },
  })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .use(harden)
  .use(rehypeSlug)
  .use(rehypeStringify)
