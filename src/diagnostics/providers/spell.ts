import type { SyntaxNode, Tree } from '@lezer/common'
import type { LangId } from '../../editors/languages'
import { dictWords } from '../dict'
import type { Issue } from '../types'

/**
 * 拼写两条规则：`spell`（注释与字符串里的自然语言）和 `spellIdent`（标识符）。
 *
 * 这是全套检查里最容易误报的一项，所以每一层都在往「不报」一侧偏：
 *   1. 只在能明确划出注释/字符串的语言上做（其余语言置灰，见 registry）；
 *   2. 词典没加载好就一条不报；
 *   3. 缩写、路径、URL、无元音串、全大写、带数字的片断全部跳过；
 *   4. 同一个词全文件只报第一次，且总数有上限。
 *
 * 不做「猜一个最像的词」：20 万词表里找最近邻又贵又容易猜错，先只标出来。
 */

const MAX_SPELL = 30
const MAX_SPELL_IDENT = 20

/** 拼写只放给这几门语言：它们的注释与字符串边界足够明确 */
const SPELL_LANGS = new Set<LangId>(['typescript', 'javascript', 'java', 'python'])

export function spellLangs(lang: LangId): boolean {
  return SPELL_LANGS.has(lang)
}

const COMMENT_NODES = new Set(['LineComment', 'BlockComment', 'Comment', 'HTMLComment'])
const STRING_NODES = new Set(['String', 'StringLiteral', 'TemplateString', 'TextBlock'])

/** 紧挨着这些字符的「词」多半是路径、域名、版本号、十六进制色值，不是英语 */
const NEIGHBORS = new Set(['/', '\\', '.', '-', '_', '@', ':', '$', '#', '%', '&', '='])

