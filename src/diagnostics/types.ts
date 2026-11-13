import { t, type MessageKey } from '../i18n'

/**
 * 检查结果的数据契约。设计依据：plans/diagnostics.md §7.2
 *
 * 这里的 `Issue` 是引擎无关的：CodeMirror 与 Monaco 都只是它的渲染器，
 * 任何"该不该报"的判断都不许写在适配器里。
 */

export type Severity = 'error' | 'warning'

export type CheckKind =
  | 'syntax'
  | 'format'
  | 'structure'
  | 'mdLint'
  | 'duplicate'
  | 'typo'
  | 'unused'
  | 'arity'
  | 'typeArgs'
  | 'spell'
  | 'spellIdent'
  | 'fileHealth'
  | 'fullwidth'

/** 用户可勾选的检查项。默认值见 plans/diagnostics.md §4（轻量的开、有负担的关） */
export interface ChecksSettings {
  syntax: boolean
  format: boolean
  structure: boolean
  /** Markdown 风格规则（plans/markdown.md §8）；只对 .md 生效 */
  mdLint: boolean
  duplicate: boolean
  typo: boolean
  unused: boolean
  arity: boolean
  typeArgs: boolean
  spell: boolean
  spellIdent: boolean
  fileHealth: boolean
  fullwidth: boolean
}

export const DEFAULT_CHECKS: ChecksSettings = {
  syntax: true,
  format: true,
  structure: true,
  mdLint: true,
  duplicate: true,
  typo: true,
  unused: true,
  arity: true,
  typeArgs: false,
  spell: false,
  spellIdent: false,
  fileHealth: true,
  fullwidth: false,
}

export interface CheckDef {
  id: CheckKind
  /** 面板里的分组：语法与结构 / 代码语义 / 文本 */
  group: 'syntax' | 'semantic' | 'text'
  /** false = 方案里排了但还没实现，复选框置灰并说明 */
  ready: boolean
}

/**
 * 面板渲染顺序即此顺序。
 * `ready: false` 的是「方案里排了但还没写」，UI 会置灰并说明原因；
 * 已经写好但某个语言用不了的，交给 registry 的能力矩阵判，不在这里一刀切。
 */
export const CHECK_LIST: CheckDef[] = [
  { id: 'syntax', group: 'syntax', ready: true },
  { id: 'format', group: 'syntax', ready: true },
  { id: 'structure', group: 'syntax', ready: true },
  { id: 'mdLint', group: 'syntax', ready: true },
  { id: 'fileHealth', group: 'syntax', ready: true },
  { id: 'fullwidth', group: 'syntax', ready: true },
  { id: 'duplicate', group: 'semantic', ready: true },
  { id: 'unused', group: 'semantic', ready: true },
  { id: 'typo', group: 'semantic', ready: true },
  { id: 'arity', group: 'semantic', ready: true },
  { id: 'typeArgs', group: 'semantic', ready: true },
  { id: 'spell', group: 'text', ready: true },
  { id: 'spellIdent', group: 'text', ready: true },
]

export interface Issue {
  /** 文档偏移，0 起；`to` 必须大于 `from`，单点错误要扩到整个 token 才有波浪线 */
  from: number
  to: number
  severity: Severity
  kind: CheckKind
  /** 文案键：渲染时才翻译，切语言不必重跑检查 */
  key: MessageKey
  params?: Record<string, string | number>
  /** provider 名，便于去重与调试 */
  source: string
}

export function issueText(issue: Issue): string {
  return t(issue.key, issue.params)
}

/** 编辑器中渲染用的最简形态，两个适配器都只吃这个 */
export interface RenderedIssue {
  from: number
  to: number
  severity: Severity
  message: string
}

export function toRendered(issues: Issue[]): RenderedIssue[] {
  return issues.map((i) => ({
    from: i.from,
    to: i.to,
    severity: i.severity,
    message: issueText(i),
  }))
}

/** 把勾选项压成位掩码，用于缓存 key（改勾选即失效） */
export function checksMask(checks: ChecksSettings): number {
  let mask = 0
  CHECK_LIST.forEach((def, i) => {
    if (checks[def.id]) mask |= 1 << i
  })
  return mask
}
