import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { closeBrackets, autocompletion, closeBracketsKeymap } from '@codemirror/autocomplete'
import { tags } from '@lezer/highlight'
import type { EditorAdapter, EditorOptions } from './adapter'
import { cmLanguage, type LangId } from './languages'

/** 颜色一律引用 CSS 变量，切换主题无需重建编辑器 */
const vellumTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--editor-font-size, 13px)',
    color: 'var(--c-text)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--mono-font)',
    lineHeight: '1.65',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '10px 0 40vh',
    caretColor: 'var(--c-accent)',
  },
  '.cm-line': { paddingLeft: '6px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--c-faint)',
    border: 'none',
    paddingLeft: '8px',
    userSelect: 'none',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--c-text)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--c-accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--c-sel) !important',
  },
  '.cm-panels': {
    backgroundColor: 'var(--c-island-2)',
    color: 'var(--c-text)',
    borderColor: 'var(--c-border)',
  },
  '.cm-panels input, .cm-panels button': {
    backgroundColor: 'var(--c-island)',
    color: 'var(--c-text)',
    border: '1px solid var(--c-border)',
    borderRadius: '5px',
    padding: '2px 6px',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--c-accent-weak)', outline: '1px solid var(--c-border)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--c-sel)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--c-accent-weak)',
    outline: '1px solid var(--c-border)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--c-island-2)',
    border: '1px solid var(--c-border)',
    color: 'var(--c-dim)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--c-island)',
    border: '1px solid var(--c-border)',
    borderRadius: '7px',
    color: 'var(--c-text)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--c-accent-weak)',
    color: 'var(--c-text)',
  },
})

const vellumHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: 'var(--syn-key)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--syn-str)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--syn-com)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-num)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syn-type)' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--syn-fn)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--syn-prop)' },
  { tag: [tags.tagName], color: 'var(--syn-key)' },
  { tag: [tags.heading], color: 'var(--syn-type)', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: 'var(--c-accent)' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.strong], fontWeight: '600' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--c-dim)' },
  { tag: [tags.invalid], color: 'var(--c-danger)' },
])

export class CodeMirrorAdapter implements EditorAdapter {
  readonly id = 'cm' as const

  private view: EditorView | null = null
  private langComp = new Compartment()
  private readOnlyComp = new Compartment()
  private wrapComp = new Compartment()
  private opts: EditorOptions | null = null

  async mount(el: HTMLElement, opts: EditorOptions): Promise<void> {
    this.opts = opts
    const state = EditorState.create({
      doc: opts.value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        search({ top: true }),
        syntaxHighlighting(vellumHighlight),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        vellumTheme,
        this.langComp.of(cmLanguage(opts.language)),
        this.readOnlyComp.of([
          EditorState.readOnly.of(opts.readOnly),
          EditorView.editable.of(!opts.readOnly),
        ]),
        this.wrapComp.of(opts.wordWrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.opts?.onChange?.(u.state.doc.toString())
          if (u.selectionSet || u.docChanged) {
            const pos = u.state.selection.main.head
            const line = u.state.doc.lineAt(pos)
            this.opts?.onCursor?.(line.number, pos - line.from + 1)
          }
        }),
      ],
    })

    this.view = new EditorView({ state, parent: el })
    this.setFontSize(opts.fontSize)
  }

  getValue(): string {
    return this.view?.state.doc.toString() ?? ''
  }

  setValue(v: string): void {
    if (!this.view || v === this.getValue()) return
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: v } })
  }

  getOffset(): number {
    return this.view?.state.selection.main.head ?? 0
  }

  setOffset(n: number): void {
    if (!this.view) return
    const pos = Math.max(0, Math.min(n, this.view.state.doc.length))
    this.view.dispatch({ selection: { anchor: pos }, scrollIntoView: false })
  }

  setLanguage(id: LangId): void {
    this.view?.dispatch({ effects: this.langComp.reconfigure(cmLanguage(id)) })
  }

  setReadOnly(v: boolean): void {
    this.view?.dispatch({
      effects: this.readOnlyComp.reconfigure([
        EditorState.readOnly.of(v),
        EditorView.editable.of(!v),
      ]),
    })
  }

  setWordWrap(v: boolean): void {
    this.view?.dispatch({
      effects: this.wrapComp.reconfigure(v ? EditorView.lineWrapping : []),
    })
  }

  setFontSize(px: number): void {
    this.view?.dom.style.setProperty('--editor-font-size', `${px}px`)
  }

  setTheme(_t: 'dark' | 'light'): void {
    // 颜色走 CSS 变量，主题切换后只需重新测量
    this.view?.requestMeasure()
  }

  goToLine(n: number): void {
    if (!this.view) return
    const doc = this.view.state.doc
    const line = doc.line(Math.max(1, Math.min(n, doc.lines)))
    this.view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    })
    this.view.focus()
  }

  openSearch(): void {
    if (!this.view) return
    openSearchPanel(this.view)
  }

  focus(): void {
    this.view?.focus()
  }

  layout(): void {
    this.view?.requestMeasure()
  }

  destroy(): void {
    this.view?.destroy()
    this.view = null
    this.opts = null
  }
}
