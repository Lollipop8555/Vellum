import { getLang, t, type MessageKey } from '../i18n'
import {
  VaultError,
  createProfile,
  deleteProfile,
  exportBackup,
  exportToken,
  getConfig,
  hasCrypto,
  importToken,
  isUnlocked,
  listProfiles,
  lock,
  renameProfile,
  reveal,
  saveConfig,
  switchModel,
  unlock,
  unlockedId,
  type ProfileConfig,
  type ProfileRecord,
} from '../shell/ai/vault'
import { probe, type ProbeResult } from '../shell/ai/transport'
import type { DocHost } from '../shell/ai/tools'
import { formatBytes } from '../shell/largefile'
import { downloadBlob } from '../shell/save'
import { createChatView, type ChatTarget, type ChatView } from './ai/chat'
import { confirmDialog, openDialog, type DialogHandle } from './dialogs'

/**
 * AI 面板 = 凭据区（P1）+ 会话区（P3）。
 *
 * 与其它面板的区别：这里**不接收 app 的状态**。凭据库的真相在 `vault.ts`，
 * 会话的真相在 `vellum-chat`，面板只是它们的视图；把 record 复制进 app.state
 * 等于多养一份可能过期的密钥引用（INV-1）。所以契约只有两条：
 * `renderAiPanel(root, getTarget?)`，以及「面板可以重画任意多次，流式输出不能因此消失」。
 *
 * 交互口径（D-41/D-42）：
 * - 列表只认**配置名**（用户自填），一套配置 = 端点 + 密钥 + 一组模型。
 * - 行上只有两个动作：**启用**、**编辑**；两个都要先输配置密码（确认是本人）。
 * - **删除藏在「编辑」里**，删之前还要过一次确认弹窗 —— 列表上不给一键删。
 *
 * 三条渲染纪律：
 * - 任何时刻都不把 apiKey 写进 DOM，唯一例外是 D-05 的「导出明文」——那要重新输密码，
 *   且落在弹窗里、不参与本模块的状态。编辑表单里的密钥框也因此**永远空着**，留空即不改。
 * - 不靠 innerHTML 拼用户数据（配置名可能是任意字符串）。
 * - 每次动作后整块重画：表单是短生命周期，没有需要保留的输入焦点。
 */

type Mode = 'list' | 'create' | 'enable' | 'editAuth' | 'edit' | 'reveal'

interface View {
  mode: Mode
  /** 正在验证密码 / 编辑 / 导出的 profile id */
  target: string | null
  error: MessageKey | ''
  notice: string
}

const view: View = { mode: 'list', target: null, error: '', notice: '' }

let root: HTMLElement | null = null
/**
 * 面板分两块：凭据区（每次动作整块重画）与会话区（流式期间**不能**被重画）。
 * 合成一个 root 再整体清空，会让「切模型」这类动作把正在生成的回复一起抹掉。
 */
let credRoot: HTMLElement | null = null
let chatRoot: HTMLElement | null = null
let chatView: ChatView | null = null
/** 当前文件由 app 注入：面板不 import app（app 反过来 import 本模块，会成环） */
let getTarget: () => ChatTarget | null = () => null
/** 文档读写入口同样由 app 注入；`null` 时会话退化成纯对话（不传 tools） */
let docHost: DocHost | null = null
let records: ProfileRecord[] = []
let loading = false
/**
 * 凭据区是否展开。
 *
 * 默认收起：配好之后 99% 的时间用户要的是对话，不是端点/密钥/模型那一堆字段。
 * 收起时可从状态栏的「管理配置」再进来，未解锁或首次配置时强制展开（`syncChat`）。
 */
let managing = false
/** 「对话是否可用」的上一帧值：只在翻转时通知壳层刷新标题栏按钮 */
let lastReady = false
/** 由 app 注入：对话可用性变了就调它重算 `actionsVisible`（不 import app，避免成环） */
let notifyReadyChange: (() => void) | null = null

/* ------------------------------------------------------------------ 入口 */

export async function renderAiPanel(
  host: HTMLElement,
  target?: () => ChatTarget | null,
  docs?: DocHost,
  onReadyChange?: () => void,
): Promise<void> {
  if (target) getTarget = target
  if (docs) docHost = docs
  if (onReadyChange) notifyReadyChange = onReadyChange

  // 切文件、重开面板都会再调一次本函数：**绝不能重建 DOM**，
  // 否则正在流式的回复会跟着容器一起被丢掉（ADR §9「切文件不中断」）。
  if (root !== host || !credRoot || !chatRoot) {
    root = host
    credRoot = div('ai-cred')
    chatRoot = div('ai-chat')
    chatView = null
    root.append(credRoot, chatRoot)
  }

  if (!hasCrypto()) {
    view.error = 'ai.err.noCrypto'
    draw()
    return
  }
  // 每次挂载（开面板 / 切文件）都从「列表 / 对话」这一层开始：
  // - 停在列表就落回对话页（配置还解锁着时，打开面板应该直接是对话，不是配置页）
  // - 上次停在表单里、面板被关掉又打开：不接着显示一张填了一半的表单
  if (view.mode === 'list') {
    managing = false
  } else if (!managing) {
    view.mode = 'list'
    view.target = null
  }
  // 列表可能被别的标签页改过，每次挂载都重读；很便宜（几条小记录）
  await reload()
  // 语言可能刚被切过：骨架不重建，文案得自己再套一遍（语言没变时是空操作）
  chatView?.relabel()
}

