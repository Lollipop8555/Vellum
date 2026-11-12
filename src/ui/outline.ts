/**
 * 大纲：从当前文本里抽出「可跳转的结构行」。
 *
 * 目标是「快速定位」，不是语法分析：只认行首可识别的声明，宁可少列也不要猜错。
 * 层级优先按缩进算（2 空格一层），Markdown 用标题级别；两者都最多 4 层，
 * 再深的结构在侧栏里缩进已经吃掉宽度，列表反而不如平铺好读。
 */
import type { LangId } from '../editors/languages'

export interface OutlineItem {
  label: string
  /** 1 起算的行号，可直接喂给 editor.goToLine */
  line: number
  /** 1 起算的层级，只用来算左侧留白 */
  level: number
}

interface Rule {
  test: RegExp
  /** 从匹配结果里取显示名 */
  name: (m: RegExpMatchArray) => string
}

/** 大纲一次最多列这么多行：再长就该靠搜索而不是滚动 */
const MAX_ITEMS = 600
const MAX_LABEL = 120

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > MAX_LABEL ? `${one.slice(0, MAX_LABEL - 1)}…` : one
}

/** 缩进 → 层级：2 空格一层，制表符按 4 空格算 */
function levelOf(indent: string): number {
  const width = indent.replace(/\t/g, '    ').length
  return Math.min(4, 1 + Math.floor(width / 2))
}

const JS: Rule[] = [
  { test: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, name: (m) => `${m[1]}()` },
  { test: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, name: (m) => m[1] },
  { test: /^(?:export\s+)?(?:declare\s+)?(?:interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/, name: (m) => m[1] },
  { test: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, name: (m) => `type ${m[1]}` },
  // 箭头函数是现在最常见的「函数」，但在文件顶层才当成结构
  { test: /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, name: (m) => `${m[1]}()` },
]

const PY: Rule[] = [
  { test: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, name: (m) => `${m[1]}()` },
  { test: /^class\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
]

const CLike: Rule[] = [
  { test: /^(?:[\w$<>[\],.?\s]+?\s)?(?:class|interface|enum|record|object|struct|union|trait|protocol|extension)\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
  { test: /^(?:public|protected|private|internal)\b[^=;{]*?\b([A-Za-z_]\w*)\s*\(/, name: (m) => `${m[1]}()` },
  { test: /^(?:[a-z]+\s+)*fun\s+([A-Za-z_]\w*)/, name: (m) => `${m[1]}()` },
]

const GO: Rule[] = [
  { test: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, name: (m) => `${m[1]}()` },
  { test: /^type\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
]

const RUST: Rule[] = [
  { test: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/, name: (m) => `${m[1]}()` },
  { test: /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod|union)\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
  { test: /^(?:pub(?:\([^)]*\))?\s+)?impl\b\s*(?:<[^>]*>\s*)?([A-Za-z_]\w*)/, name: (m) => `impl ${m[1]}` },
]

const RUBY: Rule[] = [
  { test: /^(?:class|module)\s+([A-Za-z_]\w*)/, name: (m) => m[1] },
  { test: /^def\s+(self\.)?([A-Za-z_]\w*[?!=]?)/, name: (m) => `${m[2]}()` },
]

const SHELL: Rule[] = [
  { test: /^(?:function\s+)?([A-Za-z_][\w.:-]*)\s*\(\)/, name: (m) => `${m[1]}()` },
]

const CSS: Rule[] = [
  { test: /^(@(?:media|supports|layer|container|keyframes)\b[^{]*)/, name: (m) => m[1] },
  { test: /^([.#][\w-]+(?:::?[\w-]+)?)/, name: (m) => m[1] },
]

const JSON_LIKE: Rule[] = [{ test: /^"([^"]+)"\s*:/, name: (m) => m[1] }]

const YAML: Rule[] = [{ test: /^([\w.$-][\w.$ /-]*):(?:\s|$)/, name: (m) => m[1] }]

const TOML: Rule[] = [
  { test: /^\[\[?([^\]]+)\]\]?/, name: (m) => m[1] },
  { test: /^([\w.-]+)\s*=/, name: (m) => m[1] },
]

const INI: Rule[] = [
  { test: /^\[([^\]]+)\]/, name: (m) => m[1] },
  { test: /^([\w.-]+)\s*[=:]/, name: (m) => m[1] },
]

const SQL: Rule[] = [
  {
    test: /^create\s+(?:or\s+replace\s+)?(?:table|view|index|function|procedure|schema)\s+(?:if\s+not\s+exists\s+)?([\w."`\]]+)/i,
    name: (m) => m[1],
  },
]

/** 只给真正有「结构」可跳的语言配规则；没配的语言一律空大纲，不猜 */
const RULES: Partial<Record<LangId, Rule[]>> = {
  javascript: JS,
  typescript: JS,
  python: PY,
  java: CLike,
  kotlin: CLike,
  csharp: CLike,
  swift: CLike,
  dart: CLike,
  scala: CLike,
  cpp: CLike,
  php: CLike,
  'objective-c': CLike,
  groovy: CLike,
  apex: CLike,
  solidity: CLike,
  go: GO,
  rust: RUST,
  ruby: RUBY,
  shell: SHELL,
  powershell: SHELL,
  css: CSS,
  scss: CSS,
  less: CSS,
  sass: CSS,
  json: JSON_LIKE,
  yaml: YAML,
  toml: TOML,
  ini: INI,
  sql: SQL,
}

function markdownOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = []
  let fenced = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && items.length < MAX_ITEMS; i += 1) {
    const line = lines[i]
    // 代码块里的 # 是注释，不是标题
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    items.push({ label: clip(m[2]), line: i + 1, level: m[1].length })
  }
  return items
}

export function extractOutline(text: string, lang: LangId): OutlineItem[] {
  if (lang === 'markdown') return markdownOutline(text)

  const rules = RULES[lang]
  if (!rules?.length) return []

  const items: OutlineItem[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && items.length < MAX_ITEMS; i += 1) {
    const raw = lines[i]
    if (!raw.trim()) continue
    const indent = /^[ \t]*/.exec(raw)?.[0] ?? ''
    const body = raw.slice(indent.length)
    for (const rule of rules) {
      const m = rule.test.exec(body)
      if (!m) continue
      items.push({ label: clip(rule.name(m)), line: i + 1, level: levelOf(indent) })
      break
    }
  }
  return items
}

/** 光标落在哪一项：返回最后一个起始行不超过光标的条目下标，没有就 -1 */
export function activeIndex(items: OutlineItem[], line: number): number {
  let found = -1
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].line > line) break
    found = i
  }
  return found
}
