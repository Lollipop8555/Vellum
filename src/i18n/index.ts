import { zh } from './zh'
import { en } from './en'

export type Lang = 'zh' | 'en'
export type MessageKey = keyof typeof zh

const dicts: Record<Lang, Record<MessageKey, string>> = { zh, en }

let current: Lang = 'en'
const listeners = new Set<(lang: Lang) => void>()

const STORAGE_KEY = 'vellum.lang'

export function detectLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'zh' || saved === 'en') return saved
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language]
  return langs.some((l) => l.toLowerCase().startsWith('zh')) ? 'zh' : 'en'
}

export function getLang(): Lang {
  return current
}

export function setLang(lang: Lang) {
  current = lang
  localStorage.setItem(STORAGE_KEY, lang)
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  applyStaticText()
  listeners.forEach((fn) => fn(lang))
  window.dispatchEvent(new Event('vellum:lang'))
}

export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function initLang() {
  current = detectLang()
  document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en'
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const raw = dicts[current][key] ?? dicts.en[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}

/** 把 data-i18n / data-i18n-placeholder / data-i18n-title 的静态文案应用一遍 */
export function applyStaticText(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as MessageKey
    if (key) el.textContent = t(key)
  })
  root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => {
    const key = el.dataset.i18nPlaceholder as MessageKey
    if (key) el.setAttribute('placeholder', t(key))
  })
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const key = el.dataset.i18nTitle as MessageKey
    if (key) el.setAttribute('title', t(key))
  })
}

/** 生成一个带 data-i18n 的元素（供动态构建的 UI 使用） */
export function i18nEl(tag: string, key: MessageKey, cls?: string): HTMLElement {
  const el = document.createElement(tag)
  el.dataset.i18n = key
  el.textContent = t(key)
  if (cls) el.className = cls
  return el
}
