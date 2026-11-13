import { cmSupports, monoSupports } from '../editors/lang-registry'
import { LANG_LIST, type LangId } from '../editors/languages'
import type { EngineId } from '../types'
import { BALANCE_LANGS, parserFor } from './parse'
import { hasSymbols } from './symbols'
import { spellLangs } from './providers/spell'
import { CHECK_LIST, type CheckKind, type ChecksSettings } from './types'

/** 符号层首批只放 TS/JS：这两门语言的语法树信息足够，误报可控 */
const TS_LANGS = new Set<LangId>(['typescript', 'javascript'])

/**
 * 能力矩阵：**某个检查项在这个文件上能不能跑**。
 *
 * 这是 UI 上「复选框置灰 + 说明原因」的唯一真相源（plans/diagnostics.md §6）。
 * 三种「不能跑」必须用不同文案，因为它们对用户意味着不同的事：
 * - `noParser`  这门语言根本没有语法树，只能做括号配平（Kotlin / Shell / Ruby …）
 * - `langOnly`  这项工作只对特定语言有意义（格式合法性只做 JSON/XML）
 * - `ext`       扩展名让规则不适用（`.jsonc` 允许尾逗号，套严格 JSON 会满屏误报）
 * - `planned`   方案里排了、还没实现
 */
export type UnavailableReason = 'planned' | 'noParser' | 'langOnly' | 'ext'

export type CheckAvailability = { ok: true } | { ok: false; reason: UnavailableReason }

const OK: CheckAvailability = { ok: true }

/** jsonc / json5 允许注释与尾逗号，套严格 JSON 会满屏误报 */
const LAX_JSON_EXT = new Set(['jsonc', 'json5'])

/** 有列数概念的分隔符文件；项目没有 CSV 语言模式，靠扩展名接住 */
const DSV_EXT = new Set(['csv', 'tsv'])

/**
 * 只认「完整 HTML 文档」：`.vue` / `.svelte` / `.astro` 的模板里有意不闭合的片段太多，
 * 拿标签栈去判会变成噪音机。
 */
const PLAIN_HTML_EXT = new Set(['html', 'htm', 'xhtml'])

export function extOf(name: string): string {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1) : ''
}

function hasParser(lang: LangId, name: string): boolean {
  return parserFor(lang, name) !== null
}

export function checkAvailability(kind: CheckKind, lang: LangId, name: string): CheckAvailability {
  switch (kind) {
    case 'syntax':
      // lezer 的 json 语法是严格的：注释与尾逗号都会变成 error 节点。
      // 拿它去查 .jsonc 等于给合法文件标满红线，只能不查语法（重复键那条照跑）
      if (lang === 'json' && LAX_JSON_EXT.has(extOf(name))) return { ok: false, reason: 'ext' }
      // 有解析器就用解析器；这几个语言虽然只有 stream 高亮，但括号结构单调，配平够用
      return hasParser(lang, name) || BALANCE_LANGS.has(lang) ? OK : { ok: false, reason: 'noParser' }

    case 'format':
      if (lang === 'xml') return OK
      if (lang === 'json') return LAX_JSON_EXT.has(extOf(name)) ? { ok: false, reason: 'ext' } : OK
      return { ok: false, reason: 'langOnly' }

    case 'structure':
      if (lang === 'json' || lang === 'yaml' || lang === 'markdown') return OK
      if (PLAIN_HTML_EXT.has(extOf(name))) return OK
      if (DSV_EXT.has(extOf(name))) return OK
      return { ok: false, reason: 'langOnly' }

    case 'duplicate':
    case 'arity':
    case 'typeArgs':
      // 有符号表就能做（TS/JS/Java）；其余语言连定义在哪都认不出
      return hasSymbols(lang) ? OK : { ok: false, reason: 'langOnly' }

    case 'unused':
    case 'typo':
      // 这两条误报代价最高，首批只放给 TS/JS：
      // Java 的字段可能被反射/序列化用到，本文件里「没用过」说明不了什么
      return TS_LANGS.has(lang) ? OK : { ok: false, reason: 'langOnly' }

    case 'spell':
    case 'spellIdent':
      // 只在能明确划出注释/字符串的语言上查；Markdown/JSON 这类「正文本身就是内容」
      // 的文件套英语词典等于满屏黄线（词典只有英文，中文会被整段跳过）
      return spellLangs(lang) ? OK : { ok: false, reason: 'langOnly' }

    case 'fileHealth':
      // 纯文本扫描，任何文件都能做
      return OK

    case 'fullwidth':
      // 全角标点在 Markdown/文本里是正常标点，只在代码里有意义；
      // 而且必须靠语法树排除注释与字符串，没有树就不做（否则中文注释会满屏黄线）
      if (lang === 'markdown' || lang === 'text' || lang === 'logcat') {
        return { ok: false, reason: 'langOnly' }
      }
      return hasParser(lang, name) ? OK : { ok: false, reason: 'noParser' }

    default:
      return { ok: false, reason: 'planned' }
  }
}