/* ------------------------------------------------------------------ 标题栏 */

/**
 * 面板标题栏那两颗按钮要不要出现（新建会话 / 历史会话）。
 *
 * 由 app 的 `actionsVisible` 调：**只有对话真的能用**时才给，锁着或还没配置时
 * 标题栏多出两颗点了没反应的图标，比没有更糟。
 */
export function isAiChatReady(): boolean {
  return Boolean(chatView) && isUnlocked() && Boolean(getConfig())
}

/**
 * 切语言后重刷本面板的文案。
 *
 * 面板的骨架只在挂载时写一次 `t()`，语言变了不会自己变——所以由 app 的
 * `onLangChange` 调这里。两件事分开做：凭据区整块重画（它是短生命周期视图），
 * 会话区只重套文案（流式中的回复节点不能被重画掉）。
 *
 * 表单态（`create` / `edit` …）不重画：重画会清空用户正填的输入，
 * 让文案旧一会儿，比把半张表单抹掉要好。
 */
export function relabelAiPanel(): void {
  if (!root) return
  if (view.mode === 'list') draw()
  chatView?.relabel()
}

/** 标题栏「新建会话」→ 会话区 */
export function newAiSession(): void {
  chatView?.newSession()
}

/** 标题栏「历史会话」→ 会话区浮层（把按钮当锚点传下去，浮层从它正下方开） */
export function openAiHistory(anchor?: HTMLElement): void {
  chatView?.openHistory(anchor)
}

/** 标题栏「工作区」→ 工作区切换浮层（W-S4） */
export function openAiWorkspaces(anchor?: HTMLElement): void {
  chatView?.openWorkspaces(anchor)
}

async function reload(): Promise<void> {
  loading = true
  draw()
  try {
    records = await listProfiles()
  } catch {
    records = []
    view.error = 'ai.err.io'
  }
  loading = false
  draw()
}

/* ------------------------------------------------------------------ 小工具 */

function div(cls?: string, text?: string): HTMLDivElement {
  const node = document.createElement('div')
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function button(key: MessageKey, cls = 'btn btn-ghost', onClick?: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = cls
  node.textContent = t(key)
  if (onClick) node.onclick = onClick
  return node
}

function field(
  key: MessageKey,
  hintKey: MessageKey | null,
  control: HTMLElement,
): HTMLLabelElement {
  const row = document.createElement('label')
  row.className = 'ai-field'
  const caption = div('ai-field-name', t(key))
  row.append(caption, control)
  if (hintKey) row.append(div('ai-field-hint', t(hintKey)))
  return row
}

/** 模型清单一类的小文本域：一行一个，顺手允许逗号分隔 */
function textarea(placeholderKey?: MessageKey): HTMLTextAreaElement {
  const node = document.createElement('textarea')
  // 复用 dialog-textarea 的边框/等宽字体，只把面板里的高度压下来
  node.className = 'dialog-textarea ai-textarea'
  node.rows = 3
  node.spellcheck = false
  if (placeholderKey) node.placeholder = t(placeholderKey)
  return node
}

function select(options: string[], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const node = document.createElement('select')
  node.className = 'dialog-input ai-select'
  for (const item of options) {
    const opt = document.createElement('option')
    opt.value = item
    opt.textContent = item
    node.append(opt)
  }
  node.value = value
  node.onchange = () => onChange(node.value)
  return node
}

/** 文本域 → 模型清单：换行或逗号都算分隔符，去空去重保序 */
function lines(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))]
}

function input(
  type: 'text' | 'password' | 'url' | 'number',
  value = '',
  placeholderKey?: MessageKey,
): HTMLInputElement {
  const node = document.createElement('input')
  node.className = 'dialog-input'
  node.type = type
  node.value = value
  node.spellcheck = false
  node.autocomplete = 'off'
  if (placeholderKey) node.placeholder = t(placeholderKey)
  return node
}

function when(ts: number): string {
  return new Date(ts).toLocaleString(getLang() === 'zh' ? 'zh-CN' : 'en-US')
}

/** 只露头尾各四位；短于一屏的 key 干脆全遮，免得遮罩本身泄露长度规律 */
function maskKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '…'
}

const COPY_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
  '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
  '<path d="M10.5 3.5v-.7a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h.7" ' +
  'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

/**
 * icon-only 按钮。面板最窄 280px，行上已经有「启用 / 编辑」，再塞一个四字按钮
 * 会把配置名挤成省略号 —— 而名字是未启用时唯一的识别信息（D-40）。
 */
function iconButton(
  cls: string,
  label: string,
  svg: string,
  onClick?: () => void,
): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = `btn btn-ghost ai-icon ${cls}`
  node.title = label
  node.setAttribute('aria-label', label)
  // 常量 SVG，不含任何用户数据
  node.innerHTML = svg
  if (onClick) node.onclick = onClick
  return node
}

