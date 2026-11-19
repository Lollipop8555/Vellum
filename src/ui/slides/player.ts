/**
 * 放映器：把一份演示文稿打包成**自包含**的 HTML（新窗口 / 同页 iframe / 导出 `.html` 共用）。
 *
 * 三条原则：
 *   - **页面内容由调用方给**：每页是面板里那份 `renderMarkdown()` + 图表 hydrate 之后的
 *     innerHTML。放映器不自己解析 Markdown，否则「放映」和「面板」迟早长成两种样子。
 *   - **样式内联主样式表**（`styles.css?inline`），只叠一层放映布局。抄一份 `.deck-page`
 *     子集能省 100KB，但必然与主样式漂移 —— 幻灯片最不能容忍的就是「放映时版式变了」。
 *   - **脚本零依赖**：所有状态在一个闭包里，`document.write` 进去的窗口能直接跑。
 *
 * 已知限制：外链资源（相对路径的图片）在新窗口里没有基址，调用方需要先把它们转成
 * `data:`（壳层的 `inlineDeckImages()`）。图表是内联 SVG，不涉及网络。
 */
import baseCss from '../styles.css?inline'
import mathCss from 'katex/dist/katex.min.css?inline'
import { t } from '../../i18n'
import { fitPageContent } from './autofit'
import { ratioSize } from './deck'

export interface PlayerPage {
  /** 已渲染的页内容 HTML（含内联 SVG 图表） */
  html: string
  /** 默认居中；`class: left` 时左对齐 */
  align: 'center' | 'left'
  /** 默认竖直居中；`class: top` 时顶对齐 */
  valign: 'middle' | 'top'
  color?: string
  image?: string
  size?: string
  position?: string
  /** `???` 之后的演讲者备注 */
  notes: string
}

export interface PlayerOptions {
  /** 窗口标题与导出文件名（不含扩展名） */
  title: string
  /** `16:9` / `4:3` */
  ratio: string
  /** 放映页沿用面板的配色，否则暗色主题下会突然变白 */
  theme: 'light' | 'dark'
  pages: PlayerPage[]
  /** `h` 帮助里的语法速查（`specMarkdown()` 原文，纯文本展示） */
  helpText: string
}

/** 生成整份自包含 HTML。调用方负责把每页渲染好并 hydrate 完图表。 */
export function renderDeckHtml(opts: PlayerOptions): string {
  const size = ratioSize(opts.ratio)
  const title = escapeHtml(opts.title)

  return [
    '<!doctype html>',
    `<html lang="${escapeAttr(documentLang())}" data-theme="${opts.theme === 'light' ? 'light' : 'dark'}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${baseCss}</style>`,
    `<style>${mathCss}</style>`,
    `<style>${PLAYER_CSS}</style>`,
    '</head>',
    `<body class="deck-player" style="--dp-ar: ${size.w} / ${size.h}; --dp-w: ${size.w}; --dp-h: ${size.h}">`,
    '<main class="dp-stage" id="stage">',
    opts.pages.map((page, i) => pageHtml(page, i)).join('\n'),
    '</main>',
    hudHtml(),
    helpHtml(opts.helpText),
    presenterHtml(),
    '<div class="dp-layer dp-black" id="black" aria-hidden="true"></div>',
    /**
     * 演讲者窗口的壳 + 脚本序列化进本页：`p` 时 `window.open` 一个新窗口把它写进去。
     * CSS 不带 —— 运行时从本窗口的 `<style>` 读（见 `presenterDoc()`），
     * 否则整份主样式表要在导出的 HTML 里再复制一遍。
     */
    `<script>var DECK_PRESENTER = ${jsLiteral({
      css: PRESENTER_CSS,
      body: presenterGrid(true),
      js: presenterScript(),
    })}</script>`,
    // 自动缩放要跟面板用同一份实现：`toString()` 把函数源码带进独立窗口
    `<script>var fitPageContent = ${fitPageContent.toString()};\n${playerScript()}</script>`,
    '</body>',
    '</html>',
  ].join('\n')
}

