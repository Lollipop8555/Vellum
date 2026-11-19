/**
 * Markdown 语法速查表（面板数据）。
 *
 * 三条规矩：
 * 1. `sample` 既是面板里展示的范例，也是「插入」按钮写进正文的**原文**，
 *    两边永远同一份字符串，不会出现「照着面板敲却敲出别的写法」；
 * 2. `cursor` 是插入后光标落点（相对 sample 开头），指向需要用户替换的那段文字，
 *    所以给的是「文字前面」而不是末尾；
 * 3. 只收本项目预览管线真的支持的语法（GFM + 公式 + 图表），
 *    不列「教程里有、这里渲染不出来」的条目 —— 那只会让人以为是 bug。
 *
 * 每个条目除了「是什么」，还带一条 `note` 写「怎么才有效」：层级上限、列数怎么加、
 * 围栏怎么收尾。范例只教形，note 才挡得住「照着抄还是渲染不对」。
 */
import { getLang, type Lang } from '../../i18n'

interface Text {
  zh: string
  en: string
}

interface Item {
  name: Text
  desc: Text
  /** 规则补充：容易踩坑、但光看范例看不出来的那部分 */
  note?: Text
  /** 官方语法文档：Mermaid、Graphviz 这类外部语言没法在这里讲全 */
  link?: { label: Text; url: string }
  sample: string
  /** 插入后光标位置（字符下标），缺省落在末尾 */
  cursor?: number
}

interface Group {
  title: Text
  items: Item[]
}

export interface MdSyntaxItem {
  name: string
  desc: string
  note?: string
  link?: { label: string; url: string }
  sample: string
  cursor?: number
}

export interface MdSyntaxGroup {
  title: string
  items: MdSyntaxItem[]
}

