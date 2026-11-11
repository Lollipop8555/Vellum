import type { FileMode } from '../types'

const KB = 1024
const MB = 1024 * KB

/** 体积分档阈值，全部集中在这里，便于按实测调整 */
export const LIMITS = {
  /** 超过此值关闭语法高亮开关、预览、自动换行 */
  light: 2 * MB,
  /** 超过此值进入只读模式 */
  readonly: 20 * MB,
  /** 超过此值导入前弹确认，用户坚持就照常导入（不设硬上限） */
  warn: 50 * MB,
  /** 超过此值禁用格式化（Prettier 会锁死页面） */
  format: 1 * MB,
  /** 超过此值关闭草稿防抖写入 */
  autosave: 10 * MB,
}

export function modeFor(size: number): FileMode {
  if (size > LIMITS.readonly) return 'readonly'
  if (size > LIMITS.light) return 'light'
  return 'full'
}

export function formatBytes(n: number): string {
  if (n < KB) return `${n} B`
  if (n < MB) return `${(n / KB).toFixed(1)} KB`
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`
  return `${(n / (1024 * MB)).toFixed(2)} GB`
}
