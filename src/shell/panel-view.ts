/**
 * 面板内容注册模式（PN-01 ~ PN-08）。
 *
 * 三层：内容（PanelContent）、槽位（PanelSlotSpec）、绑定（PanelBinding）。
 * - 内容只管「我长什么样、我的数据从哪来」，不持有任何容器引用；
 * - 槽位只管「挂在哪、开合怎么表达、chrome 元素是谁」；
 * - 绑定是唯一把两者连起来的地方，也唯一知道按钮 id。
 *
 * 于是「按钮挪位置」「内容换个容器」都只是改绑定，内容代码零改动。
 * 任意时刻槽位里只有当前内容的根节点（切换时 detach，不留 hidden 常驻树）。
 */
import { applyStaticText, onLangChange, t, type MessageKey } from '../i18n'

export interface PanelContent {
  readonly id: string
  readonly titleKey: MessageKey
  /** 内容自己的根节点；由 createContent 建（或接管 HTML 里的骨架），槽位负责 append/remove */
  readonly root: HTMLElement
  /** 面板头部属于本页的按钮 id（PN-05） */
  readonly actions: readonly string[]
  /** 额外条件：例如「检查」在没有文件时不显示选项按钮 */
  actionsVisible(): boolean
  /** 填内容；可能异步（Markdown 渲染） */
  render(): void | Promise<void>
  /**
   * 只同步 chrome（禁用态、互斥条、计数文案），不重画列表。
   * 槽位在切页/开合后调用；有细粒度状态的页（如文件页的批量条）在这里补一刀。
   */
  syncChrome?(): void
  /** 离开挂载点时收尾：停掉后台任务、关掉浮层、清掉悬空的编辑态 */
  onUnmount?(): void
  /** 是否挂在某个槽位上 */
  isMounted(): boolean
  /** 是否正被用户看见（挂在槽位上且槽位展开）；副作用守卫问它（PN-07） */
  isVisible(): boolean
}

export interface PanelSlotSpec {
  readonly id: string
  /** 内容挂载点：任意时刻最多一个子节点 */
  readonly host: HTMLElement
  isOpen(): boolean
  setOpen(open: boolean): void
  /** 标题元素：文本来自绑定指向的内容 */
  readonly title?: HTMLElement
  /** 动作按钮的父元素：显隐按当前内容的 actions 决定 */
  readonly actionsHost?: HTMLElement
  onLayout?(): void
}

export interface PanelBinding {
  /** 触发按钮的元素 id；按钮只需带 data-panel-trigger 属性 */
  readonly trigger: string
  readonly slot: string
  readonly content: string
  /** 再点一次是否收起 */
  readonly toggle: boolean
  /** 按钮是否声明了 aria-pressed / aria-expanded（左竖条那种切换型图标） */
  readonly aria?: boolean
}

interface Entry {
  content: PanelContent
  /** 当前挂在哪个槽位；null = 未挂载 */
  slotId: string | null
  /** detach 时的滚动位置，重新挂回时恢复（PN-06） */
  scrollTop: number
}

const entries = new Map<string, Entry>()
const slots = new Map<string, PanelSlotSpec>()
const bindings = new Map<string, PanelBinding>()
/** 槽位当前显示的内容 */
const active = new Map<string, string>()

export function createContent(spec: {
  id: string
  titleKey: MessageKey
  className: string
  /** 可选：DOM id，保持既有选择器/验收脚本可用（同一时刻只挂一个内容，不会重名） */
  rootId?: string
  /**
   * 可选：接管 HTML 里预置的骨架（结构复杂、静态文案多的页）。
   * 接管后节点立刻脱离文档、归属内容，由槽位在切换时 append/remove；
   * 传了就忽略 className / rootId —— 骨架上的类名与 id 以 HTML 为准。
   */
  element?: HTMLElement
  actions?: readonly string[]
  actionsVisible?: () => boolean
  render: () => void | Promise<void>
  syncChrome?: () => void
  onUnmount?: () => void
}): PanelContent {
  const root = spec.element ?? document.createElement('div')
  if (spec.element) {
    // 预置骨架默认可能带 hidden（多页互斥的老写法），内容自己决定可见性
    spec.element.hidden = false
    spec.element.remove()
    // 骨架脱离文档后 applyStaticText 的全局扫描够不到它：
    // 首次挂载时补一次（那时语言已确定），之后跟着语言切换重翻
    onLangChange(() => applyStaticText(spec.element))
  } else {
    root.className = spec.className
    if (spec.rootId) root.id = spec.rootId
  }
  const content: PanelContent = {
    id: spec.id,
    titleKey: spec.titleKey,
    root,
    actions: spec.actions ?? [],
    actionsVisible: spec.actionsVisible ?? (() => true),
    render: spec.render,
    syncChrome: spec.syncChrome,
    onUnmount: spec.onUnmount,
    isMounted: () => entries.get(spec.id)?.slotId != null,
    isVisible: () => {
      const entry = entries.get(spec.id)
      if (!entry?.slotId) return false
      return slots.get(entry.slotId)?.isOpen() ?? false
    },
  }
  entries.set(spec.id, { content, slotId: null, scrollTop: 0 })
  return content
}