const WORD = /[A-Za-z][A-Za-z'’]*/g
const VOWELS = /[aeiouy]/
const ACRONYM = /^[A-Z]+$/
const DOUBLED = /([bdgklmnprt])\1(?:ed|ing)$/

/** 常见词尾还原：configurations / quickly / stopped 这类不该因为「没有原形」被报 */
const TRIM: Array<[string, (stem: string) => string]> = [
  ['ies', (s) => `${s}y`],
  ['ied', (s) => `${s}y`],
  ['ness', (s) => s],
  ['est', (s) => s],
  ['ing', (s) => s],
  ['ing', (s) => `${s}e`],
  ['ed', (s) => s],
  ['ed', (s) => `${s}e`],
  ['ly', (s) => s],
  ['es', (s) => s],
  ['s', (s) => s],
]

function known(word: string, dict: Set<string>): boolean {
  if (dict.has(word)) return true
  for (const [suffix, stem] of TRIM) {
    if (!word.endsWith(suffix)) continue
    const base = stem(word.slice(0, -suffix.length))
    if (base.length >= 3 && dict.has(base)) return true
  }
  if (DOUBLED.test(word) && dict.has(word.replace(DOUBLED, '$1'))) return true
  return false
}

/** 这个词长什么样才算「值得查」 */
function checkable(raw: string, dict: Set<string>, ignore: Set<string>, fileText: string, from: number, to: number): string | null {
  const word = raw.replace(/['’]/g, '')
  if (word.length < 3) return null
  if (ACRONYM.test(raw)) return null
  if (!VOWELS.test(word)) return null
  const key = word.toLowerCase()
  if (ignore.has(key) || known(key, dict)) return null
  const before = fileText[from - 1]
  const after = fileText[to]
  if ((before && NEIGHBORS.has(before)) || (after && NEIGHBORS.has(after))) return null
  return key
}

/** 字符串节点的首尾引号要剔掉，否则 `'hello wrold'` 会切出 `wrold'` 这种词 */
const QUOTES = new Set(['"', "'", '`'])

function collectRanges(text: string, tree: Tree, nodes: Set<string>): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  tree.iterate({
    enter(node) {
      if (!nodes.has(node.name)) return
      let { from, to } = node
      if (STRING_NODES.has(node.name)) {
        while (from < to && QUOTES.has(text[from])) from++
        while (to > from && QUOTES.has(text[to - 1])) to--
      }
      if (to > from) ranges.push({ from, to })
      // 字符串里的子节点（模板插值、转义）不用再走一遍
      return false
    },
  })
  return ranges
}

function issueAt(from: number, to: number, kind: 'spell' | 'spellIdent', word: string): Issue {
  return {
    from,
    to,
    severity: 'warning',
    kind,
    key: kind === 'spell' ? 'issues.spell' : 'issues.spellIdent',
    params: { word },
    source: 'symbols',
  }
}

/** 注释与字符串里的自然语言 */
export function spellIssues(text: string, lang: LangId, tree: Tree | null, ignoreList: readonly string[]): Issue[] {
  if (!tree || !spellLangs(lang)) return []
  const dict = dictWords()
  if (!dict) return []

  const ignore = new Set(ignoreList.map((w) => w.toLowerCase()))
  const seen = new Set<string>()
  const issues: Issue[] = []

  for (const range of collectRanges(text, tree, new Set([...COMMENT_NODES, ...STRING_NODES]))) {
    const slice = text.slice(range.from, range.to)
    WORD.lastIndex = 0
    for (let m = WORD.exec(slice); m; m = WORD.exec(slice)) {
      if (issues.length >= MAX_SPELL) return issues
      const from = range.from + m.index
      const to = from + m[0].length
      const word = checkable(m[0], dict, ignore, text, from, to)
      if (!word || seen.has(word)) continue
      seen.add(word)
      issues.push(issueAt(from, to, 'spell', word))
    }
  }
  return issues
}

/** 标识符名里按 camelCase / snake_case 拆出来的片断 */
const IDENT_NODES: Partial<Record<LangId, string[]>> = {
  typescript: ['VariableName', 'PropertyName', 'TypeName', 'JSXIdentifier'],
  javascript: ['VariableName', 'PropertyName', 'TypeName', 'JSXIdentifier'],
  java: ['Identifier', 'TypeName'],
  python: ['VariableName', 'PropertyName', 'TypeName'],
}

/**
 * 标识符拼写。比 `spell` 更保守：片断要 4 个字母起，
 * 且只查「拆出来全是小写字母」的那种——`getURLCache` 这类混缩写的整条跳过。
 */
export function spellIdentIssues(text: string, lang: LangId, tree: Tree | null, ignoreList: readonly string[]): Issue[] {
  if (!tree || !spellLangs(lang)) return []
  const dict = dictWords()
  if (!dict) return []
  const nodes = IDENT_NODES[lang]
  if (!nodes) return []

  const ignore = new Set(ignoreList.map((w) => w.toLowerCase()))
  const seen = new Set<string>()
  const issues: Issue[] = []

  const visit = (node: SyntaxNode): void => {
    const raw = text.slice(node.from, node.to)
    // snake_case → camelCase → 片断；带数字的片断直接丢
    for (const part of raw.split(/[_\d]+/)) {
      for (const piece of part.split(/(?=[A-Z])/)) {
        if (issues.length >= MAX_SPELL_IDENT) return
        // `userNmae` 拆成 `user` + `Nmae`：片断首字母大写是正常的，统一按小写查
        const word = piece.toLowerCase()
        if (word.length < 4 || !/^[a-z]+$/.test(word)) continue
        if (known(word, dict) || ignore.has(word) || seen.has(word)) continue
        if (!VOWELS.test(word)) continue
        seen.add(word)
        // 只标整个标识符：拆出来的片断没有独立偏移，标半个词反而不好点
        issues.push(issueAt(node.from, node.to, 'spellIdent', word))
      }
    }
  }

  tree.iterate({
    enter(node) {
      if (nodes.includes(node.name)) visit(node.node)
    },
  })
  return issues
}
