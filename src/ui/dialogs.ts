import { t } from '../i18n'
import { computeDiff } from '../shell/diff'
import {
  b64decode,
  b64encode,
  convertTimestamp,
  decodeJwt,
  urlDecode,
  urlEncode,
} from '../shell/tools'
import type { TransformId } from '../shell/transform'
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
  onClose?: () => void
}): DialogHandle {
  const host = layer()
  host.hidden = false
  host.innerHTML = ''

  const dialog = document.createElement('div')
  dialog.className = `dialog${opts.narrow ? ' narrow' : ''}`

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

export function helpDialog() {
  const rows: [string, string][] = [
    ['Ctrl/Cmd + S', t('help.save')],
    ['Ctrl/Cmd + O', t('help.import')],
    ['Ctrl/Cmd + B', t('help.drawer')],
    ['Ctrl/Cmd + P', t('help.quick')],
    ['Shift + Alt + E', t('help.engine')],
    ['Shift + Alt + F', t('help.format')],
    ['Ctrl/Cmd + F', t('help.find')],
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

  const row = document.createElement('div')
  row.className = 'toolbar-row'

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

  wrap.append(row, input, output)
  openDialog({ title: t('dialog.tools'), body: wrap })
}

export function diffDialog(baselineLabel: string, baseline: string, current: string) {
  const wrap = document.createElement('div')
  const { rows, added, removed } = computeDiff(baseline, current)

  const stat = document.createElement('div')
  stat.className = 'diff-stat'
  stat.textContent =
    added === 0 && removed === 0
      ? t('diff.identical')
      : `${t('diff.other', { name: baselineLabel })} · ${t('diff.added', { n: added })} · ${t('diff.removed', { n: removed })}`

  const box = document.createElement('div')
  box.className = 'diff'
  const frag = document.createDocumentFragment()
  for (const row of rows) {
    const line = document.createElement('div')
    line.className = `diff-line${row.kind === 'add' ? ' add' : row.kind === 'del' ? ' del' : ''}`
    const a = document.createElement('span')
    a.textContent = row.oldNo === null ? '' : String(row.oldNo)
    const b = document.createElement('span')
    b.textContent = row.newNo === null ? '' : String(row.newNo)
    const c = document.createElement('span')
    c.textContent = row.text
    line.append(a, b, c)
    frag.appendChild(line)
  }
  box.appendChild(frag)
  wrap.append(stat, box)

  openDialog({ title: t('dialog.diff'), body: wrap })
}
