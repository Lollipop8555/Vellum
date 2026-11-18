/**
 * AI 面板的会话视图（P3 落库 / P4 工具循环）。
 *
 * 与 P2 的「试聊」的差别，一句话：**消息按文件落库，关页面重开仍在**。
 * 由此带来两条必须写死的交互口径（ADR §9）：
 *
 * - **切文件不 abort**：回复照常流完、照常落库。流式中面板继续显示原来那个文件的对话
 *   （标题栏写着文件名，不会认错）；回复结束后自动切到当前文件自己的会话。
 * - **切配置 abort + 清空内存**：换 profile 等于换人格与额度，不能把 A 的对话留在 B 下面。
 *   已落库的消息不删，下次回到 A 的配置还能看到。
 *
 * 落库时机：用户消息**发请求前**落（关掉标签页也不丢这句话）；助手消息在**每一轮流结束**
 * （含中断、失败）时整条落一次，中断的带 `incomplete`。流式过程中不逐块写库 ——
 * D-09 要求消息行只追加不改，逐块写就要反复改同一行。
 *
 * P4 的一轮长这样（一次用户发言可以有多轮，§7）：
 *
 * ```
 * 用户 → [助手: 文字? + tool_calls] → [tool × n] → [助手…] → … → 助手(无 tool_calls) 收尾
 * ```
 *
 * 每一段都落库、都成对：`assistant(tool_calls)` 后面必定紧跟它的 `tool` 结果（INV-6）。
 * 循环上限 60 轮、每轮最多 20 次写入；用尽**不静默截断**，而是说清楚为什么停、怎么继续。
 */

import { getLang, t, type MessageKey } from '../../i18n'
import {
  appendMessage,
  createSession,
  deleteSession,
  findSession,
  getSession,
  listSessions,
  loadMessages,
  sessionStatsByWorkspace,
  type ChatMessage,
  type ChatSession,
} from '../../shell/ai/session'
import {
  BUDGET_TOKENS,
  EVENT_PREFIX,
  locator,
  nonce,
  sanitizeWire,
  systemPrompt,
  trimHistory,
} from '../../shell/ai/context'
import { inSubtree, isGrantedBy } from '../../shell/ai/project'
import {
  createToolbox,
  MAX_WRITE_LIMIT,
  toolSchemas,
  type DocHost,
  type Toolbox,
  type ToolEvent,
  type ToolQuota,
  type ToolResult,
} from '../../shell/ai/tools'
import {
  streamChat,
  type StreamEvent,
  type ToolSchema,
  type WireMessage,
  type WireToolCall,
} from '../../shell/ai/transport'
import {
  getConfig,
  listProfiles,
  switchModel,
  unlock,
  unlockedId,
  type ProfileRecord,
} from '../../shell/ai/vault'
import { getSettings, updateSettings } from '../../shell/settings'
import { toast } from '../toast'
import { confirmDialog, openDialog } from '../dialogs'
import { renderMarkdown } from '../markdown'
import { createStreamBody, hydrateDiagrams, type StreamBody } from './md-stream'

export interface ChatTarget {
  id: string
  name: string
}

export interface ChatView {
  /** 文件或配置变了：对齐到当前文件。**不 abort** 在途请求 */
  refresh(): void
  /** 配置锁了 / 换了：abort 并清空内存与 DOM */
  reset(): void
  /**
   * 切换语言后重刷文案。骨架只建一次（流式期间不能重建），所以写死的
   * placeholder / 按钮 title / 空态文案必须自己再套一遍 `t()`。
   * 内部按语言号做幂等：语言没变就什么都不做，可以在每次挂载时无脑调用。
   */
  relabel(): void
  /** 新建会话。入口在**面板标题栏**（`#aiNew`），由 `ai-panel` 转发进来 */
  newSession(): void
  /**
   * 打开历史会话浮层。同样由标题栏转发，并把那颗按钮当锚点传进来 ——
   * 浮层要从**按钮正下方**拉出来，而不是从会话话题那一行冒出来。
   */
  openHistory(anchor?: HTMLElement): void
  /**
   * 打开工作区切换浮层（W-S4）。入口是面板标题栏的 `#aiWorkspace`，
   * 同样把按钮当锚点传进来 —— 浮层要贴着它往下拉。
   */
  openWorkspaces(anchor?: HTMLElement): void
}

export interface ChatOptions {
  host: HTMLElement
  /** 当前打开的文件；读由 app 注入，本模块不反向依赖 app（避免循环导入） */
  getTarget(): ChatTarget | null
  /**
   * 文档读写入口。`null` = 当前环境不给工具（只发文字），
   * 例如 P4 上线前的老路径或没注入 host 的测试。
   */
  docHost?: DocHost | null
  /** 状态按钮里的「管理配置」：把面板切到凭据区（由 `ai-panel` 提供） */
  onManage?: () => void
  /** 配置被本模块改过（换方案 / 换模型）：让凭据区重新读一遍列表 */
  onConfigChange?: () => void
}

/** 缺省参数：设置里没存过就用这个，不主动写进 localStorage（见 types.ts 的注释） */
/**
 * 默认输出上限。1024 连一个几百行的文件都装不下：`write_file` 的 arguments 会被
 * 拦腰截断，落到工具层就是「参数不是合法 JSON」—— 模型无从知道是被截断，只能反复重试。
 * 8192 能覆盖「一次写一个中等文件」，更大的文件靠 read_file + apply_edits 分批。
 */
const AI_DEFAULTS = { maxTokens: 8192, temperature: 0.7 }
/** 首屏最多画这么多条：更早的只给一行「已省略」，不做分页 */
const MAX_RENDERED = 200
/**
 * 一次用户发言内最多几轮工具循环（§7）。到顶就停并让用户说「继续」。
 *
 * 20 轮听着很多，实际一轮只干一件事：read → 改 → 跑一下验证 → 再修一处。
 * 写个小单元测试就要 8-10 轮，20 轮在第 3 个文件就见底，用户体感是
 * 「话没说完就被掐断」。放到 60：够收尾，也还留着兜底不至于无限跑。
 */
const MAX_ROUNDS = 60
/** 每轮用户发言内最多写几次文档（§7）—— 与工具层同一个来源，回给模型的 limit 才对得上 */
const MAX_WRITES = MAX_WRITE_LIMIT
/** 粘底阈值：离底 48px 以内算「还在看最新一条」 */
const STICK_SLOP = 48
/**
 * 发送 / 停止的图标。用描边 SVG 而不是「发送」「停止」两串字：
 * 按钮只有 32px 宽，文字要么被截断、要么跟着语言换宽度，图标两态还分得开。
 * 线宽 1.6、圆头收口，和标题栏、抽屉里那套图标同一风格。
 */
const ICON_SEND = `<svg viewBox="0 0 20 20" aria-hidden="true">
  <path d="M10 15.6V4.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M5.4 9.4 10 4.8l4.6 4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
const ICON_STOP = `<svg viewBox="0 0 20 20" aria-hidden="true">
  <rect x="6.4" y="6.4" width="7.2" height="7.2" rx="1.4" fill="currentColor"/>
</svg>`
/** 授权入口的文件夹图标，同样是 1.6 线宽的描边风格 */
const ICON_FOLDER = `<svg viewBox="0 0 20 20" aria-hidden="true">
  <path d="M3.4 6.2a1.4 1.4 0 0 1 1.4-1.4h2.6l1.5 1.6h6.3a1.4 1.4 0 0 1 1.4 1.4v6.4a1.4 1.4 0 0 1-1.4 1.4H4.8a1.4 1.4 0 0 1-1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
</svg>`
/**
 * 联网开关：地球 + 经线。用图标而不是「联网 开」两个字——
 * 状态栏本来就窄，文字 chip 会把「方案 · 模型」挤没；点亮/变灰本身就能读出状态。
 */
const ICON_NETWORK = `<svg viewBox="0 0 20 20" aria-hidden="true">
  <circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M3.4 10h13.2" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M10 3.4c1.9 1.9 2.9 4.1 2.9 6.6S11.9 14.7 10 16.6C8.1 14.7 7.1 12.5 7.1 10S8.1 5.3 10 3.4z" fill="none" stroke="currentColor" stroke-width="1.5"/>
</svg>`
/** 脚本开关：尖括号 + 斜杠 */
const ICON_SCRIPT = `<svg viewBox="0 0 20 20" aria-hidden="true">
  <path d="M7.2 5.6 3.4 10l3.8 4.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M12.8 5.6 16.6 10l-3.8 4.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M11.4 4.4 8.6 15.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`
/** 取消授权：叉号。与标题栏、浮层里那套 1.6 线宽同规格 */
const ICON_CLOSE = `<svg viewBox="0 0 20 20" aria-hidden="true">
  <path d="M5.8 5.8 14.2 14.2M14.2 5.8 5.8 14.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`

interface Ui {
  box: HTMLElement
  title: HTMLElement
  meta: HTMLElement
  log: HTMLElement
  input: HTMLTextAreaElement
  /** 输入框的圆角外壳：滚动条要压在它里面才不切角（见 `.ai-chat-field`） */
  field: HTMLElement
  send: HTMLButtonElement
  status: HTMLButtonElement
  /** 状态栏那行字（方案 · 模型），单独一个节点，换模型时只改它 */
  statusText: HTMLElement
  /** 发送键二选一：回车 / ⌘+回车 */
  keyEnter: HTMLButtonElement
  keyMod: HTMLButtonElement
  /** 状态栏左侧的文件夹图标：点开管理 AI 授权列表（S3） */
  grants: HTMLButtonElement
  /** 联网 / 脚本状态 chip（P-11）：常驻可见，点一下切换 */
  netChip: HTMLButtonElement
  scriptChip: HTMLButtonElement
  /** 同时只允许开一个浮层；`null` 表示都关着 */
  pop: HTMLElement | null
  /** 关浮层时要顺手摘掉的 document 监听 */
  unpop: (() => void) | null
}

interface Shown {
  workspaceId: string
  session: ChatSession | null
  messages: ChatMessage[]
  /** 因为超过 `MAX_RENDERED` 而没画出来的条数 */
  hidden: number
}

/** 一次在途请求。DOM 与库两边都要收尾，所以把两者都挂在这里 */
interface Run {
  sessionId: string
  /** 这一轮是给哪个工作区发的：收尾时据此判断用户有没有切走 */
  workspaceId: string
  abort: AbortController
  /** 当前这一轮的正文容器（每轮新开一个 turn 节点） */
  turn: HTMLElement | null
  body: StreamBody | null
  reasoning: ReasoningSink | null
  /** 本次发言已经流出来的全部文字（多轮累加，只用于「有没有说过话」的判断） */
  text: string
  usage: string
  failed: boolean
  error: string
  /** 已经用掉的轮数与写入额度 */
  rounds: number
  quota: ToolQuota
  /** 停下来的原因：'' = 正常结束 */
  stopped: '' | 'rounds' | 'budget'
}

