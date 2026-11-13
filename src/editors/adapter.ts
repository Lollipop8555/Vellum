import type { LangId } from './languages'
import type { RenderedIssue } from '../diagnostics/types'

export interface EditorOptions {
  value: string
  language: LangId
  readOnly: boolean
  wordWrap: boolean
  theme: 'dark' | 'light'
  fontSize: number
  onChange?: (value: string) => void
  onCursor?: (line: number, col: number) => void
  /** 引擎拦下自己的查找键（Mod+F / Mod+Alt+F）后回调，交给统一的查找栏处理 */
  onFind?: (replace: boolean) => void
}

export interface Edit {
  from: number
  to: number
  insert: string
}

/** 与引擎无关的查找能力：偏移量统一用 JS 字符串下标 */
export interface SearchApi {
  getSelection(): { from: number; to: number }
  /** 滚动到该区间并设置为选区（不抢焦点，焦点要留在查找输入框里） */
  selectRange(from: number, to: number): void
  /** 给全部匹配上底色，active 单独加强 */
  setSearchMarks(ranges: Array<{ from: number; to: number }>, active: number): void
  clearSearchMarks(): void
  /** 一次事务内应用多处编辑，撤消时算一步 */
  applyEdits(edits: Edit[]): void
}

export interface EditorAdapter {
  readonly id: 'cm' | 'monaco'
  mount(el: HTMLElement, opts: EditorOptions): Promise<void>
  getValue(): string
  setValue(v: string): void
  getOffset(): number
  setOffset(n: number): void
  setLanguage(id: LangId): void
  /** 该引擎有没有这个语言的语法定义，没有时状态栏说实话而不是假装在着色 */
  supportsLanguage(id: LangId): boolean
  setReadOnly(v: boolean): void
  setWordWrap(v: boolean): void
  setFontSize(px: number): void
  setTheme(t: 'dark' | 'light'): void
  /** 主题色取自 CSS 变量（如强调色开关），同名主题也要重读 */
  refreshTheme(): void
  goToLine(n: number): void
  /** 语法检查结果。空数组即清空；判断"该不该报"不归适配器管 */
  setIssues(issues: RenderedIssue[]): void
  openSearch(): void
  searchApi(): SearchApi
  focus(): void
  layout(): void
  destroy(): void
}
