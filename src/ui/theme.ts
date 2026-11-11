import { getSettings } from '../shell/settings'
import type { Settings } from '../types'

/** 读取 CSS 变量，保证 Monaco 主题与 CSS 主题同源，不出现第二份色值 */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function applyTheme(theme?: Settings['theme']) {
  const s = getSettings()
  const target = theme ?? s.theme
  document.documentElement.dataset.theme = target
  document.documentElement.dataset.accent = s.accentOn ? 'on' : 'off'
  document.documentElement.style.setProperty('--editor-font-size', `${s.fontSize}px`)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', target === 'dark' ? '#131315' : '#e8e8eb')
}
