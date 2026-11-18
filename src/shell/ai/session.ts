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
const DB_VERSION = 2
const SESSIONS = 'sessions'
const MESSAGES = 'messages'

/* ------------------------------------------------------------------ 类型 */

export type MessageRole = 'user' | 'assistant' | 'tool' | 'event'

/**
 * 会话归属**工作区**，不再跟随文件（plans/ai-project-v2.md §8.3 / W-01）。
 * `workspaceId === ''` 是「还没有任何工作区」的过渡态（P0），W-S3 接入选择器后恒非空。
 * `lastMessageId` 是本模块的私有字段：链尾缓存，省掉每次追加都扫一遍全量消息。
 */
export interface ChatSession {
  id: string
  workspaceId: string
  /** 首条用户消息的摘要；空串表示还没说过话，UI 退回显示「未命名」 */
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
  // v1 → v2：会话归属从「文件」改为「工作区」，旧的 `fileId` 索引语义作废。
  // 开发期无存量（AI 工作区尚未发布），直接重建两个 store。**不要**把这个技巧带到
  // 文件库 `vellum` 上 —— 那边升版会清空用户全部文件（INV-8 / D-03）。
  if (raw.objectStoreNames.contains(SESSIONS)) raw.deleteObjectStore(SESSIONS)
  if (raw.objectStoreNames.contains(MESSAGES)) raw.deleteObjectStore(MESSAGES)

  const sessions = raw.createObjectStore(SESSIONS, { keyPath: 'id' })
  // 空串是合法键，所以「还没有工作区」的会话也能被索引到（不再需要全表扫）
  sessions.createIndex('workspaceId', 'workspaceId')
  sessions.createIndex('wsUpdatedAt', ['workspaceId', 'updatedAt'])

  const messages = raw.createObjectStore(MESSAGES, { keyPath: 'id' })
  messages.createIndex('sessionId', 'sessionId')
  messages.createIndex('sessionSeq', ['sessionId', 'seq'])
})

/* ------------------------------------------------------------------ 读 */

/**
 * 某个工作区最近的一条会话；没有就 `null`。
 *
 * 同一工作区的所有会话共享同一份 `:proj` 与 `:link`（W-03），所以这里只挑最近一条，
 * 不按文件筛 —— 切文件不再换会话。
 */
export async function findSession(workspaceId: string): Promise<ChatSession | null> {
  return db.read([SESSIONS], async (store) => {
    const list = await req(
      store(SESSIONS).index('workspaceId').getAll(workspaceId) as IDBRequest<ChatSession[]>,
    )
    return newest(list)
  })
}

/**
 * 某个工作区的全部会话，最近更新的在前（「历史会话」列表用）。
 *
 * 排序放在这里而不是调用方：列表要按「刚聊过的在上面」排，`updatedAt` 是同一份真相。
 */
export async function listSessions(workspaceId: string): Promise<ChatSession[]> {
  return db.read([SESSIONS], async (store) => {
    const list = await req(
      store(SESSIONS).index('workspaceId').getAll(workspaceId) as IDBRequest<ChatSession[]>,
    )
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

export async function createSession(input: { workspaceId: string }): Promise<ChatSession> {
  const now = Date.now()
  const row: ChatSession = {
    id: crypto.randomUUID(),
    workspaceId: input.workspaceId,
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

/**
 * 每个工作区的会话数与最后活动时间（W-S4：面板列表、树上徽标共用这一份）。
 *
 * 一次扫全表、本地聚合：面板打开就要画，逐工作区查会变成 N 次往返。
 */
export async function sessionStatsByWorkspace(): Promise<
  Map<string, { count: number; lastAt: number }>
> {
  return db.read([SESSIONS], async (store) => {
    const rows = await req(store(SESSIONS).getAll() as IDBRequest<ChatSession[]>)
    const stats = new Map<string, { count: number; lastAt: number }>()
    for (const row of rows) {
      const at = stats.get(row.workspaceId)
      if (at) {
        at.count += 1
        at.lastAt = Math.max(at.lastAt, row.updatedAt ?? row.createdAt)
      } else {
        stats.set(row.workspaceId, { count: 1, lastAt: row.updatedAt ?? row.createdAt })
      }
    }
    return stats
  })
}

/** 一个工作区的会话数与消息数：硬删前的确认框要写清楚会丢掉多少（W-09） */
export async function workspaceChatStats(
  workspaceId: string,
): Promise<{ sessions: number; messages: number }> {
  if (!workspaceId) return { sessions: 0, messages: 0 }
  return db.read([SESSIONS], async (store) => {
    const rows = await req(
      store(SESSIONS).index('workspaceId').getAll(workspaceId) as IDBRequest<ChatSession[]>,
    )
    let messages = 0
    for (const row of rows) messages += row.messageCount ?? 0
    return { sessions: rows.length, messages }
  })
}

/** 每条消息的固定开销：id / 角色 / 时间戳 / 计数字段，按 64 字节估（W-11 口径） */
const MESSAGE_OVERHEAD = 64

/**
 * 一个工作区的会话体积（W-11）：`text` + `reasoning` 的 UTF-8 字节，加每行固定开销。
 *
 * 只算这一个工作区：走 `workspaceId` 索引取会话，再逐会话走 `sessionId` 索引取消息。
 * 全表扫会把所有工作区的消息都读进内存，正是 §8.6 警告的那种成本。
 */
export async function workspaceChatUsage(
  workspaceId: string,
): Promise<{ sessions: number; messages: number; bytes: number }> {
  if (!workspaceId) return { sessions: 0, messages: 0, bytes: 0 }
  return db.read([SESSIONS, MESSAGES], async (store) => {
    const rows = await req(
      store(SESSIONS).index('workspaceId').getAll(workspaceId) as IDBRequest<ChatSession[]>,
    )
    const index = store(MESSAGES).index('sessionId')
    const encoder = new TextEncoder()
    let messages = 0
    let bytes = 0
    for (const row of rows) {
      const list = await req(index.getAll(row.id) as IDBRequest<ChatMessage[]>)
      for (const msg of list) {
        messages += 1
        bytes += MESSAGE_OVERHEAD + encoder.encode(msg.text ?? '').length
        if (msg.reasoning) bytes += encoder.encode(msg.reasoning).length
      }
    }
    return { sessions: rows.length, messages, bytes }
  })
}

/**
 * 删掉一个工作区的**全部会话与消息**（W-09 硬删级联）。
 *
 * 只该在「工作区被彻底删除」时调用：软删（进回收站）要保留会话，恢复后还能接着聊。
 */
export async function clearWorkspace(workspaceId: string): Promise<number> {
  if (!workspaceId) return 0
  return db.write([SESSIONS, MESSAGES], async (store) => {
    const sessions = store(SESSIONS)
    const rows = await req(
      sessions.index('workspaceId').getAll(workspaceId) as IDBRequest<ChatSession[]>,
    )
    const table = store(MESSAGES)
    const index = table.index('sessionId')
    for (const row of rows) {
      await new Promise<void>((resolve, reject) => {
        const cursor = index.openCursor(IDBKeyRange.only(row.id))
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
      await req(sessions.delete(row.id))
    }
    return rows.length
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
