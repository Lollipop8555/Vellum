/**
 * OpenAI 兼容接口的流式传输层（D-37）。
 *
 * 设计上只有一条出口：**归一化事件流**。调用方（P3 的 session / P4 的工具循环）
 * 只认 `StreamEvent`，不碰 SSE、不碰 `choices[0].delta`、也不碰 HTTP 状态码。
 *
 * 非 2xx **不 throw，而是 yield 一个 error 事件**：一条错误通道比两条好写，
 * 调用方不必在 `for await` 外面再套一层 try。
 *
 * 六个必须处理的真实坑（见 plans/ai-integration-survey.md §4.1）：
 * 1. JSON 跨 chunk 断裂 —— 按 `\n\n` 切事件，最后一段不完整就留在缓冲里
 * 2. `tool_calls[]` 的 `index` 才是分组键，`id`/`name` 只在首个分片出现
 * 3. `usage` 只出现在最后一个 chunk，`[DONE]` 之后还可能有空行
 * 4. `reasoning_content` 与 `content` 并列，不能当未知字段丢掉
 * 5. abort 后必须主动 `reader.cancel()`，否则 Safari 留半开连接
 * 6. 非 2xx 的 body 可能是网关 HTML 页；只取 `error.message`，绝不整段回显（INV-1）
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** 真正的线上报文：字段名保持下划线风格，别在这里做「好看」的重命名 */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface WireMessage {
  role: Role
  /** assistant 带 tool_calls 时内容可以是 null */
  content: string | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type ErrorCode =
  /** 连不上：CORS、地址不可达、DNS */
  | 'network'
  /** 401 / 403 */
  | 'auth'
  /** 404：baseUrl 或 model 不存在 */
  | 'not_found'
  /** 429 */
  | 'rate_limit'
  /** 其它非 2xx */
  | 'http'
  /** 流本身不合法（没有 body、JSON 坏掉） */
  | 'stream'
  /** 调用方主动中止：通常不会走到这里，abort 时事件流直接结束 */
  | 'aborted'

export type StreamEvent =
  | { type: 'text.delta'; delta: string }
  | { type: 'reasoning.delta'; delta: string }
  | { type: 'tool-call.start'; index: number; id: string; name: string }
  | { type: 'tool-call.delta'; index: number; argsDelta: string }
  | { type: 'tool-call.done'; index: number; id: string; name: string; args: string }
  | { type: 'step.done'; finishReason: string; usage?: Usage }
  | { type: 'error'; code: ErrorCode; message: string; status?: number }

export interface ChatRequest {
  /** OpenAI 兼容根地址，可带 `/v1`，也可直接给到 `/chat/completions` */
  baseUrl: string
  apiKey: string
  model: string
  messages: WireMessage[]
  tools?: ToolSchema[]
  signal: AbortSignal
  temperature?: number
  maxTokens?: number
}

const CHAT_PATH = '/chat/completions'
const DONE = '[DONE]'
/** 错误体最多读这么多：网关 HTML 可能有几十 KB，读全等于把页面塞进内存 */
const ERROR_BODY_LIMIT = 4096
/** 回显给用户的错误摘要上限（INV-1：只取 message，且截断） */
const ERROR_TEXT_LIMIT = 240

/** 拼接端点：允许 baseUrl 写成 `.../v1`、`.../v1/` 或完整端点 */
function endpointOf(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith(CHAT_PATH) ? trimmed : trimmed + CHAT_PATH
}

function codeOf(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limit'
  return 'http'
}

/** HTML 兜底：去标签、压空白，得到一句人话；不保留结构，免得把整页漏出去 */
function plainText(raw: string): string {
  return raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ERROR_TEXT_LIMIT)
}

/**
 * 从错误响应里抠出一句话。
 * 先试 JSON 的 `error.message`（OpenAI / DeepSeek / 大多数网关），再试 `message`，
 * 最后才退化成「去标签的纯文本」。任何情况下都不返回整个 body。
 */
async function readError(res: Response): Promise<string> {
  let raw = ''
  try {
    raw = (await res.text()).slice(0, ERROR_BODY_LIMIT)
  } catch {
    return `HTTP ${res.status}`
  }
  try {
    const json = JSON.parse(raw) as {
      error?: { message?: unknown } | string
      message?: unknown
    }
    const direct = typeof json.error === 'string' ? json.error : json.error?.message
    const message = typeof direct === 'string' ? direct : json.message
    if (typeof message === 'string' && message.trim()) {
      return message.trim().slice(0, ERROR_TEXT_LIMIT)
    }
  } catch {
    // 不是 JSON：多半是网关错误页，走下面的纯文本兜底
  }
  return plainText(raw) || `HTTP ${res.status}`
}

function mapUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  if (!('prompt_tokens' in o) && !('completion_tokens' in o) && !('total_tokens' in o)) {
    return undefined
  }
  return {
    promptTokens: num(o.prompt_tokens),
    completionTokens: num(o.completion_tokens),
    totalTokens: num(o.total_tokens),
  }
}

/** 取一个 SSE 事件块里的 data 载荷；注释行（`:` 开头）与 event 行直接跳过 */
function payloadOf(block: string): string | null {
  const parts: string[] = []
  for (const line of block.split('\n')) {
    const text = line.trimEnd()
    if (!text || text.startsWith(':')) continue
    if (!text.startsWith('data:')) continue
    // 规范允许 `data:` 后有一个空格，也允许多行 data 拼接
    parts.push(text.slice(5).replace(/^ /, ''))
  }
  return parts.length ? parts.join('\n') : null
}

/** 一个分片里的 tool_calls：按 index 归并，首个带 id/name 的分片才算 start */
interface CallSlot {
  id: string
  name: string
  args: string
}

/** 发一次请求；网络层错误交给调用方判断是不是 abort */
async function post(req: ChatRequest, body: Record<string, unknown>): Promise<Response> {
  return fetch(endpointOf(req.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })
}

/**
 * 400 自愈：新模型越来越爱拒绝老参数。
 *
 * 已知的两种：推理模型报 `` `temperature` is deprecated for this model ``；
 * 新接口把 `max_tokens` 换成了 `max_completion_tokens`。**只在报错点名了那个字段时才改**——
 * 400 也可能是「messages 格式错」，那种重试只是把钱花两遍。
 *
 * 只重试一次；两次都不行就把第二次的原文交给调用方。
 */
async function healBody(res: Response, body: Record<string, unknown>): Promise<boolean> {
  if (res.status !== 400) return false
  const hasTemp = typeof body.temperature === 'number'
  const hasTokens = typeof body.max_tokens === 'number'
  if (!hasTemp && !hasTokens) return false

  // clone 一份读错误体：真正要用的时候（不重试）原始 res 还要能读
  let text = ''
  try {
    text = (await res.clone().text()).slice(0, ERROR_BODY_LIMIT)
  } catch {
    return false
  }
  const dropTemp = hasTemp && /temperature/i.test(text)
  const swapTokens = hasTokens && /max_tokens/i.test(text) && !dropTemp
  if (!dropTemp && !swapTokens) return false

  if (dropTemp) delete body.temperature
  if (swapTokens) {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
  }
  return true
}

