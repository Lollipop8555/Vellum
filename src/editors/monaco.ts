import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import type { EditorAdapter, EditorOptions } from './adapter'
import { monacoLanguage, type LangId } from './languages'
import { cssVar } from '../ui/theme'

// 只提供 editor worker；TS/JSON 语言服务不参与打包，避免 worker 协议错配
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

const THEMES = { dark: 'vellum-dark', light: 'vellum-light' } as const

function hex(name: string): string {
  return cssVar(name).replace('#', '') || '888888'
}

function defineThemes() {
  const base = { inherit: true, rules: [], colors: {} }
  monaco.editor.defineTheme(THEMES.dark, {
    ...base,
    base: 'vs-dark',
    rules: [
      { token: 'keyword', foreground: hex('--syn-key') },
      { token: 'string', foreground: hex('--syn-str') },
      { token: 'comment', foreground: hex('--syn-com'), fontStyle: 'italic' },
      { token: 'number', foreground: hex('--syn-num') },
      { token: 'type', foreground: hex('--syn-type') },
      { token: 'delimiter', foreground: hex('--c-dim') },
      { token: 'tag', foreground: hex('--syn-key') },
      { token: 'attribute.name', foreground: hex('--syn-prop') },
      { token: 'attribute.value', foreground: hex('--syn-str') },
    ],
    colors: {
      'editor.background': cssVar('--c-island'),
      'editor.foreground': cssVar('--c-text'),
      'editorLineNumber.foreground': cssVar('--c-faint'),
      'editorLineNumber.activeForeground': cssVar('--c-text'),
      'editorCursor.foreground': cssVar('--c-accent'),
      'editor.selectionBackground': cssVar('--c-sel'),
      'editor.inactiveSelectionBackground': cssVar('--c-sel'),
      'editor.lineHighlightBackground': '#00000000',
      'editorIndentGuide.background1': cssVar('--c-border-soft'),
      'editorWidget.background': cssVar('--c-island-2'),
      'editorWidget.border': cssVar('--c-border'),
      'input.background': cssVar('--c-island'),
      'input.border': cssVar('--c-border'),
      'focusBorder': cssVar('--c-accent'),
      'scrollbarSlider.background': cssVar('--c-border'),
    },
  })
  monaco.editor.defineTheme(THEMES.light, {
    ...base,
    base: 'vs',
    rules: [
      { token: 'keyword', foreground: hex('--syn-key') },
      { token: 'string', foreground: hex('--syn-str') },
      { token: 'comment', foreground: hex('--syn-com'), fontStyle: 'italic' },
      { token: 'number', foreground: hex('--syn-num') },
      { token: 'type', foreground: hex('--syn-type') },
    ],
    colors: {
      'editor.background': cssVar('--c-island'),
      'editor.foreground': cssVar('--c-text'),
      'editorLineNumber.foreground': cssVar('--c-faint'),
      'editorLineNumber.activeForeground': cssVar('--c-text'),
      'editorCursor.foreground': cssVar('--c-accent'),
      'editor.selectionBackground': cssVar('--c-sel'),
      'editor.lineHighlightBackground': '#00000000',
      'editorWidget.background': cssVar('--c-island-2'),
      'editorWidget.border': cssVar('--c-border'),
      'input.background': cssVar('--c-island'),
      'input.border': cssVar('--c-border'),
      'focusBorder': cssVar('--c-accent'),
    },
  })
}

export class MonacoAdapter implements EditorAdapter {
  readonly id = 'monaco' as const

  private editor: monaco.editor.IStandaloneCodeEditor | null = null
  private model: monaco.editor.ITextModel | null = null
  private opts: EditorOptions | null = null
  private suppress = false
  private currentTheme: 'dark' | 'light' = 'dark'
  private themesReady = false

  async mount(el: HTMLElement, opts: EditorOptions): Promise<void> {
    this.opts = opts
    this.currentTheme = opts.theme

    if (!this.themesReady) {
      defineThemes()
      this.themesReady = true
    }

    this.model = monaco.editor.createModel(opts.value, monacoLanguage(opts.language))
    this.editor = monaco.editor.create(el, {
      model: this.model,
      theme: THEMES[opts.theme],
      readOnly: opts.readOnly,
      fontSize: opts.fontSize,
      fontFamily: cssVar('--mono-font'),
      lineHeight: Math.round(opts.fontSize * 1.65),
      wordWrap: opts.wordWrap ? 'on' : 'off',
      automaticLayout: false,
      fixedOverflowWidgets: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: false,
      renderWhitespace: 'none',
      renderLineHighlight: 'none',
      guides: { indentation: false },
      folding: true,
      lineNumbers: 'on',
      glyphMargin: false,
      padding: { top: 10, bottom: 24 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      largeFileOptimizations: true,
      contextmenu: true,
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      stickyScroll: { enabled: false },
      bracketPairColorization: { enabled: false },
    })

    this.model.onDidChangeContent(() => {
      if (this.suppress) return
      this.opts?.onChange?.(this.model?.getValue() ?? '')
    })

    this.editor.onDidChangeCursorPosition((e) => {
      this.opts?.onCursor?.(e.position.lineNumber, e.position.column)
    })
  }

  getValue(): string {
    return this.model?.getValue() ?? ''
  }

  setValue(v: string): void {
    if (!this.model || v === this.model.getValue()) return
    this.suppress = true
    this.model.setValue(v)
    this.suppress = false
  }

  getOffset(): number {
    if (!this.editor || !this.model) return 0
    return this.model.getOffsetAt(this.editor.getPosition() ?? { lineNumber: 1, column: 1 })
  }

  setOffset(n: number): void {
    if (!this.editor || !this.model) return
    const pos = this.model.getPositionAt(Math.max(0, Math.min(n, this.model.getValueLength())))
    this.editor.setPosition(pos)
  }

  setLanguage(id: LangId): void {
    if (!this.model) return
    monaco.editor.setModelLanguage(this.model, monacoLanguage(id))
  }

  setReadOnly(v: boolean): void {
    this.editor?.updateOptions({ readOnly: v })
  }

  setWordWrap(v: boolean): void {
    this.editor?.updateOptions({ wordWrap: v ? 'on' : 'off' })
  }

  setFontSize(px: number): void {
    this.editor?.updateOptions({ fontSize: px, lineHeight: Math.round(px * 1.65) })
  }

  setTheme(t: 'dark' | 'light'): void {
    if (this.currentTheme === t) return
    this.currentTheme = t
    // 主题色取自 CSS 变量，切换时需重新读取
    defineThemes()
    monaco.editor.setTheme(THEMES[t])
  }

  goToLine(n: number): void {
    if (!this.editor) return
    const max = this.model?.getLineCount() ?? 1
    const line = Math.max(1, Math.min(n, max))
    this.editor.revealLineInCenter(line)
    this.editor.setPosition({ lineNumber: line, column: 1 })
    this.editor.focus()
  }

  openSearch(): void {
    void this.editor?.getAction('actions.find')?.run()
  }

  focus(): void {
    this.editor?.focus()
  }

  layout(): void {
    this.editor?.layout()
  }

  destroy(): void {
    this.editor?.dispose()
    this.model?.dispose()
    this.editor = null
    this.model = null
    this.opts = null
  }
}