/** 新窗口被拦截时的占位：先给个「正在准备」，别让用户点了没反应 */
export function playerPlaceholder(title: string): string {
  return [
    '<!doctype html><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>html,body{height:100%;margin:0;display:grid;place-items:center;background:#000;' +
      'color:#bbb;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif}</style>',
    `<p>${escapeHtml(t('deck.player.prepare'))}</p>`,
  ].join('')
}

/* ------------------------------------------------------------------ 页面 */

function pageHtml(page: PlayerPage, index: number): string {
  const style = [
    page.color ? `background-color:${page.color}` : '',
    page.image ? `background-image:url("${page.image}")` : '',
    page.size ? `background-size:${page.size}` : '',
    page.position ? `background-position:${page.position}` : '',
  ]
    .filter(Boolean)
    .join(';')

  return [
    `<section class="deck-page dp-slide" data-align="${page.align}" ` +
      `data-valign="${page.valign}" data-notes="${escapeAttr(page.notes)}" ` +
      `data-index="${index}" aria-hidden="true"${style ? ` style="${escapeAttr(style)}"` : ''}>`,
    `<div class="deck-page-inner markdown-body">${page.html}</div>`,
    '</section>',
  ].join('')
}

function hudHtml(): string {
  return [
    '<div class="dp-hud" id="hud">',
    '<span id="hudPage">1 / 1</span>',
    '<span id="hudTimer" hidden>00:00</span>',
    '</div>',
  ].join('')
}

function helpHtml(helpText: string): string {
  const rows = helpKeys()
    .map(([keys, action]) => `<tr><td><kbd>${escapeHtml(keys)}</kbd></td><td>${escapeHtml(action)}</td></tr>`)
    .join('')

  return [
    '<div class="dp-layer" id="help" aria-hidden="true">',
    `<h1>${escapeHtml(t('deck.player.help'))}</h1>`,
    '<div class="dp-help-grid">',
    `<table class="dp-keys"><tbody>${rows}</tbody></table>`,
    '<div class="dp-syntax">',
    `<h2>${escapeHtml(t('deck.player.syntax'))}</h2>`,
    `<pre>${escapeHtml(helpText)}</pre>`,
    '</div>',
    '</div>',
    `<p class="dp-hint">${escapeHtml(t('deck.player.k.exit'))}</p>`,
    '</div>',
  ].join('')
}

/**
 * 演讲者视图的主结构：当前页缩略、下一页缩略、页码/计时、备注。
 *
 * 同一份结构跑在两个地方 —— 独立的演讲者窗口（双屏：演示留在投影上，这块在笔记本上）
 * 和放映窗口里的浮层（新窗口被拦截时的退路）。`withControls` 只在窗口里给翻页按钮：
 * 浮层版本自己没有脚本，按钮摆上去也点不动。
 */
function presenterGrid(withControls: boolean): string {
  return [
    '<div class="dp-presenter-grid">',
    '<div>',
    `<h2>${escapeHtml(t('deck.player.now'))}</h2>`,
    '<div class="dp-mini-window" id="presentNow"></div>',
    `<h2>${escapeHtml(t('deck.player.next'))}</h2>`,
    '<div class="dp-mini-window" id="presentNext"></div>',
    '</div>',
    '<div class="dp-side">',
    '<p class="dp-meta"><span id="presentPage">1 / 1</span> · <span id="presentTimer">00:00</span></p>',
    `<h2>${escapeHtml(t('deck.player.notes'))}</h2>`,
    '<p class="dp-notes" id="presentNotes"></p>',
    withControls
      ? '<div class="dp-ctl"><button type="button" id="presentPrev">←</button>' +
        '<button type="button" id="presentNextBtn">→</button></div>'
      : '',
    '</div>',
    '</div>',
  ].join('')
}

function presenterHtml(): string {
  return `<div class="dp-layer dp-presenter" id="presenter" aria-hidden="true">${presenterGrid(false)}</div>`
}