let opts: ChatOptions | null = null
let ui: Ui | null = null
let owner: string | null = null
let shown: Shown | null = null
let run: Run | null = null
let sending = false
/**
 * 用户手动选定的会话：`undefined` = 跟随「该文件最近一条」，`null` = 刚点了「新建会话」
 * （还没落库），字符串 = 从历史里挑中的那一条。
 *
 * 不能只靠 `shown.session` 表达：`align()` 每次都要回库里找，若没有这个「意图」标记，
 * 刷新或切回面板就会把「新建的空会话」又换回最近一条旧会话。
 */
let activeId: string | null | undefined = undefined
/** `activeId` 是给哪个工作区选的：换工作区必须丢弃（否则会拿 A 的会话去显示 B） */
let activeWorkspace = ''

/** 本次打开面板后用户主动选过的工作区（切换浮层 / 列表）；切回别的就丢（W-S4） */
let pickedWorkspace: string | undefined

/**
 * 当前工作区 id；库里一个工作区都没有时为空串（面板此时显示工作区列表）。
 *
 * 优先级：本次选中的 > 上次记住的（`settings.aiLastWorkspace`）> 当前文件所属的。
 * 前两个都要先确认**还在**：工作区被删掉后不能拿一个死 id 去查会话（W-10）。
 *
 * 会话归属工作区、不跟随文件（W-01）：在同一个工作区里切文件不换会话。
 */
function currentWorkspaceId(): string {
  const list = opts?.docHost?.listWorkspaces?.() ?? []
  const alive = (id: string | undefined): string =>
    id && list.some((workspace) => workspace.id === id) ? id : ''
  const target = opts?.getTarget()
  return (
    alive(pickedWorkspace) ||
    alive(getSettings().aiLastWorkspace) ||
    (target ? opts?.docHost?.workspaceOf?.(target.id) ?? '' : '') ||
    ''
  )
}

/** 记住选择（W-10：下次打开面板回到同一个工作区；目标被删则自动回落） */
function rememberWorkspace(id: string): void {
  pickedWorkspace = id
  if (getSettings().aiLastWorkspace !== id) updateSettings({ aiLastWorkspace: id })
}
/** 状态栏里的方案名（配置名）；异步读，读到再重画那一行 */
let planName = ''
/** 读库的世代号：慢查询回来时文件可能已经换过两次 */
let alignGen = 0
/** 重画的世代号：异步 Markdown 渲染回来时容器可能已经被清空 */
let paintGen = 0
/** 上一次套文案时的语言：骨架只在 `build()` 里写死一次文案，切语言靠它判断要不要重刷 */
let lastLang = getLang()
/**
 * 历史浮层的锚点 = 面板标题栏那颗「历史」按钮。它由 `ai-panel` 转发进来
 * （chat 模块不该自己去 `getElementById` 摸壳层的 DOM）。
 * 记住是为了删会话后重新打开浮层时还能贴着同一颗按钮。
 */
let historyAnchor: HTMLElement | null = null

export function createChatView(options: ChatOptions): ChatView {
  opts = options
  return { refresh, reset, relabel, newSession, openHistory, openWorkspaces }
}

/**
 * 切语言后重刷文案。
 *
 * 骨架不能重建（流式中的回复节点会一起没），所以 `build()` 里写死的 placeholder、
 * 按钮 title、消息里的「你 / 工具名 / 中断标记」都得自己再套一遍 `t()`。
 * 语言没变就直接返回：这个方法在每次挂载时都会被调用。
 */
function relabel(): void {
  const lang = getLang()
  if (lang === lastLang) return
  lastLang = lang
  if (!ui) return
  ui.input.placeholder = t('ai.chat.placeholder')
  // 授权入口的 tooltip 也是骨架里写死的：不补这一句，切到英文后悬停还是中文
  ui.grants.title = t('ai.grant.panelTitle')
  ui.grants.setAttribute('aria-label', ui.grants.title)
  // 消息里也有逐条 `t()` 出来的字：整屏重画一次最省事，也不会漏掉折叠节点
  paint()
}

/* ------------------------------------------------------------------ 骨架 */

function refresh(): void {
  if (!opts) return
  if (!getConfig()) {
    reset()
    return
  }
  const id = unlockedId()
  if (owner !== id) {
    // 换配置：abort + 清空（消息已在库里，不丢）
    reset()
    owner = id
  }
  if (!ui) build()
  void refreshPlan()
  void align()
  void loadWsStats()
}

function reset(): void {
  run?.abort.abort()
  run = null
  sending = false
  owner = null
  shown = null
  activeId = undefined
  activeWorkspace = ''
  alignGen += 1
  paintGen += 1
  closePop()
  ui = null
  if (opts) opts.host.textContent = ''
}

/**
 * 骨架：**顶栏（话题 + 新建 + 历史）/ 消息区 / 输入框 / 状态栏**，四段纵向排。
 *
 * 顶栏与状态栏固定，只有消息区滚 —— 面板本身（`aside` 里的槽位）也跟着滚的话，
 * 流式时每来一段字整页都会跳。
 */
function build(): void {
  const host = opts?.host
  if (!host) return
  host.textContent = ''

  const box = div('ai-chat-box')

  // 头只留话题：新建 / 历史是**面板标题栏**的按钮（和预览、检查面板同一套位置）
  const head = div('ai-chat-head')
  const heading = div('ai-chat-heading')
  const title = div('ai-chat-title')
  const meta = div('ai-chat-meta')
  heading.append(title, meta)
  head.append(heading)

  const log = div('ai-chat-log')

  // 圆角画在外壳上：textarea 自己出现滚动条时，滚动条会把它右角的弧盖成直角
  const composer = div('ai-chat-composer')
  const field = div('ai-chat-field')
  const input = document.createElement('textarea')
  input.className = 'dialog-textarea ai-chat-input'
  // 一屏就给三行的空间：只露一行看起来像「随手写一句」，而不是会话输入框
  input.rows = 3
  input.placeholder = t('ai.chat.placeholder')
  field.append(input)

  const submit = document.createElement('button')
  submit.type = 'button'
  submit.className = 'btn btn-primary ai-chat-send'
  composer.append(field, submit)

  const statusBar = div('ai-chat-statusbar')
  const status = document.createElement('button')
  status.type = 'button'
  status.className = 'ai-chat-status'
  const statusText = div('ai-chat-status-text')
  status.append(statusText, div('ai-chat-status-caret', '▾'))
  // 状态栏右端：发送键二选一。放在这儿是因为它和「方案·模型」一样，是输入框的配置
  const keys = div('ai-sendkey')
  const keyEnter = sendKeyOption('enter')
  const keyMod = sendKeyOption('mod')
  keys.append(keyEnter, keyMod)
  // 授权入口：文件夹图标，紧挨「方案·模型」左侧；点开管理当前 AI 授权列表
  const grants = document.createElement('button')
  grants.type = 'button'
  grants.className = 'ai-chat-grants'
  grants.title = t('ai.grant.panelTitle')
  grants.setAttribute('aria-label', t('ai.grant.panelTitle'))
  grants.innerHTML = ICON_FOLDER
  // 联网 / 脚本开关常驻在输入框下方（P-11）：不用翻浮层就知道模型现在能不能联网、能不能跑脚本
  const flags = div('ai-flags')
  const netChip = flagChip('network')
  const scriptChip = flagChip('script')
  flags.append(netChip, scriptChip)
  statusBar.append(grants, flags, status, keys)

  box.append(head, log, composer, statusBar)
  host.append(box)

  ui = {
    box,
    title,
    meta,
    log,
    input,
    field,
    send: submit,
    status,
    statusText,
    keyEnter,
    keyMod,
    grants,
    netChip,
    scriptChip,
    pop: null,
    unpop: null,
  }
  lastLang = getLang()
  paintHead()
  void refreshPlan()

  submit.addEventListener('click', () => {
    if (run) {
      run.abort.abort()
      return
    }
    void send()
  })
  grants.addEventListener('click', () => void toggleGrants())
  status.addEventListener('click', () => void toggleStatus())
  input.addEventListener('input', () => autosize(input))
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    // 输入法组字期间的回车是在选词，不能当成发送
    if (e.isComposing) return
    // 发送键由用户在状态栏里选：默认 ⌘/Ctrl+Enter（回车只换行），
    // 选成「回车发送」时 Shift+Enter 保留换行
    const sendable = sendMode() === 'enter' ? !e.shiftKey : e.metaKey || e.ctrlKey
    if (!sendable) return
    e.preventDefault()
    e.stopPropagation()
    if (!run) void send()
  })
  // rows=3 只是初始高度，进 DOM 后按实际内容再量一次（字体大小可能被设置改过）
  autosize(input)
}

/** 当前选定的发送键：`enter` = 回车发送，`mod` = ⌘/Ctrl+Enter 发送 */
function sendMode(): 'enter' | 'mod' {
  return getSettings().aiSendKey === 'enter' ? 'enter' : 'mod'
}

/**
 * 回车键的图标：**画**一个 20×20 的定宽描边箭头，而不是打一个 `↵`。
 *
 * 字符版的毛病是观感不由我们决定：`↵` 在部分系统上会掉进 emoji 字体，又小又灰，
 * 字宽还随字号/字体回退漂移。这里线宽、圆角、留白都是定值，和标题栏那套图标同规格。
 */
