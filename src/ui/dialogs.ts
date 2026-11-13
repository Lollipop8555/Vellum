import { t } from '../i18n'
import { computeDiff } from '../shell/diff'
import { formatBytes } from '../shell/largefile'
import {
  b64decode,
  b64encode,
  convertTimestamp,
  decodeJwt,
  urlDecode,
  urlEncode,
} from '../shell/tools'
import type { TransformId } from '../shell/transform'
import { UrlImportError, fetchUrlAsFile } from '../shell/url-import'
import { TRANSFORM_KEYS } from './labels'

const layer = () => document.getElementById('dialogLayer') as HTMLElement

export interface DialogHandle {
  close(): void
  root: HTMLElement
}

export function openDialog(opts: {
  title: string
  body: HTMLElement
  foot?: HTMLElement
  narrow?: boolean
  /** 需要左右分栏的弹窗（对比）用宽版 */
  wide?: boolean
  onClose?: () => void
}): DialogHandle {
  const host = layer()
  host.hidden = false
  host.innerHTML = ''

  const dialog = document.createElement('div')
  dialog.className = `dialog${opts.narrow ? ' narrow' : ''}${opts.wide ? ' wide' : ''}`

  const head = document.createElement('div')
  head.className = 'dialog-head'
  head.textContent = opts.title

  const closeBtn = document.createElement('button')
  closeBtn.className = 'btn btn-ghost icon-only'
  closeBtn.textContent = '×'
  const spacer = document.createElement('div')
  spacer.className = 'spacer'
  head.append(spacer, closeBtn)

  const body = document.createElement('div')
  body.className = 'dialog-body'
  body.appendChild(opts.body)

  dialog.append(head, body)

  if (opts.foot) {
    const foot = document.createElement('div')
    foot.className = 'dialog-foot'
    foot.appendChild(opts.foot)
    dialog.appendChild(foot)
  }

  host.appendChild(dialog)

  const close = () => {
    host.hidden = true
    host.innerHTML = ''
    document.removeEventListener('keydown', onKey)
    opts.onClose?.()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  document.addEventListener('keydown', onKey)
  closeBtn.onclick = close
  host.onclick = (e) => {
    if (e.target === host) close()
  }

  return { close, root: dialog }
}

export function confirmDialog(
  title: string,
  message: string,
  check?: { label: string; checked: boolean },
): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    const body = document.createElement('div')
    body.textContent = message

    let box: HTMLInputElement | null = null
    if (check) {
      const line = document.createElement('label')
      line.className = 'checkline'
      line.style.marginTop = '14px'
      box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = check.checked
      line.append(box, document.createTextNode(check.label))
      body.appendChild(line)
    }

    const foot = document.createElement('div')
    const cancel = document.createElement('button')
    cancel.className = 'btn btn-ghost'
    cancel.textContent = t('action.cancel')
    const ok = document.createElement('button')
    ok.className = 'btn btn-primary'
    ok.textContent = t('action.confirm')
    foot.append(cancel, ok)

    const dlg = openDialog({ title, body, foot, narrow: true })
    cancel.onclick = () => {
      dlg.close()
      resolve({ ok: false, checked: box?.checked ?? false })
    }
    ok.onclick = () => {
      const checked = box?.checked ?? false
      dlg.close()
      resolve({ ok: true, checked })
    }
  })
}

/**
 * 居中取名对话框：新建文件 / 文件夹这类「关掉就该有结果」的场景用。
 * 开着 `submitOnDismiss` 时，点遮罩空白与 Esc 都等于确认——没有「窗口关了却什么也没发生」
 * 的中间态。校验不过时回车留在窗口里说明原因；空白/Esc 这种「想走」的操作则直接放弃，
 * 免得把人锁在窗口里出不去。
 */
