import { t } from '../i18n'
import { wordCount } from '../shell/transform'
import { formatBytes } from '../shell/largefile'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

export function setCursor(line: number, col: number) {
  $('stCursor').textContent = t('status.line', { line, col })
}

export function setCount(text: string) {
  const lines = text === '' ? 0 : text.split('\n').length
  $('stCount').textContent = t('status.count', {
    lines,
    chars: text.length,
    words: wordCount(text),
  })
}

export function setCache(used: number, quota: number) {
  $('stCache').textContent = t('drawer.foot', {
    used: formatBytes(used),
    quota: quota ? formatBytes(quota) : '—',
  })
}

export function setEncoding(label: string) {
  $('stEncoding').textContent = label
}

export function setEol(eol: 'lf' | 'crlf') {
  $('stEol').textContent = eol === 'crlf' ? 'CRLF' : 'LF'
}

export function setEngineLabel(label: string) {
  $('stEngine').textContent = label
}

export function setReadonly(v: boolean) {
  $('stReadonly').hidden = !v
}
