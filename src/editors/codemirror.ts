import {
  Compartment,
  EditorState,
  Prec,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
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
  type DecorationSet,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { closeBrackets, autocompletion, closeBracketsKeymap } from '@codemirror/autocomplete'
import { Tag, tags } from '@lezer/highlight'
import type { EditorAdapter, EditorOptions, SearchApi } from './adapter'
import { cmLanguage, scanLogcatLine, type LangId, type LogcatToken } from './languages'

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

/* ---------------- logcat ---------------- */

/** logcat 专用标签：内置 tags 表达不了「按日志级别分色」，单独定义 */
const logcatTags = {
  time: Tag.define(),
  pid: Tag.define(),
  verbose: Tag.define(),
  debug: Tag.define(),
  info: Tag.define(),
  warn: Tag.define(),
  error: Tag.define(),
  tag: Tag.define(),
  stack: Tag.define(),
  exc: Tag.define(),
}

const LOG_LEVEL_TAGS: Record<string, Tag> = {
  'level-verbose': logcatTags.verbose,
  'level-debug': logcatTags.debug,
  'level-info': logcatTags.info,
  'level-warn': logcatTags.warn,
  'level-error': logcatTags.error,
}

// 同一行会被逐段请求，缓存解析结果，避免重复跑正则
const logcatCache = new Map<string, LogcatToken[]>()

function logcatTokens(line: string): LogcatToken[] {
  const hit = logcatCache.get(line)
  if (hit) return hit
  const tokens = scanLogcatLine(line)
  if (logcatCache.size > 300) logcatCache.clear()
  logcatCache.set(line, tokens)
  return tokens
}

const logcatLanguage = StreamLanguage.define({
  name: 'logcat',
  token(stream) {
    const tokens = logcatTokens(stream.string)
    // 跳到当前位置之后的下一个着色区间，中间的普通文本一起跳过
    const hit = tokens.find((t) => t.end > stream.pos)
    if (!hit) {
      stream.skipToEnd()
      return null
    }
    stream.pos = hit.end
    return hit.type
  },
  tokenTable: {
    time: logcatTags.time,
    pid: logcatTags.pid,
    tag: logcatTags.tag,
    stack: logcatTags.stack,
    error: logcatTags.exc,
    ...LOG_LEVEL_TAGS,
  },
})

/** logcat 的扩展不走 languages.ts，避免那两个模块互相引用 */
const langExtension = (id: LangId) => (id === 'logcat' ? logcatLanguage : cmLanguage(id))

/* ---------------- 查找高亮 ---------------- */

interface FindMarks {
  ranges: Array<{ from: number; to: number }>
  active: number
}

const setFindMarks = StateEffect.define<FindMarks>()

/**
 * 匹配底色由这个 StateField 持有：放在编辑器状态里，
 * 滚动时由视口自动裁剪，不必自己算可见区间。
 */
const findMarkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setFindMarks)) continue
      const { ranges, active } = effect.value
      const items = []
      for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i]
        if (r.to <= r.from) continue
        const attrs = { class: i === active ? 'cm-find-active' : 'cm-find-match' }
        items.push(Decoration.mark(attrs).range(r.from, r.to))
      }
      next = Decoration.set(items, true)
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
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
  // logcat：时间戳与 PID 用弱色，级别按严重程度递进
  { tag: [logcatTags.time, logcatTags.pid], color: 'var(--c-dim)' },
  { tag: [logcatTags.verbose], color: 'var(--c-faint)' },
  { tag: [logcatTags.debug], color: 'var(--syn-type)' },
  { tag: [logcatTags.info], color: 'var(--syn-str)' },
  { tag: [logcatTags.warn], color: 'var(--syn-num)' },
  { tag: [logcatTags.error], color: 'var(--c-danger)', fontWeight: '600' },
  { tag: [logcatTags.tag], color: 'var(--syn-key)' },
  { tag: [logcatTags.stack], color: 'var(--c-dim)' },
  { tag: [logcatTags.exc], color: 'var(--c-danger)' },
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
        findMarkField,
        syntaxHighlighting(vellumHighlight),
        // 查找键位压过内建键位，统一交给界面上的查找栏
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-f',
              run: () => {
                this.opts?.onFind?.(false)
                return true
              },
            },
            {
              key: 'Mod-Alt-f',
              run: () => {
                this.opts?.onFind?.(true)
                return true
              },
            },
          ]),
        ),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        vellumTheme,
        this.langComp.of(langExtension(opts.language)),
        // 只读会把 contenteditable 关掉，元素就不可聚焦，Cmd+End / 方向键全部失效；
        // 补一个 tabindex 让只读的大文件也能用键盘翻
        EditorView.contentAttributes.of({ tabindex: '0' }),
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
    this.view?.dispatch({ effects: this.langComp.reconfigure(langExtension(id)) })
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
    this.refreshTheme()
  }

  refreshTheme(): void {
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
    this.opts?.onFind?.(false)
  }

  searchApi(): SearchApi {
    const view = () => this.view
    return {
      getSelection() {
        const sel = view()?.state.selection.main
        return { from: sel?.from ?? 0, to: sel?.to ?? 0 }
      },
      selectRange(from, to) {
        const v = view()
        if (!v) return
        const len = v.state.doc.length
        const a = Math.max(0, Math.min(from, len))
        const b = Math.max(a, Math.min(to, len))
        v.dispatch({
          selection: { anchor: a, head: b },
          effects: EditorView.scrollIntoView(a, { y: 'center' }),
        })
      },
      setSearchMarks(ranges, active) {
        view()?.dispatch({ effects: setFindMarks.of({ ranges, active }) })
      },
      clearSearchMarks() {
        view()?.dispatch({ effects: setFindMarks.of({ ranges: [], active: -1 }) })
      },
      applyEdits(edits) {
        const v = view()
        if (!v || edits.length === 0) return
        // 同一事务里的多处改动，撤销时算一步
        v.dispatch({
          changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
        })
      },
    }
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
