import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import type { EditorAdapter, EditorOptions, SearchApi } from './adapter'
import { monacoLanguage, monoSupports, scanLogcatLine, type LangId } from './languages'
import { cssVar } from '../ui/theme'

// 只提供 editor worker；TS/JSON 语言服务不参与打包，避免 worker 协议错配
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

const THEMES = { dark: 'vellum-dark', light: 'vellum-light' } as const

/** Monaco 内置的大文件分词阈值：超过它，模型不会再被分词 */
const MONACO_TOKEN_LIMIT = 20 * 1024 * 1024

function hex(name: string): string {
  return cssVar(name).replace('#', '') || '888888'
}

/* ---------------- logcat ---------------- */

const LOG_LEVEL_SCOPES: Record<string, string> = {
  'level-verbose': 'logcat.level.verbose',
  'level-debug': 'logcat.level.debug',
  'level-info': 'logcat.level.info',
  'level-warn': 'logcat.level.warn',
  'level-error': 'logcat.level.error',
}

let logcatReady = false

/**
 * Monaco 的 basic-languages 里没有 logcat，这里自带一个：
 * 直接复用 languages.ts 的行解析器，保证两种引擎的分色完全一致。
 */
function registerLogcat() {
  if (logcatReady) return
  logcatReady = true

  const empty = { clone: () => empty, equals: () => true }
  monaco.languages.register({ id: 'logcat' })
  monaco.languages.setTokensProvider('logcat', {
    getInitialState: () => empty,
    tokenize(line: string) {
      const tokens = scanLogcatLine(line).map((t) => ({
        startIndex: t.start,
        scopes: t.type === 'time' || t.type === 'pid' ? `logcat.${t.type}` : (LOG_LEVEL_SCOPES[t.type] ?? `logcat.${t.type}`),
      }))
      return { tokens, endState: empty }
    },
  })
}

let jsonReady = false

/**
 * Monaco 把 JSON 放在 language service（`vs/language/json`）里，basic-languages 没有它：
 * 只引 basic-languages 时 `json` 这个 id 压根没注册，状态栏说「高亮」其实一片素色。
 * 这里补一个纯 Monarch 的 JSON/JSONC，不拉 json worker：只上色，不校验、不补全。
 */
function registerJson() {
  if (jsonReady) return
  jsonReady = true

  monaco.languages.register({
    id: 'json',
    extensions: ['.json', '.jsonc', '.json5', '.har', '.webmanifest'],
    aliases: ['JSON', 'json'],
    mimetypes: ['application/json'],
  })
  monaco.languages.setMonarchTokensProvider('json', {
    tokenizer: {
      root: [
        [/\s+/, ''],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/[^\n]*/, 'comment'],
        // 键：字符串后面紧跟冒号。两个捕获组依次上色，冒号仍算分隔符
        [/("(?:[^"\\]|\\.)*")([ \t]*:)/, ['string.key', 'delimiter']],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/[{}[\],:]/, 'delimiter'],
      ],
      comment: [
        [/[^*/]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[*/]/, 'comment'],
      ],
    },
  })
}