export function promptDialog(opts: {
  title: string
  value?: string
  hint?: string
  placeholder?: string
  submitOnDismiss?: boolean
  validate?: (raw: string) => string | null
}): Promise<string | null> {
  return new Promise((resolve) => {
    const body = document.createElement('div')

    if (opts.hint) {
      const hint = document.createElement('div')
      hint.className = 'dialog-hint'
      hint.textContent = opts.hint
      body.appendChild(hint)
    }

    const input = document.createElement('input')
    input.className = 'dialog-input'
    input.type = 'text'
    input.value = opts.value ?? ''
    input.spellcheck = false
    input.autocomplete = 'off'
    if (opts.placeholder) input.placeholder = opts.placeholder

    const err = document.createElement('div')
    err.className = 'dialog-err'
    err.hidden = true

    body.append(input, err)

    const foot = document.createElement('div')
    const cancel = document.createElement('button')
    cancel.className = 'btn btn-ghost'
    cancel.textContent = t('action.cancel')
    const ok = document.createElement('button')
    ok.className = 'btn btn-primary'
    ok.textContent = t('action.confirm')
    foot.append(cancel, ok)

    let settled = false
    let dialog: DialogHandle

    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      dialog.close()
      resolve(value)
    }

    const submit = (fromDismiss = false) => {
      const raw = input.value.trim()
      const message = opts.validate?.(raw) ?? null
      if (message) {
        if (fromDismiss) {
          finish(null)
          return
        }
        err.textContent = message
        err.hidden = false
        input.focus()
        return
      }
      finish(raw)
    }

    const onKey = (e: KeyboardEvent) => {
      // 输入法回车是在上屏候选词，不能当成确认
      if (e.isComposing) return
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        submit()
        return
      }
      if (e.key === 'Escape' && opts.submitOnDismiss) {
        e.stopPropagation()
        submit(true)
      }
    }
    document.addEventListener('keydown', onKey, true)

    dialog = openDialog({
      title: opts.title,
      body,
      foot,
      narrow: true,
      onClose: () => {
        if (settled) return
        settled = true
        document.removeEventListener('keydown', onKey, true)
        resolve(null)
      },
    })

    cancel.onclick = () => finish(null)
    ok.onclick = () => submit()
    // 点遮罩空白：要「关掉即确认」就改成提交，否则沿用 openDialog 默认的取消
    if (opts.submitOnDismiss) {
      layer().onclick = (e) => {
        if (e.target === layer()) submit(true)
      }
    }

    // 默认选中主名（不含后缀）：直接打字就能替换掉「未命名-1」，不用先删
    const dot = input.value.lastIndexOf('.')
    input.focus()
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
  })
}

/* ------------------------------------------------------------ 新建菜单 */

// 静态图形，和抽屉头、文件树里用的是同一套描边风格
const FILE_ICON =
  '<svg viewBox="0 0 20 20" aria-hidden="true">' +
  '<path d="M7.6 2.6H3.8a1.1 1.1 0 0 0-1.1 1.1v9.8a1.1 1.1 0 0 0 1.1 1.1h6.8V5.6z" fill="none" ' +
  'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
  '<path d="M7.6 2.6v3h3" fill="none" stroke="currentColor" stroke-width="1.2" ' +
  'stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M14.9 13.2v4M12.9 15.2h4" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round"/></svg>'

const FOLDER_ICON =
  '<svg viewBox="0 0 20 20" aria-hidden="true">' +
  '<path d="M2.4 6.4h3.8l1.2 1.5h3.2v4.2a1.1 1.1 0 0 1-1.1 1.1H3.5a1.1 1.1 0 0 1-1.1-1.1z" ' +
  'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
  '<path d="M14.9 13.2v4M12.9 15.2h4" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round"/></svg>'

const CLIPBOARD_ICON =
  '<svg viewBox="0 0 20 20" aria-hidden="true">' +
  '<path d="M4.4 5.6h11.2v9.7a1.1 1.1 0 0 1-1.1 1.1H5.5a1.1 1.1 0 0 1-1.1-1.1z" fill="none" ' +
  'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
  '<path d="M7.8 3.6h4.4v2.1H7.8z" fill="none" stroke="currentColor" stroke-width="1.3" ' +
  'stroke-linejoin="round"/>' +
  '<path d="M7.2 9.4h5.6M7.2 12.2h3.8" fill="none" stroke="currentColor" stroke-width="1.2" ' +
  'stroke-linecap="round"/></svg>'