const GROUPS: Group[] = [
  {
    title: { zh: '标题', en: 'Headings' },
    items: [
      {
        name: { zh: '一级标题', en: 'Heading 1' },
        desc: {
          zh: '一个 # 加一个空格。一篇文档只用一个，当标题。',
          en: 'One # and a space. Use a single one per document, as the title.',
        },
        note: {
          zh: '# 后面必须有空格；# 越多级别越低，最多 6 个（######），第 7 个就不是标题了。',
          en: 'A space must follow the #. More # means a lower level; six (######) is the deepest, a seventh is just text.',
        },
        sample: '# 一级标题',
        cursor: 2,
      },
      {
        name: { zh: '二级标题', en: 'Heading 2' },
        desc: { zh: '两个 #，用来分章节。', en: 'Two #, for chapters.' },
        sample: '## 二级标题',
        cursor: 3,
      },
      {
        name: { zh: '三级标题', en: 'Heading 3' },
        desc: { zh: '三个 #，用来分小节。', en: 'Three #, for sections.' },
        sample: '### 三级标题',
        cursor: 4,
      },
      {
        name: { zh: '四级到六级', en: 'Heading 4 to 6' },
        desc: {
          zh: '四个、五个、六个 #，逐级往下；结构再深就该拆成两篇了。',
          en: 'Four, five or six #. Deeper than that and the document wants splitting.',
        },
        note: {
          zh: '六级（######）是最深一级；想再细分只能用列表缩进。',
          en: 'Six (######) is the deepest level; go further with nested lists.',
        },
        sample: '#### 四级标题\n##### 五级标题\n###### 六级标题',
      },
    ],
  },
  {
    title: { zh: '文字样式', en: 'Text styles' },
    items: [
      {
        name: { zh: '加粗', en: 'Bold' },
        desc: { zh: '前后各两个星号（用下划线也行）。', en: 'Two asterisks (or underscores) on each side.' },
        note: {
          zh: '星号要紧贴文字，写成 ** 文字 ** 中间多了空格就不生效。',
          en: 'Keep the marks tight against the text; spaces inside will break it.',
        },
        sample: '**加粗文字**',
        cursor: 2,
      },
      {
        name: { zh: '斜体', en: 'Italic' },
        desc: { zh: '前后各一个星号。', en: 'One asterisk on each side.' },
        sample: '*斜体文字*',
        cursor: 1,
      },
      {
        name: { zh: '删除线', en: 'Strikethrough' },
        desc: { zh: '前后各两个波浪号。', en: 'Two tildes on each side.' },
        sample: '~~删除线~~',
        cursor: 2,
      },
      {
        name: { zh: '行内代码', en: 'Inline code' },
        desc: {
          zh: '用反引号把一小段包起来，比如函数名、命令。',
          en: 'Wrap a short snippet in backticks, e.g. a function name or command.',
        },
        note: {
          zh: '反引号成对出现；正文里想显示一个反引号，就用两个包住。',
          en: 'Backticks come in pairs; to show one, wrap it with two.',
        },
        sample: '`行内代码`',
        cursor: 1,
      },
    ],
  },
  {
    title: { zh: '列表', en: 'Lists' },
    items: [
      {
        name: { zh: '无序列表', en: 'Bullet list' },
        desc: { zh: '行首一个减号（星号、加号也可以）。', en: 'A dash at line start (asterisk or plus works too).' },
        note: {
          zh: '下一级缩进 2 个空格（或 1 个 Tab）；缩进不够会被当成同一级。',
          en: 'Nest with two spaces (or one tab); less and it stays on the same level.',
        },
        sample: '- 第一项\n- 第二项\n  - 缩进两格的子项',
      },
      {
        name: { zh: '有序列表', en: 'Numbered list' },
        desc: { zh: '数字加英文句点。', en: 'A number and a period.' },
        note: {
          zh: '序号会自动重排，全写 1. 也没问题。',
          en: 'Numbers renumber themselves; writing 1. on every line is fine.',
        },
        sample: '1. 第一项\n2. 第二项\n3. 第三项',
      },
      {
        name: { zh: '任务列表', en: 'Task list' },
        desc: { zh: '勾选框：方括号里留空是未完成，写 x 是已完成。', en: 'Checkboxes: empty brackets for open, an x for done.' },
        note: {
          zh: '方括号里必须有空格或 x，[ ] 写成 [] 就只是普通文字。',
          en: 'The brackets need a space or an x inside; an empty [] is just text.',
        },
        sample: '- [ ] 待办事项\n- [x] 已完成事项',
      },
    ],
  },
  {
    title: { zh: '引用与分隔', en: 'Quotes & dividers' },
    items: [
      {
        name: { zh: '引用', en: 'Blockquote' },
        desc: { zh: '行首一个大于号，适合摘录或提醒。', en: 'A greater-than sign; good for excerpts or callouts.' },
        note: {
          zh: '连续多行每行都要写 >；中间断一行，引用就结束。',
          en: 'Every line of the quote repeats the >; a bare line ends it.',
        },
        sample: '> 引用一段话',
        cursor: 2,
      },
      {
        name: { zh: '分隔线', en: 'Divider' },
        desc: {
          zh: '三个减号，画一条横线；在幻灯片里它同时是「翻页」。',
          en: 'Three dashes. In a deck this is also a page break.',
        },
        note: {
          zh: '必须独占一行，上下各留一个空行（范例里那两行空的），否则会把上一行文字变成标题。',
          en: 'It needs its own line with blank lines around it (as in the sample), or it turns the line above into a heading.',
        },
        sample: '\n\n---\n\n',
      },
    ],
  },
  {
    title: { zh: '链接与图片', en: 'Links & images' },
    items: [
      {
        name: { zh: '链接', en: 'Link' },
        desc: { zh: '方括号里是显示文字，圆括号里是地址。', en: 'Brackets hold the label, parentheses the URL.' },
        note: {
          zh: '地址写全 http(s)://；预览里会自动加下划线并显示成可点。',
          en: 'Include the full http(s):// prefix so the preview can link it.',
        },
        sample: '[链接文字](https://example.com)',
        cursor: 1,
      },
      {
        name: { zh: '图片', en: 'Image' },
        desc: {
          zh: '比链接多一个感叹号；圆括号里放图片地址。',
          en: 'A link with a leading exclamation mark; the URL points at the image.',
        },
        note: {
          zh: '本地图片写成工作区里的文件名（可带子路径）；网络图片用完整 http(s) 链接。',
          en: 'Local images use a file name in the workspace; remote ones a full http(s) URL.',
        },
        sample: '![图片说明](image.png)',
        cursor: 2,
      },
    ],
  },
  {
    title: { zh: '代码块', en: 'Code blocks' },
    items: [
      {
        name: { zh: '带语言的代码块', en: 'Fenced code block' },
        desc: { zh: '三个反引号开头，后面写语言名。', en: 'Three backticks, then the language name.' },
        note: {
          zh: '语言名紧跟在开头的反引号后面（js、ts、python…）；结尾的三反引号必须单独一行。',
          en: 'The language follows the opening fence (js, ts, python…); the closing fence sits alone on its line.',
        },
        sample: '```js\nconst a = 1\n```',
        cursor: 6,
      },
      {
        name: { zh: '纯文本代码块', en: 'Plain code block' },
        desc: { zh: '不写语言名，就没有语法高亮。', en: 'No language name means no highlighting.' },
        sample: '```\n纯文本\n```',
        cursor: 4,
      },
    ],
  },
  {
    title: { zh: '表格', en: 'Table' },
    items: [
      {
        name: { zh: '两列表格', en: 'Two-column table' },
        desc: {
          zh: '第一行表头，第二行是分隔行，数据从第三行开始。',
          en: 'Header row, then a divider row, then the data.',
        },
        note: {
          zh: '列数不固定：竖线的数量 = 列数 + 1，要三列就多加一根竖线（见下一条）。',
          en: 'Columns are open-ended: pipes = columns + 1. Add a pipe for a third column.',
        },
        sample: '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |',
      },
      {
        name: { zh: '三列与对齐', en: 'Three columns & alignment' },
        desc: {
          zh: '想几列就写几列，第二行的 --- 数量要和表头一致。',
          en: 'Write as many columns as you need; the --- row must match the header.',
        },
        note: {
          zh: '冒号控制对齐：:--- 左对齐、:---: 居中、---: 右对齐；不写默认左对齐。',
          en: 'Colons set alignment: :--- left, :---: center, ---: right; default is left.',
        },
        sample: '| 列 1 | 列 2 | 列 3 |\n| :--- | :---: | ---: |\n| 左 | 中 | 右 |',
      },
    ],
  },
  {
    title: { zh: '公式', en: 'Math' },
    items: [
      {
        name: { zh: '行内公式', en: 'Inline math' },
        desc: { zh: '两个美元符号之间写 LaTeX。', en: 'LaTeX between two dollar signs.' },
        note: {
          zh: '美元符号里不能有空行；和中文挨得紧时，前后各留一个空格更稳。',
          en: 'No blank lines inside; a space on each side avoids swallowing adjacent text.',
        },
        sample: '$E = mc^2$',
        cursor: 1,
      },
      {
        name: { zh: '公式块', en: 'Math block' },
        desc: { zh: '两块美元符号各占一行，中间写多行推导。', en: 'Dollar signs on their own lines, steps in between.' },
        note: {
          zh: '$$ 单独占一行才算公式块，和文字同行会被当成行内公式。',
          en: 'The $$ must be on its own lines; inline with text it renders as inline math.',
        },
        sample: '$$\n\n$$',
        cursor: 3,
      },
    ],
  },
  {
    title: { zh: '图表', en: 'Diagrams' },
    items: [
      {
        name: { zh: 'Mermaid 图', en: 'Mermaid diagram' },
        desc: {
          zh: '用 ```mermaid 围栏包住，围栏里面写 Mermaid 自己的语法。',
          en: 'Wrap it in a ```mermaid fence; inside goes Mermaid syntax, not Markdown.',
        },
        note: {
          zh: '第一行声明图类型：graph TD 是流程图、sequenceDiagram 是时序图、gantt 是甘特图。预览、导图、幻灯片里都会画出来。',
          en: 'The first line names the diagram type: graph TD, sequenceDiagram, gantt. It renders in preview, mindmap and slides.',
        },
        link: {
          label: { zh: 'Mermaid 官方语法文档', en: 'Mermaid syntax reference' },
          url: 'https://mermaid.js.org/intro/syntax-reference.html',
        },
        sample: '```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```',
      },
      {
        name: { zh: 'Graphviz 图', en: 'Graphviz diagram' },
        desc: {
          zh: '```dot 围栏里写 DOT 语言，适合画关系图。',
          en: 'DOT language inside a ```dot fence; good for relationship graphs.',
        },
        note: {
          zh: '整体用 digraph G { 开头、} 结尾；每条边写 A -> B，节点属性放在方括号里。',
          en: 'Open with digraph G { and close with }; each edge is A -> B, attributes go in brackets.',
        },
        link: {
          label: { zh: 'DOT 语法文档', en: 'DOT language reference' },
          url: 'https://graphviz.org/doc/info/lang.html',
        },
        sample: '```dot\ndigraph G {\n  A -> B\n}\n```',
      },
    ],
  },
  {
    title: { zh: '脚注', en: 'Footnotes' },
    items: [
      {
        name: { zh: '脚注', en: 'Footnote' },
        desc: { zh: '正文里标一个编号，文末写同编号的内容。', en: 'Mark a number in the text, define the same number at the end.' },
        note: {
          zh: '两处的编号必须一致（[^1] 对 [^1]:）；定义可以放在文末任意位置。',
          en: 'Both sides use the same label ([^1] and [^1]:); the definition can sit anywhere at the end.',
        },
        sample: '正文[^1]\n\n[^1]: 脚注内容',
        cursor: 2,
      },
    ],
  },
]

/** 当前语言下的速查分组 */
export function mdSyntaxGroups(lang: Lang = getLang()): MdSyntaxGroup[] {
  return GROUPS.map((group) => ({
    title: group.title[lang],
    items: group.items.map((item) => ({
      name: item.name[lang],
      desc: item.desc[lang],
      note: item.note?.[lang],
      link: item.link ? { label: item.link.label[lang], url: item.link.url } : undefined,
      sample: item.sample,
      cursor: item.cursor,
    })),
  }))
}
