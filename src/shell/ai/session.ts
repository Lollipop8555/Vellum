/**
 * 会话库：`vellum-chat` 库 + 会话/消息的追加式读写。
 *
 * 设计依据：plans/ai-assistant.md §5.3（存储）、§6（会话与消息）、D-08/D-09。
 *
 * 三条不可动摇的约束：
 * - **D-08** 会话存**明文**的独立库，与文件库 `vellum`、凭据库 `vellum-ai` 三方隔离。
 *   本模块不 import `store.ts`，也不碰 `vellum` 的版本（INV-8）。
 * - **D-09** 消息行**只追加、不修改**：`lastChat` 指向上一条消息 id，`null` 即会话首条。
 *   权威顺序是这条链，`seq` 只用于分页与断链兜底。
 * - 会话行是可更新的小记录（`updatedAt` / `messageCount` / `lastMessageId`），200 字节，
 *   与消息同事务写，不触碰任何已有消息行。
 */

import { estimateTokens } from './context'
import { database, req } from './db'
import type { WireToolCall } from './transport'

const DB_NAME = 'vellum-chat'
const DB_VERSION = 1
const SESSIONS = 'sessions'
const MESSAGES = 'messages'

/* ------------------------------------------------------------------ 类型 */

export type MessageRole = 'user' | 'assistant' | 'tool'

/**
 * `fileId` 为 `null` 表示「没有打开文件时的对话」。
 * `lastMessageId` 是本模块的私有字段：链尾缓存，省掉每次追加都扫一遍全量消息。
 */
export interface ChatSession {
  id: string
  fileId: string | null
  fileName: string
  /** 首条用户消息的摘要；空串表示还没说过话，UI 退回显示文件名 */
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  lastMessageId: string | null
}

export interface ChatMessage {
  id: string
  sessionId: string
  /** 上一条消息 id；`null` = 会话首条（D-09） */
  lastChat: string | null
  /** `createdAt * 1000 + 会话内自增`，仅用于分页与断链兜底 */
  seq: number
  role: MessageRole
  text: string
  chars: number
  /** 粗略估算（见 `estimateTokens`），供 P4 的预算裁剪用 */
  tokens: number
  /**
   * 这一轮模型的原生思维链（`reasoning_content`）。
   *
   * 落库只为了「答完还能翻回去看」：流式期间它显示在 live turn 里，一旦这一轮结束、
   * 整屏从库里重画，没存下来的话思考过程就凭空消失了（用户反馈过）。
   * 它**不进** `toWire()`，也不会再发给 provider —— 那是模型自己的输出，不是上下文。
   */
  reasoning?: string
  /** 流式中断时落库的半条回复 */
  incomplete?: boolean
  /** assistant 带工具调用：与随后的 `tool` 消息成对且有序（INV-6） */
  toolCalls?: WireToolCall[]
  /** `role === 'tool'` 时指回是哪一次调用 */
  toolCallId?: string
  /** `role === 'tool'` 时的工具名，只用于渲染与调试 */
  name?: string
  createdAt: number
}

/* ------------------------------------------------------------------ 库 */

const db = database(DB_NAME, DB_VERSION, (raw) => {
  if (!raw.objectStoreNames.contains(SESSIONS)) {
    const sessions = raw.createObjectStore(SESSIONS, { keyPath: 'id' })
    // `fileId` 为 null 的记录不会进索引（null 不是合法键），查询时退回全表扫
    sessions.createIndex('fileId', 'fileId')
    sessions.createIndex('updatedAt', 'updatedAt')
  }
  if (!raw.objectStoreNames.contains(MESSAGES)) {
    const messages = raw.createObjectStore(MESSAGES, { keyPath: 'id' })
    messages.createIndex('sessionId', 'sessionId')
    messages.createIndex('sessionSeq', ['sessionId', 'seq'])
  }
})

/* ------------------------------------------------------------------ 读 */

/**
 * 当前文件最近的一条会话；没有就 `null`。
 *
 * 一个文件一条活动会话（多会话列表留给后续阶段，表结构已支持多行）。
 * `fileId === null` 走全表扫：IDB 索引不允许 null 键，这类记录根本不在索引里。
 */
export async function findSession(fileId: string | null): Promise<ChatSession | null> {
  return db.read([SESSIONS], async (store) => {
    const table = store(SESSIONS)
    const list =
      fileId === null
        ? (await req(table.getAll() as IDBRequest<ChatSession[]>)).filter((s) => !s.fileId)
        : await req(table.index('fileId').getAll(fileId) as IDBRequest<ChatSession[]>)
    return newest(list)
  })
}

/**
 * 某个文件的全部会话，最近更新的在前（「历史会话」列表用）。
 *
 * 排序放在这里而不是调用方：列表要按「刚聊过的在上面」排，`updatedAt` 是同一份真相。
 */
export async function listSessions(fileId: string | null): Promise<ChatSession[]> {
  return db.read([SESSIONS], async (store) => {
    const table = store(SESSIONS)
    const list =
      fileId === null
        ? (await req(table.getAll() as IDBRequest<ChatSession[]>)).filter((s) => !s.fileId)
        : await req(table.index('fileId').getAll(fileId) as IDBRequest<ChatSession[]>)
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  })
}