const LINK_ICON =
  '<svg viewBox="0 0 20 20" aria-hidden="true">' +
  '<path d="M8.6 11.4a2.9 2.9 0 0 0 4.1 0l2.1-2.1a2.9 2.9 0 0 0-4.1-4.1l-.9.9" fill="none" ' +
  'stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
  '<path d="M11.4 8.6a2.9 2.9 0 0 0-4.1 0l-2.1 2.1a2.9 2.9 0 0 0 4.1 4.1l.9-.9" fill="none" ' +
  'stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

/** 同一时刻只允许一个 + 菜单，再点同一个按钮视为收起 */
let popMenu: { anchor: HTMLElement; root: HTMLElement; close(): void } | null = null

export function closeNewItemMenu() {
  popMenu?.close()
}

/**
 * 抽屉标题栏的 + 菜单：挂在按钮下沿的浮层（右键菜单那样），而不是居中对话框。
 * 都是「再来一步」的动作，居中弹窗要先跨过半个屏幕才能选，反而更远。
 */
export function newItemMenuDialog(
  anchor: HTMLElement,
  actions: { file(): void; folder(): void; paste(): void; url(): void },
) {
  if (popMenu?.anchor === anchor) {
    popMenu.close()
    return
  }
  closeNewItemMenu()

  const root = document.createElement('div')
  root.className = 'popmenu'
  root.setAttribute('role', 'menu')
  // 先量尺寸再定位，避免从左上角滑到位的闪烁
  root.style.visibility = 'hidden'

  const buttons: HTMLButtonElement[] = []
  const add = (label: string, icon: string, run: () => void) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'menu-item'
    btn.setAttribute('role', 'menuitem')

    const box = document.createElement('span')
    box.className = 'menu-ico'
    box.innerHTML = icon

    const text = document.createElement('span')
    text.textContent = label

    btn.append(box, text)
    btn.onclick = () => {
      close()
      run()
    }
    buttons.push(btn)
    root.appendChild(btn)
  }

  add(t('action.newFile'), FILE_ICON, actions.file)
  add(t('action.newFolder'), FOLDER_ICON, actions.folder)
  add(t('action.clipboardImport'), CLIPBOARD_ICON, actions.paste)
  add(t('action.urlImport'), LINK_ICON, actions.url)

  const focusAt = (index: number) => {
    const n = buttons.length
    buttons[((index % n) + n) % n]?.focus()
  }

  const close = () => {
    if (popMenu?.root !== root) return
    popMenu = null
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', close)
    window.removeEventListener('scroll', close, true)
    root.remove()
    anchor.setAttribute('aria-expanded', 'false')
  }

  // 点空白、点别处、切视图都要收：用捕获阶段先于按钮自己的 click
  const onDown = (e: MouseEvent) => {
    const target = e.target as Node | null
    if (target && (root.contains(target) || anchor.contains(target))) return
    close()
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      anchor.focus()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      focusAt(current + (e.key === 'ArrowDown' ? 1 : -1))
      return
    }
    // Tab 会把焦点带出菜单，菜单却还挂着，索性收起
    if (e.key === 'Tab') close()
  }

  const place = () => {
    const rect = anchor.getBoundingClientRect()
    const width = root.offsetWidth
    const height = root.offsetHeight
    // 右对齐按钮：菜单左边缘往左长，不会顶出面板
    const left = Math.min(
      Math.max(8, rect.right - width),
      Math.max(8, window.innerWidth - width - 8),
    )
    const below = rect.bottom + 4
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below
    root.style.left = `${Math.round(left)}px`
    root.style.top = `${Math.round(top)}px`
  }

  document.body.appendChild(root)
  place()
  root.style.visibility = ''

  popMenu = { anchor, root, close }
  anchor.setAttribute('aria-expanded', 'true')
  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', close)
  window.addEventListener('scroll', close, true)
  // 键盘用户直接回车就能选第一项
  buttons[0]?.focus()
}

/* --------------------------------------------------------- 粘贴文本导入 */

/**
 * 粘贴文本 → 返回文本，落库交给调用方。
 *
 * 不在打开时去读剪贴板：Chrome 会为 `readText()` 弹一个「粘贴」授权气泡，
 * 非安全上下文还会直接失败，用户看到的是一个莫名的小浮层而不是对话框。
 * 这里把光标放进输入框，用户自己 Ctrl/⌘+V —— 少一步弹窗，粘贴也走浏览器原生的那次事件。
 */