/** probe 的错误码 → 现成文案；不在这里发明新说法 */
function probeReason(result: ProbeResult): string {
  if (result.timedOut) return t('ai.err.timeout')
  switch (result.code) {
    case 'auth':
      return t('ai.err.auth')
    case 'not_found':
      return t('ai.err.http404')
    case 'rate_limit':
      return t('ai.err.rateLimit')
    case 'network':
      return t('ai.err.network')
    case 'http':
      return t('ai.err.http', { status: result.status ?? 0 })
    default:
      return t('ai.err.stream')
  }
}

/**
 * 发一次最小请求并把结果落到一行内联状态里。
 *
 * 测的永远是**传进来的那一份 config**：新建是表单值，编辑是表单值（含未保存改动），
 * 导入是刚解出来的那一份。所以不存在「为了测一次要解锁全部配置」。
 */
async function runProbe(
  config: ProfileConfig,
  status: HTMLElement,
  model = config.model,
): Promise<boolean> {
  status.hidden = false
  status.className = 'ai-alert'
  status.textContent = t('ai.test.running')
  const result = await probe({ baseUrl: config.baseUrl, apiKey: config.apiKey, model })
  if (result.ok) {
    status.className = 'ai-alert is-ok'
    status.textContent = t('ai.test.ok', { ms: result.ms })
    return true
  }
  status.className = 'ai-alert is-err'
  status.textContent = t('ai.test.fail', { model, reason: probeReason(result) })
  return false
}

/** 口令里没有名字（只装三个元素），导入时用域名当默认名，用户可改 */
function nameFromUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || t('ai.token.defaultName')
  } catch {
    return t('ai.token.defaultName')
  }
}

function errorText(err: unknown): MessageKey {
  if (!(err instanceof VaultError)) return 'ai.err.io'
  switch (err.code) {
    case 'no_crypto':
      return 'ai.err.noCrypto'
    case 'empty_name':
      return 'ai.err.emptyName'
    case 'empty_password':
      return 'ai.err.emptyPassword'
    case 'bad_config':
      return 'ai.err.incomplete'
    case 'unlock_failed':
      return 'ai.err.unlockFailed'
    case 'bad_token':
      return 'ai.err.badToken'
    case 'not_found':
      return 'ai.err.notFound'
    case 'locked':
      return 'ai.err.locked'
    default:
      return 'ai.err.io'
  }
}

/* ------------------------------------------------------------------ 绘制 */

function draw(): void {
  const host = credRoot
  if (!host) return
  host.textContent = ''

  if (view.error === 'ai.err.noCrypto') {
    host.append(div('ai-alert is-err', t('ai.err.noCrypto')))
    host.append(div('ai-hint', t('ai.hint.noCrypto')))
    syncChat()
    return
  }

  const unlockedConfig = isUnlocked() ? getConfig() : null
  const ready = Boolean(unlockedConfig)
  // 编辑态要同时看得见卡片（当前模型）与表单（在改什么）
  const editing =
    view.mode === 'edit' && view.target ? records.find((r) => r.id === view.target) : undefined
  // 记录被删 / 会话被锁：退回列表，别留在没有数据的表单里
  if (view.mode === 'edit' && !editing) {
    view.mode = 'list'
    view.target = null
  }

  /**
   * 一份配置都没有、也不在填表：整块留白只放一个居中的「添加配置」。
   * 这是第一次打开面板时唯一的画面 —— 让人一眼知道下一步就是点那颗按钮，
   * 而不是在空列表和一堆说明文字里找出口。
   */
  const empty =
    !records.length && !unlockedConfig && view.mode !== 'create' && !editing && !loading

  host.classList.toggle('is-empty', empty)
  host.append(credHead(ready))

  if (view.error) host.append(div('ai-alert is-err', t(view.error)))
  if (view.notice) host.append(div('ai-alert is-ok', view.notice))

  if (empty) {
    host.append(emptyState())
  } else if (loading && !records.length && !unlockedConfig) {
    host.append(div('ai-hint', t('ai.chat.loading')))
  } else if (view.mode === 'create') {
    host.append(createForm())
  } else if (editing && unlockedConfig && unlockedId() === editing.id) {
    host.append(card(unlockedConfig), editForm(editing, unlockedConfig))
  } else {
    if (unlockedConfig) host.append(card(unlockedConfig))
    host.append(listSection())
    const foot = div('ai-foot')
    foot.append(
      button('ai.action.new', 'btn btn-primary', startCreate),
      button('ai.action.pasteToken', 'btn btn-ghost', openImportDialog),
      button('ai.action.backup', 'btn btn-ghost', () => void doBackup()),
    )
    if (loading) foot.classList.add('is-busy')
    host.append(foot)
  }

  // 凭据区的每次重画都可能改变「是否已启用」，会话区跟着增删
  syncChat()
}

