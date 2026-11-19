/** 移植层的 token / 幻灯片结构类型（与 remark v0.15.0 的形状对齐，补了 offset） */

export type TokenType =
  | 'text'
  | 'code'
  | 'fences'
  | 'def'
  | 'macro'
  | 'separator'
  | 'notes_separator'
  | 'content_start'
  | 'content_end'

export interface Token {
  readonly type: TokenType
  /** 在源文本（已归一化换行）中的字符偏移。上游没有这个字段 */
  readonly start: number
  text?: string
  /** separator：分页符本体（`---` / `--` / `<!-- break -->` 去空白），`text` 是含换行的整段匹配 */
  marker?: string
  /** def */
  id?: string
  href?: string
  title?: string
  /** macro */
  name?: string
  args?: Array<string | undefined>
  obj?: string
  /** content_start / content_end */
  classes?: string[]
  block?: boolean
}