function defineThemes() {
  const logcatRules = [
    { token: 'logcat.time', foreground: hex('--c-dim') },
    { token: 'logcat.pid', foreground: hex('--c-dim') },
    { token: 'logcat.level.verbose', foreground: hex('--c-faint') },
    { token: 'logcat.level.debug', foreground: hex('--syn-type') },
    { token: 'logcat.level.info', foreground: hex('--syn-str') },
    { token: 'logcat.level.warn', foreground: hex('--syn-num') },
    { token: 'logcat.level.error', foreground: hex('--c-danger'), fontStyle: 'bold' },
    { token: 'logcat.tag', foreground: hex('--syn-key') },
    { token: 'logcat.stack', foreground: hex('--c-dim') },
    { token: 'logcat.error', foreground: hex('--c-danger') },
  ]

  const base = { inherit: true, rules: [], colors: {} }
  monaco.editor.defineTheme(THEMES.dark, {
    ...base,
    base: 'vs-dark',
    rules: [
      { token: 'keyword', foreground: hex('--syn-key') },
      { token: 'string', foreground: hex('--syn-str') },
      { token: 'string.key', foreground: hex('--syn-prop') },
      { token: 'comment', foreground: hex('--syn-com'), fontStyle: 'italic' },
      { token: 'number', foreground: hex('--syn-num') },
      { token: 'type', foreground: hex('--syn-type') },
      { token: 'delimiter', foreground: hex('--c-dim') },
      { token: 'tag', foreground: hex('--syn-key') },
      { token: 'attribute.name', foreground: hex('--syn-prop') },
      { token: 'attribute.value', foreground: hex('--syn-str') },
      ...logcatRules,
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
      'scrollbarSlider.background': cssVar('--c-scroll'),
      'scrollbarSlider.hoverBackground': cssVar('--c-scroll-hover'),
      'scrollbarSlider.activeBackground': cssVar('--c-scroll-hover'),
      'scrollbar.shadow': '#00000000',
    },
  })
  monaco.editor.defineTheme(THEMES.light, {
    ...base,
    base: 'vs',
    rules: [
      { token: 'keyword', foreground: hex('--syn-key') },
      { token: 'string', foreground: hex('--syn-str') },
      { token: 'string.key', foreground: hex('--syn-prop') },
      { token: 'comment', foreground: hex('--syn-com'), fontStyle: 'italic' },
      { token: 'number', foreground: hex('--syn-num') },
      { token: 'type', foreground: hex('--syn-type') },
      ...logcatRules,
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
      'scrollbarSlider.background': cssVar('--c-scroll'),
      'scrollbarSlider.hoverBackground': cssVar('--c-scroll-hover'),
      'scrollbarSlider.activeBackground': cssVar('--c-scroll-hover'),
      'scrollbar.shadow': '#00000000',
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
  private findDecorations: monaco.editor.IEditorDecorationsCollection | null = null

  async mount(el: HTMLElement, opts: EditorOptions): Promise<void> {
    this.opts = opts
    this.currentTheme = opts.theme

    if (!this.themesReady) {
      defineThemes()
      this.themesReady = true
    }
    // 必须在 createModel 之前注册，否则语言 id 还没被 Monaco 认识
    registerLogcat()
    registerJson()

    // Monaco 在建模那一刻就定死「这个模型要不要分词」：开着大文件优化时，
    // 超过 20MB 的文档永远不会上色。大文件要颜色就只能把优化关掉，
    // 代价是折叠也跟着变重，所以这两种情况一并放弃折叠。
    const tokens = opts.value.length > MONACO_TOKEN_LIMIT && opts.language !== 'text'

    this.editor = monaco.editor.create(el, {
      value: opts.value,
      language: monacoLanguage(opts.language),
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
      folding: !tokens,
      lineNumbers: 'on',
      glyphMargin: false,
      padding: { top: 10, bottom: 24 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      largeFileOptimizations: !tokens,
      contextmenu: true,
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      stickyScroll: { enabled: false },
      bracketPairColorization: { enabled: false },
    })
    this.model = this.editor.getModel()

    this.model?.onDidChangeContent(() => {
      if (this.suppress) return
      this.opts?.onChange?.(this.model?.getValue() ?? '')
    })

    this.editor.onDidChangeCursorPosition((e) => {
      this.opts?.onCursor?.(e.position.lineNumber, e.position.column)
    })

    this.findDecorations = this.editor.createDecorationsCollection()
    // 覆盖内建查找键位，让两个引擎都走同一个查找栏
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () =>
      this.opts?.onFind?.(false),
    )
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
      () => this.opts?.onFind?.(true),
    )
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

  supportsLanguage(id: LangId): boolean {
    return monoSupports(id)
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
    this.refreshTheme()
  }

  refreshTheme(): void {
    // 颜色全部取自 CSS 变量，强调色开关变化时同名主题也要重新定义
    defineThemes()
    this.themesReady = true
    monaco.editor.setTheme(THEMES[this.currentTheme])
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
    this.opts?.onFind?.(false)
  }

  searchApi(): SearchApi {
    const model = () => this.model
    const editor = () => this.editor
    const decorations = this.findDecorations
    const rangeOf = (from: number, to: number) => {
      const m = model()
      if (!m) return new monaco.Range(1, 1, 1, 1)
      const a = m.getPositionAt(from)
      const b = m.getPositionAt(to)
      return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column)
    }

    return {
      getSelection() {
        const sel = editor()?.getSelection()
        const m = model()
        if (!sel || !m) return { from: 0, to: 0 }
        return {
          from: m.getOffsetAt(sel.getStartPosition()),
          to: m.getOffsetAt(sel.getEndPosition()),
        }
      },
      selectRange(from, to) {
        const e = editor()
        if (!e) return
        const len = model()?.getValueLength() ?? 0
        const a = Math.max(0, Math.min(from, len))
        const b = Math.max(a, Math.min(to, len))
        const range = rangeOf(a, b)
        e.setSelection(range)
        e.revealRangeInCenterIfOutsideViewport(range)
      },
      setSearchMarks(ranges, active) {
        const collection = decorations
        if (!collection) return
        const items: monaco.editor.IModelDeltaDecoration[] = []
        for (let i = 0; i < ranges.length; i++) {
          const r = ranges[i]
          if (r.to <= r.from) continue
          items.push({
            range: rangeOf(r.from, r.to),
            options: {
              inlineClassName: i === active ? 'monaco-find-active' : 'monaco-find-match',
              // 概览条上也点一下，长文件里能直接看到分布
              overviewRuler: {
                color: i === active ? 'rgba(217,160,91,0.9)' : 'rgba(217,160,91,0.45)',
                position: monaco.editor.OverviewRulerLane.Center,
              },
            },
          })
        }
        collection.set(items)
      },
      clearSearchMarks() {
        decorations?.clear()
      },
      applyEdits(edits) {
        const e = editor()
        if (!e || edits.length === 0) return
        e.pushUndoStop()
        e.executeEdits(
          'vellum-find',
          edits.map((item) => ({ range: rangeOf(item.from, item.to), text: item.insert })),
        )
        e.pushUndoStop()
      },
    }
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
    this.findDecorations = null
    this.opts = null
  }
}