/** 页头：标题 + 一句当前处境；已启用时右上角给一颗**看得见**的「返回对话」 */
function credHead(ready: boolean): HTMLElement {
  const head = div('ai-cred-head')
  const heading = div('ai-cred-heading')
  heading.append(
    div('ai-cred-title', t('ai.cred.title')),
    div('ai-cred-sub', t(ready ? 'ai.cred.manage' : 'ai.cred.start')),
  )
  head.append(heading)

  if (ready) {
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'btn btn-ghost ai-cred-back'
    back.textContent = `← ${t('ai.chat.back')}`
    back.addEventListener('click', () => {
      managing = false
      view.mode = 'list'
      view.target = null
      view.error = ''
      view.notice = ''
      draw()
    })
    head.append(back)
  }
  return head
}

function emptyState(): HTMLElement {
  const box = div('ai-empty-state')
  box.append(
    div('ai-empty-title', t('ai.empty.noProfiles')),
    div('ai-empty-note', t('ai.empty.addNote')),
    button('ai.action.addConfig', 'btn btn-primary ai-empty-add', startCreate),
  )
  return box
}

function startCreate(): void {
  // 新建/编辑/备份都是「管理动作」：期间别把凭据区收起来，否则刚填的表单一闪就没
  managing = true
  view.mode = 'create'
  view.target = null
  view.error = ''
  view.notice = ''
  draw()
}

/** 已启用：只显示非敏感摘要 + 元数据，key 永远打码 */
function card(config: ProfileConfig): HTMLElement {
  const rec = records.find((r) => r.id === unlockedId())
  const box = div('ai-card')

  const head = div('ai-card-head')
  head.append(div('ai-card-title', rec?.name ?? t('ai.active')))
  head.append(div('ai-badge', t('ai.active')))
  box.append(head)

  const meta = document.createElement('dl')
  meta.className = 'ai-meta'
  // 一套配置多个模型时给切换器 —— 这就是「DeepSeek flash / pro 来回切」的位置。
  // 切换只改当前模型并落库，不重问密码：配置已经解锁，这属于使用而非改动凭据。
  const modelNode: HTMLElement =
    config.models.length > 1
      ? select(config.models, config.model, (value) => void doSwitchModel(value))
      : div('ai-meta-value', config.model)
  const pairs: [MessageKey, HTMLElement][] = [
    ['ai.field.model', modelNode],
    ['ai.field.baseUrl', div('ai-meta-value', config.baseUrl)],
    ['ai.field.apiKey', div('ai-meta-value', maskKey(config.apiKey))],
  ]
  for (const [key, value] of pairs) {
    const dt = document.createElement('dt')
    dt.textContent = t(key)
    const dd = document.createElement('dd')
    dd.append(value)
    meta.append(dt, dd)
  }
  box.append(meta)

  const actions = div('ai-actions')
  actions.append(
    button('ai.action.edit', 'btn btn-ghost', () => {
      if (!rec) return
      view.mode = 'editAuth'
      view.target = rec.id
      view.error = ''
      draw()
    }),
    button('ai.action.export', 'btn btn-ghost', () => {
      if (!rec) return
      view.mode = 'reveal'
      view.target = rec.id
      view.error = ''
      draw()
    }),
    button('ai.action.lock', 'btn btn-ghost', () => {
      lock()
      view.mode = 'list'
      view.target = null
      view.notice = t('ai.notice.locked')
      draw()
    }),
  )
  box.append(actions)

  if (view.mode === 'reveal' && view.target === rec?.id) {
    box.append(passwordForm('ai.field.passwordAsk', async (password) => {
      const plain = await reveal(rec.id, password)
      showPlain(plain)
      view.mode = 'list'
      view.target = null
      draw()
    }))
  }

  return box
}

function listSection(): HTMLElement {
  const box = div('ai-section')
  box.append(div('ai-section-title', t('ai.section.profiles')))

  if (!records.length) {
    box.append(div('ai-empty', t('ai.empty.profiles')))
    return box
  }

  for (const rec of records) {
    const row = div('ai-row')
    const main = div('ai-row-main')
    // 列表认的是**用户自己起的配置名**（D-40）。模型名、地址、密钥都在信封里，
    // 未启用时一概看不到 —— 所以名字必须由用户起成「自己认得出的那个」。
    main.append(div('ai-row-name', rec.name))
    main.append(div('ai-row-sub', t('ai.row.used', { time: when(rec.lastUsedAt) })))
    row.append(main)

    if ((view.mode === 'enable' || view.mode === 'editAuth') && view.target === rec.id) {
      const enabling = view.mode === 'enable'
      // 密码框单独占一块，不要塞进行里跟名字抢宽度（面板最窄只有 280px）
      const open = div('ai-inline-wrap')
      open.append(
        passwordForm('ai.field.passwordAsk', async (password) => {
          // 两个动作都要先证明是本人：启用 = 解出明文到内存，编辑 = 还要拿到可重封装的 key
          await unlock(rec.id, password)
          if (enabling) {
            // 启用即进对话页：用户点「启用」要的是马上能聊，不是再看一遍配置列表。
            // 想回来管理配置，状态栏的「管理配置」随时在。
            managing = false
            view.mode = 'list'
            view.target = null
            view.notice = ''
            await reload()
          } else {
            managing = true
            view.mode = 'edit'
            view.error = ''
            view.notice = ''
            draw()
          }
        }),
        button('action.cancel', 'btn btn-ghost', () => {
          view.mode = 'list'
          view.target = null
          view.error = ''
          draw()
        }),
      )
      box.append(row, open)
      continue
    }

    const actions = div('ai-row-actions')
    if (isUnlocked() && unlockedId() === rec.id) {
      actions.append(div('ai-badge', t('ai.active')))
    } else {
      // 「启用」是这一页唯一的主线动作（启用完就进对话），给它实心按钮
      actions.append(
        button('ai.action.activate', 'btn btn-primary ai-row-activate', () => {
          view.mode = 'enable'
          view.target = rec.id
          view.error = ''
          view.notice = ''
          draw()
        }),
      )
    }
    // 复制口令不需要先解锁：它是密文的重编码，不含明文 key，只要求重新输密码（D-47）
    actions.append(
      iconButton('ai-row-copy', t('ai.action.copyToken'), COPY_SVG, () => {
        openExportDialog(rec)
      }),
    )
    // 删除不在这里：它藏在「编辑」里，先验证密码再删（D-42）
    actions.append(
      button('ai.action.edit', 'btn btn-ghost', () => {
        view.mode = 'editAuth'
        view.target = rec.id
        view.error = ''
        view.notice = ''
        draw()
      }),
    )
    row.append(actions)
    box.append(row)
  }

  return box
}

