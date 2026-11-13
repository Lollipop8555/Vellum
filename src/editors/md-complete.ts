import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { t } from '../i18n'
import { slugify } from '../ui/md/slug'

/**
 * Markdown 编辑器的补全。
 *
 * 只做四件真正省事的事，顺序就是价值顺序：
 * ① 围栏语言名（``` 之后）—— 图表语言记不住，代码语言拼错也不高亮
 * ② 行首块骨架（# / - / > / ``` / | / $）—— 少记几种语法
 * ③ 锚点（](# 之后）—— 补出来的锚点一定和预览 id 同源，不会自己造死链
 * ④ 引用式标签（][ 之后）—— 复用文档里已定义的 label
 *
 * 不做：文件名补全。Markdown 的图片/链接目标多数是相对路径或网址，
 * 从库里猜一半错一半，比不给更烦人。
 */

export interface MarkdownCompletionOptions {
  /** 预览能画出来的图表围栏（mermaid / dot / plantuml …） */
  blockLangs: readonly string[]
  /** 语言表里的全部语言 id，兜住所有能上色的代码围栏 */
  codeLangs: readonly string[]
}

/** 这些节点里的内容不是 Markdown 语法，补全一律不弹 */
const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'CodeText', 'InlineCode'])

function enclosingCode(state: EditorState, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1)
  for (; node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return node
  }
  return null
}

interface Heading {
  slug: string
  text: string
}

/** 当前文档的标题与锚点；重名按预览那边的约定补 -1、-2 */
function headingsOf(state: EditorState): Heading[] {
  const seen = new Map<string, number>()
  const out: Heading[] = []
  syntaxTree(state).iterate({
    enter(node) {
      if (!/^(?:ATX|Setext)Heading\d$/.test(node.name)) return
      const raw = state.sliceDoc(node.from, node.to)
      const text = raw
        .replace(/^#{1,6}\s*/, '')
        .replace(/[*_~`]/g, '')
        .trim()
      if (!text) return
      const base = slugify(text)
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      out.push({ slug: count === 0 ? base : `${base}-${count}`, text })
    },
  })
  return out
}

/** 文档里已有的引用式定义 `[label]: url` */
function labelsOf(state: EditorState): string[] {
  const out = new Set<string>()
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'LinkReference') return
      const line = state.doc.lineAt(node.from)
      const match = /^\s*\[([^\]]+)\]:/.exec(state.sliceDoc(line.from, line.to))
      if (match?.[1]) out.add(match[1])
    },
  })
  return [...out]
}

/** 插入一段带光标落点的文本（骨架都走这里，避免每项手写 dispatch） */
function snippet(label: string, insert: string, cursorOffset: number, detail: string): Completion {
  return {
    label,
    detail,
    type: 'text',
    apply: (view, _completion, from, to) => {
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + cursorOffset },
        scrollIntoView: true,
        userEvent: 'input.complete',
      })
    },
  }
}

let snippets: Completion[] | null = null

function snippetList(): Completion[] {
  snippets ??= [
    snippet('# 一级标题', '# ', 2, 'Heading 1'),
    snippet('## 二级标题', '## ', 3, 'Heading 2'),
    snippet('### 三级标题', '### ', 4, 'Heading 3'),
    snippet('- 无序列表', '- ', 2, 'List'),
    snippet('1. 有序列表', '1. ', 3, 'Ordered list'),
    snippet('> 引用', '> ', 2, 'Quote'),
    snippet('--- 分隔线', '---\n', 4, 'Thematic break'),
    snippet('``` 代码块', '```\n\n```', 4, 'Fenced code'),
    snippet('```mermaid 图表', '```mermaid\n\n```', 11, 'Mermaid'),
    snippet('```dot 图表', '```dot\n\n```', 7, 'Graphviz DOT'),
    snippet('$$ 公式块', '$$\n\n$$', 3, 'Math block'),
    snippet('| 表格', '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n', 2, 'Table'),
    snippet('[^1]: 脚注', '[^1]: ', 6, 'Footnote'),
  ]
  return snippets
}

/**
 * 建一个补全源。
 * 参数从语言表和区块注册表现取：语言加一个、图表加一种，这里不用改。
 */
export function createMarkdownCompletions(options: MarkdownCompletionOptions): CompletionSource {
  const chartLangs = [...new Set(options.blockLangs)]
  const codeLangs = [...new Set(options.codeLangs)].filter((name) => !chartLangs.includes(name))

  return (context: CompletionContext): CompletionResult | null => {
    // 输入法组字期间光标停在拼音上，这时候弹列表会把组字打断
    if (context.view?.composing) return null

    const { state, pos } = context
    const line = state.doc.lineAt(pos)
    const before = state.sliceDoc(line.from, pos)
    const code = enclosingCode(state, pos)

    // ① 围栏语言名。注意这一行本身就在 FencedCode 节点里，
    // 所以要先判断「这个围栏是不是本行开的」，是才补语言名
    const fence = /^(\s*)(`{3,}|~{3,})([\w+#.-]*)$/.exec(before)
    if (fence && !(code && code.from < line.from)) {
      return {
        from: line.from + fence[1]!.length + fence[2]!.length,
        to: pos,
        options: [
          ...chartLangs.map((name) => ({
            label: name,
            detail: t('complete.chart'),
            type: 'keyword',
            boost: 2,
          })),
          ...codeLangs.map((name) => ({
            label: name,
            detail: t('complete.code'),
            type: 'keyword',
          })),
        ],
        validFor: /^[\w+#.-]*$/,
      }
    }

    // 代码块、行内代码里写的是内容，不是语法
    if (code) return null

    // ② 锚点：](# 之后
    const anchor = /\]\(#([^)\s]*)$/.exec(before)
    if (anchor) {
      const items = headingsOf(state)
      if (items.length === 0) return null
      return {
        from: pos - anchor[1]!.length,
        to: pos,
        options: items.map((heading) => ({
          label: heading.slug,
          detail: heading.text,
          type: 'text',
        })),
        validFor: /^[^)\s]*$/,
      }
    }

    // ③ 引用式标签：][ 之后
    const ref = /\]\[([^\]\n]*)$/.exec(before)
    if (ref) {
      const items = labelsOf(state)
      if (items.length === 0) return null
      return {
        from: pos - ref[1]!.length,
        to: pos,
        options: items.map((label) => ({
          label,
          detail: t('complete.label'),
          type: 'text',
        })),
        validFor: /^[^\]\n]*$/,
      }
    }

    // ④ 行首骨架。只在「用户真敲了触发字符」或手按 Ctrl+Space 时给，
    // 否则每敲一次回车都会弹一串列表
    const start = /^(\s*)([#>*`|$~-]{0,3})$/.exec(before)
    if (start && (context.explicit || start[2]!.length > 0)) {
      return {
        from: line.from + start[1]!.length,
        to: pos,
        options: snippetList(),
        validFor: /^[#>*`|$~-]*$/,
      }
    }

    return null
  }
}
