/**
 * 幻灯片语法规格：**一处定义、五处复用**
 *
 *   - 面板头「?」的速查对话框（`specMarkdown()`）
 *   - 新建「演示文稿」时的初始内容（`deckTemplate()`）
 *   - AI 的 system prompt 摘要（`specForAi()`）
 *   - AI 的只读工具 `read_deck_spec`（`specDetail()`）
 *   - 问题面板里的结构告警（`specCheck()`）
 *
 * 这么做的原因：语法说明一旦分散，「文档里写的」和「解析器认的」就会漂。
 * 这里只描述 `deck.ts` 真实支持的子集，不支持的上游特性（JS 宏、`--` 增量、`:::` 多栏）
 * 明确标成后续，而不是假装支持。
 *
 * 文件头**不做任何声明**：同一份 Markdown，文档视图照常读，幻灯片面板按 `---` 分页。
 */
import { t, type MessageKey } from '../../i18n'
import { zh } from '../../i18n/zh'
import { parseDeck } from './deck'

export interface DeckSyntax {
  /** 表格里的「写法」列，等宽字体展示 */
  syntax: string
  descKey: MessageKey
  /** 示例片段，拼进速查页的 `### ` 小节 */
  example: string
}

/**
 * 语法表。顺序即速查页顺序：从「怎么分页」到「页长什么样」，最后是还没做的。
 * 每条的 `example` 都要能被 `parseDeck` 正确解析（`plans/slides-spec-check.mjs` 会验）。
 */
export const DECK_SYNTAX: readonly DeckSyntax[] = [
  {
    syntax: '---',
    descKey: 'deck.spec.separator.desc',
    example: ['# 第一页', '', '---', '', '# 第二页'].join('\n'),
  },
  {
    syntax: '???',
    descKey: 'deck.spec.notes.desc',
    example: ['# 大纲', '', '???', '这页的备注，不上画面'].join('\n'),
  },
  {
    syntax: 'class: left, top',
    descKey: 'deck.spec.align.desc',
    example: ['class: left, top', '', '# 左上排版'].join('\n'),
  },
  {
    syntax: 'background-color: #1b1d22',
    descKey: 'deck.spec.background.desc',
    example: ['background-color: #1b1d22', '', '# 深色封面'].join('\n'),
  },
  {
    syntax: 'name: intro',
    descKey: 'deck.spec.pageprops.desc',
    example: ['name: intro', '', '# 封面'].join('\n'),
  },
  {
    syntax: '--  /  :::',
    descKey: 'deck.spec.later.desc',
    example: ['# 两栏', '', '::: left', '左', ':::', '', '::: right', '右', ':::'].join('\n'),
  },
]

/* ------------------------------------------------------- 速查页（对话框） */

/** 面板「?」对话框的 Markdown 内容。用 `renderMarkdown()` 渲染，与正文同一套样式 */
export function specMarkdown(): string {
  const rows = DECK_SYNTAX.map((item) => `| \`${item.syntax}\` | ${t(item.descKey)} |`).join('\n')
  const examples = DECK_SYNTAX.map(
    (item) => `### \`${item.syntax}\`\n\n\`\`\`md\n${item.example}\n\`\`\``,
  ).join('\n\n')

  return [
    `# ${t('deck.help')}`,
    '',
    t('deck.spec.intro'),
    '',
    `| ${t('deck.spec.headerSyntax')} | ${t('deck.spec.headerMeaning')} |`,
    '| --- | --- |',
    rows,
    '',
    `## ${t('deck.spec.headerExample')}`,
    '',
    examples,
    '',
    `## ${t('deck.spec.pitfalls')}`,
    '',
    `1. ${t('deck.spec.pit.setext')}`,
    `2. ${t('deck.spec.pit.ref')}`,
    '',
  ].join('\n')
}

/* --------------------------------------------------- 新建演示文稿的初始内容 */

/** 新建「演示文稿」写进去的模板：三页，含备注与一页居中封面 */
export function deckTemplate(): string {
  return [
    `# ${t('deck.template.title')}`,
    '',
    t('deck.template.subtitle'),
    '',
    '---',
    '',
    `## ${t('deck.template.points')}`,
    '',
    `- ${t('deck.template.point1')}`,
    `- ${t('deck.template.point2')}`,
    '',
    '---',
    '',
    `## ${t('deck.template.points')}`,
    '',
    t('deck.template.body'),
    '',
    '???',
    t('deck.template.notes'),
    '',
  ].join('\n')
}

