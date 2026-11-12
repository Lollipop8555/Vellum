import type { EngineId } from '../types'

/**
 * 两个引擎的标记。都是自绘的简化图形，不是官方 logo：两家都没有提供可再分发的矢量资产，
 * 与其从压缩包里抠一张 32px 的位图，不如画两个一眼能分开的记号。
 * - CodeMirror：一对尖括号，描边跟随文字色，深浅主题都对
 * - Monaco：蓝色圆角方块里的「M」山峰，固定品牌色，压暗的状态栏上也认得出来
 */
const CM_MARK =
  '<svg class="eng-ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M6.2 3.4 2 8l4.2 4.6M9.8 3.4 14 8l-4.2 4.6" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const MONACO_MARK =
  '<svg class="eng-ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<rect x="1" y="1" width="14" height="14" rx="3.6" fill="#1f7ad4"/>' +
  '<path d="M4.7 11.2V5.3L8 8.5l3.3-3.2v5.9" fill="none" stroke="#fff" stroke-width="1.4" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** 引擎名只在 tooltip、弹窗标题这类必须写字的地方出现，界面上尽量用图标代替 */
export const ENGINE_NAMES: Record<EngineId, string> = { cm: 'CodeMirror', monaco: 'Monaco' }

export function engineIcon(id: EngineId): string {
  return id === 'monaco' ? MONACO_MARK : CM_MARK
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 小标记：只有一侧引擎支持这个语言时挂在条目/徽标上，文字说明放 title */
export function engineMark(id: EngineId, title: string): string {
  return `<span class="eng-mark" title="${esc(title)}" aria-label="${esc(title)}">${engineIcon(id)}</span>`
}