/** 内联进 `<script>` 的字面量：`JSON.stringify` 不管 `<`，内容里有 `</script>` 会提前闭合宿主标签 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** 键盘表：键位是语言中立的，动作名走 i18n */
function helpKeys(): [string, string][] {
  return [
    ['→ ← Space PgUp PgDn j k', t('deck.player.k.move')],
    ['Home End', t('deck.player.k.edge')],
    ['f', t('deck.player.k.full')],
    ['p', t('deck.player.k.presenter')],
    ['b', t('deck.player.k.black')],
    ['s', t('deck.player.k.timer')],
    ['h ?', t('deck.player.k.help')],
    ['Esc', t('deck.player.k.exit')],
  ]
}

/* -------------------------------------------------------------- 文本工具 */

function documentLang(): string {
  return document.documentElement.lang || 'zh-CN'
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

function escapeAttr(text: string): string {
  return escapeHtml(text)
}

/**
 * 放映布局：只处理「视口里怎么摆一页」和浮层，页内排版全部继承主样式。
 * 主样式的 `.deck-page` 是按面板尺寸写的（固定 width/transform/padding），
 * 这里覆盖成「按视口最大内接」，其余（背景、对齐、cqw 字号）原样复用。
 */
const PLAYER_CSS = `
html,
body {
  height: 100%;
  margin: 0;
  overflow: hidden;
  overscroll-behavior: none;
  background: #000;
}

body.deck-player {
  display: block;
}

.dp-stage {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
}

.dp-slide {
  display: none;
  width: min(100vw, calc(100vh * var(--dp-w) / var(--dp-h)));
  height: auto;
  aspect-ratio: var(--dp-ar);
  padding: 4.375% 5%;
  transform: none;
  border-radius: 0;
  box-shadow: none;
  cursor: pointer;
}

.dp-slide.is-active {
  display: flex;
}

/* HUD：平时藏着，动一下才出现 */
.dp-hud {
  position: fixed;
  left: 50%;
  bottom: 16px;
  z-index: 20;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 5px 14px;
  border-radius: 99px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba(255, 255, 255, 0.88);
  font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
  font-variant-numeric: tabular-nums;
  opacity: 0;
  transform: translateX(-50%);
  transition: opacity 0.25s ease;
  pointer-events: none;
}

.dp-hud.is-on {
  opacity: 1;
}

.dp-hud.is-done #hudTimer {
  color: #f5c26b;
}

/* 浮层：帮助 / 演讲者 / 黑屏共用一个壳 */
.dp-layer {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: none;
  padding: 4vh 4vw;
  overflow: auto;
  background: rgba(0, 0, 0, 0.9);
  color: #e6e6e6;
  font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
}

.dp-layer.is-open {
  display: block;
}

.dp-black {
  z-index: 40;
  padding: 0;
  overflow: hidden;
  background: #000;
}

.dp-layer h1 {
  margin: 0 0 14px;
  font-size: 20px;
  font-weight: 600;
}

.dp-layer h2 {
  margin: 18px 0 8px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.6;
}

.dp-help-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  gap: 32px;
  align-items: start;
}

.dp-keys {
  border-collapse: collapse;
  width: 100%;
}

.dp-keys td {
  padding: 6px 10px 6px 0;
  vertical-align: top;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.dp-keys td:first-child {
  width: 46%;
  white-space: nowrap;
}

.dp-keys kbd {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}

.dp-syntax {
  min-width: 0;
}

.dp-syntax pre {
  margin: 0;
  padding: 14px 16px;
  max-height: 68vh;
  overflow: auto;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

.dp-hint {
  margin: 20px 0 0;
  font-size: 12px;
  opacity: 0.55;
}

/* 演讲者视图 */
.dp-presenter {
  --dp-k: 0.22;
}

.dp-presenter-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 28px;
  align-items: start;
}

.dp-mini-window {
  width: calc(var(--dp-w) * var(--dp-k) * 1px);
  max-width: 100%;
  height: calc(var(--dp-h) * var(--dp-k) * 1px);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  background: #fff;
}

.dp-mini-window > .deck-page {
  display: flex;
  width: calc(var(--dp-w) * 1px);
  height: calc(var(--dp-h) * 1px);
  transform: scale(var(--dp-k));
  transform-origin: 0 0;
  border-radius: 0;
  box-shadow: none;
}

.dp-side {
  min-width: 0;
}

.dp-meta {
  margin: 0;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

.dp-notes {
  margin: 0;
  white-space: pre-wrap;
  font-size: 15px;
  line-height: 1.75;
}

/* 打印：一页一张纸，全部摊平 */
@media print {
  @page {
    size: A4 landscape;
    margin: 0;
  }

  html,
  body {
    height: auto;
    overflow: visible;
    background: #fff;
  }

  .dp-stage {
    position: static;
    display: block;
  }

  .dp-slide {
    display: flex !important;
    width: 100%;
    aspect-ratio: var(--dp-ar);
    padding: 4.375% 5%;
    break-after: page;
  }

  .dp-hud,
  .dp-layer {
    display: none !important;
  }
}
`

/**
 * 演讲者窗口自己的布局（`p` 打开的第二窗口）。
 *
 * 这份窗口不参与放映：不透明的黑底、两栏（缩略在上、备注在右）、没有 HUD。
 * 页内排版仍走主样式，缩略页靠 `.dp-mini-window` 的 `--dp-k` 整体缩放，
 * `--dp-k` 由窗口脚本按栏宽写入（1280 的页塞进 560 的栏）。
 */
const PRESENTER_CSS = `
html,
body {
  height: 100%;
  margin: 0;
}

body.dp-presenter-body {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr);
  gap: 22px;
  align-items: start;
  box-sizing: border-box;
  padding: 22px 24px;
  overflow: hidden;
  background: #141414;
  color: #e9e9e9;
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
}

body.dp-presenter-body h2 {
  margin: 0 0 7px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  opacity: 0.5;
}

body.dp-presenter-body .dp-mini-window {
  width: calc(var(--dp-w) * var(--dp-k, 0.22) * 1px);
  max-width: 100%;
  height: calc(var(--dp-h) * var(--dp-k, 0.22) * 1px);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 10px;
  background: #fff;
}

body.dp-presenter-body .dp-mini-window + h2 {
  margin-top: 18px;
}

body.dp-presenter-body .dp-mini-window > .deck-page {
  display: flex;
  width: calc(var(--dp-w) * 1px);
  height: calc(var(--dp-h) * 1px);
  transform: scale(var(--dp-k, 0.22));
  transform-origin: 0 0;
  border-radius: 0;
  box-shadow: none;
}

body.dp-presenter-body .dp-side {
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
}

body.dp-presenter-body .dp-meta {
  margin: 0 0 16px;
  font-size: 26px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}

body.dp-presenter-body .dp-meta span + span {
  font-size: 15px;
  opacity: 0.6;
}

body.dp-presenter-body .dp-notes {
  margin: 0;
  max-height: 52vh;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 15px;
  line-height: 1.8;
}

body.dp-presenter-body .dp-ctl {
  display: flex;
  gap: 10px;
  margin-top: auto;
  padding-top: 18px;
}

body.dp-presenter-body .dp-ctl button {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font: inherit;
  font-size: 17px;
  cursor: pointer;
}

body.dp-presenter-body .dp-ctl button:hover {
  background: rgba(255, 255, 255, 0.12);
}
`

/**
 * 演讲者窗口的脚本（零依赖，字符串形式，理由同 `playerScript()`）。
 *
 * 页码、备注、当前页 HTML 全部由放映窗口推过来（`deck-state`）：真相只有一份。
 * 计时是唯一的例外 —— **本窗口自己走表**，只在「开窗 / 开始 / 停止」这几个
 * 用户动作上抄一次读数当基准，之后按本地 `Date.now()` 累加，一个消息都不等。
 * 中间不再有 tick 推送：本窗口被投影挡住、定时器被节流到分钟级也照样每秒一跳。
 */
function presenterScript(): string {
  return `
(function () {
  'use strict'

  var host = window.opener
  var nowBox = document.getElementById('presentNow')
  var nextBox = document.getElementById('presentNext')
  var notesEl = document.getElementById('presentNotes')
  var pageEl = document.getElementById('presentPage')
  var timerEl = document.getElementById('presentTimer')
  var state = { index: 0, total: 1, notes: '', nowHtml: '', nextHtml: '', time: '00:00', ticking: false }
  /* 计时的基准：放映窗口给的读数 + 收到那一刻的本地时钟 */
  var baseMs = 0
  var baseAt = 0

  function send(msg) {
    if (!host || host.closed) return
    try {
      host.postMessage(msg, '*')
    } catch (err) {}
  }

  /* 缩略页按左栏宽度定缩放比：窗口拉大拉小都填满，不留白边也不溢出 */
  function fitMini() {
    var w = parseFloat(getComputedStyle(document.body).getPropertyValue('--dp-w')) || 1280
    var col = nowBox.parentElement ? nowBox.parentElement.clientWidth : 0
    if (col > 0) document.body.style.setProperty('--dp-k', String(Math.min(col / w, 1)))
  }

  function toMs(text) {
    var m = /^\\s*(\\d+):(\\d{2})\\s*$/.exec(text || '')
    return m ? Number(m[1]) * 60000 + Number(m[2]) * 1000 : 0
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n
  }

  function paintTimer() {
    var ms = baseMs + (state.ticking ? Date.now() - baseAt : 0)
    var sec = Math.max(0, Math.floor(ms / 1000))
    timerEl.textContent = pad(Math.floor(sec / 60)) + ':' + pad(sec % 60)
  }

  /* 校准基准：优先用毫秒原值，只有文本时按秒解析（会截断，只够退路用） */
  function syncTimer(text, ticking, ms) {
    baseMs = typeof ms === 'number' && isFinite(ms) ? ms : toMs(text)
    baseAt = Date.now()
    if (ticking !== undefined) state.ticking = Boolean(ticking)
    paintTimer()
  }

  function paint() {
    nowBox.innerHTML = state.nowHtml
    nextBox.innerHTML = state.nextHtml
    notesEl.textContent = state.notes || ''
    pageEl.textContent = (state.index + 1) + ' / ' + state.total
    syncTimer(state.time, state.ticking, state.ms)
    fitMini()
  }

  window.addEventListener('message', function (e) {
    var d = e.data
    if (!d) return
    if (d.type === 'deck-state') {
      state = d
      paint()
      return
    }
    /* 没带 ticking 的消息不能把表打停：沿用上一个已知状态 */
    if (d.type === 'deck-tick') syncTimer(d.time, d.ticking, d.ms)
  })

  /* 本窗口自己的表：一个消息都不等，放映窗口那边停不停都不影响这里 */
  window.setInterval(paintTimer, 250)

  window.addEventListener('keydown', function (e) {
    var k = e.key
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'PageDown' || k === 'n' || k === 'N') {
      e.preventDefault()
      send({ type: 'deck-step', delta: 1 })
      return
    }
    if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'k' || k === 'K') {
      e.preventDefault()
      send({ type: 'deck-step', delta: -1 })
      return
    }
    if (k === 'Home') {
      e.preventDefault()
      send({ type: 'deck-goto', index: 0 })
      return
    }
    if (k === 'End') {
      e.preventDefault()
      send({ type: 'deck-goto', index: Math.max(0, state.total - 1) })
      return
    }
    if (k === 'b' || k === 'B') {
      e.preventDefault()
      send({ type: 'deck-key', key: 'b' })
      return
    }
    if (k === 's' || k === 'S') {
      e.preventDefault()
      send({ type: 'deck-key', key: 's' })
      return
    }
    if (k === 'Escape') {
      e.preventDefault()
      window.close()
    }
  })

  document.getElementById('presentPrev').addEventListener('click', function () {
    send({ type: 'deck-step', delta: -1 })
  })
  document.getElementById('presentNextBtn').addEventListener('click', function () {
    send({ type: 'deck-step', delta: 1 })
  })

  window.addEventListener('resize', fitMini)
  window.addEventListener('beforeunload', function () {
    send({ type: 'deck-presenter-closed' })
  })
})()
`
}

/**
 * 放映脚本：零依赖，靠 CSS 类做状态（`is-active` / `is-open`）。
 * 写成字符串是因为整份文档要能 `document.write` 进新窗口、也要能存成 `.html` 文件，
 * 没法把模块打包进去。
 */
function playerScript(): string {
  return `
(function () {
  'use strict'

  var stage = document.getElementById('stage')
  if (!stage) return
  var slides = [].slice.call(stage.querySelectorAll('.dp-slide'))
  if (!slides.length) return

  var hud = document.getElementById('hud')
  var hudPage = document.getElementById('hudPage')
  var hudTimer = document.getElementById('hudTimer')
  var help = document.getElementById('help')
  var presenter = document.getElementById('presenter')
  var black = document.getElementById('black')
  var presentNow = document.getElementById('presentNow')
  var presentNext = document.getElementById('presentNext')
  var presentNotes = document.getElementById('presentNotes')
  var presentPage = document.getElementById('presentPage')
  var presentTimer = document.getElementById('presentTimer')

  var total = slides.length
  var index = 0
  /*
   * 进放映就开始走：上台的人不会记得先按一下 s，表停在 00:00 只会让人觉得坏了。
   * s 变成暂停/继续，读数从开映算起 —— 演讲者窗口开出来看到的就是已经讲了多久。
   */
  var elapsed = 0
  var ticking = true
  var tickStart = Date.now()
  var hudHide = 0
  /**
   * 双屏：p 把演讲者视图开成第二个窗口，放映窗口留在投影上不动。
   * 被弹窗拦截时 presenterWin 为空，退回同窗浮层（#presenter）。
   */
  var presenterWin = null
  var deckPresenter = typeof DECK_PRESENTER === 'object' && DECK_PRESENTER ? DECK_PRESENTER : null

  function pad(n) {
    return (n < 10 ? '0' : '') + n
  }

  function elapsedMs() {
    return elapsed + (ticking ? Date.now() - tickStart : 0)
  }

  function clock() {
    var sec = Math.floor(elapsedMs() / 1000)
    return pad(Math.floor(sec / 60)) + ':' + pad(sec % 60)
  }

  function isOpen(layer) {
    return layer.classList.contains('is-open')
  }

  function openLayer(layer) {
    layer.classList.add('is-open')
    layer.setAttribute('aria-hidden', 'false')
  }

  function closeLayer(layer) {
    layer.classList.remove('is-open')
    layer.setAttribute('aria-hidden', 'true')
  }

  /* 只画本窗口：秒针在演讲者窗口那边由它自己的表走，不靠这里一帧一帧推 */
  function paintClock() {
    var text = clock()
    hudTimer.textContent = text
    hudTimer.hidden = !ticking && elapsed === 0
    presentTimer.textContent = text
  }

  function poke() {
    hud.classList.add('is-on')
    window.clearTimeout(hudHide)
    hudHide = window.setTimeout(function () {
      hud.classList.remove('is-on')
    }, 2400)
  }

  function renderPresenter() {
    var cur = slides[index]
    var next = slides[index + 1]
    presentNow.innerHTML = ''
    presentNext.innerHTML = ''
    if (cur) presentNow.appendChild(cur.cloneNode(true))
    if (next) presentNext.appendChild(next.cloneNode(true))
    presentNotes.textContent = (cur && cur.getAttribute('data-notes')) || ''
    presentPage.textContent = (index + 1) + ' / ' + total
    paintClock()
  }

  /**
   * 演讲者窗口的整份 HTML：从本窗口的 style 标签里取 CSS（放映器和演讲者必须长同一样），
   * --dp-w/--dp-h 从 body 的 style 抄过去，缩略页才能按同一画布缩放。
   * window.open 之后再 document.write，全程不碰网络。
   */
  function presenterDoc() {
    if (!deckPresenter) return ''
    var css = ''
    var tags = document.querySelectorAll('style')
    for (var i = 0; i < tags.length; i++) css += tags[i].textContent + '\\n'
    var bodyStyle = document.body.getAttribute('style') || ''
    return '<!doctype html><html lang="' + (document.documentElement.lang || 'zh') +
      '" data-theme="' + (document.documentElement.getAttribute('data-theme') || 'dark') + '">' +
      '<head><meta charset="utf-8"><title>' + document.title + '</title><style>' + css +
      deckPresenter.css + '</style></head><body class="dp-presenter-body"' +
      (bodyStyle ? ' style="' + bodyStyle + '"' : '') + '>' + deckPresenter.body +
      '<script>' + deckPresenter.js + '<\\/script></body></html>'
  }

  function openPresenter() {
    if (presenterWin && !presenterWin.closed) return true
    var doc = presenterDoc()
    if (!doc) return false
    var win = null
    try {
      win = window.open('', 'deck-presenter', 'popup=yes,width=1020,height=720')
    } catch (err) {
      win = null
    }
    if (!win || win.closed) return false
    try {
      win.document.open()
      win.document.write(doc)
      win.document.close()
    } catch (err) {
      try {
        win.close()
      } catch (e2) {}
      return false
    }
    presenterWin = win
    // 等它跑完解析再推第一帧，否则消息发在监听器挂上之前
    window.setTimeout(postState, 200)
    return true
  }

  function closePresenter() {
    if (presenterWin && !presenterWin.closed) {
      try {
        presenterWin.close()
      } catch (err) {}
    }
    presenterWin = null
  }

  function postState() {
    if (!presenterWin || presenterWin.closed) {
      presenterWin = null
      return
    }
    var cur = slides[index]
    var next = slides[index + 1]
    presenterWin.postMessage(
      {
        type: 'deck-state',
        index: index,
        total: total,
        notes: (cur && cur.getAttribute('data-notes')) || '',
        nowHtml: cur ? cur.outerHTML : '',
        nextHtml: next ? next.outerHTML : '',
        time: clock(),
        ms: elapsedMs(),
        ticking: ticking,
      },
      '*',
    )
  }

  /**
   * 计时每 0.5s 一跳，只推读数，不重新序列化整页。
   * 演讲者窗口收到后只把它当校准基准，自己按本地时钟走 —— 本窗口被投影挡住时
   * 浏览器会把这个 interval 节流到分钟级，光靠它推数秒针就会停。
   * ms 是毫秒原值：只给 分:秒 文本的话，对方每次校准都向下截断到整秒，
   * 校准比插值还密时秒针就会被反复拉回同一格，看起来像停住。
   */
  function postClock() {
    if (!presenterWin || presenterWin.closed) {
      presenterWin = null
      return
    }
    presenterWin.postMessage({ type: 'deck-tick', time: clock(), ms: elapsedMs(), ticking: ticking }, '*')
  }

  // 只有激活的页才有尺寸（其余页 display:none），所以切页后立刻量一次
  function fitActive() {
    var cur = slides[index]
    var inner = cur && cur.querySelector('.deck-page-inner')
    if (inner) fitPageContent(inner)
  }

  function show(n) {
    var target = Math.max(0, Math.min(total - 1, n))
    if (target !== index) {
      index = target
      for (var i = 0; i < total; i++) {
        var on = i === index
        slides[i].classList.toggle('is-active', on)
        slides[i].setAttribute('aria-hidden', on ? 'false' : 'true')
      }
      hudPage.textContent = (index + 1) + ' / ' + total
      try {
        history.replaceState(null, '', '#p' + (index + 1))
      } catch (err) {}
      if (isOpen(presenter)) renderPresenter()
      if (presenterWin) postState()
      fitActive()
    }
    poke()
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () {})
      return
    }
    document.documentElement.requestFullscreen().catch(function () {})
  }

  function toggleTimer() {
    if (ticking) {
      elapsed += Date.now() - tickStart
      ticking = false
    } else {
      tickStart = Date.now()
      ticking = true
    }
    paintClock()
    /* 开始/停表是用户动作，顺手把基准抄给演讲者窗口；之后它自己走 */
    postClock()
  }

  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    var k = e.key

    if (k === 'Escape') {
      e.preventDefault()
      if (isOpen(help)) return closeLayer(help)
      if (isOpen(presenter)) return closeLayer(presenter)
      if (presenterWin && !presenterWin.closed) return closePresenter()
      if (isOpen(black)) return closeLayer(black)
      if (document.fullscreenElement) return toggleFullscreen()
      // 独立窗口能关就关；被嵌在外层 iframe 里时关不掉，通知外层收掉
      try {
        window.close()
      } catch (err) {}
      if (window.parent && window.parent !== window) {
        try {
          window.parent.postMessage({ type: 'deck-exit' }, '*')
        } catch (err) {}
      }
      return
    }

    if (k === 'h' || k === 'H' || k === '?' || k === 'F1') {
      e.preventDefault()
      if (isOpen(help)) closeLayer(help)
      else openLayer(help)
      return
    }

    if (isOpen(help)) return

    if (
      k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'PageDown' ||
      k === 'j' || k === 'J' || k === 'n' || k === 'N'
    ) {
      e.preventDefault()
      return show(index + 1)
    }
    if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'k' || k === 'K') {
      e.preventDefault()
      return show(index - 1)
    }
    if (k === 'Home') {
      e.preventDefault()
      return show(0)
    }
    if (k === 'End') {
      e.preventDefault()
      return show(total - 1)
    }
    if (k === 'f' || k === 'F') {
      e.preventDefault()
      return toggleFullscreen()
    }
    if (k === 'p' || k === 'P') {
      e.preventDefault()
      if (presenterWin && !presenterWin.closed) return closePresenter()
      if (isOpen(presenter)) return closeLayer(presenter)
      if (openPresenter()) return
      // 弹窗被拦：退回同窗浮层，单屏也能看备注，只是会盖住演示页
      renderPresenter()
      return openLayer(presenter)
    }
    if (k === 'b' || k === 'B') {
      e.preventDefault()
      return isOpen(black) ? closeLayer(black) : openLayer(black)
    }
    if (k === 's' || k === 'S') {
      e.preventDefault()
      return toggleTimer()
    }
  })

  /* 演讲者窗口里的按键 / 翻页按钮转回来：翻页器插在笔记本上，焦点通常在那一侧 */
  window.addEventListener('message', function (e) {
    var d = e.data
    if (!d || typeof d !== 'object') return
    if (d.type === 'deck-step') {
      show(index + (d.delta || 0))
      return
    }
    if (d.type === 'deck-goto') {
      show(d.index)
      return
    }
    if (d.type === 'deck-key') {
      if (d.key === 'b') {
        if (isOpen(black)) closeLayer(black)
        else openLayer(black)
      } else if (d.key === 's') {
        toggleTimer()
      }
      return
    }
    if (d.type === 'deck-presenter-closed') presenterWin = null
  })

  stage.addEventListener('click', function (e) {
    if (isOpen(help) || isOpen(presenter) || isOpen(black)) return
    if (e.clientX < window.innerWidth * 0.35) show(index - 1)
    else show(index + 1)
  })

  // 放映窗口关掉后演讲者窗口不该单独活下来
  window.addEventListener('beforeunload', closePresenter)

  window.addEventListener('mousemove', poke)
  window.setInterval(paintClock, 500)

  // 页宽随视口变，cqw 字号跟着变，缩好的比例得重算
  var fitTimer = 0
  window.addEventListener('resize', function () {
    window.clearTimeout(fitTimer)
    fitTimer = window.setTimeout(fitActive, 120)
  })

  var fromHash = /^#p(\\d+)$/.exec(location.hash)
  if (fromHash) index = Math.max(0, Math.min(total - 1, parseInt(fromHash[1], 10) - 1))
  slides[index].classList.add('is-active')
  slides[index].setAttribute('aria-hidden', 'false')
  hudPage.textContent = (index + 1) + ' / ' + total
  paintClock()
  fitActive()
  poke()
})()
`
}