/** 新建表单：四个字段一次填完，创建成功则直接解锁（少一次「刚建完又要输密码」） */
function createForm(): HTMLElement {
  const box = div('ai-card is-form')
  box.append(div('ai-card-title', t('ai.action.new')))
  box.append(div('ai-hint', t('ai.hint.createNote')))

  const name = input('text', '', 'ai.field.nameHint')
  const baseUrl = input('url', 'https://api.openai.com/v1', 'ai.field.baseUrlHint')
  const models = textarea('ai.field.modelsHint')
  const apiKey = input('password', '', 'ai.field.apiKeyHint')
  const password = input('password', '', 'ai.field.passwordHint')

  box.append(
    field('ai.field.name', 'ai.field.nameNote', name),
    field('ai.field.baseUrl', null, baseUrl),
    field('ai.field.models', 'ai.field.modelsNote', models),
    field('ai.field.apiKey', null, apiKey),
    field('ai.field.password', 'ai.field.passwordNote', password),
  )

  const err = div('ai-alert is-err')
  err.hidden = true
  const status = div('ai-alert')
  status.hidden = true
  box.append(err, status)

  /** 表单当前值 → config。测试和创建都用它，保证「测的」和「存的」是同一份 */
  const snapshot = (): ProfileConfig => {
    const list = lines(models.value)
    return {
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      models: list,
      model: list[0] ?? '',
    }
  }

  let busy = false
  const foot = div('ai-actions')
  foot.append(
    button('action.cancel', 'btn btn-ghost', () => {
      view.mode = 'list'
      view.error = ''
      draw()
    }),
    button('ai.action.test', 'btn btn-ghost', () => {
      void (async () => {
        if (busy) return
        const config = snapshot()
        if (!config.baseUrl || !config.apiKey || !config.models.length) {
          err.textContent = t('ai.err.incomplete')
          err.hidden = false
          return
        }
        err.hidden = true
        busy = true
        try {
          await runProbe(config, status)
        } finally {
          busy = false
        }
      })()
    }),
    button('ai.action.create', 'btn btn-primary', () => {
      void (async () => {
        if (busy) return
        const config = snapshot()
        const wanted = name.value.trim()
        // 名称先查：它是未启用时唯一的识别信息，空着建出来的配置等于没法选
        if (!wanted) {
          err.textContent = t('ai.err.emptyName')
          err.hidden = false
          name.focus()
          return
        }
        if (!config.baseUrl || !config.apiKey || !config.models.length) {
          err.textContent = t('ai.err.incomplete')
          err.hidden = false
          return
        }
        err.hidden = true
        busy = true
        try {
          // 先测再存（D-04 修订）：连不上的配置落库只会变成列表里的垃圾
          if (!(await runProbe(config, status))) return
          const rec = await createProfile(wanted, password.value, config)
          await unlock(rec.id, password.value)
          // 建完直接解锁 + 进对话页：少一次「刚建完又要输密码」，也少一次「建完不知道去哪」
          managing = false
          view.mode = 'list'
          view.notice = ''
          await reload()
        } catch (e) {
          err.textContent = t(errorText(e))
          err.hidden = false
        } finally {
          busy = false
        }
      })()
    }),
  )
  box.append(foot)

  // 弹窗里第一眼该落在名称上
  queueMicrotask(() => name.focus())
  return box
}

/**
 * 编辑态：进到这里说明密码已经验过，`session` 就是这份配置（拿到可重封装的 key）。
 *
 * 密钥框**故意留空**：留空即不改。这样「编辑」不需要把明文 key 放进 DOM，
 * INV-1 不用为它开口子；真要换 key 就填新的。
 */