export function pasteImportDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    const body = document.createElement('div')

    const hint = document.createElement('div')
    hint.className = 'dialog-hint'
    hint.textContent = t('dialog.pasteHint')

    const area = document.createElement('textarea')
    area.className = 'dialog-textarea'
    area.spellcheck = false
    area.placeholder = t('dialog.pastePlaceholder')

    const err = document.createElement('div')
    err.className = 'dialog-err'
    err.hidden = true

    body.append(hint, area, err)

    const foot = document.createElement('div')
    const cancel = document.createElement('button')
    cancel.className = 'btn btn-ghost'
    cancel.textContent = t('action.cancel')
    const ok = document.createElement('button')
    ok.className = 'btn btn-primary'
    ok.textContent = t('action.doImport')
    foot.append(cancel, ok)

    let settled = false
    let dlg: DialogHandle

    const teardown = () => document.removeEventListener('keydown', onKey, true)

    const finish = (text: string | null) => {
      if (settled) return
      settled = true
      teardown()
      dlg.close()
      resolve(text)
    }

    const submit = () => {
      const text = area.value
      if (!text.trim()) {
        err.textContent = t('err.pasteEmpty')
        err.hidden = false
        area.focus()
        return
      }
      finish(text)
    }

    // 多行输入：回车是换行，Ctrl/⌘+Enter 才是导入
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      e.stopPropagation()
      submit()
    }
    document.addEventListener('keydown', onKey, true)

    ok.onclick = submit
    cancel.onclick = () => finish(null)

    dlg = openDialog({
      title: t('dialog.pasteImport'),
      body,
      foot,
      narrow: true,
      onClose: () => finish(null),
    })
    area.focus()
  })
}

/* --------------------------------------------------------- URL 导入 */

function urlErrorText(err: unknown): string {
  if (err instanceof UrlImportError) {
    if (err.reason === 'url') return t('err.urlInvalid')
    if (err.reason === 'scheme') return t('err.urlScheme')
    if (err.reason === 'status') return t('err.urlStatus', { status: err.status })
    if (err.reason === 'timeout') return t('err.urlTimeout')
    if (err.reason === 'empty') return t('err.urlEmpty')
    return t('err.urlNetwork')
  }
  return t('toast.readFailed', { msg: (err as Error).message })
}

/**
 * 输入地址 → 下载 → 返回 File，交给调用方走现有的 ingestFile。
 * 失败就留在窗口里说明原因：跨域、404、超时都能重试，不用从头再点一遍。
 */