const ICON_ENTER = `<svg viewBox="0 0 20 20" aria-hidden="true">
  <path d="M15 4.6v5.6a2 2 0 0 1-2 2H7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  <path d="M9.4 8.8 5.8 12.2l3.6 3.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

/**
 * 修饰键的字面：macOS 是 `⌘`，其它平台是 `Ctrl`。
 *
 * 只取决于平台、**不跟语言变** —— 这个控件的字形不该在切中英文时换一副样子。
 * 翻译只走 `title` / `aria-label`（见 `paintSendKey`）。
 */
const MOD_KEY = /Mac|iPhone|iPad|iPod/i.test(
  `${navigator.platform ?? ''} ${navigator.userAgent}`,
)
  ? '⌘'
  : 'Ctrl'

/** 状态栏右端的二选一按钮：字形与语言无关，title 才是说明 */
function sendKeyOption(mode: 'enter' | 'mod'): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = 'ai-sendkey-opt'
  node.dataset.mode = mode
  if (mode === 'mod') {
    const chip = document.createElement('span')
    chip.className = 'ai-sendkey-mod'
    chip.textContent = MOD_KEY
    node.append(chip)
  }
  node.insertAdjacentHTML('beforeend', ICON_ENTER)
  node.addEventListener('click', () => {
    updateSettings({ aiSendKey: mode })
    paintSendKey()
    ui?.input.focus()
  })
  return node
}

/* ------------------------------------------------------------------ 对齐到当前文件 */

/** `force` 用于「刚写完库」：库是权威，DOM 必须跟着重新读 */
async function align(force = false): Promise<void> {
  if (!opts || !ui) return
  const workspaceId = currentWorkspaceId()
  // 流式中不动：DOM 里那条正在长，重画会把它的半截抹掉
  if (run && !force) return
  if (!force && shown && shown.workspaceId === workspaceId) return

  // 换了工作区就丢掉「上次选的是哪条」：跨工作区沿用会张冠李戴
  if (workspaceId !== activeWorkspace) {
    activeWorkspace = workspaceId
    activeId = undefined
  }

  const gen = ++alignGen
  let session: ChatSession | null = null
  let messages: ChatMessage[] = []
  try {
    if (activeId === null) {
      // 用户刚点了「新建会话」：库里有旧的也不取，就让这一屏空着
      session = null
    } else {
      session = activeId ? await getSession(activeId) : await findSession(workspaceId)
      if (session) messages = await loadMessages(session.id)
    }
  } catch {
    if (ui) ui.log.append(note(t('ai.err.io'), 'ai-chat-note is-err'))
    return
  }
  if (gen !== alignGen || !ui) return

  const hidden = Math.max(0, messages.length - MAX_RENDERED)
  shown = { workspaceId, session, messages: messages.slice(-MAX_RENDERED), hidden }
  paint()
}

/* ------------------------------------------------------------------ 画 */

function paint(): void {
  if (!ui) return
  const gen = ++paintGen
  ui.log.textContent = ''

  const session = shown?.session ?? null
  if (shown && shown.hidden > 0) {
    ui.log.append(note(t('ai.chat.hidden', { count: shown.hidden }), 'ai-chat-note'))
  }
  if (!shown || !session || shown.messages.length === 0) {
    // 没有任何工作区时，面板默认显示工作区列表（W-10）：入口不能只藏在标题栏那颗按钮里
    ui.log.append(
      currentWorkspaceId()
        ? div('ai-chat-empty', t('ai.chat.empty'))
        : workspaceListNode(),
    )
  } else {
    for (const message of shown.messages) ui.log.append(messageNode(message, gen))
  }
  // 流式中的那条挂在最后：它还没落库，是唯一的「活」节点
  if (run && session && run.sessionId === session.id && run.turn) ui.log.append(run.turn)

  paintHead()
  stickBottom(true)
}

function paintHead(): void {
  if (!ui) return
  const session = shown?.session ?? null
  // 条数按「已画 + 省略」算，不读 session.messageCount：流式中刚发出去的那条
  // 还没进库统计，读库会让标题栏写着「0 条」而下面明明有话
  const count = shown ? shown.messages.length + shown.hidden : 0
  ui.title.textContent = session?.title || t('ai.chat.untitled')
  ui.title.title = session?.title || ''
  // 会话归工作区（W-01 / W-S3）：第一段说**工作区名**。没有工作区的过渡态退回当前文件名，
  // 否则这里会是一条光秃秃的「· 3 条」，看不出这是什么范围的对话。
  const workspaceId = currentWorkspaceId()
  const scope =
    opts?.docHost?.listWorkspaces?.().find((workspace) => workspace.id === workspaceId)?.name ||
    opts?.getTarget()?.name ||
    t('ai.chat.noFile')
  ui.meta.textContent = `${scope} · ${
    session ? t('ai.chat.count', { count }) : t('ai.chat.untitled')
  }`
  // 发送按钮是箭头图标：语言无关，切语言时改的是 title / aria
  ui.send.innerHTML = run ? ICON_STOP : ICON_SEND
  ui.send.title = run ? t('ai.chat.stop') : t('ai.chat.send')
  ui.send.setAttribute('aria-label', ui.send.title)
  ui.send.classList.toggle('is-stop', Boolean(run))
  paintStatus()
  paintSendKey()
  paintFlags()
}

/**
 * 联网 / 脚本 chip：一眼看到当前状态，点一下就地切换（P-11）。
 * 切换只改设置，不改本轮已下发的工具表 —— 下一次请求才生效，这和浮层里的勾选一致。
 */
function flagChip(kind: 'network' | 'script'): HTMLButtonElement {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'ai-flag'
  chip.dataset.flag = kind
  chip.innerHTML = kind === 'network' ? ICON_NETWORK : ICON_SCRIPT
  chip.addEventListener('click', () => {
    const settings = getSettings()
    if (kind === 'network') updateSettings({ aiNetwork: settings.aiNetwork === false })
    else updateSettings({ aiScript: settings.aiScript !== true })
    paintFlags()
    announceFlag(kind)
  })
  return chip
}

function paintFlags(): void {
  if (!ui) return
  const settings = getSettings()
  const network = settings.aiNetwork !== false
  const script = settings.aiScript === true
  const pairs: Array<[HTMLButtonElement, 'network' | 'script', boolean]> = [
    [ui.netChip, 'network', network],
    [ui.scriptChip, 'script', script],
  ]
  for (const [chip, kind, on] of pairs) {
    const label = kind === 'network' ? t('ai.flag.network') : t('ai.flag.script')
    // 图标态：亮 = 开、灰虚线 = 关；名字和状态只进 tooltip，不再占宽度
    chip.classList.toggle('is-off', !on)
    chip.title = t('ai.flag.title', {
      name: label,
      state: t(on ? 'ai.flag.stateOn' : 'ai.flag.stateOff'),
    })
    chip.setAttribute('aria-label', chip.title)
    chip.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
}

/** 切换开关后提醒一次：说明这改变的是「模型能做什么」，不是这一条消息的开关 */
function announceFlag(kind: 'network' | 'script'): void {
  const on = kind === 'network' ? getSettings().aiNetwork !== false : getSettings().aiScript === true
  const name = kind === 'network' ? t('ai.flag.network') : t('ai.flag.script')
  toast(t(on ? 'ai.flag.turnedOn' : 'ai.flag.turnedOff', { name }))
}

/** 新开会话时把两个开关的状态说一遍（P-11：开会话提醒一次），避免「以为能联网其实关着」 */
function announceFlags(): void {
  const settings = getSettings()
  const flags = [
    `${t('ai.flag.network')} ${settings.aiNetwork !== false ? t('ai.flag.on') : t('ai.flag.off')}`,
    `${t('ai.flag.script')} ${settings.aiScript === true ? t('ai.flag.on') : t('ai.flag.off')}`,
  ].join(' · ')
  toast(t('ai.flag.sessionHint', { flags }))
}

/** 状态栏那行：「方案名 · 模型」。放在输入框下面，随时能看出现在是谁在答 */
function paintStatus(): void {
  if (!ui) return
  const model = getConfig()?.model ?? ''
  const label = [planName, model].filter(Boolean).join(' · ')
  ui.statusText.textContent = label || t('ai.chat.statusEmpty')
  ui.status.title = t('ai.chat.statusHint')
  ui.status.hidden = false
  paintGrants()
}

/**
 * 授权按钮：**有引用才点亮**，条数写进 tooltip。
 *
 * 自动引用（§8.4 第 7 步）加完后要立刻反映到这里，否则用户点开浮层才发现多了东西，
 * 会以为是别处改的。
 */
function paintGrants(): void {
  if (!ui) return
  // 数**当前工作区**的引用，不是「库里的第一个」：多工作区下那颗按钮点开了
  // 才不会是别人家的清单（W-S5 顺手收掉的旧语义）
  const workspaceId = currentWorkspaceId()
  const count = workspaceId
    ? (opts?.docHost?.workspace?.(workspaceId)?.root.aiWorkspace?.grants.length ?? 0)
    : 0
  ui.grants.classList.toggle('is-on', count > 0)
  ui.grants.dataset.count = String(count)
  const label = count ? `${t('ai.grant.panelTitle')} · ${count}` : t('ai.grant.panelTitle')
  ui.grants.title = label
  ui.grants.setAttribute('aria-label', label)
}

/** 状态栏右端的发送键：选中的那颗点亮，另一颗只留字形 */
function paintSendKey(): void {
  if (!ui) return
  const mode = sendMode()
  const options: ReadonlyArray<[HTMLButtonElement, 'enter' | 'mod']> = [
    [ui.keyEnter, 'enter'],
    [ui.keyMod, 'mod'],
  ]
  for (const [node, value] of options) {
    const on = mode === value
    node.classList.toggle('is-on', on)
    const label = t(value === 'enter' ? 'ai.sendkey.enter' : 'ai.sendkey.mod')
    node.title = label
    node.setAttribute('aria-label', label)
    node.setAttribute('aria-pressed', String(on))
  }
}

function messageNode(message: ChatMessage, gen: number): HTMLElement {
  const turn = document.createElement('div')
  turn.className = `ai-turn is-${message.role}`

  if (message.role === 'user') {
    turn.append(div('ai-turn-role', t('ai.chat.you')))
    const body = div('ai-turn-text')
    // 用户输入的永远是纯文本：把它当 Markdown 解析会把 `*` 和 `_` 吃掉
    body.textContent = message.text
    turn.append(body)
    return turn
  }

  // 工具结果：一行摘要 + 折叠的原始 JSON/文本。摘要给眼睛，原文给想深挖的人
  if (message.role === 'tool') {
    const view = toolView(message.name ?? '', message.text)
    const box = document.createElement('details')
    box.className = `ai-tool${view.ok ? '' : ' is-err'}`
    const summary = document.createElement('summary')
    summary.className = 'ai-tool-head'
    summary.textContent = `${toolLabel(message.name ?? '')} · ${view.summary}`
    const pre = document.createElement('pre')
    pre.className = 'ai-tool-body'
    pre.textContent = view.detail
    box.append(summary, pre)
    turn.append(box)
    return turn
  }

  // 系统事件（P-06）：cp 的可见记录。不是折叠的 tool 结果，也不是 AI 说的话，
  // 独占一行、写明来源与目标，让用户一眼看出「刚才真的复制了文件」
  if (message.role === 'event') {
    turn.append(div('ai-event', message.text))
    return turn
  }

  // 助手：可能带着「我调了哪些工具」和一段文字（只有工具没文字也是正常形态）
  if (message.toolCalls?.length) {
    turn.append(
      div(
        'ai-tool-chips',
        message.toolCalls.map((call) => toolLabel(call.function.name)).join(' · '),
      ),
    )
  }
  // 思维链排在正文之前：它就是「想」在「说」前面
  if (message.reasoning?.trim()) turn.append(reasoningNode(message.reasoning))
  if (!message.text.trim()) {
    if (message.incomplete) turn.append(note(t('ai.chat.incomplete'), 'ai-chat-note'))
    return turn
  }

  const body = div('ai-md markdown-body')
  turn.append(body)
  void renderMarkdown(message.text).then(async (html) => {
    if (gen !== paintGen || !body.isConnected) return
    body.innerHTML = html
    await hydrateDiagrams(body)
  })
  if (message.incomplete) turn.append(note(t('ai.chat.incomplete'), 'ai-chat-note'))
  return turn
}

/** 工具名 → 人类可读的一行（未登记的插件式工具名原样显示，别把真名藏起来） */
const TOOL_LABELS: Record<string, MessageKey> = {
  read_doc: 'ai.tool.read_doc',
  apply_edits: 'ai.tool.apply_edits',
  replace_doc: 'ai.tool.replace_doc',
  get_state: 'ai.tool.get_state',
  read_file: 'ai.tool.read_file',
  write_file: 'ai.tool.write_file',
  mkdir: 'ai.tool.mkdir',
  rm: 'ai.tool.rm',
  mv: 'ai.tool.mv',
}

function toolLabel(name: string): string {
  const key = TOOL_LABELS[name]
  return key ? t(key) : name
}

/** 工具详情最多画这么长：一次 read_doc 可以有 16K 字符，全塞进 DOM 会拖垮长会话 */
const TOOL_DETAIL_LIMIT = 2000

interface ToolView {
  ok: boolean
  summary: string
  detail: string
}

/**
 * 结果正文 → 一行摘要。只解析**第一行**：read_doc 的正文里还跟着编号原文，
 * 整段 JSON.parse 一定失败，而头部元信息正好在第一行。
 */
function toolView(name: string, content: string): ToolView {
  const detail =
    content.length > TOOL_DETAIL_LIMIT
      ? `${content.slice(0, TOOL_DETAIL_LIMIT)}\n…（共 ${content.length} 字符）`
      : content

  let head: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(content.slice(0, content.indexOf('\n') + 1 || content.length))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      head = parsed as Record<string, unknown>
    }
  } catch {
    head = null
  }

  if (head && typeof head.error === 'string') {
    const message = typeof head.message === 'string' ? head.message : ''
    return { ok: false, summary: message ? `${head.error} · ${message}` : head.error, detail }
  }
  if (name === 'read_doc' && head) {
    return {
      ok: true,
      summary: t('ai.chat.toolRead', {
        from: String(head.fromLine ?? 0),
        to: String(head.toLine ?? 0),
        total: String(head.totalLines ?? 0),
      }),
      detail,
    }
  }
  if ((name === 'apply_edits' || name === 'replace_doc') && head) {
    return { ok: true, summary: t('ai.chat.toolWrote', { rev: String(head.rev ?? 0) }), detail }
  }
  if (name === 'get_state' && head) {
    return {
      ok: true,
      summary: `${String(head.file ?? '')} · ${t('ai.chat.count', { count: Number(head.lines ?? 0) })}`,
      detail,
    }
  }
  return { ok: true, summary: t('ai.chat.toolOk'), detail }
}

/** 工具刚跑完时的就地渲染：不等收尾重画，用户先看到发生了什么 */
function paintToolTurn(call: WireToolCall, result: ToolResult): void {
  if (!ui) return
  const pseudo: ChatMessage = {
    id: `live-${call.id}`,
    sessionId: shown?.session?.id ?? '',
    lastChat: null,
    seq: 0,
    role: 'tool',
    text: result.content,
    chars: result.content.length,
    tokens: 0,
    toolCallId: call.id,
    name: call.function.name,
    createdAt: Date.now(),
  }
  ui.log.append(messageNode(pseudo, paintGen))
  stickBottom(true)
}

/**
 * 只补上刚发出去的那一条用户消息。
 * 用整屏 `paint()` 也能达到同样效果，但会把历史消息的 Markdown 重新解析一遍，
 * 每发一句就重解析一次，长会话下肉眼可见地卡。
 */
function paintUserTurn(message: ChatMessage): void {
  if (!ui) return
  ui.log.querySelector('.ai-chat-empty')?.remove()
  ui.log.append(messageNode(message, paintGen))
  paintHead()
  stickBottom(true)
}

/* ------------------------------------------------------------------ 发送 */

/** 一次用户发言的固定环境：配置 + 参数 + 工具宿主，整个循环内不变 */
interface TurnEnv {
  baseUrl: string
  apiKey: string
  model: string
  /**
   * `undefined` = **不传**（不是 0）。
   *
   * 新版模型普遍把 `temperature` 标成 deprecated，发了就 400；用户没在设置里显式填过就别发，
   * 让 provider 用自己的默认值。设置里填了 0 也是合法值，所以这里不能拿 0 当「没设」。
   */
  temperature?: number
  maxTokens: number
  showReasoning: boolean
  /** `null` = 不传 tools（没有文档宿主），退化成纯对话 */
  toolbox: Toolbox | null
  docHost: DocHost | null
}

/**
 * 发消息前把当前打开的文件纳入引用（W-04 / §8.4）。
 *
 * 顺序固定：已在 `:proj` 子树内 → 跳过；已被现有授权覆盖 → 跳过；否则加进 `:link`
 * 并回一条可见事件。**不加就发**是错的：`read_doc`、选区、光标都走「当前打开文件」
 * 通道，只有文件同时进了引用集，模型才能既拿到全文又拿到光标上下文。
 *
 * 重复发消息不该堆一串同样的授权：`isGrantedBy` 会沿祖先链判定，第二句就跳过了。
 */
async function autoReference(
  target: ChatTarget | null,
  workspaceId: string,
  sessionId: string,
): Promise<ChatMessage | null> {
  const docHost = opts?.docHost
  if (!docHost?.grantRef || !target || !workspaceId) return null
  const view = docHost.workspace?.(workspaceId) ?? null
  if (!view) return null
  if (inSubtree(target.id, view.root.id, view.nodes)) return null
  const grants = (view.root.aiWorkspace?.grants ?? []).map((grant) => grant.refId)
  if (isGrantedBy(target.id, grants, view.nodes)) return null

  let added = false
  try {
    added = await docHost.grantRef(target.id, workspaceId)
  } catch {
    added = false
  }
  if (!added) return null
  paintGrants()

  try {
    return await appendMessage({
      sessionId,
      role: 'event',
      text: t('ai.grant.auto', { name: target.name, ws: view.root.name }),
    })
  } catch {
    // 事件没落上不影响这一轮：引用已经加进去了，模型照样能读到
    return null
  }
}

async function send(): Promise<void> {
  if (!opts || !ui || run || sending) return
  const config = getConfig()
  if (!config) return
  const text = ui.input.value.trim()
  if (!text) return

  const target = opts.getTarget()
  let workspaceId = currentWorkspaceId()
  const docHost = opts.docHost ?? null
  const env: TurnEnv = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    // 没填过就 undefined：连 400 都不会出现，不用等自愈
    temperature: optionalNumber(getSettings().aiTemperature, 0, 2),
    maxTokens: clampNumber(getSettings().aiMaxTokens, AI_DEFAULTS.maxTokens, 1, 32768),
    // **默认显示**：思维链是最直白的「它在干活」的证据，关掉只会让首字前的十几秒
    // 像卡死（用户反馈过「回复显得很慢」，其实是在默默思考）。想清净的人去参数里关。
    showReasoning: getSettings().aiReasoning !== false,
    toolbox: docHost ? createToolbox(docHost) : null,
    docHost,
  }

  sending = true
  ui.input.value = ''
  autosize(ui.input)
  let current: Run | null = null
  try {
    // 没选工作区也能直接发（别逼人先去列表里点一下）：发出去这一刻补建一个。
    // 会话必须有归属 —— 落在空 workspaceId 上的会话既没有工具、也不引用文件，
    // 等于把「AI 什么也做不了」包装成了一次正常回复。
    if (!workspaceId) {
      const created = await docHost?.createWorkspace?.()
      if (!created) throw new Error('workspace-unavailable')
      workspaceId = created.id
      rememberWorkspace(workspaceId)
      activeWorkspace = workspaceId
      activeId = undefined
      shown = null
    }
    let session = shown && shown.workspaceId === workspaceId ? shown.session : null
    if (!session) {
      session = await createSession({ workspaceId })
      // 记住这一条：「新建」的空屏到这里才真正有了会话，不记的话 align 会退回去挑库里最新的
      activeWorkspace = workspaceId
      activeId = session.id
      shown = { workspaceId, session, messages: [], hidden: 0 }
      paint()
    }
    const sessionId = session.id

    // 先落库再发请求：此刻关掉标签页，这句话也还在
    const userMessage = await appendMessage({ sessionId, role: 'user', text })
    const view: Shown =
      shown && shown.session?.id === sessionId
        ? shown
        : { workspaceId, session, messages: [], hidden: 0 }
    view.messages.push(userMessage)
    shown = view
    // 发出去就该看见。不整屏 `paint()`：那会把已有历史里的 Markdown 全部重新解析一遍
    paintUserTurn(userMessage)

    // §8.4 固定顺序：用户消息落库之后、组装 wire 之前，把当前文件纳入引用。
    // 事件消息也进 view.messages，否则这一轮的上下文里没有「刚引用了什么」。
    const autoRef = await autoReference(target, workspaceId, sessionId)
    if (autoRef) {
      view.messages.push(autoRef)
      if (ui) {
        ui.log.append(messageNode(autoRef, paintGen))
        stickBottom(true)
      }
    }

    const abort = new AbortController()
    current = {
      sessionId,
      workspaceId,
      abort,
      turn: null,
      body: null,
      reasoning: null,
      text: '',
      usage: '',
      failed: false,
      error: '',
      rounds: 0,
      // 额度按「一次用户发言」重置：换一句就重新给满
      // 前缀用的是工作区 id（W-07），与会话 id 无关
      quota: { writesLeft: MAX_WRITES, workspaceId },
      stopped: '',
    }
    run = current
    paintHead()

    // 位置块只挂在**最后一条**用户消息上：历史里那些早就过期，带上既费钱又会误导
    const tag = nonce()
    const history = view.messages.map(toWire)
    const last = history.length - 1
    if (last >= 0 && history[last].role === 'user') {
      history[last] = { role: 'user', content: withLocator(text, env.docHost, tag) }
    }

    await converse(current, history, env)
  } catch {
    // 建会话 / 落用户消息失败：话没发出去，把字还给用户
    if (ui && !ui.input.value) ui.input.value = text
    if (ui) ui.log.append(note(t('ai.err.io'), 'ai-chat-note is-err'))
  } finally {
    sending = false
  }

  const finished = current
  if (!finished) return
  if (run === finished) run = null
  if (!ui) return

  // 期间换了工作区 / 点了「新建」/ 切到别的会话：这一轮的 DOM 已经不属于当前视图，
  // 只能整屏从库里重读一次（也用不着在这上面省）。
  // 注意只比较工作区：同一工作区内切文件不打断本轮。
  const switched =
    currentWorkspaceId() !== finished.workspaceId ||
    shown?.session?.id !== finished.sessionId
  if (switched) {
    await align(true)
    return
  }

  // 没换：**不整屏重画**。DOM 里就是这一轮（含工具循环各轮）的 live turn，
  // 内容与刚落库的行一致；重画要把所有历史消息的 Markdown 重新解析一遍，
  // 一段长会话每次答完都能看到一次明显停顿（用户反馈「回复显得很慢」）。
  // 唯一会变的是标题 —— 首条用户消息刚把标题写进会话行，重读这一行就够。
  if (shown?.session) {
    shown.session = (await getSession(finished.sessionId)) ?? shown.session
  }
  if (finished.usage) ui.log.append(note(finished.usage, 'ai-chat-usage'))
  if (finished.stopped === 'rounds') {
    ui.log.append(note(t('ai.chat.rounds', { count: String(finished.rounds) }), 'ai-chat-note'))
  }
  if (finished.stopped === 'budget') {
    ui.log.append(note(t('ai.chat.budget', { count: String(MAX_WRITES) }), 'ai-chat-note'))
  }
  if (finished.error) ui.log.append(note(finished.error, 'ai-chat-note is-err'))
  paintHead()
  stickBottom(true)
}

/* ------------------------------------------------------------------ 工具循环 */

/** 库里的消息 → 线上报文。tool 与 tool_calls 原样带上，否则历史被截断成残链（INV-6） */
function toWire(message: ChatMessage): WireMessage {
  if (message.role === 'tool') {
    const base = { role: 'tool' as const, content: message.text, tool_call_id: message.toolCallId ?? '' }
    // 空串 name 有些 provider 会当非法字段拒掉；没有就不发
    return message.name ? { ...base, name: message.name } : base
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.text || null,
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls } : {}),
    }
  }
  // P-06：事件也要给 AI 看。映射成 user 而非 system —— system 只在 payload 头部注入，
  // 中途插一条会破坏结构；user 又是 trimHistory 的合法切点，不会被拦腰截断（§6）。
  if (message.role === 'event') return eventWire(message.text)
  return { role: 'user', content: message.text }
}

/** 事件进上下文的统一定性前缀：明确告诉模型「这是系统记录，不是你的新指令」 */
function eventWire(text: string): WireMessage {
  // 前缀与 trimHistory 共用一份常量：它决定「这条 user 不是对话边界」，
  // 两边写岔了就会在裁剪时把 tool 链切断
  return { role: 'user', content: `${EVENT_PREFIX}${text}` }
}

/** 结构化事件 → 落库文案。时间用本地化的时分秒，来源/目标是虚拟地址（AI 认得） */
function eventText(event: ToolEvent): string {
  const time = new Date(event.at).toLocaleTimeString()
  if (event.kind === 'copy') {
    return t('ai.event.copy', { from: event.from, to: event.to, time })
  }
  if (event.kind === 'write') {
    return t('ai.event.write', { to: event.to, time })
  }
  if (event.kind === 'mkdir') {
    return t('ai.event.mkdir', { to: event.to, time })
  }
  if (event.kind === 'rm') {
    return t('ai.event.rm', { from: event.from, time })
  }
  if (event.kind === 'mv') {
    return t('ai.event.mv', { from: event.from, to: event.to, time })
  }
  return `${time} · ${event.kind}`
}

/** 用户原话 + 位置块（无选区时约 60 token；有选区才附内容，见 context.locator） */
function withLocator(text: string, docHost: DocHost | null, tag: string): string {
  if (!docHost) return text
  try {
    return `${text}\n\n${locator(docHost.stat(), docHost.text(), tag, !!currentWorkspaceId())}`
  } catch {
    // 拿不到文档状态（切文件瞬间）也照发：宁缺位置，不吞这一句
    return text
  }
}

/**
 * 工具循环（§7）：一次用户发言最多 `MAX_ROUNDS` 轮。
 *
 * 一轮 = 发请求 → 收文字与 tool_calls → 落库 → 执行工具 → 落 tool 结果 → 下一轮。
 * 没有 tool_calls 就是终点。三种结束方式都要**说清楚**（正常 / 轮数到顶 / 写入额度用尽），
 * 不能静默停住让用户对着不动的界面等。
 */
async function converse(current: Run, base: WireMessage[], env: TurnEnv): Promise<void> {
  let messages = base

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (current.abort.signal.aborted) return
    current.rounds = round + 1

    const turn = openTurn(current)
    const outcome = await streamRound(current, turn, messages, env)

    if (outcome.aborted || outcome.failed) {
      // 中断/失败的半条也要落库，标记 `incomplete`：刷新后看得见「这段没说完」
      await persistAssistant(current, outcome.text, [], true, outcome.reasoning)
      return
    }

    // 顺序即契约：assistant(可带 tool_calls) → 它的每一条 tool 结果
    await persistAssistant(current, outcome.text, outcome.calls, false, outcome.reasoning)
    if (!outcome.calls.length) return

    messages = [...messages, { role: 'assistant', content: outcome.text || null, tool_calls: outcome.calls }]

    let exhausted = false
    const events: string[] = []
    for (const call of outcome.calls) {
      // 用户点了停止：剩下的调用也必须各回一条结果（见 abortedResult），
      // 不能在这里直接 return —— 那会把残链留在库里
      const aborted = current.abort.signal.aborted
      const result = aborted ? abortedResult() : exhausted ? budgetResult() : await runTool(current, call, env)
      if (!aborted && !exhausted && isBudgetError(result)) exhausted = true
      // 额度用尽 / 中断时**剩下的调用也要回一条**：否则下一轮报文里出现
      // 「有 tool_calls、缺 tool 结果」的残链，provider 直接 400
      messages = [
        ...messages,
        { role: 'tool', content: result.content, tool_call_id: call.id, name: call.function.name },
      ]
      await persistTool(current, call, result)
      // P-06：cp 等工具成功后的可见事件，落一条消息给用户看、也进上下文给 AI 看。
      // 先攒着、等这一组的 tool 结果全落完再插：夹在两条 tool 之间会让 provider
      // 判定「tool_calls 后面不是 tool 消息」，整轮 400。
      if (result.event) events.push(eventText(result.event))
    }
    for (const text of events) {
      messages = [...messages, eventWire(text)]
      await persistEvent(current, text)
    }
    if (current.abort.signal.aborted) return

    if (exhausted) {
      current.stopped = 'budget'
      return
    }
  }

  // 走完全部轮次还在要工具：停下，让用户决定要不要说「继续」
  current.stopped = 'rounds'
}

/** 开一轮新的助手气泡：每轮一个 turn 节点，工具结果夹在中间才读得懂 */
function openTurn(current: Run): HTMLElement {
  const turn = div('ai-turn is-assistant')
  turn.append(div('ai-turn-role', t('ai.chat.title')))
  current.turn = turn
  current.reasoning = null
  current.body = null
  if (ui) {
    ui.log.append(turn)
    paintHead()
    stickBottom(true)
  }
  return turn
}

interface RoundOutcome {
  text: string
  /** 这一轮的原生思维链（没给就是空串），随消息一起落库 */
  reasoning: string
  calls: WireToolCall[]
  failed: boolean
  aborted: boolean
}

/**
 * 一轮请求：把 SSE 事件收敛成「文字 + 工具调用」，DOM 边流边推。
 *
 * 工具调用的 id 在部分 provider 上会缺（只在首个分片给一次，或干脆不给）：
 * 这里兜底补一个 —— `tool_call_id` 对不上，下一轮必被拒。
 */
async function streamRound(
  current: Run,
  turn: HTMLElement,
  messages: WireMessage[],
  env: TurnEnv,
): Promise<RoundOutcome> {
  const settings = getSettings()
  const tools: ToolSchema[] | undefined = env.toolbox
    ? toolSchemas({ script: settings.aiScript === true, network: settings.aiNetwork !== false })
    : undefined
  // 每轮都重新裁：工具结果让报文涨得很快，只有发请求这一刻的判断算数
  const trimmed = trimHistory(messages, BUDGET_TOKENS)
  const payload: WireMessage[] = [
    { role: 'system', content: systemPrompt({ workspaceId: current.workspaceId }) },
    // 库里可能存着残链（旧版本 / 中断 / 手改）：发之前补一次，否则一条脏记录
    // 就让整个会话永远 400，用户只会看到「全部都坏了」
    ...sanitizeWire(trimmed.messages),
  ]

  let text = ''
  let failed = false
  const calls = new Map<number, WireToolCall>()

  const reasoning = env.showReasoning ? mountReasoning(turn) : null
  current.reasoning = reasoning
  const body = createStreamBody(turn, ui!.log)
  current.body = body

  // 模型会先「默默想」十几秒（deepseek 一类）：界面上必须有东西在动，否则用户以为卡死。
  // 这段占位**总是**先挂上，思维链一到、或第一段正文 / 第一个工具调用就撤掉 ——
  // 关掉思维链的人也能看见「它在动」，开着的人则几乎立刻被真正的思考内容替换。
  const thinking: HTMLElement = div('ai-tool-live is-thinking', t('ai.chat.thinking'))
  turn.append(thinking)
  const dropThinking = (): void => {
    thinking.remove()
  }

  try {
    for await (const event of streamChat({
      baseUrl: env.baseUrl,
      apiKey: env.apiKey,
      model: env.model,
      messages: payload,
      ...(tools ? { tools } : {}),
      signal: current.abort.signal,
      ...(env.temperature === undefined ? {} : { temperature: env.temperature }),
      maxTokens: env.maxTokens,
    })) {
      if (event.type === 'text.delta') {
        dropThinking()
        text += event.delta
        body.push(event.delta)
      } else if (event.type === 'reasoning.delta') {
        dropThinking()
        reasoning?.push(event.delta)
      } else if (event.type === 'tool-call.start') {
        // 参数还在流：先让用户看到「在动」，别对着静止的界面猜是不是卡了
        dropThinking()
        liveToolLine(turn, event.name)
      } else if (event.type === 'tool-call.done') {
        calls.set(event.index, {
          id: event.id || `call_${event.index}_${Date.now().toString(36)}`,
          type: 'function',
          function: { name: event.name, arguments: event.args },
        })
      } else if (event.type === 'error') {
        failed = true
        current.failed = true
        current.error = streamErrorText(event)
        body.fail(current.error)
      } else if (event.type === 'step.done' && event.usage) {
        current.usage = t('ai.chat.usage', {
          prompt: String(event.usage.promptTokens),
          completion: String(event.usage.completionTokens),
        })
      }
    }
  } catch {
    failed = true
    current.failed = true
    current.error ||= t('ai.err.io')
    body.fail(current.error)
  }

  turn.querySelector('.ai-tool-live')?.remove()
  if (!failed) await body.finish(text)
  const thought = reasoning?.seal() ?? ''
  current.text += text

  return {
    text,
    reasoning: thought,
    calls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call),
    failed,
    aborted: current.abort.signal.aborted,
  }
}

/** 流式中那行「⋯ 读取文档」：同一轮只留一行，出结果后由 tool 节点取代 */
function liveToolLine(turn: HTMLElement, name: string): void {
  if (turn.querySelector('.ai-tool-live')) return
  turn.append(div('ai-tool-live', `⋯ ${toolLabel(name)}`))
  stickBottom()
}

/** 执行一次工具：它自己炸了也要变成「一条工具结果」，不能让整段对话跟着断 */
async function runTool(current: Run, call: WireToolCall, env: TurnEnv): Promise<ToolResult> {
  const name = call.function.name
  if (!env.toolbox) {
    const result: ToolResult = {
      ok: false,
      content: JSON.stringify({ error: 'no_host', message: '当前没有可操作的文档' }),
    }
    paintToolTurn(call, result)
    return result
  }
  try {
    const result = await env.toolbox.run(name, call.function.arguments, current.quota)
    paintToolTurn(call, result)
    return result
  } catch (err) {
    const result: ToolResult = {
      ok: false,
      content: JSON.stringify({ error: 'tool_failed', message: (err as Error).message }),
    }
    paintToolTurn(call, result)
    return result
  }
}

/* ------------------------------------------------------------------ 落库与就地渲染 */

/** 落库成功且仍看着同一个会话时，把这一行也记进内存视图，免得重画时跳一下 */
function adopt(message: ChatMessage | null): void {
  if (!message) return
  if (shown && shown.session?.id === message.sessionId) shown.messages.push(message)
}

async function persistAssistant(
  current: Run,
  text: string,
  calls: WireToolCall[],
  incomplete: boolean,
  reasoning = '',
): Promise<void> {
  // 只有思维链、没有正文也要落：否则这一轮的思考过程只活在 DOM 里，重画就没了
  if (!text.trim() && !calls.length && !reasoning.trim()) return
  try {
    adopt(
      await appendMessage({
        sessionId: current.sessionId,
        role: 'assistant',
        text,
        incomplete,
        ...(reasoning.trim() ? { reasoning } : {}),
        ...(calls.length ? { toolCalls: calls } : {}),
      }),
    )
    // 这一轮不再整屏重画（见 `send()` 收尾），「被中断」的提示要就地补到 live turn 上
    if (incomplete) current.turn?.append(note(t('ai.chat.incomplete'), 'ai-chat-note'))
  } catch {
    current.error ||= t('ai.err.io')
  }
}

async function persistTool(
  current: Run,
  call: WireToolCall,
  result: ToolResult,
): Promise<void> {
  try {
    adopt(
      await appendMessage({
        sessionId: current.sessionId,
        role: 'tool',
        text: result.content,
        toolCallId: call.id,
        name: call.function.name,
      }),
    )
  } catch {
    current.error ||= t('ai.err.io')
  }
}

/** P-06：事件落库 + 就地渲染。没有 toolCallId，是一条独立的可见消息 */
async function persistEvent(current: Run, text: string): Promise<void> {
  try {
    const row = await appendMessage({ sessionId: current.sessionId, role: 'event', text })
    adopt(row)
    if (ui) {
      ui.log.append(messageNode(row, paintGen))
      stickBottom(true)
    }
  } catch {
    current.error ||= t('ai.err.io')
  }
}

/* ------------------------------------------------------------------ 小额度的兜底 */

function budgetResult(): ToolResult {
  return {
    ok: false,
    content: JSON.stringify({
      error: 'budget',
      message: '本轮写入额度已用尽，请把剩下的改动说给用户听',
    }),
  }
}

function isBudgetError(result: ToolResult): boolean {
  return !result.ok && result.content.includes('"error":"budget"')
}

/**
 * 中断时也要给每个调用补一条结果。
 *
 * 只 `return` 不补，库里就留下「assistant 带 3 个 tool_calls、只有 1 条 tool」的残链，
 * 下一句话发出去必被 provider 400（`insufficient tool messages following tool_calls`）——
 * 用户看到的是「整个 AI 不能用」，而根因只是点了下停止。
 */
function abortedResult(): ToolResult {
  return {
    ok: false,
    content: JSON.stringify({ error: 'aborted', message: '用户中止了这次操作，结果未知' }),
  }
}

/* ------------------------------------------------------------------ 会话：新建 / 历史 / 切换 */

/**
 * 新建会话 = 让「这一屏」空着，**不立刻建库**。
 *
 * 空的 session 行没有价值（标题都得等第一句话），而且用户点错了 + 不该在库里留垃圾。
 * 真正的 `createSession` 仍在 `send()` 里发生（见「落库与就地渲染」）。
 */
function newSession(): void {
  if (!ui || !opts) return
  // 新会话是「主动离开当前这轮」：正在流的那个干脆停掉，别两条线并行
  run?.abort.abort()
  closePop()
  activeWorkspace = currentWorkspaceId()
  activeId = null
  shown = { workspaceId: activeWorkspace, session: null, messages: [], hidden: 0 }
  ui.input.value = ''
  autosize(ui.input)
  paint()
  // P-11：新开会话提醒一次当前开关状态（脚本默认关，容易被误以为「能跑」）
  announceFlags()
  ui.input.focus()
}

async function openHistory(anchor?: HTMLElement): Promise<void> {
  if (!ui) return
  if (anchor) historyAnchor = anchor
  if (ui.pop?.dataset.kind === 'history') {
    closePop()
    return
  }
  // 按钮在**面板标题栏**（`.ai-chat-box` 之外），而浮层必须长在会话区 `.ai-chat` 里：
  // 那儿才既有定位祖先、又不会被 `.ai-chat-box` 的 `overflow: hidden` 裁掉。
  // 会话区顶边正好是标题栏底边，所以贴着 `top` 开就是从按钮正下方拉出来。
  const fixed = historyAnchor?.isConnected ? historyAnchor : null
  await openPop('history', fixed ?? ui.title, fillHistory, fixed ? 'host' : 'box')
}

async function fillHistory(body: HTMLElement): Promise<void> {
  body.append(div('ai-pop-title', t('ai.chat.history')))
  const workspaceId = currentWorkspaceId()
  let list: ChatSession[] = []
  try {
    list = await listSessions(workspaceId)
  } catch {
    body.append(div('ai-pop-empty', t('ai.err.io')))
    return
  }
  if (!body.isConnected) return
  if (!list.length) {
    body.append(div('ai-pop-empty', t('ai.chat.historyEmpty')))
    return
  }
  for (const session of list) {
    const row = div('ai-pop-row')
    if (session.id === shown?.session?.id) row.classList.add('is-active')
    const main = document.createElement('button')
    main.type = 'button'
    main.className = 'ai-pop-main'
    main.append(
      div('ai-pop-name', session.title || t('ai.chat.untitled')),
      div(
        'ai-pop-sub',
        `${clockOf(session.updatedAt)} · ${t('ai.chat.count', { count: session.messageCount })}`,
      ),
    )
    main.addEventListener('click', () => void switchTo(session))
    const drop = iconButton('✕', t('ai.chat.delete'), () => void dropSession(session))
    drop.classList.add('ai-pop-drop')
    row.append(main, drop)
    body.append(row)
  }
}

/* ------------------------------------------------------------------ 工作区（W-S4） */

/** 工作区切换浮层的锚点 = 面板标题栏那颗「工作区」按钮（同历史浮层的道理） */
let workspaceAnchor: HTMLElement | null = null
/** 各工作区的会话数/最后活动：面板列表要显示，异步补上后重画 */
let wsStats: ReadonlyMap<string, { count: number; lastAt: number }> = new Map()

async function loadWsStats(): Promise<void> {
  try {
    wsStats = await sessionStatsByWorkspace()
  } catch {
    return
  }
  // 列表态才需要这份数字；有工作区时聊天区不显示它，重画是浪费
  if (ui && !currentWorkspaceId()) paint()
}

/** 切到某个工作区：在途请求停掉，否则旧工作区的回复会写进新会话的界面 */
async function pickWorkspace(id: string): Promise<void> {
  if (!ui) return
  closePop()
  // 已经是它也要重画一次：新建完工作区的那一刻面板还停在列表态，
  // 这里不重画就会一直显示「还没有工作区」，直到下次切文件
  if (id !== currentWorkspaceId()) {
    run?.abort.abort()
    activeWorkspace = id
    activeId = undefined
    shown = null
  }
  rememberWorkspace(id)
  await align(true)
}

async function createWorkspaceAndPick(): Promise<void> {
  const created = await opts?.docHost?.createWorkspace?.()
  if (!created) return
  closePop()
  await pickWorkspace(created.id)
}

/**
 * 标题栏「工作区」按钮（§8.5）：列出**引用过当前文件**的工作区。
 *
 * 只列相关的，不列全库：这颗按钮回答的是「这个文件在哪些工作区里能聊」。
 * 全库列表在面板默认视图里（`workspaceListNode()`），那才是「挑一个工作区开始」。
 */
async function openWorkspaces(anchor?: HTMLElement): Promise<void> {
  if (!ui) return
  if (anchor) workspaceAnchor = anchor
  if (ui.pop?.dataset.kind === 'workspaces') {
    closePop()
    return
  }
  const fixed = workspaceAnchor?.isConnected ? workspaceAnchor : null
  await openPop('workspaces', fixed ?? ui.title, fillWorkspaces, fixed ? 'host' : 'box')
}

async function fillWorkspaces(body: HTMLElement): Promise<void> {
  body.append(div('ai-pop-title', t('ai.ws.popTitle')))
  const target = opts?.getTarget() ?? null
  const all = opts?.docHost?.listWorkspaces?.() ?? []
  const current = currentWorkspaceId()
  // 没打开文件时无从判断「相关」，就列全库 —— 空着比列全库更像坏了
  const related = target
    ? all.filter((workspace) => {
        const view = opts?.docHost?.workspace?.(workspace.id)
        return view ? isGrantedBy(target.id, workspace.grantIds, view.nodes) : false
      })
    : all
  if (!related.length) {
    body.append(div('ai-pop-empty', t('ai.ws.noneRelated')))
  } else {
    for (const workspace of related) {
      const row = div('ai-pop-row')
      if (workspace.id === current) row.classList.add('is-active')
      const main = document.createElement('button')
      main.type = 'button'
      main.className = 'ai-pop-main'
      const stat = wsStats.get(workspace.id)
      main.append(
        div('ai-pop-name', workspace.name),
        div(
          'ai-pop-sub',
          stat
            ? `${t('ai.chat.count', { count: stat.count })} · ${clockOf(stat.lastAt)}`
            : t('ai.ws.noSessions'),
        ),
      )
      main.addEventListener('click', () => void pickWorkspace(workspace.id))
      row.append(main)
      if (workspace.id === current) row.append(div('ai-pop-mark', '✓'))
      body.append(row)
    }
  }
  // 入口始终在：一个都还没建的时候，这里就是唯一能建的地方（W-10）
  const create = document.createElement('button')
  create.type = 'button'
  create.className = 'ai-pop-action'
  create.textContent = t('ai.ws.new')
  create.addEventListener('click', () => void createWorkspaceAndPick())
  body.append(create)
}

/**
 * 面板默认视图：工作区列表（W-10）。
 *
 * 只在**一个工作区都没有**时出现。有工作区就进它的会话 —— 每次都先看一遍列表
 * 再点一下，是把「默认视图」做成了「每次多一次点击」。
 */
function workspaceListNode(): HTMLElement {
  const box = div('ai-ws-list')
  box.append(div('ai-ws-head', t('ai.ws.pickTitle')))
  const all = opts?.docHost?.listWorkspaces?.() ?? []
  if (!all.length) box.append(div('ai-ws-empty', t('ai.ws.empty')))
  for (const workspace of all) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'ai-ws-row'
    const stat = wsStats.get(workspace.id)
    row.append(
      div('ai-pop-name', workspace.name),
      div(
        'ai-pop-sub',
        stat
          ? `${t('ai.chat.count', { count: stat.count })} · ${clockOf(stat.lastAt)}`
          : t('ai.ws.noSessions'),
      ),
    )
    row.addEventListener('click', () => void pickWorkspace(workspace.id))
    box.append(row)
  }
  const create = document.createElement('button')
  create.type = 'button'
  create.className = 'ai-ws-new'
  create.textContent = t('ai.ws.new')
  create.addEventListener('click', () => void createWorkspaceAndPick())
  box.append(create)
  // 不点也能开始：发送时自动补建（见 send()），先把这条路说出来，别让人以为必须先选
  box.append(div('ai-ws-hint', t('ai.ws.autoHint')))
  return box
}

/** 从历史里挑一条：中途切走会把正在跑的那轮停掉（和新建同理，避免两条线并行） */
async function switchTo(session: ChatSession): Promise<void> {
  if (!ui) return
  closePop()
  if (session.id === shown?.session?.id) return
  run?.abort.abort()
  activeWorkspace = session.workspaceId
  activeId = session.id
  // 直接对齐到这一条，不走 `align()` 的「同工作区早退」
  shown = { workspaceId: session.workspaceId, session, messages: [], hidden: 0 }
  paint()
  await align(true)
}

async function dropSession(session: ChatSession): Promise<void> {
  const answer = await confirmDialog(
    t('ai.chat.delete'),
    `${t('ai.chat.clearAsk')} ${t('ai.chat.clearNote')}`,
  )
  if (!answer.ok) return
  try {
    await deleteSession(session.id)
  } catch {
    if (ui) ui.log.append(note(t('ai.err.io'), 'ai-chat-note is-err'))
    return
  }
  // 删的正好是当前这条 → 退回「新会话」的空屏；否则只刷新历史列表
  if (session.id === shown?.session?.id) {
    activeId = null
    shown = { workspaceId: shown?.workspaceId ?? '', session: null, messages: [], hidden: 0 }
    paint()
  }
  closePop()
  await openHistory()
}

/* ------------------------------------------------------------------ 状态栏：方案 / 模型 / 参数 */

async function toggleGrants(): Promise<void> {
  if (!ui) return
  if (ui.pop?.dataset.kind === 'grants') {
    closePop()
    return
  }
  await openPop('grants', ui.grants, async (body) => {
    body.append(div('ai-pop-title', t('ai.grant.panelTitle')))
    const workspaceId = currentWorkspaceId()
    const view = workspaceId ? (opts?.docHost?.workspace?.(workspaceId) ?? null) : null
    if (!view) {
      body.append(div('ai-pop-sub', t('ai.grant.none')))
      return
    }
    const grants = view.root.aiWorkspace?.grants ?? []
    if (!grants.length) {
      body.append(div('ai-pop-sub', t('ai.grant.none')))
      return
    }
    for (const grant of grants) {
      const node = view.nodes.get(grant.refId)
      const row = div('ai-pop-row is-flat')
      const label = div('ai-pop-name', node?.name ?? t('ai.grant.missing'))
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'btn ai-pop-remove'
      // 图标 + tooltip：一行宽 260px 里再塞「取消」两个字，名字一长就被挤成省略号
      remove.innerHTML = ICON_CLOSE
      remove.title = t('ai.grant.revoke')
      remove.setAttribute('aria-label', t('ai.grant.revoke'))
      remove.addEventListener('click', async () => {
        // 带上这个清单属于谁：跨工作区引用（B 引用了 A 里的文件）时，
        // 只给 refId 会让 app 侧按「文件老家」去猜，点了等于没反应
        await opts?.docHost?.revokeGrant?.(grant.refId, workspaceId)
        // 重绘：取消后列表与状态栏角标立刻反映新状态
        paintGrants()
        closePop()
        void toggleGrants()
      })
      row.append(label, remove)
      body.append(row)
    }
  })
}

async function toggleStatus(): Promise<void> {
  if (!ui) return
  if (ui.pop?.dataset.kind === 'status') {
    closePop()
    return
  }
  await openPop('status', ui.status, async (body) => {
    const config = getConfig()
    const current = unlockedId()

    body.append(div('ai-pop-title', t('ai.chat.switchPlan')))
    let records: ProfileRecord[] = []
    try {
      records = await listProfiles()
    } catch {
      records = []
    }
    if (!body.isConnected) return
    for (const record of records) {
      const row = div('ai-pop-row is-flat')
      if (record.id === current) row.classList.add('is-active')
      const main = document.createElement('button')
      main.type = 'button'
      main.className = 'ai-pop-main'
      main.append(
        div('ai-pop-name', record.name),
        div('ai-pop-sub', record.id === current ? t('ai.chat.inUse') : t('ai.chat.switch')),
      )
      main.addEventListener('click', () => {
        if (record.id === current) return
        askPassword(record)
      })
      row.append(main)
      body.append(row)
    }

    const models = config?.models ?? []
    if (models.length) {
      body.append(div('ai-pop-title', t('ai.chat.switchModel')))
      for (const model of models) {
        const row = div('ai-pop-row is-flat')
        if (model === config?.model) row.classList.add('is-active')
        const main = document.createElement('button')
        main.type = 'button'
        main.className = 'ai-pop-main'
        main.append(div('ai-pop-name', model))
        main.addEventListener('click', () => void pickModel(model))
        row.append(main)
        body.append(row)
      }
    }

    body.append(div('ai-pop-title', t('ai.chat.params')))
    body.append(paramsRow())

    // 「管理配置」放最后：它自带 `border-top`，是「配置区 ⇄ 管理入口」的分隔线。
    // 挂到最前面就成了浮层顶边下面一条莫名其妙的横线（用户反馈的「顶部还有一条分割线」）。
    // 它不依赖库，所以读库期间浮层已经有标题可看，不会出现空窗。
    const foot = div('ai-pop-foot')
    const manage = document.createElement('button')
    manage.type = 'button'
    manage.className = 'btn btn-ghost ai-pop-manage'
    manage.textContent = t('ai.chat.manage')
    manage.addEventListener('click', () => {
      closePop()
      opts?.onManage?.()
    })
    foot.append(manage)
    body.append(foot)
  })
}

async function pickModel(model: string): Promise<void> {
  try {
    await switchModel(model)
  } catch {
    if (ui) ui.log.append(note(t('ai.err.io'), 'ai-chat-note is-err'))
    return
  }
  closePop()
  paintStatus()
  opts?.onConfigChange?.()
}

/** 切方案要密码：直接用对话框问，比在 280px 的浮层里塞输入框体面 */
function askPassword(record: ProfileRecord): void {
  const body = div('ai-pw')
  body.append(div('ai-hint', t('ai.field.passwordAsk')))
  const input = document.createElement('input')
  input.type = 'password'
  input.className = 'dialog-input'
  input.autocomplete = 'current-password'
  const error = div('ai-chat-note is-err')
  error.hidden = true
  body.append(input, error)

  const foot = document.createElement('div')
  const cancel = document.createElement('button')
  cancel.className = 'btn btn-ghost'
  cancel.textContent = t('action.cancel')
  const ok = document.createElement('button')
  ok.className = 'btn btn-primary'
  ok.textContent = t('action.confirm')
  foot.append(cancel, ok)

  const handle = openDialog({ title: record.name, body, foot, narrow: true })
  cancel.addEventListener('click', () => handle.close())
  ok.addEventListener('click', () => void submit())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    }
  })
  input.focus()

  async function submit(): Promise<void> {
    try {
      await unlock(record.id, input.value)
    } catch {
      error.textContent = t('ai.err.unlockFailed')
      error.hidden = false
      return
    }
    handle.close()
    closePop()
    // 换了方案 = 换了整套配置（模型、密钥、工具白名单都可能变），视图必须重建
    opts?.onConfigChange?.()
    reset()
    refresh()
  }
}

async function refreshPlan(): Promise<void> {
  try {
    const records = await listProfiles()
    planName = records.find((one) => one.id === unlockedId())?.name ?? ''
  } catch {
    planName = ''
  }
  if (ui) paintStatus()
}

/* ------------------------------------------------------------------ 浮层（历史 / 状态栏共用） */

/**
 * 浮层挂在哪一层。`box` = 会话盒子（状态栏浮层，贴着状态栏往上开）；
 * `host` = 会话区（历史浮层，锚是标题栏那颗按钮，而按钮在盒子之外）。
 */
type PopSurface = 'box' | 'host'

/**
 * 开一个贴着 `anchor` 的浮层。内容用回调填，因为两边都要异步读库。
 *
 * 位置靠 `getBoundingClientRect` 算相对落点元素的偏移：面板窄且会被拖动，写死 CSS 会跑偏。
 * 事件用捕获阶段挂在 document 上，点面板外也关。
 */
async function openPop(
  kind: string,
  anchor: HTMLElement,
  fill: (body: HTMLElement) => Promise<void>,
  surface: PopSurface = 'box',
): Promise<void> {
  const host = opts?.host
  if (!ui || !host) return
  closePop()
  const pop = div('ai-pop')
  pop.dataset.kind = kind

  const surfaceEl = surface === 'host' ? host : ui.box
  const surfaceRect = surfaceEl.getBoundingClientRect()
  const rect = anchor.getBoundingClientRect()
  if (surface === 'host') {
    // 会话区的顶边就是标题栏底边：贴着 top 开，看起来就是从按钮正下方拉出来的。
    // 右缘对齐按钮右缘（按钮在面板右上角，左对齐会顶出面板右边）。
    const width = Math.min(Math.max(surfaceRect.width - 8, 180), 280)
    const left = Math.min(
      Math.max(rect.right - surfaceRect.left - width, 4),
      Math.max(surfaceRect.width - width - 4, 4),
    )
    pop.style.left = `${Math.round(left)}px`
    pop.style.top = `${Math.max(2, Math.round(rect.bottom - surfaceRect.top + 2))}px`
    pop.style.width = `${width}px`
  } else {
    pop.style.left = `${Math.max(0, rect.left - surfaceRect.left)}px`
    pop.style.width = `${Math.min(surfaceRect.width - 8, 260)}px`
    if (kind === 'status' || kind === 'grants') {
      // 这两个入口都在状态栏（输入框下面、盒子最底部）：只能往上开。
      // 往下开会顶出 `.ai-chat-box` 的 `overflow: hidden`，浮层只剩标题行。
      pop.style.bottom = `${surfaceRect.bottom - rect.top + 4}px`
    } else {
      pop.style.top = `${rect.bottom - surfaceRect.top + 4}px`
    }
  }
  surfaceEl.append(pop)
  ui.pop = pop

  const onDown = (event: MouseEvent): void => {
    const target = event.target as Node | null
    if (!target) return
    if (pop.contains(target) || anchor.contains(target)) return
    closePop()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePop()
  }
  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('keydown', onKey, true)
  ui.unpop = () => {
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
  }

  // 内容由 `fill` 立刻挂标题、随后异步补行：浮层一出现就有东西可看。
  // 不再叠一行「读取中」——读库通常一帧内就回来，那行一闪而过更像报错，
  // 而且两边 `fill` 的第一件事都是同步 append 标题，本来就不会出现空窗。
  const body = div('ai-pop-body')
  pop.append(body)
  let failed = false
  try {
    await fill(body)
  } catch {
    failed = true
  }
  if (ui?.pop !== pop) return
  if (failed) body.append(div('ai-pop-empty', t('ai.err.io')))
  else if (!body.childElementCount) body.append(div('ai-pop-empty', t('ai.chat.historyEmpty')))
}

function closePop(): void {
  if (!ui) return
  ui.unpop?.()
  ui.unpop = null
  ui.pop?.remove()
  ui.pop = null
}

/* ------------------------------------------------------------------ 参数行 */

/** 参数行（输出上限 / 温度 / 思维链）：放在状态栏浮层里，不再单独占一行 */
function paramsRow(): HTMLElement {
  const settings = getSettings()
  const box = div('ai-params')

  const row = div('ai-params-row')
  const tokens = numberInput(
    clampNumber(settings.aiMaxTokens, AI_DEFAULTS.maxTokens, 1, 32768),
    1,
    32768,
    128,
  )
  // 温度默认留空 = 不传，交给 provider 自己的缺省值（见 TurnEnv.temperature）
  const temp = numberInput(
    typeof settings.aiTemperature === 'number' ? settings.aiTemperature : 0,
    0,
    2,
    0.1,
  )
  if (typeof settings.aiTemperature !== 'number') {
    temp.value = ''
    temp.placeholder = t('ai.field.auto')
  }
  const reasoning = document.createElement('input')
  reasoning.type = 'checkbox'
  reasoning.className = 'ai-check'
  // 与 `showReasoning` 同一口径：只有显式关掉（=== false）才不显示
  reasoning.checked = settings.aiReasoning !== false
  // 联网缺省开；脚本运行缺省关（plans/ai-project-v2.md P-11 / P-16）
  const network = document.createElement('input')
  network.type = 'checkbox'
  network.className = 'ai-check'
  network.checked = settings.aiNetwork !== false
  const script = document.createElement('input')
  script.type = 'checkbox'
  script.className = 'ai-check'
  script.checked = settings.aiScript === true

  row.append(
    param('ai.field.maxTokens', tokens),
    param('ai.field.temperature', temp),
    param('ai.field.reasoning', reasoning),
    param('ai.field.network', network),
    param('ai.field.script', script),
  )
  box.append(row)

  tokens.addEventListener('change', () => {
    const value = clampNumber(tokens.valueAsNumber, AI_DEFAULTS.maxTokens, 1, 32768)
    tokens.value = String(value)
    updateSettings({ aiMaxTokens: value })
  })
  temp.addEventListener('change', () => {
    // 清空 = 回到「不传」，所以这里不能拿缺省值兜底
    if (temp.value.trim() === '') {
      updateSettings({ aiTemperature: undefined })
      return
    }
    const value = clampNumber(temp.valueAsNumber, AI_DEFAULTS.temperature, 0, 2)
    temp.value = value.toFixed(1)
    updateSettings({ aiTemperature: value })
  })
  reasoning.addEventListener('change', () => {
    updateSettings({ aiReasoning: reasoning.checked })
  })
  // 同一个设置有两处入口（这行复选框 / 输入框下方的图标开关），
  // 改完必须回写状态栏，否则外面那两个图标还是旧样子
  network.addEventListener('change', () => {
    updateSettings({ aiNetwork: network.checked })
    paintFlags()
    announceFlag('network')
  })
  script.addEventListener('change', () => {
    updateSettings({ aiScript: script.checked })
    paintFlags()
    announceFlag('script')
  })
  return box
}

function param(labelKey: MessageKey, control: HTMLElement): HTMLElement {
  const cell = document.createElement('label')
  cell.className = 'ai-param'
  const caption = document.createElement('span')
  caption.className = 'ai-param-name'
  caption.textContent = t(labelKey)
  cell.append(caption, control)
  return cell
}

function numberInput(value: number, min: number, max: number, step: number): HTMLInputElement {
  const node = document.createElement('input')
  node.type = 'number'
  node.className = 'dialog-input ai-number'
  node.min = String(min)
  node.max = String(max)
  node.step = String(step)
  node.value = String(value)
  return node
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 只在「用户真的设过」时给值；没设返回 `undefined`（调用方据此**不发**这个字段） */
function optionalNumber(raw: unknown, min: number, max: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return Math.min(max, Math.max(min, raw))
}

/* ------------------------------------------------------------------ 思维链 */

interface ReasoningSink {
  push(delta: string): void
  /** 收尾：返回整段思维链（空白就返回空串，并把折叠框摘掉 —— 空框只是噪音） */
  seal(): string
}

/**
 * 流式期间的「思考过程」折叠框：**默认展开**。
 *
 * 折叠着流等于没显示：用户看不到字在动，只会觉得慢。等这一轮落库、整屏从库里
 * 重画时，历史里的那条才收起来（见 `reasoningNode`）。
 */
function mountReasoning(turn: HTMLElement): ReasoningSink {
  const box = document.createElement('details')
  box.className = 'ai-reasoning is-live'
  box.open = true
  const summary = document.createElement('summary')
  summary.textContent = t('ai.chat.thinking')
  const pre = document.createElement('pre')
  pre.className = 'ai-reasoning-text'
  box.append(summary, pre)
  turn.append(box)

  let text = ''
  return {
    push(delta: string): void {
      text += delta
      pre.textContent = text
    },
    seal(): string {
      const kept = text.trim() ? text : ''
      if (!kept) {
        box.remove()
        return ''
      }
      summary.textContent = t('ai.chat.reasoned', { count: kept.length })
      box.classList.remove('is-live')
      return kept
    },
  }
}

/** 历史消息里的思维链：带字数、默认收起，点开能翻回去看（以前答完就没了） */
function reasoningNode(text: string): HTMLElement {
  const box = document.createElement('details')
  box.className = 'ai-reasoning'
  const summary = document.createElement('summary')
  summary.textContent = t('ai.chat.reasoned', { count: text.length })
  const pre = document.createElement('pre')
  pre.className = 'ai-reasoning-text'
  pre.textContent = text
  box.append(summary, pre)
  return box
}

/* ------------------------------------------------------------------ 小工具 */

function div(cls?: string, text?: string): HTMLElement {
  const node = document.createElement('div')
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function note(text: string, cls = 'ai-chat-note'): HTMLElement {
  return div(cls, text)
}

/** 顶栏的两个图标按钮：文案走 `aria-label`/`title`，眼睛只看符号，读屏也能念出来 */
function iconButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = 'btn btn-ghost icon-only ai-icon'
  node.textContent = label
  node.title = title
  node.setAttribute('aria-label', title)
  node.addEventListener('click', onClick)
  return node
}

/** 输入框跟着内容长高，超过 8 行就内部滚（不再往消息区挤） */
function autosize(input: HTMLTextAreaElement): void {
  input.style.height = 'auto'
  const line = 20
  input.style.height = `${Math.min(input.scrollHeight, line * 8)}px`
}

/** 历史列表里的「刚刚 / 3 分钟前 / 昨天 / 11-16」——按天退化，不引格式化库 */
function clockOf(stamp: number): string {
  const delta = Date.now() - stamp
  if (delta < 60_000) return t('ai.chat.justNow')
  if (delta < 3_600_000) return t('ai.chat.minutesAgo', { count: Math.floor(delta / 60_000) })
  const date = new Date(stamp)
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  return `${date.getMonth() + 1}-${date.getDate()}`
}

function stickBottom(force = false): void {
  const log = ui?.log
  if (!log) return
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < STICK_SLOP
  if (force || near) log.scrollTop = log.scrollHeight
}

/** 错误事件 → 一句本地化的话 + provider 的原话（transport 已截断，INV-1） */
function streamErrorText(event: Extract<StreamEvent, { type: 'error' }>): string {
  const base =
    event.code === 'auth'
      ? t('ai.err.auth')
      : event.code === 'not_found'
        ? t('ai.err.http404')
        : event.code === 'rate_limit'
          ? t('ai.err.rateLimit')
          : event.code === 'network'
            ? t('ai.err.network')
            : event.code === 'stream'
              ? t('ai.err.stream')
              : event.code === 'aborted'
                ? t('ai.err.aborted')
                : t('ai.err.http', { status: String(event.status ?? 0) })
  return event.message && event.message !== base ? `${base} · ${event.message}` : base
}