function editForm(rec: ProfileRecord, config: ProfileConfig): HTMLElement {
  const box = div('ai-card is-form')
  box.append(div('ai-card-title', t('ai.edit.title', { name: rec.name })))
  box.append(div('ai.hint', t('ai.edit.hint')))

  const name = input('text')
  name.value = rec.name
  const baseUrl = input('url')
  baseUrl.value = config.baseUrl
  const models = textarea('ai.field.modelsHint')
  models.value = config.models.join('\n')
  const apiKey = input('password', '', 'ai.field.apiKeyKeepHint')
  apiKey.autocomplete = 'new-password'

  const keyField = field('ai.field.apiKey', null, apiKey)
  keyField.append(div('ai-field-hint', t('ai.field.apiKeyKeep', { key: maskKey(config.apiKey) })))

  box.append(
    field('ai.field.name', 'ai.field.nameNote', name),
    field('ai.field.baseUrl', null, baseUrl),
    field('ai.field.models', 'ai.field.modelsNote', models),
    keyField,
  )

  const err = div('ai-alert is-err')
  err.hidden = true
  const status = div('ai-alert')
  status.hidden = true
  box.append(err, status)

  /** 表单当前值（key 留空则沿用旧 key）——测的必须是用户填的那一份，不是已存的 */
  const draft = (): ProfileConfig => {
    const list = lines(models.value)
    return {
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim() || config.apiKey,
      models: list,
      model: list.includes(config.model) ? config.model : list[0],
    }
  }

  let busy = false
  const foot = div('ai-actions')
  foot.append(
    button('action.cancel', 'btn btn-ghost', () => {
      view.mode = 'list'
      view.target = null
      view.error = ''
      draw()
    }),
    // 删除只在这里出现：验过密码 + 再过一次确认，才是「本人主动删」
    button('ai.action.delete', 'btn btn-ghost is-danger', () => void doDelete(rec)),
    // 测试紧挨着保存：用户改完端点后想知道的正是「我填的这个通不通」
    button('ai.action.test', 'btn btn-ghost', () => {
      void (async () => {
        if (busy) return
        const next = draft()
        if (!next.baseUrl || !next.models.length) {
          err.textContent = t('ai.err.incomplete')
          err.hidden = false
          return
        }
        err.hidden = true
        busy = true
        try {
          await runProbe(next, status)
        } finally {
          busy = false
        }
      })()
    }),
    button('ai.action.save', 'btn btn-primary', () => {
      void (async () => {
        const list = lines(models.value)
        const wanted = name.value.trim()
        if (!wanted) {
          err.textContent = t('ai.err.emptyName')
          err.hidden = false
          name.focus()
          return
        }
        if (!baseUrl.value.trim() || !list.length) {
          err.textContent = t('ai.err.incomplete')
          err.hidden = false
          return
        }
        const patch: Partial<ProfileConfig> = {
          baseUrl: baseUrl.value.trim(),
          models: list,
          // 当前模型被删掉就落到第一行，不留「指向不存在模型」的悬空状态
          model: list.includes(config.model) ? config.model : list[0],
        }
        const typed = apiKey.value.trim()
        if (typed) patch.apiKey = typed
        try {
          await saveConfig(patch)
          await renameProfile(rec.id, wanted)
          view.mode = 'list'
          view.target = null
          view.notice = t('ai.notice.saved', { name: wanted })
          await reload()
        } catch (e) {
          err.textContent = t(errorText(e))
          err.hidden = false
        }
      })()
    }),
  )
  box.append(foot)
  return box
}

/** 非安全上下文下 navigator.clipboard 可能不存在；失败时由调用方降级为「选中文本」 */
async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

function selectNode(node: Node): void {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/**
 * 「复制口令」（D-47）。
 *
 * 先验密码不是多余的仪式：AES-GCM 不挑密码，任何字符串都能「加密成功」，
 * 不验就会生成一段谁也打不开的文本。所以这里比导入多花一次 PBKDF2（约 0.4s）。
 */
function openExportDialog(rec: ProfileRecord): void {
  const body = div('ai-token-box')

  const askStep = (): void => {
    body.textContent = ''
    body.append(div('ai-hint', t('ai.token.exportHint')))
    const password = input('password', '', 'ai.field.passwordAsk')
    password.autocomplete = 'current-password'
    const status = div('ai-alert')
    status.hidden = true
    const go = button('ai.token.generate', 'btn btn-primary')
    const row = div('ai-actions')
    row.append(go)
    body.append(field('ai.field.password', null, password), status, row)

    go.onclick = () => {
      void (async () => {
        if (go.disabled) return
        go.disabled = true
        // 口令用 1M 次 PBKDF2，加上前面的验证，这一下大约 1 秒；不给反馈就像卡死
        status.className = 'ai-alert'
        status.textContent = t('ai.token.working')
        status.hidden = false
        try {
          const result = await exportToken(rec.id, password.value)
          showStep(result.token, result.chars)
        } catch (e) {
          status.className = 'ai-alert is-err'
          status.textContent = t(errorText(e))
          status.hidden = false
          password.select()
        } finally {
          go.disabled = false
        }
      })()
    }
    password.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        go.click()
      }
    })
    queueMicrotask(() => password.focus())
  }

  const showStep = (token: string, chars: number): void => {
    body.textContent = ''
    body.append(div('ai-hint', t('ai.token.warn')))
    const pre = document.createElement('pre')
    pre.className = 'ai-plain ai-token-text'
    pre.textContent = token
    const status = div('ai-alert')
    status.hidden = true
    const copy = button('ai.action.copyToken', 'btn btn-primary')
    copy.onclick = () => {
      void (async () => {
        status.hidden = false
        if (await copyText(token)) {
          status.className = 'ai-alert is-ok'
          status.textContent = t('ai.token.copied', { chars })
          return
        }
        status.className = 'ai-alert is-err'
        status.textContent = t('ai.token.copyFailed')
        selectNode(pre)
      })()
    }
    const row = div('ai-actions')
    row.append(copy)
    body.append(pre, status, row)
  }

  askStep()
  openDialog({ title: t('ai.token.exportTitle', { name: rec.name }), body })
}

