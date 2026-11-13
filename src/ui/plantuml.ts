import { getSettings } from '../shell/settings'
import { t } from '../i18n'
import { encodeSource } from './plantuml-encode'
import { cssVar } from './theme'

/**
 * PlantUML 图表。
 *
 * 与 mermaid / graphviz 的差别只有一条：**它没有纯前端实现**。
 * 所以这块是「用户明确打开开关之后，把源码编码后发给 plantuml.com，拿回 SVG」，
 * 关着的时候什么都不发，只在块里留一行说明 + 源码。
 *
 * 拿回来的 SVG 用 `<img>` 装：SVG 作为图片加载时不执行脚本、也不加载外部资源，
 * 比自己解析进 DOM 再洗一遍更省事，同时保住了「不把文档变成一次出站访问」这条底线。
 */
const SERVER = 'https://www.plantuml.com/plantuml/svg/'
const TIMEOUT_MS = 12000
/** 编码后的串 → SVG 原文。同一张图在连续预览里会反复出现，不缓存就是反复打服务器 */
const cache = new Map<string, string>()
const CACHE_LIMIT = 40

/* ---------- 主题 ---------- */

/**
 * 往源码里塞几行 skinparam。
 *
 * 图会被当图片加载，读不到页面 CSS 变量，颜色只能写死成具体值；
 * 换主题时会重画（`hydrateDiagrams` 的调用方负责），所以不用担心值过期。
 * 位置必须在 `@startuml` 之后、图内容之前。
 */
function themedSource(source: string, theme: 'dark' | 'light'): string {
  const body = source.trim()
  const wrapped = /^@start/i.test(body) ? body : `@startuml\n${body}\n@enduml`
  const lines = wrapped.split('\n')
  const at = /^@start/i.test(lines[0] ?? '') ? 1 : 0
  const skin = [
    'skinparam backgroundColor transparent',
    `skinparam defaultFontColor ${hex(theme, '--c-text')}`,
    `skinparam ArrowColor ${hex(theme, '--c-dim')}`,
    `skinparam BorderColor ${hex(theme, '--c-border')}`,
    'skinparam shadowing false',
  ]
  lines.splice(at, 0, ...skin)
  return lines.join('\n')
}

/**
 * `cssVar` 读的是当前主题下的值，但这里要的是**确定的**颜色：
 * 空白或 `var(...)` 一律退回按主题写死的灰度，免得把 `var(--x)` 当成颜色发给服务器。
 */
function hex(theme: 'dark' | 'light', name: string): string {
  const value = cssVar(name).trim()
  if (/^#|^rgb|^hsl/i.test(value)) return value
  const fallback: Record<string, string> = {
    '--c-text': theme === 'dark' ? '#d8d8de' : '#1e1e23',
    '--c-dim': theme === 'dark' ? '#6a6a72' : '#8a8a90',
    '--c-border': theme === 'dark' ? '#303036' : '#d8d8dc',
  }
  return fallback[name] ?? '#888888'
}

/* ---------- 取图 ---------- */

async function fetchSvg(encoded: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(SERVER + encoded, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    // 出错时服务器也回 200，回的是 PNG 错误图或一段 HTML，认一下再往下走
    if (!text.includes('<svg')) throw new Error('返回的不是 SVG')
    return text
  } finally {
    clearTimeout(timer)
  }
}

/** SVG 原文 → data URL。Base64 走 UTF-8 字节，避免 btoa 在非 ASCII 上直接抛错 */
function toDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

/* ---------- 渲染 ---------- */

function note(block: HTMLElement, message: string) {
  block.querySelector('.plantuml-note')?.remove()
  const div = document.createElement('div')
  div.className = 'plantuml-note'
  div.textContent = message
  block.append(div)
}

/**
 * 把宿主里所有 .plantuml-block 换成图。
 *
 * 开关关着时不发任何请求，只补一行「为什么没画」；
 * 失败（断网、超时、服务器报错）保留源码 + 一行原因，和 graphviz 一样能对着改。
 */
export async function renderPlantumlBlocks(host: HTMLElement, theme: 'dark' | 'light') {
  const blocks = [...host.querySelectorAll<HTMLElement>('.plantuml-block')]
  if (blocks.length === 0) return

  if (!getSettings().plantumlRemote) {
    for (const block of blocks) {
      if (block.classList.contains('is-rendered')) continue
      note(block, t('chart.plantumlOff'))
    }
    return
  }

  for (const block of blocks) {
    const source = decodeURIComponent(block.dataset.plantuml ?? '')
    if (!source.trim()) continue

    // 先清掉上一轮的错误/说明，否则重画后会和图叠在一起
    block.querySelector('.plantuml-error')?.remove()
    let encoded: string
    try {
      encoded = await encodeSource(themedSource(source, theme))
    } catch (error) {
      fail(block, (error as Error).message)
      continue
    }

    if (!cache.has(encoded)) note(block, t('chart.remotePending'))
    try {
      let svg = cache.get(encoded)
      if (!svg) {
        svg = await fetchSvg(encoded)
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
        cache.set(encoded, svg)
      }
      const img = document.createElement('img')
      img.src = toDataUrl(svg)
      img.alt = t('chart.plantuml')
      // 图换掉了源码节点，但源码仍在 data-plantuml 里，换主题重画不依赖 DOM
      block.replaceChildren(img)
      block.classList.add('is-rendered')
      block.classList.remove('is-error')
    } catch (error) {
      fail(block, (error as Error).message)
    }
  }

  // 全部画完之后把残留的「正在联网渲染…」收掉（成功的块已经被 replaceChildren 清空）
  for (const block of blocks) {
    if (block.classList.contains('is-rendered')) block.querySelector('.plantuml-note')?.remove()
  }
}

function fail(block: HTMLElement, message: string) {
  block.classList.add('is-error')
  block.classList.remove('is-rendered')
  block.querySelector('img')?.remove()
  const detail = document.createElement('pre')
  detail.className = 'plantuml-error'
  detail.textContent = t('chart.remoteFailed', { msg: message })
  block.append(detail)
  if (!block.querySelector('.plantuml-source')) {
    // 成功过一次再失败：源码节点已经被 img 换掉了，得补回来
    const pre = document.createElement('pre')
    pre.className = 'plantuml-source'
    pre.textContent = decodeURIComponent(block.dataset.plantuml ?? '')
    block.prepend(pre)
  }
}