export function registerSlot(spec: PanelSlotSpec): void {
  slots.set(spec.id, spec)
}

export function registerBinding(binding: PanelBinding): void {
  bindings.set(binding.trigger, binding)
}

function detach(contentId: string): void {
  const entry = entries.get(contentId)
  if (!entry?.slotId) return
  entry.scrollTop = entry.content.root.scrollTop
  entry.content.root.remove()
  entry.slotId = null
  // 先脱离再收尾：onUnmount 里可能触发的 chrome 同步不该再算到这一页头上
  entry.content.onUnmount?.()
}

function mountContent(slotId: string, contentId: string): PanelContent | null {
  const slot = slots.get(slotId)
  const entry = entries.get(contentId)
  if (!slot || !entry) return null

  const prev = active.get(slotId)
  if (prev && prev !== contentId) detach(prev)

  if (entry.slotId !== slotId) {
    slot.host.append(entry.content.root)
    entry.slotId = slotId
    // 接管来的骨架在文档外待过，静态文案要在这里补翻一次
    applyStaticText(entry.content.root)
    // append 之后才能设滚动位置，否则会被重置
    entry.content.root.scrollTop = entry.scrollTop
  }
  active.set(slotId, contentId)
  return entry.content
}

/** 槽位 chrome 的唯一刷新点：标题、动作按钮、竖条高亮 */
function syncChrome(slotId: string): void {
  const slot = slots.get(slotId)
  if (!slot) return
  const contentId = active.get(slotId)
  const content = contentId ? entries.get(contentId)?.content : undefined
  const open = slot.isOpen()

  if (slot.title) slot.title.textContent = content ? t(content.titleKey) : ''

  if (slot.actionsHost) {
    const allowed =
      content && content.actionsVisible() ? new Set(content.actions) : new Set<string>()
    slot.actionsHost.querySelectorAll<HTMLElement>('[data-panel-action]').forEach((btn) => {
      btn.hidden = !allowed.has(btn.id)
    })
  }

  for (const [trigger, binding] of bindings) {
    if (binding.slot !== slotId) continue
    const btn = document.getElementById(trigger)
    if (!btn) continue
    const on = open && contentId === binding.content
    btn.classList.toggle('is-active', on)
    if (binding.aria) {
      btn.setAttribute('aria-pressed', String(on))
      btn.setAttribute('aria-expanded', String(open))
    }
  }

  // 内容自己的细粒度 chrome（禁用态、批量条、计数文案）跟在后面补
  content?.syncChrome?.()
}

export function refreshChrome(slotId: string): void {
  syncChrome(slotId)
}

export function activeContentId(slotId: string): string | null {
  return active.get(slotId) ?? null
}

export function contentById(contentId: string): PanelContent | null {
  return entries.get(contentId)?.content ?? null
}

/**
 * 唯一入口：按钮点了就走这里（PN-02）。
 * 返回值 = 面板最终是否展开；`force` 用于「必须打开并渲染」的场景（打印）。
 */
export async function activateBinding(triggerId: string, force?: boolean): Promise<boolean> {
  const binding = bindings.get(triggerId)
  if (!binding) return false
  const slot = slots.get(binding.slot)
  if (!slot) return false

  const current = active.get(binding.slot)
  const want = force ?? !(slot.isOpen() && current === binding.content)

  if (!want) {
    slot.setOpen(false)
    syncChrome(binding.slot)
    slot.onLayout?.()
    return false
  }

  const content = mountContent(binding.slot, binding.content)
  slot.setOpen(true)
  syncChrome(binding.slot)
  slot.onLayout?.()
  await content?.render()
  return true
}

/** 不 toggle，直接切到某个内容：切文件时的回退走这里 */
export async function showContent(slotId: string, contentId: string): Promise<void> {
  const slot = slots.get(slotId)
  if (!slot) return
  const content = mountContent(slotId, contentId)
  slot.setOpen(true)
  syncChrome(slotId)
  slot.onLayout?.()
  await content?.render()
}

export function closeSlot(slotId: string): void {
  const slot = slots.get(slotId)
  if (!slot) return
  slot.setOpen(false)
  syncChrome(slotId)
  slot.onLayout?.()
}