export async function* streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
    // 让 provider 在最后一片带上 usage；不认这个字段的实现会默默忽略
    stream_options: { include_usage: true },
  }
  if (req.tools?.length) body.tools = req.tools
  if (typeof req.temperature === 'number') body.temperature = req.temperature
  if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens

  let res: Response
  try {
    res = await post(req, body)
    if (!res.ok && (await healBody(res, body))) {
      // 换掉那个字段再来一次；仍是 4xx 就按第二次的报错说话
      res = await post(req, body)
    }
  } catch (error) {
    if (req.signal.aborted) return
    yield {
      type: 'error',
      code: 'network',
      message: (error as Error).message || 'fetch failed',
    }
    return
  }

  if (!res.ok) {
    yield {
      type: 'error',
      code: codeOf(res.status),
      message: await readError(res),
      status: res.status,
    }
    return
  }
  if (!res.body) {
    yield { type: 'error', code: 'stream', message: 'response has no body' }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const calls = new Map<number, CallSlot>()
  let buffer = ''
  let finishReason = ''
  let usage: Usage | undefined
  let sawDone = false

  /** 解析一个完整事件块；返回要发的事件（generator 里不能嵌套 yield，改成收集） */
  const consume = (block: string): StreamEvent[] => {
    const payload = payloadOf(block)
    if (!payload) return []
    if (payload === DONE) {
      sawDone = true
      return []
    }
    let chunk: {
      choices?: Array<{
        delta?: {
          content?: unknown
          reasoning_content?: unknown
          /** 非 OpenAI 系端点的别名（OpenRouter 一类），和 `reasoning_content` 同义 */
          reasoning?: unknown
          tool_calls?: Array<{
            index?: unknown
            id?: unknown
            function?: { name?: unknown; arguments?: unknown }
          }>
        }
        finish_reason?: unknown
      }>
      usage?: unknown
    }
    try {
      chunk = JSON.parse(payload)
    } catch {
      // 单块坏掉不该毁掉整条流：丢掉它继续读
      return []
    }
    const out: StreamEvent[] = []
    const mapped = mapUsage(chunk.usage)
    if (mapped) usage = mapped

    const choice = chunk.choices?.[0]
    if (!choice) return out
    const delta = choice.delta ?? {}

    // 思维链的字段名各家不一：reasoning_content 是主流，reasoning 是别名。
    // 只认其中一个的话，换端点就「思考过程完全不展示」，而用户无从判断是谁的锅。
    const thought =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : ''
    if (thought) out.push({ type: 'reasoning.delta', delta: thought })
    if (typeof delta.content === 'string' && delta.content) {
      out.push({ type: 'text.delta', delta: delta.content })
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = typeof tc.index === 'number' ? tc.index : 0
        let slot = calls.get(index)
        if (!slot) {
          slot = { id: '', name: '', args: '' }
          calls.set(index, slot)
        }
        const id = typeof tc.id === 'string' ? tc.id : ''
        const name = typeof tc.function?.name === 'string' ? tc.function.name : ''
        let started = false
        if (id && !slot.id) {
          slot.id = id
          started = true
        }
        if (name && !slot.name) {
          slot.name = name
          started = true
        }
        if (started && slot.name) {
          out.push({ type: 'tool-call.start', index, id: slot.id, name: slot.name })
        }
        const argsDelta = tc.function?.arguments
        if (typeof argsDelta === 'string' && argsDelta) {
          slot.args += argsDelta
          out.push({ type: 'tool-call.delta', index, argsDelta })
        }
      }
    }

    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      finishReason = choice.finish_reason
    }
    return out
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let cut = buffer.indexOf('\n\n')
      while (cut >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        for (const event of consume(block)) yield event
        cut = buffer.indexOf('\n\n')
      }
    }

    // 有些实现最后一条事件没有以空行收尾：补一次
    buffer += decoder.decode()
    if (buffer.trim()) {
      for (const event of consume(buffer)) yield event
    }

    // 工具调用收口：即使没有 finish_reason（流被截断），也要让调用方拿到参数
    for (const [index, slot] of calls) {
      yield { type: 'tool-call.done', index, id: slot.id, name: slot.name, args: slot.args }
    }
    yield {
      type: 'step.done',
      finishReason: finishReason || 'stop',
      ...(usage ? { usage } : {}),
    }
  } catch (error) {
    if (req.signal.aborted) return
    yield { type: 'error', code: 'stream', message: (error as Error).message || 'stream broke' }
  } finally {
    // abort 时 fetch 已经断开，但 reader 不 cancel 会在 Safari 留半开连接
    if (!sawDone) {
      try {
        await reader.cancel()
      } catch {
        // 已关闭的连接 cancel 会 reject，忽略
      }
    }
  }
}

/* ------------------------------------------------------------------ 连通性探活 */

export interface ProbeInput {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
}

export interface ProbeResult {
  ok: boolean
  /** 首个事件到达的耗时（毫秒） */
  ms: number
  code?: ErrorCode
  message?: string
  status?: number
  /** 本地超时（区别于服务端直接连不上） */
  timedOut?: boolean
}

const PROBE_TIMEOUT_MS = 15_000

/**
 * 一次最小请求的连通性验证（D-04 修订）。
 *
 * 走 `streamChat` 而不是 `GET /models`：后者通不代表这个 key 有 chat 权限，
 * 而这里要回答的正是「现在发一句话到底能不能成」。`max_tokens: 16` 而不是 1
 * —— 不少 provider 对 1 直接回 400。
 *
 * 只关心第一个有意义的事件：拿到文本、思维链或收尾即算通。
 * 失败把 `code` 原样交给 UI 映射文案，不在这里拼中文（分层纪律）。
 */
export async function probe(input: ProbeInput): Promise<ProbeResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? PROBE_TIMEOUT_MS)
  try {
    for await (const event of streamChat({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16,
      signal: controller.signal,
    })) {
      if (event.type === 'error') {
        return {
          ok: false,
          ms: Date.now() - started,
          code: event.code,
          message: event.message,
          status: event.status,
        }
      }
      if (
        event.type === 'text.delta' ||
        event.type === 'reasoning.delta' ||
        event.type === 'step.done'
      ) {
        return { ok: true, ms: Date.now() - started }
      }
    }
    if (controller.signal.aborted) {
      return { ok: false, ms: Date.now() - started, code: 'network', message: 'timeout', timedOut: true }
    }
    // 流干净收尾却没给内容：2xx 且能正常断开，仍算通
    return { ok: true, ms: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      code: 'network',
      message: (error as Error).message || 'probe failed',
    }
  } finally {
    clearTimeout(timer)
  }
}