/**
 * 「粘贴口令」（D-04 修订 + D-47）。
 *
 * 三步：解口令 → 解出来的配置**可编辑**（跨网络的端点常常必须改）→ 测试通过才落库。
 * 任何一步失败都不写库：库里不该出现「打不开」或「根本连不上」的配置。
 */
function openImportDialog(): void {
  managing = true
  const body = div('ai-token-box')
  // 口令密码同时是这条新记录的密码：用户刚输过，不再问第二次
  let secret = ''
  let handle: DialogHandle | null = null
  const close = (): void => handle?.close()

  const pasteStep = (): void => {
    body.textContent = ''
    body.append(div('ai-hint', t('ai.token.importHint')))
    const token = textarea('ai.token.pasteHint')
    token.rows = 5
    token.spellcheck = false
    const password = input('password', '', 'ai.field.passwordAsk')
    password.autocomplete = 'current-password'
    const status = div('ai-alert')
    status.hidden = true
    const go = button('ai.token.decrypt', 'btn btn-primary')
    const row = div('ai-actions')
    row.append(button('action.cancel', 'btn btn-ghost', close), go)
    body.append(
      field('ai.token.paste', null, token),
      field('ai.field.password', 'ai.token.passwordNote', password),
      status,
      row,
    )

    go.onclick = () => {
      void (async () => {
        if (go.disabled) return
        go.disabled = true
        status.className = 'ai-alert'
        status.textContent = t('ai.token.working')
        status.hidden = false
        try {
          const config = await importToken(token.value, password.value)
          secret = password.value
          previewStep(config)
        } catch (e) {
          status.className = 'ai-alert is-err'
          status.textContent = t(errorText(e))
          status.hidden = false
        } finally {
          go.disabled = false
        }
      })()
    }
    queueMicrotask(() => token.focus())
  }

  const previewStep = (config: ProfileConfig): void => {
    body.textContent = ''
    body.append(div('ai-hint', t('ai.token.previewHint', { n: config.models.length })))
    const name = input('text')
    name.value = nameFromUrl(config.baseUrl)
    const baseUrl = input('url')
    baseUrl.value = config.baseUrl
    const models = textarea('ai.field.modelsNote')
    models.value = config.models.join('\n')
    const err = div('ai-alert is-err')
    err.hidden = true
    const status = div('ai-alert')
    status.hidden = true
    body.append(
      field('ai.field.name', 'ai.field.nameNote', name),
      field('ai.field.baseUrl', 'ai.token.baseUrlNote', baseUrl),
      field('ai.field.models', 'ai.field.modelsNote', models),
      err,
      status,
    )

    let busy = false
    const go = button('ai.token.testAndImport', 'btn btn-primary')
    const row = div('ai-actions')
    row.append(button('action.cancel', 'btn btn-ghost', close), go)
    body.append(row)

    go.onclick = () => {
      void (async () => {
        if (busy) return
        const list = lines(models.value)
        const wanted = name.value.trim()
        if (!wanted) {
          err.textContent = t('ai.err.emptyName')
          err.hidden = false
          name.focus()
          return
        }
        if (!baseUrl.value.trim() || !list.length) {
          err.textContent = t('ai.err.incomplete')
          err.hidden = false
          return
        }
        err.hidden = true
        busy = true
        go.disabled = true
        try {
          const next: ProfileConfig = {
            baseUrl: baseUrl.value.trim(),
            apiKey: config.apiKey,
            models: list,
            model: list.includes(config.model) ? config.model : list[0],
          }
          // 先测再存：加密成功只证明密码对，证明不了这台机器现在连得上
          if (!(await runProbe(next, status, next.model))) return
          const rec = await createProfile(wanted, secret, next)
          await unlock(rec.id, secret)
          managing = false
          view.mode = 'list'
          view.error = ''
          view.notice = t('ai.notice.imported', { name: wanted })
          await reload()
          close()
        } catch (e) {
          err.textContent = t(errorText(e))
          err.hidden = false
        } finally {
          busy = false
          go.disabled = false
        }
      })()
    }
  }

  handle = openDialog({
    title: t('ai.token.importTitle'),
    body,
    onClose: () => {
      managing = false
      view.error = ''
      draw()
    },
  })
  pasteStep()
}