export function urlImportDialog(): Promise<File | null> {
  return new Promise((resolve) => {
    const body = document.createElement('div')

    const hint = document.createElement('div')
    hint.className = 'dialog-hint'
    hint.textContent = t('dialog.urlHint')

    const input = document.createElement('input')
    input.className = 'dialog-input'
    input.type = 'url'
    input.spellcheck = false
    input.autocomplete = 'off'
    input.placeholder = t('dialog.urlPlaceholder')

    const err = document.createElement('div')
    err.className = 'dialog-err'
    err.hidden = true

    const progress = document.createElement('div')
    progress.className = 'url-progress'
    progress.hidden = true
    const spin = document.createElement('span')
    spin.className = 'spinner'
    const progressText = document.createElement('span')
    progress.append(spin, progressText)

    body.append(hint, input, err, progress)

    const foot = document.createElement('div')
    const cancel = document.createElement('button')
    cancel.className = 'btn btn-ghost'
    cancel.textContent = t('action.cancel')
    const ok = document.createElement('button')
    ok.className = 'btn btn-primary'
    ok.textContent = t('action.doImport')
    foot.append(cancel, ok)

    let settled = false
    let busy = false
    let ctrl: AbortController | null = null
    let dlg: DialogHandle

    const teardown = () => document.removeEventListener('keydown', onKey, true)

    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      ctrl?.abort()
      teardown()
      dlg.close()
      resolve(file)
    }

    const showErr = (message: string) => {
      err.textContent = message
      err.hidden = false
    }

    const submit = () => {
      if (busy) return
      const raw = input.value.trim()
      if (!raw) {
        showErr(t('err.urlRequired'))
        input.focus()
        return
      }

      err.hidden = true
      busy = true
      ctrl = new AbortController()
      ok.disabled = true
      // readOnly 而不是 disabled：地址保持可见，才知道在下载哪一个
      input.readOnly = true
      progress.hidden = false
      progressText.textContent = t('url.fetching')

      void fetchUrlAsFile(raw, ctrl.signal, ({ received, total }) => {
        if (settled) return
        progressText.textContent = total
          ? t('url.fetchingSize', { done: formatBytes(received), total: formatBytes(total) })
          : t('url.fetching')
      })
        .then((file) => finish(file))
        .catch((e: unknown) => {
          // 关闭对话框导致的 abort 不算错误
          if (settled || (e as Error).name === 'AbortError') return
          busy = false
          ctrl = null
          ok.disabled = false
          input.readOnly = false
          progress.hidden = true
          showErr(urlErrorText(e))
          input.focus()
        })
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      if (e.key !== 'Enter') return
      // 焦点在按钮上时交给按钮自己（取消键要能取消），其余位置回车即导入
      if (e.target instanceof HTMLButtonElement) return
      e.preventDefault()
      e.stopPropagation()
      submit()
    }
    document.addEventListener('keydown', onKey, true)

    dlg = openDialog({
      title: t('dialog.urlImport'),
      body,
      foot,
      narrow: true,
      onClose: () => {
        if (settled) return
        settled = true
        ctrl?.abort()
        teardown()
        resolve(null)
      },
    })

    cancel.onclick = () => finish(null)
    ok.onclick = submit
    input.focus()
  })
}

export function helpDialog() {
  const rows: [string, string][] = [
    ['Ctrl/Cmd + S', t('help.save')],
    ['Ctrl/Cmd + O', t('help.import')],
    ['Ctrl/Cmd + B', t('help.drawer')],
    ['Ctrl/Cmd + P', t('help.quick')],
    ['Shift + Alt + E', t('help.engine')],
    ['Shift + Alt + F', t('help.format')],
    ['Ctrl/Cmd + F', t('help.find')],
    ['Ctrl/Cmd + Alt + F', t('help.replace')],
    ['?', t('help.help')],
  ]
  const grid = document.createElement('div')
  grid.className = 'keys'
  rows.forEach(([k, label]) => {
    const kbd = document.createElement('kbd')
    kbd.textContent = k
    const span = document.createElement('span')
    span.textContent = label
    grid.append(kbd, span)
  })
  openDialog({ title: t('dialog.help'), body: grid, narrow: true })
}

export function transformsDialog(onPick: (id: TransformId) => void) {
  const wrap = document.createElement('div')
  wrap.className = 'toolbar-row'
  ;(Object.keys(TRANSFORM_KEYS) as TransformId[]).forEach((id) => {
    const btn = document.createElement('button')
    btn.className = 'btn'
    btn.textContent = t(TRANSFORM_KEYS[id])
    btn.onclick = () => {
      close()
      onPick(id)
    }
    wrap.appendChild(btn)
  })
  const dlg = openDialog({ title: t('dialog.transforms'), body: wrap, narrow: true })
  const close = () => dlg.close()
}

export function toolsDialog() {
  const wrap = document.createElement('div')

  const input = document.createElement('textarea')
  input.className = 'raw'
  input.placeholder = t('tools.input')

  const output = document.createElement('textarea')
  output.className = 'raw'
  output.placeholder = t('tools.output')
  output.readOnly = true

  // 一排动作按钮夹在输入与输出之间：它们是对输入的一次性操作，不是模式选择
  const row = document.createElement('div')
  row.className = 'toolbar-row tools-actions'

  const add = (label: string, fn: (v: string) => string) => {
    const b = document.createElement('button')
    b.className = 'btn'
    b.textContent = label
    b.onclick = () => {
      try {
        output.value = fn(input.value)
      } catch (err) {
        output.value = `Error: ${(err as Error).message}`
      }
    }
    row.appendChild(b)
  }

  add(`${t('tools.base64')} ${t('tools.encode')}`, b64encode)
  add(`${t('tools.base64')} ${t('tools.decode')}`, b64decode)
  add(`${t('tools.url')} ${t('tools.encode')}`, urlEncode)
  add(`${t('tools.url')} ${t('tools.decode')}`, urlDecode)
  add(t('tools.jwt'), (v) => JSON.stringify(decodeJwt(v), null, 2))
  add(t('tools.timestamp'), (v) => {
    const r = convertTimestamp(v)
    return r.ms === undefined ? '' : `${r.ms}\n${r.date}`
  })

  wrap.append(input, row, output)
  openDialog({ title: t('dialog.tools'), body: wrap })
}

