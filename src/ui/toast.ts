let host: HTMLElement | null = null

function container(): HTMLElement {
  if (!host) host = document.getElementById('toasts') ?? document.body
  return host
}

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 2600) {
  const el = document.createElement('div')
  el.className = `toast${kind === 'error' ? ' is-error' : ''}`
  el.textContent = message
  container().appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = 'opacity .2s'
    setTimeout(() => el.remove(), 220)
  }, ms)
}