/** 启用 / 导出共用：只问密码，回车即提交 */
function passwordForm(
  labelKey: MessageKey,
  submit: (password: string) => Promise<void>,
): HTMLElement {
  const box = div('ai-inline-form')
  const password = input('password')
  password.autocomplete = 'current-password'
  box.append(field(labelKey, null, password))

  const err = div('ai-alert is-err')
  err.hidden = true
  box.append(err)

  const go = () => {
    void (async () => {
      try {
        await submit(password.value)
      } catch (e) {
        err.textContent = t(errorText(e))
        err.hidden = false
        password.select()
      }
    })()
  }

  const foot = div('ai-actions')
  foot.append(button('action.confirm', 'btn btn-primary', go))
  box.append(foot)

  password.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      go()
    }
  })
  queueMicrotask(() => password.focus())
  return box
}

/* ------------------------------------------------------------------ 动作 */

/** 一套配置里换模型：已解锁状态下不重问密码，选了就落库（下次解锁记得） */
async function doSwitchModel(model: string): Promise<void> {
  view.error = ''
  view.notice = ''
  try {
    await switchModel(model)
    view.notice = t('ai.notice.modelSwitched', { model })
  } catch (e) {
    view.error = errorText(e)
  }
  await reload()
}

async function doDelete(rec: ProfileRecord): Promise<void> {
  const { ok } = await confirmDialog(
    t('ai.confirm.deleteTitle', { name: rec.name }),
    t('ai.confirm.deleteBody'),
  )
  if (!ok) return
  try {
    await deleteProfile(rec.id)
    view.error = ''
    view.notice = t('ai.notice.deleted')
  } catch (e) {
    view.error = errorText(e)
  }
  await reload()
}

async function doBackup(): Promise<void> {
  view.error = ''
  view.notice = ''
  try {
    const result = await exportBackup()
    downloadBlob(result.fileName, result.blob)
    view.notice = t('ai.notice.backup', {
      n: result.count,
      size: formatBytes(result.bytes),
    })
  } catch (e) {
    view.error = errorText(e)
  }
  await reload()
}

/**
 * D-05：导出明文。文本落在弹窗里，不写剪贴板、不写 localStorage；
 * 关掉弹窗即从 DOM 消失（`openDialog` 会清空 dialogLayer）。
 */
function showPlain(config: ProfileConfig): void {
  const body = document.createElement('div')
  body.append(div('ai-hint', t('ai.export.hint')))
  const pre = document.createElement('pre')
  pre.className = 'ai-plain'
  pre.textContent = JSON.stringify(config, null, 2)
  body.append(pre)

  const foot = div('ai-actions')
  const copy = button('ai.action.copy', 'btn btn-primary', () => {
    void navigator.clipboard?.writeText(pre.textContent ?? '').then(
      () => {
        copy.textContent = t('ai.action.copied')
      },
      () => {
        // 非安全上下文没有 clipboard：退化成「全选让人自己复制」
        const range = document.createRange()
        range.selectNodeContents(pre)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      },
    )
  })
  foot.append(copy)
  openDialog({ title: t('ai.export.title'), body, foot })
}

/* ------------------------------------------------------------------ 会话区 */

/**
 * 会话区整块交给 `ai/chat.ts`：它要跟当前文件、配置锁、在途请求三件事打交道，
 * 留在凭据面板里会让本文件突破 1000 行，也会把两套状态混成一套。
 *
 * 这里只负责一件事：**什么时候把它叫醒**。
 * - 解锁了 → refresh（对齐到当前文件，不 abort 在途请求）
 * - 锁了 / 没配置 → reset（abort + 清空内存，消息仍在库里）
 */
function syncChat(): void {
  if (!chatRoot || !credRoot) return

  const ready = isUnlocked() && Boolean(getConfig()) && view.error !== 'ai.err.noCrypto'
  // 没配好就只能看凭据区；配好了默认只看对话
  const showCred = managing || !ready
  credRoot.hidden = !showCred
  chatRoot.hidden = showCred
  // 对话模式下**不能让外层槽位滚**：否则流式每来一段字整页都在跳（滚动权交给消息区）
  root?.classList.toggle('is-chat', !showCred)

  if (!ready) {
    chatView?.reset()
    announceReady(false)
    return
  }
  if (!chatView) {
    chatView = createChatView({
      host: chatRoot,
      getTarget: () => getTarget(),
      // 用 getter 包一层：测试或将来换宿主时不用重建整个面板
      get docHost() {
        return docHost
      },
      onManage: () => {
        managing = true
        view.mode = 'list'
        view.error = ''
        view.notice = ''
        draw()
      },
      onConfigChange: () => void reload(),
    })
  }
  chatView.refresh()
  // 必须在 chatView 建好**之后**通知：`isAiChatReady()` 看的就是它，
  // 提前通知会让标题栏算成「还不能用」，两颗按钮第一次解锁时不出现
  announceReady(true)
}

/** 对话可用性翻转时通知壳层重算标题栏按钮；没翻转就什么都不做 */
function announceReady(ready: boolean): void {
  if (ready === lastReady) return
  lastReady = ready
  notifyReadyChange?.()
}