/** 一次铺进 DOM 的差异行上限，超过就只留改动附近的内容 */
const MAX_DIFF_ROWS = 4000

/** 几万行 context 铺进 DOM 会直接卡死，超大差异只保留改动 ±2 行 */
function trimRows(rows: ReturnType<typeof computeDiff>['rows']) {
  if (rows.length <= MAX_DIFF_ROWS) return { rows, trimmed: false }
  const keep = new Set<number>()
  rows.forEach((row, i) => {
    if (row.kind === 'context') return
    for (let k = Math.max(0, i - 2); k <= Math.min(rows.length - 1, i + 2); k++) keep.add(k)
  })
  const picked = [...keep].sort((a, b) => a - b).map((i) => rows[i])
  return { rows: picked.slice(0, MAX_DIFF_ROWS), trimmed: true }
}

function noCell(text: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'diff-no'
  span.textContent = text
  return span
}

function textCell(text: string, showFull: boolean): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'diff-text'
  span.textContent = text
  // 长行被省略号吃掉时，至少悬停能看到全文
  if (showFull && text.length > 90) span.title = text
  return span
}

/** 左右分栏：每一行同时给出基准侧与当前侧，删行左边有字、右边空，增行反过来 */
export function diffDialog(baselineLabel: string, baseline: string, current: string) {
  const wrap = document.createElement('div')
  const { rows, added, removed } = computeDiff(baseline, current)

  const stat = document.createElement('div')
  stat.className = 'diff-stat'
  stat.textContent =
    added === 0 && removed === 0
      ? t('diff.identical')
      : `${t('diff.other', { name: baselineLabel })} · ${t('diff.added', { n: added })} · ${t('diff.removed', { n: removed })}`

  // 内容完全一致就不铺任何行，省得给几十 MB 的文件白建节点
  if (added === 0 && removed === 0) {
    wrap.append(stat)
    openDialog({ title: t('dialog.diff'), body: wrap, wide: true })
    return
  }

  const { rows: shown, trimmed } = trimRows(rows)

  const box = document.createElement('div')
  box.className = 'diff diff-split'

  const head = document.createElement('div')
  head.className = 'diff-head'
  const left = document.createElement('span')
  left.className = 'diff-head-cell is-left'
  left.textContent = `${t('diff.baseline')} · ${baselineLabel}`
  const right = document.createElement('span')
  right.className = 'diff-head-cell is-right'
  right.textContent = t('diff.current')
  head.append(left, right)
  box.appendChild(head)

  const frag = document.createDocumentFragment()
  for (const row of shown) {
    const isAdd = row.kind === 'add'
    const isDel = row.kind === 'del'
    const line = document.createElement('div')
    line.className = `diff-row${isAdd ? ' add' : isDel ? ' del' : ''}`

    // 增行只存在于当前侧，删行只存在于基准侧，另一侧留空
    line.append(
      noCell(isAdd || row.oldNo === null ? '' : String(row.oldNo)),
      textCell(isAdd ? '' : row.text, !isAdd),
      noCell(isDel || row.newNo === null ? '' : String(row.newNo)),
      textCell(isDel ? '' : row.text, !isDel),
    )
    frag.appendChild(line)
  }
  box.appendChild(frag)
  wrap.append(stat, box)

  if (trimmed) {
    const note = document.createElement('div')
    note.className = 'diff-note'
    note.textContent = t('diff.trimmed')
    wrap.append(note)
  }

  openDialog({ title: t('dialog.diff'), body: wrap, wide: true })
}