/* ------------------------------------------------------------ AI 的摘要 */

/**
 * 给模型的精简版语法说明。
 *
 * 固定中文，跟 `systemPrompt()` 的语言一致（不随界面语言变）；只讲模型容易写错的地方，
 * 完整规则让模型按需调 `read_deck_spec` 拿——省 token 比省一次调用重要。
 */
export function specForAi(): string {
  return [
    '本文档按幻灯片预览（remark 语法）。规则：',
    '- 单独一行 `---` 分页（页与页之间留空行；代码块里的 `---` 不分页）',
    '- `???` 之后到下一页之前是演讲者备注，不出现在页面上',
    '- 每页内容默认水平+竖直居中；页首写 `class: left` 或 `class: top` 可回到左上排版',
    '- 页首属性行还有：`background-color: #fff`、`background-image: url(...)`、`name: 名字`、`exclude: true`',
    '- 每页是独立的 Markdown：引用式链接 `[文字][id]` 与 `[id]: url` 必须写在同一页',
    '- 二级标题写成 `## 标题`；直接写「一行文字」+ 下一行 `---` 会被当成分页而不是 setext 标题',
    '- 不支持：JS 宏、`--` 增量片段、`:::` 多栏（写了会原样显示）',
  ].join('\n')
}

/**
 * `read_deck_spec` 工具返回的完整版：在 `specForAi()` 之上把每条写法的示例补全。
 *
 * 固定读 `zh` 而不是 `t()`：界面切换成英文时，同一个会话里前后两份说明不该
 * 一半中文一半英文——术语一漂，模型就按漂后的术语写。
 */
export function specDetail(): string {
  const examples = DECK_SYNTAX.map(
    (item) => `## ${item.syntax}\n${zh[item.descKey]}\n\`\`\`md\n${item.example}\n\`\`\``,
  ).join('\n\n')
  return [specForAi(), '', examples, ''].join('\n')
}

/* ------------------------------------------------------------- 诊断 */

export type DeckSpecRule = 'setext' | 'multiH1' | 'emptyNotes' | 'crossRef' | 'unknownProp'

export interface DeckSpecIssue {
  rule: DeckSpecRule
  key: MessageKey
  /** 源文件字符偏移，供问题面板定位 */
  from: number
  to: number
}

/** 页首允许出现的属性键（`continued` 由解析层写出，用户不用手写） */
const KNOWN_PROPS = new Set([
  'name',
  'class',
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'exclude',
  'continued',
  'ratio',
])

/**
 * 结构性问题检查（分页与页属性的语义问题，语法错误交给 markdown 的 lint）。
 *
 * 门槛是**真的分了页**（≥2 页）：没有文档级别的声明可看，而单页文档没有任何
 * 分页语义可检查；普通 Markdown 里的 `---` 是分隔线，拿分页规则去提醒只会制造噪音。
 */