/** 整张表：UI 渲染复选框时一次算完，别在渲染循环里反复问 */
export function availabilityFor(lang: LangId, name: string): Record<CheckKind, CheckAvailability> {
  const table = {} as Record<CheckKind, CheckAvailability>
  for (const def of CHECK_LIST) table[def.id] = checkAvailability(def.id, lang, name)
  return table
}

/**
 * 「语言 × 检查项」矩阵的一行：一门语言能开哪几项检查。
 *
 * 面板按语言扫——用户的问题是「我用 Kotlin，能开哪几项」，不是
 * 「全角标点支持哪些语言」。反过来的聚合只会逼人逐行认名字。
 * 数据同样从 `checkAvailability` 现算，不另写一张会过期的表。
 */
export interface LanguageSupport {
  id: LangId
  label: string
  /** 与 `CHECK_LIST` 同序 */
  ok: boolean[]
  /** 与 `CHECK_LIST` 同序；可用时为 null */
  reasons: Array<UnavailableReason | null>
  /** 可用项数，排序用 */
  count: number
  /**
   * 只有一侧引擎认得这门语言时给出那一侧；两侧都认得（或都不认得）为 null。
   *
   * 检查本身与引擎无关（纯文本分析），但语言只有那个引擎能着色——用户要知道
   * 自己的 ✓ 是建立在哪个引擎上的，否则切过去发现满屏黑白会以为功能坏了。
   */
  engine: EngineId | null
}

let langCache: LanguageSupport[] | null = null

/** 按可用项数降序（V8 的 sort 稳定，同分保持 `LANG_LIST` 顺序） */
export function languageMatrix(): LanguageSupport[] {
  if (langCache) return langCache
  langCache = LANG_LIST.map((d): LanguageSupport => {
    const ext = d.ext as readonly string[]
    // 判定拿首个扩展名做代表：.jsonc / .csv 这类特例只落在个别语言上，
    // 不影响「这门语言大体能不能查」这个结论
    const name = ext.length > 0 ? `x.${ext[0]}` : 'x'
    const cells = CHECK_LIST.map((def) => checkAvailability(def.id, d.id, name))
    const cm = cmSupports(d.id)
    const mono = monoSupports(d.id)
    return {
      id: d.id,
      label: d.label,
      ok: cells.map((c) => c.ok),
      reasons: cells.map((c) => (c.ok ? null : c.reason)),
      count: cells.filter((c) => c.ok).length,
      engine: cm === mono ? null : cm ? 'cm' : 'monaco',
    }
  }).sort((a, b) => b.count - a.count)
  return langCache
}

export function enabledChecks(checks: ChecksSettings): CheckKind[] {
  return CHECK_LIST.filter((def) => checks[def.id]).map((def) => def.id)
}

/** 当前勾选在本文件上是否有任何一项能跑。「一项都跑不了」要说成「无检查」而不是「无问题」 */
export function hasRunnable(checks: ChecksSettings, lang: LangId, name: string): boolean {
  return enabledChecks(checks).some((kind) => checkAvailability(kind, lang, name).ok)
}

/** 空态提示该怪谁：优先说「语言没有解析器」，它比「你没勾」更有解释力 */
export function dominantReason(
  checks: ChecksSettings,
  lang: LangId,
  name: string,
): 'planned' | 'noParser' | 'langOnly' | 'ext' | null {
  const reasons = enabledChecks(checks)
    .map((kind) => checkAvailability(kind, lang, name))
    .filter((a): a is { ok: false; reason: 'planned' | 'noParser' | 'langOnly' | 'ext' } => !a.ok)
  if (reasons.length === 0) return null
  for (const want of ['noParser', 'langOnly', 'ext', 'planned'] as const) {
    if (reasons.some((r) => r.reason === want)) return want
  }
  return null
}
