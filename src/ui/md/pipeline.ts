import type { ElementContent } from 'hast'
import type { Blockquote, Code, Paragraph, Root, RootContent } from 'mdast'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import rehypeSlug from 'rehype-slug'
import rehypeStringify from 'rehype-stringify'
import remarkFrontmatter from 'remark-frontmatter'
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
 * parse → frontmatter/gfm/math（改 mdast）→ rehype（mdast→hast，允许原始 HTML 通过）
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

/**
 * `???` 之后的演讲者备注，在文档视图里渲染成弱化的旁注（`<aside class="md-notes">`）。
 *
 * 幻灯片面板会把这段摘走、只给演讲者看；文档视图里若照常渲染，正文中就是几个
 * 带 `???` 的普通段落，同一份文件两种看法的体验就断了。这里按幻灯片语义收拢：
 * 去掉标记、灰字收小、左边一条细线，读起来像旁注而不是正文。
 *
 * 只认**自己起一段**的 `???`（代码块、引用、列表里的不动），备注到下一个
 * 分隔线（文档视图里 `---` 是 thematicBreak）或标题为止——与「备注到下一页」同构。
 */
function remarkNotes(tree: Root): void {
  const kids = tree.children as RootContent[]
  const out: RootContent[] = []

  for (let i = 0; i < kids.length; i++) {
    const node = kids[i]
    const first = node.type === 'paragraph' ? node.children[0] : undefined
    if (first?.type !== 'text' || !first.value.trimStart().startsWith('???')) {
      out.push(node)
      continue
    }

    const notes: RootContent[] = []
    const lead = first.value.replace(/^\s*\?\?\?[ \t]*/, '')
    if (lead.trim() !== '') {
      notes.push({
        ...(node as Paragraph),
        children: [{ ...first, value: lead }, ...(node as Paragraph).children.slice(1)],
      })
    }
    let j = i + 1
    while (j < kids.length && kids[j].type !== 'thematicBreak' && kids[j].type !== 'heading') {
      notes.push(kids[j])
      j++
    }
    if (notes.length > 0) {
      out.push({
        type: 'blockquote',
        children: notes as Blockquote['children'],
        data: { hName: 'aside', hProperties: { className: ['md-notes'] } },
      })
    }
    i = j - 1
  }
  tree.children = out
}

export const processor = unified()
  .use(remarkParse)
  // 只认文档首部的 `---` 块（MD-09）：正文里的 `---` 依旧由 gfm 解析成水平线
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkMath)
  .use(() => remarkNotes)
  .use(remarkRehype, {
    // 语料里 <br>/<details> 是既成习惯，必须原样交给后面的 rehype-raw 解析
    allowDangerousHtml: true,
    handlers: {
      code: (_state, node) => codeBlock(node as Code),
      math: (_state, node) => renderMath((node as { value: string }).value, true),
      inlineMath: (_state, node) => renderMath((node as { value: string }).value, false),
      // frontmatter 不能凭空消失（那是信息丢失），渲染成等宽块；白名单里 pre 放行 className
      yaml: (_state, node) => {
        const value = (node as { value: string }).value
        // `slides` / `ratio` 是旧版幻灯片声明：现在已经不读了，再显示只会让文档
        // 头部悬着一个看不懂的灰色代码块。只滤这两行，其它键照常显示。
        const kept = value
          .split('\n')
          .filter((line) => !/^\s*(slides|ratio)\s*:/i.test(line))
          .join('\n')
        return {
          type: 'element' as const,
          tagName: 'pre',
          properties: { className: ['frontmatter'] },
          children: kept.trim() === '' ? [] : [{ type: 'text' as const, value: kept }],
        }
      },
    },
  })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .use(harden)
  .use(rehypeSlug)
  .use(rehypeStringify)