/** 按 id 取一条会话：从历史列表切回某个旧会话时用；已被删则 `null` */
export async function getSession(id: string): Promise<ChatSession | null> {
  const row = await db.read([SESSIONS], (store) =>
    req(store(SESSIONS).get(id) as IDBRequest<ChatSession | undefined>),
  )
  return row ?? null
}

function newest(list: ChatSession[]): ChatSession | null {
  let best: ChatSession | null = null
  for (const row of list) if (!best || row.updatedAt > best.updatedAt) best = row
  return best
}

/** 一个会话的全部消息，按 `lastChat` 链还原顺序 */
export async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  const list = await db.read([MESSAGES], (store) =>
    req(store(MESSAGES).index('sessionId').getAll(sessionId) as IDBRequest<ChatMessage[]>),
  )
  return chainOrder(list)
}

/**
 * 按 `lastChat` 链排序（D-09）。
 *
 * 从 `lastChat === null` 出发逐条找下一个；链断（父消息不在了）或分叉（同一父下有两条）
 * 时按 `seq` 兜底补齐 —— 宁可顺序不完美，也不让整段消息消失。
 */
export function chainOrder(list: ChatMessage[]): ChatMessage[] {
  const sorted = [...list].sort((a, b) => a.seq - b.seq)
  const used = new Set<string>()
  const out: ChatMessage[] = []
  let cursor: string | null = null
  for (;;) {
    const next = sorted.find((m) => (m.lastChat ?? null) === cursor && !used.has(m.id))
    if (!next) break
    out.push(next)
    used.add(next.id)
    cursor = next.id
  }
  for (const row of sorted) if (!used.has(row.id)) out.push(row)
  return out
}

/* ------------------------------------------------------------------ 写 */

export async function createSession(input: {
  fileId: string | null
  fileName: string
}): Promise<ChatSession> {
  const now = Date.now()
  const row: ChatSession = {
    id: crypto.randomUUID(),
    fileId: input.fileId,
    fileName: input.fileName,
    title: '',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastMessageId: null,
  }
  await db.write([SESSIONS], async (store) => {
    await req(store(SESSIONS).add(row))
  })
  return row
}

/**
 * 追加一条消息，同事务把会话行的 `updatedAt / messageCount / lastMessageId` 推上去。
 *
 * `text` 为空的消息不写：流式失败又没吐一个字时，库里不该留一个空格子。
 */
export async function appendMessage(input: {
  sessionId: string
  role: MessageRole
  text: string
  /** 这一轮模型的原生思维链：只为了「回头看得到」，不会回传给 provider */
  reasoning?: string
  incomplete?: boolean
  toolCalls?: WireToolCall[]
  toolCallId?: string
  name?: string
}): Promise<ChatMessage> {
  const now = Date.now()
  return db.write([SESSIONS, MESSAGES], async (store) => {
    const sessions = store(SESSIONS)
    const found = await req(sessions.get(input.sessionId) as IDBRequest<ChatSession | undefined>)
    if (!found) throw new Error('会话不存在：可能已被清空')

    const row: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      lastChat: found.lastMessageId ?? null,
      seq: now * 1000 + (found.messageCount ?? 0),
      role: input.role,
      text: input.text,
      chars: input.text.length,
      tokens: estimateTokens(input.text),
      // 思维链单独存：不计 chars/tokens（它是展示用的，永不回传给 provider，
      // 混进 token 估算会让「历史裁剪」误以为这条消息很贵）
      ...(input.reasoning?.trim() ? { reasoning: input.reasoning } : {}),
      ...(input.incomplete ? { incomplete: true } : {}),
      ...(input.toolCalls?.length ? { toolCalls: input.toolCalls } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.name ? { name: input.name } : {}),
      createdAt: now,
    }
    await req(store(MESSAGES).add(row))
    await req(
      sessions.put({
        ...found,
        updatedAt: now,
        messageCount: (found.messageCount ?? 0) + 1,
        lastMessageId: row.id,
        title: found.title || (input.role === 'user' ? clip(input.text) : ''),
      }),
    )
    return row
  })
}

/** 删会话 + 级联删消息（一个事务）；副本文件不跟着删，那是用户数据 */
export async function deleteSession(sessionId: string): Promise<void> {
  await db.write([SESSIONS, MESSAGES], async (store) => {
    const table = store(MESSAGES)
    const index = table.index('sessionId')
    await new Promise<void>((resolve, reject) => {
      const cursor = index.openCursor(IDBKeyRange.only(sessionId))
      cursor.onsuccess = () => {
        const at = cursor.result
        if (!at) {
          resolve()
          return
        }
        at.delete()
        at.continue()
      }
      cursor.onerror = () => reject(cursor.error)
    })
    await req(store(SESSIONS).delete(sessionId))
  })
}

/* ------------------------------------------------------------------ 小工具 */

/** 首条消息摘要：换行压平，40 字截断 */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat
}

/** 估算口径只有一份，在 `ai/context.ts`（D-38）；这里只是转出去给调用方省一次 import */
export { estimateTokens }