export function specCheck(text: string): DeckSpecIssue[] {
  const doc = parseDeck(text)
  if (doc.reason === 'broken' || doc.pages.length < 2) return []

  const src = text.replace(/\r\n?/g, '\n')
  const starts = lineStarts(src)
  const at = (line: number) => starts[Math.min(line, starts.length) - 1] ?? src.length
  const issues: DeckSpecIssue[] = []

  // 引用式链接的全局定义表：`[id]: url` → 行号（1-based）
  const srcLines = src.split('\n')
  const defs = new Map<string, number[]>()
  srcLines.forEach((line, index) => {
    const def = /^ {0,3}\[([^\]]+)\]:/.exec(line)
    if (!def) return
    const id = def[1].toLowerCase()
    const known = defs.get(id)
    if (known) known.push(index + 1)
    else defs.set(id, [index + 1])
  })

  for (const page of doc.pages) {
    const lines = page.source.split('\n')
    const lineOf = (k: number) => page.line + k
    /** 本页在原文里的行区间终点（不含） */
    const end = page.index + 1 < doc.pages.length ? doc.pages[page.index + 1].line : srcLines.length + 1
    /** 本页用到的显式引用式链接 `[文字][id]`（折叠式 `[文字][]` 拿不到 id，跳过） */
    const refs: { id: string; k: number }[] = []
    lines.forEach((line, k) => {
      const ref = /\[[^\]]*\]\[([^\]]*)\]/.exec(line)
      if (ref) refs.push({ id: (ref[1] || '').toLowerCase(), k })
    })

    // 1. 单行页 + `---`：多半想要二级标题，却写成了分页
    const body = lines.filter((line) => line.trim() !== '')
    if (body.length === 1 && !/^#{1,6}[ \t]/.test(body[0].trim()) && page.index < doc.pages.length - 1) {
      const k = lines.indexOf(body[0])
      issues.push({
        rule: 'setext',
        key: 'deck.check.setext',
        from: at(lineOf(k)),
        to: at(lineOf(k)) + body[0].length,
      })
    }

    // 2. 一页里多个 h1：放映时两行大标题会抢版面
    let h1 = 0
    lines.forEach((line, k) => {
      if (!/^#[ \t]/.test(line)) return
      h1++
      if (h1 > 1) {
        issues.push({
          rule: 'multiH1',
          key: 'deck.check.multiH1',
          from: at(lineOf(k)),
          to: at(lineOf(k)) + line.length,
        })
      }
    })

    // 3. 拼错的页属性：`backgroud-color:` 会被当成正文原样显示
    for (const key of Object.keys(page.props.raw)) {
      if (KNOWN_PROPS.has(key)) continue
      const line = findPropLine(src, starts, page.line, key)
      if (line > 0) {
        issues.push({
          rule: 'unknownProp',
          key: 'deck.check.unknownProp',
          from: at(line),
          to: at(line) + key.length,
        })
      }
    }

    // 4. 引用式链接跨页：定义在别的页，本页渲染出来就是纯文本
    //    定义行会被 Markdown 解析器从页内容里摘走，所以定义表按**原始行**建，
    //    再判断定义是否落在本页的行区间内。
    for (const item of refs) {
      if (item.id === '') continue
      const linesOfDef = defs.get(item.id) ?? []
      if (linesOfDef.some((line) => line >= page.line && line < end)) continue
      if (linesOfDef.length === 0) continue
      const line = page.line + item.k
      issues.push({
        rule: 'crossRef',
        key: 'deck.check.crossRef',
        from: at(line),
        to: at(line) + lines[item.k].length,
      })
    }
  }

  issues.push(...emptyNotes(src, starts))

  // 同一位置只报一次（多 h1 与 setext 可能指向同一行）
  const seen = new Set<string>()
  return issues
    .sort((a, b) => a.from - b.from)
    .filter((issue) => {
      const id = `${issue.from}:${issue.key}`
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
}

/* ------------------------------------------------------------------ 内部 */

function lineStarts(src: string): number[] {
  const starts: number[] = [0]
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/** 在页首几行里找 `key:`，用于给拼错的属性行定位 */
function findPropLine(src: string, starts: number[], pageLine: number, key: string): number {
  const from = Math.max(1, pageLine - 8)
  for (let line = from; line < pageLine; line++) {
    const text = src.slice(starts[line - 1] ?? 0, starts[line] ?? src.length)
    if (new RegExp(`^[ \\t]*${key}[ \\t]*:`, 'i').test(text)) return line
  }
  return 0
}

/** `???` 之后到下一页/文件末尾之间没有文字：备注写了等于没写 */
function emptyNotes(src: string, starts: number[]): DeckSpecIssue[] {
  const issues: DeckSpecIssue[] = []
  const lines = src.split('\n')
  let fence = ''
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed)
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = ''
      return
    }
    if (fence || trimmed !== '???') return

    for (let next = index + 1; next < lines.length; next++) {
      const body = lines[next].trim()
      if (body === '') continue
      if (/^-{3,}$/.test(body)) break
      return
    }
    const from = starts[index] ?? 0
    issues.push({ rule: 'emptyNotes', key: 'deck.check.emptyNotes', from, to: from + 3 })
  })
  return issues
}
