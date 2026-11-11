/**
 * 查找 / 替换的纯逻辑层：不碰 DOM，也不依赖具体编辑器引擎。
 * 两种引擎都拿同一份文本、同一套偏移量（JS 字符串下标）来定位，
 * 因此高亮与替换行为完全一致。
 */

export interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export interface SearchMatch {
  from: number
  to: number
  /** 捕获组，[0] 是整段匹配；非正则模式只有 [0] */
  groups: string[]
}

export interface SearchResult {
  matches: SearchMatch[]
  /** 正则语法错误信息，正常时为 null */
  error: string | null
  /** 匹配过多被截断（只保留前 MAX_MATCHES 条） */
  truncated: boolean
}

/** 上限定得比可视区域高亮的需求大很多，同时避免几十万条匹配把主线程拖死 */
export const MAX_MATCHES = 5000

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 整词匹配用前后断言而不是 \b：\b 依赖 \w，
 * 这样写能把 `foo` 从 `foo.bar` 里排除，又不会把 CJK 当成词边界。
 */
export function buildRegExp(query: string, opts: SearchOptions): RegExp | null {
  if (!query) return null
  const flags = opts.caseSensitive ? 'g' : 'gi'
  if (opts.regex) return new RegExp(query, flags)
  const body = escapeRegExp(query)
  return new RegExp(opts.wholeWord ? `(?<![\\w])${body}(?![\\w])` : body, flags)
}

export function findMatches(text: string, query: string, opts: SearchOptions): SearchResult {
  if (!query) return { matches: [], error: null, truncated: false }

  let re: RegExp
  try {
    re = buildRegExp(query, opts) as RegExp
  } catch (err) {
    return { matches: [], error: (err as Error).message, truncated: false }
  }

  const matches: SearchMatch[] = []
  let truncated = false
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    matches.push({ from: m.index, to: m.index + m[0].length, groups: [...m] })
    // 零宽匹配（如 `^`、`\b`）必须手动推进，否则 exec 原地打转
    if (m[0].length === 0) re.lastIndex++
    if (matches.length >= MAX_MATCHES) {
      truncated = true
      break
    }
  }
  return { matches, error: null, truncated }
}

/**
 * 展开替换模板。正则模式支持 $&、$1..$99、$$、$`（匹配前）、$'（匹配后）；
 * 普通文本模式按字面替换，$ 不作特殊含义——否则粘一段 `$&` 会被悄悄改掉。
 */
export function expandReplacement(
  template: string,
  text: string,
  match: SearchMatch,
  regex: boolean,
): string {
  if (!regex) return template
  return template.replace(/\$(\$|&|`|'|\d{1,2})/g, (_all, token: string) => {
    if (token === '$') return '$'
    if (token === '&') return match.groups[0] ?? ''
    if (token === '`') return text.slice(0, match.from)
    if (token === "'") return text.slice(match.to)
    return match.groups[Number(token)] ?? ''
  })
}

/** 当前匹配之后的下一个下标；到尾部回到开头 */
export function nextIndex(active: number, total: number, forward: boolean): number {
  if (total <= 0) return -1
  if (active < 0) return forward ? 0 : total - 1
  return (active + (forward ? 1 : -1) + total) % total
}

/** 内容变化后，找第一个起点不小于 offset 的匹配；越过末尾则回到开头 */
export function indexAtOrAfter(matches: SearchMatch[], offset: number): number {
  if (!matches.length) return -1
  const hit = matches.findIndex((m) => m.from >= offset)
  return hit === -1 ? 0 : hit
}
