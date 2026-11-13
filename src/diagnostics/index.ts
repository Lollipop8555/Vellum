import type { Tree } from '@lezer/common'
import type { LangId } from '../editors/languages'
import { parserFor, parseTree } from './parse'
import { checkAvailability, enabledChecks, hasRunnable } from './registry'
import { balanceIssues, treeIssues } from './providers/syntax'
import { formatIssues } from './providers/format'
import { structureIssues } from './providers/structure'
import { fileHealthIssues, fullwidthIssues } from './providers/filehealth'
import { arityIssues, duplicateIssues, typeArgIssues, typoIssues, unusedIssues } from './providers/symbols'
import { spellIdentIssues, spellIssues } from './providers/spell'
import { symbolTable, type SymTab } from './symbols'
import type { CheckKind, ChecksSettings, Issue } from './types'

/**
 * 检查总入口：收文本，出一份引擎无关的 Issue 列表。
 *
 * 这里是纯函数（除了内部解析缓存），谁调用都行：app 的调度器、将来的批量体检、
 * 或者测试。两个编辑器适配器只负责把结果画出来。
 */

export const MAX_ISSUES = 200

/**
 * 诊断自己的闸门，比 `LIMITS.light`（2MB）更严：light 档只是关高亮开关，
 * 而这里每次都要整篇重新解析一遍（解析缓存按内容失效，打字即全量），
 * 512KB 是"一次解析不让用户感觉到卡"的量级。超了就如实显示"未检查 · 大文件"。
 */
export const MAX_TEXT = 512 * 1024

/**
 * 规则版本。改了任何一条规则就 +1：缓存 key 里带着它，
 * 旧文件才不会拿着旧结果当权威（DG-09）。
 */
export const DIAG_VERSION = 4

export { contentHash } from './parse'
export { availabilityFor, checkAvailability, extOf } from './registry'

export interface AnalyzeInput {
  text: string
  lang: LangId
  name: string
  checks: ChecksSettings
  /** 用户自定的「忽略的单词」，只影响拼写两项 */
  ignore?: readonly string[]
}

export interface AnalyzeResult {
  issues: Issue[]
  /** 至少有一项检查真的跑过了。false + 无问题 = 「没查」而不是「干净」 */
  ran: boolean
  /** 该语言/文件在当前勾选下是否有任何能力 */
  supported: boolean
}

export interface ProviderContext {
  text: string
  lang: LangId
  name: string
  /** 语法树；只有需要树的检查项会触发解析，其余为 null */
  tree: Tree | null
  /** 符号表：懒建。四条符号规则共用一个实例，谁先跑到谁触发 */
  symbols: () => SymTab | null
  /** 用户自定的忽略词（小写） */
  ignore: readonly string[]
}

/**
 * provider 注册表（plans/diagnostics.md §7.1）：加一项检查 = 加一个函数 + 一条 CHECK_LIST，
 * 调度器与 UI 都不用动。能力矩阵在 registry.ts 里单独判，不混进来。
 */
const PROVIDERS: Partial<Record<CheckKind, (ctx: ProviderContext) => Issue[]>> = {
  syntax: ({ text, tree }) => {
    if (tree) return treeIssues(tree, text.length)
    // 没有解析器但括号结构单调的语言（Kotlin/Shell/Ruby…）走配平兜底
    return balanceIssues(text)
  },
  format: ({ text, lang }) => formatIssues(text, lang),
  structure: ({ text, lang, name, tree }) => structureIssues(text, lang, name, tree),
  fileHealth: ({ text }) => fileHealthIssues(text),
  fullwidth: ({ text, tree }) => fullwidthIssues(text, tree),
  duplicate: ({ symbols }) => {
    const tab = symbols()
    return tab ? duplicateIssues(tab) : []
  },
  unused: ({ symbols, name }) => {
    const tab = symbols()
    return tab ? unusedIssues(tab, name) : []
  },
  typo: ({ symbols }) => {
    const tab = symbols()
    return tab ? typoIssues(tab) : []
  },
  arity: ({ symbols }) => {
    const tab = symbols()
    return tab ? arityIssues(tab) : []
  },
  typeArgs: ({ symbols }) => {
    const tab = symbols()
    return tab ? typeArgIssues(tab) : []
  },
  spell: ({ text, lang, tree, ignore }) => spellIssues(text, lang, tree, ignore),
  spellIdent: ({ text, lang, tree, ignore }) => spellIdentIssues(text, lang, tree, ignore),
}

function overlaps(a: Issue, b: Issue): boolean {
  return a.from < b.to && b.from < a.to
}

function finalize(issues: Issue[]): Issue[] {
  const seen = new Set<string>()
  const out: Issue[] = []
  for (const issue of issues.sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (issue.to <= issue.from) continue
    const id = `${issue.from}:${issue.to}:${issue.kind}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(issue)
    if (out.length >= MAX_ISSUES) break
  }
  return out
}

/** 哪些检查项需要语法树：只有它们才值得付出一次解析的代价 */
function needsTree(kind: CheckKind, lang: LangId, name: string): boolean {
  if (kind === 'syntax') return parserFor(lang, name) !== null
  if (kind === 'structure') return lang === 'json' || lang === 'yaml'
  if (kind === 'fullwidth') return true
  // 符号层五条：没有树就整项不可用（能力矩阵那一侧已经挡住，这里只是别白解析）
  if (kind === 'duplicate' || kind === 'unused' || kind === 'typo' || kind === 'arity' || kind === 'typeArgs') {
    return true
  }
  if (kind === 'spell' || kind === 'spellIdent') return true
  return false
}

export function analyze({ text, lang, name, checks, ignore }: AnalyzeInput): AnalyzeResult {
  const supported = hasRunnable(checks, lang, name)
  if (text.length > MAX_TEXT) return { issues: [], ran: false, supported }

  const runnable = enabledChecks(checks).filter((kind) => checkAvailability(kind, lang, name).ok)
  if (runnable.length === 0) return { issues: [], ran: false, supported }

  const tree = runnable.some((kind) => needsTree(kind, lang, name))
    ? parseTree(lang, text, name)
    : null

  // 符号表懒建：四条符号规则同用一张，关掉它们时一次都不建
  let symTab: SymTab | null | undefined
  const symbols = (): SymTab | null => {
    if (symTab === undefined) symTab = tree ? symbolTable(lang, name, tree, text) : null
    return symTab
  }

  const ctx: ProviderContext = { text, lang, name, tree, symbols, ignore: ignore ?? [] }
  const issues: Issue[] = []
  // 格式层的消息比语法层的「语法错误」精确得多，先收集、后压制
  const formatIssuesOut: Issue[] = []
  const syntaxIssuesOut: Issue[] = []

  for (const kind of runnable) {
    const run = PROVIDERS[kind]
    if (!run) continue
    const result = run(ctx)
    if (kind === 'format') formatIssuesOut.push(...result)
    else if (kind === 'syntax') syntaxIssuesOut.push(...result)
    else issues.push(...result)
  }

  // 同一处会被两层同时发现（JSON 的 lezer error 往往就落在 JSON.parse 报的位置上），
  // 压掉重叠的语法层条目，避免一个错报两遍
  const keptSyntax =
    formatIssuesOut.length === 0
      ? syntaxIssuesOut
      : syntaxIssuesOut.filter((s) => !formatIssuesOut.some((f) => overlaps(s, f)))

  return { issues: finalize([...keptSyntax, ...formatIssuesOut, ...issues]), ran: true, supported }
}
