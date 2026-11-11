import { t } from '../i18n'
import type { EditorAdapter } from '../editors/adapter'
import {
  MAX_MATCHES,
  expandReplacement,
  findMatches,
  indexAtOrAfter,
  nextIndex,
  type SearchMatch,
  type SearchOptions,
} from '../shell/search'

export interface FindBarDeps {
  getAdapter(): EditorAdapter | null
  getText(): string
  /** 只读文件、大文件模式都不允许改写内容 */
  canReplace(): boolean
}

export interface FindBar {
  open(opts?: { replace?: boolean }): void
  close(): void
  isOpen(): boolean
  /** 文档内容或引擎切换后重新匹配；keepOffset 用于替换后落到下一个匹配 */
  refresh(keepOffset?: number): void
  /** 界面语言变化后重刷动态文案 */
  relabel(): void
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export function createFindBar(deps: FindBarDeps): FindBar {
  const bar = el('findBar')
  const query = el<HTMLInputElement>('findInput')
  const replaceRow = el('findReplaceRow')
  const replacement = el<HTMLInputElement>('replaceInput')
  const count = el('findCount')
  const caseBtn = el<HTMLButtonElement>('findCase')
  const wordBtn = el<HTMLButtonElement>('findWord')
  const regexBtn = el<HTMLButtonElement>('findRegex')
  const replaceToggle = el<HTMLButtonElement>('findReplaceToggle')
  const replaceOne = el<HTMLButtonElement>('findReplaceOne')
  const replaceAll = el<HTMLButtonElement>('findReplaceAll')

  // 选项在多次开关面板之间保持，跟主流编辑器一致
  const opts: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false }
  let matches: SearchMatch[] = []
  let active = -1
  let truncated = false
  let invalid: string | null = null
  let pendingKeep: number | null = null
  let lastText = ''
  let timer = 0
  let open = false

  const ranges = () => matches.map((m) => ({ from: m.from, to: m.to }))

  const updateOptions = () => {
    caseBtn.classList.toggle('is-on', opts.caseSensitive)
    caseBtn.setAttribute('aria-pressed', String(opts.caseSensitive))
    wordBtn.classList.toggle('is-on', opts.wholeWord)
    wordBtn.setAttribute('aria-pressed', String(opts.wholeWord))
    regexBtn.classList.toggle('is-on', opts.regex)
    regexBtn.setAttribute('aria-pressed', String(opts.regex))
  }

  const updateCount = () => {
    if (invalid) {
      count.textContent = '—'
      count.classList.add('is-error')
      query.title = invalid
      query.classList.add('is-invalid')
    } else {
      count.textContent = matches.length
        ? `${active + 1} / ${matches.length}${truncated ? '+' : ''}`
        : '0 / 0'
      count.classList.remove('is-error')
      query.title = truncated ? t('find.truncated', { n: MAX_MATCHES }) : ''
      query.classList.remove('is-invalid')
    }

    const canEdit = deps.canReplace() && matches.length > 0
    replaceOne.disabled = !canEdit || active < 0
    replaceAll.disabled = !canEdit
    replaceToggle.title = t('find.toggleReplace')
    if (!deps.canReplace()) {
      const why = t('find.readonly')
      replaceOne.title = why
      replaceAll.title = why
    } else {
      replaceOne.title = ''
      replaceAll.title = ''
    }
  }

  const paint = () => {
    const adapter = deps.getAdapter()
    updateCount()
    if (!adapter) return
    if (!matches.length) {
      adapter.searchApi().clearSearchMarks()
      return
    }
    adapter.searchApi().setSearchMarks(ranges(), active)
    const m = matches[active]
    if (m) adapter.searchApi().selectRange(m.from, m.to)
  }

  const runSearch = () => {
    const text = deps.getText()
    lastText = text
    const result = findMatches(text, query.value, opts)
    matches = result.matches
    truncated = result.truncated
    invalid = result.error

    if (pendingKeep !== null) {
      active = indexAtOrAfter(matches, pendingKeep)
      pendingKeep = null
    } else {
      active = matches.length ? 0 : -1
    }
    paint()
  }

