import type { LangId } from './languages'

export interface EditorOptions {
  value: string
  language: LangId
  readOnly: boolean
  wordWrap: boolean
  theme: 'dark' | 'light'
  fontSize: number
  onChange?: (value: string) => void
  onCursor?: (line: number, col: number) => void
}

export interface EditorAdapter {
  readonly id: 'cm' | 'monaco'
  mount(el: HTMLElement, opts: EditorOptions): Promise<void>
  getValue(): string
  setValue(v: string): void
  getOffset(): number
  setOffset(n: number): void
  setLanguage(id: LangId): void
  setReadOnly(v: boolean): void
  setWordWrap(v: boolean): void
  setFontSize(px: number): void
  setTheme(t: 'dark' | 'light'): void
  goToLine(n: number): void
  openSearch(): void
  focus(): void
  layout(): void
  destroy(): void
}
