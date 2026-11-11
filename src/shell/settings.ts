import { DEFAULT_SETTINGS, type Settings } from '../types'

const KEY = 'vellum.settings'

let current: Settings = { ...DEFAULT_SETTINGS }

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) current = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    current = { ...DEFAULT_SETTINGS }
  }
  return current
}

export function getSettings(): Settings {
  return current
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch }
  localStorage.setItem(KEY, JSON.stringify(current))
  return current
}