  const schedule = (delay = 80) => {
    window.clearTimeout(timer)
    timer = window.setTimeout(runSearch, delay)
  }

  const jump = (forward: boolean) => {
    if (!matches.length) return
    active = nextIndex(active, matches.length, forward)
    paint()
    // 焦点留在输入框，方便继续敲查询
    query.focus()
  }

  /** debounce 期间文档可能已经变了，替换前先对齐一次，避免按旧偏移量改写 */
  const syncIfStale = () => {
    if (deps.getText() !== lastText) runSearch()
  }

  const doReplace = () => {
    const adapter = deps.getAdapter()
    if (!adapter || !deps.canReplace()) return
    syncIfStale()
    if (active < 0) return
    const match = matches[active]
    if (!match) return

    const insert = expandReplacement(replacement.value, deps.getText(), match, opts.regex)
    adapter.searchApi().applyEdits([{ from: match.from, to: match.to, insert }])
    // 引擎的 onChange 会回来刷新，这里给一个落点：替换后从插入内容末尾继续找
    pendingKeep = match.from + insert.length
    schedule(30)
  }

  const doReplaceAll = () => {
    const adapter = deps.getAdapter()
    if (!adapter || !deps.canReplace()) return
    syncIfStale()
    if (!matches.length) return
    const text = deps.getText()
    adapter.searchApi().applyEdits(
      matches.map((m) => ({
        from: m.from,
        to: m.to,
        insert: expandReplacement(replacement.value, text, m, opts.regex),
      })),
    )
    pendingKeep = null
    active = -1
    schedule(30)
  }

  const setReplaceVisible = (visible: boolean) => {
    replaceRow.hidden = !visible
    replaceToggle.classList.toggle('is-on', visible)
    replaceToggle.setAttribute('aria-pressed', String(visible))
  }

  const openBar: FindBar['open'] = (o) => {
    if (!deps.getAdapter()) return
    open = true
    bar.hidden = false
    if (o?.replace) setReplaceVisible(true)

    // 有选区时用选中的文本预填，和浏览器 / 编辑器的习惯一致
    const adapter = deps.getAdapter()
    const sel = adapter?.searchApi().getSelection()
    if (sel && sel.to > sel.from) {
      const picked = deps.getText().slice(sel.from, sel.to)
      if (picked && picked.length <= 200 && !picked.includes('\n')) query.value = picked
    }

    query.focus()
    query.select()
    runSearch()
  }

  const close = () => {
    if (!open) return
    open = false
    bar.hidden = true
    window.clearTimeout(timer)
    pendingKeep = null
    deps.getAdapter()?.searchApi().clearSearchMarks()
    deps.getAdapter()?.focus()
  }

  query.addEventListener('input', () => {
    pendingKeep = null
    schedule(90)
  })
  query.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      jump(!e.shiftKey)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  })
  replacement.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      doReplace()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  })

  el('findPrev').addEventListener('click', () => jump(false))
  el('findNext').addEventListener('click', () => jump(true))
  el('findClose').addEventListener('click', close)

  const toggle = (key: keyof SearchOptions, btn: HTMLButtonElement) => {
    btn.addEventListener('click', () => {
      opts[key] = !opts[key]
      updateOptions()
      runSearch()
      query.focus()
    })
  }
  toggle('caseSensitive', caseBtn)
  toggle('wholeWord', wordBtn)
  toggle('regex', regexBtn)

  replaceToggle.addEventListener('click', () => {
    setReplaceVisible(replaceRow.hidden)
    query.focus()
  })
  replaceOne.addEventListener('click', doReplace)
  replaceAll.addEventListener('click', doReplaceAll)

  updateOptions()
  setReplaceVisible(false)

  return {
    open: openBar,
    close,
    isOpen: () => open,
    refresh(keepOffset) {
      if (!open) return
      if (keepOffset !== undefined) pendingKeep = keepOffset
      schedule()
    },
    relabel() {
      updateCount()
    },
  }
}
