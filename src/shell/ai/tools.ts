/**
 * 工具协议（L4）：schema、参数校验、读票、转译到 `app.ts` 的窄接口。
 *
 * 依据 plans/ai-assistant.md §7（工具协议）、§14.1（D-35 锚点）、INV-2/INV-3/INV-10。
 *
 * 三件事只在这里做：
 * - **schema**：给模型看的 JSON Schema。描述里的每条限制都有对应的校验分支，
 *   写不进去的规矩就别写进去（模型会照着描述去试，试不动就是白花一轮）。
 * - **读票**：`read_doc` 发一张票，写工具必须落在某张票覆盖的区间里。
 *   票**不落库**：它对应原文就在刚才那条 `tool` 消息里，重开页面后模型自己会安排重读。
 * - **校验顺序**：见 §7。顺序本身是契约 —— 先报 `readonly` 还是先报 `not_read` 会让模型
 *   走上完全不同的自纠路径。
 *
 * 本模块**不 import app**：所有读写都走注入进来的 `DocHost`（L5 边界）。
 */

import { expandToLines, lineOf, numbered, offsetOfLine, wrap } from './context'
import type { DocStat } from './context'
import type { ToolSchema } from './transport'

/** app.ts 注入的窄接口：读写都在这里，AI 接触不到别的东西 */
export interface DocHost {
  /** 当前打开文件的状态；没打开文件时 `null` */
  stat(): DocStat | null
  /** 当前文本（含未保存草稿） */
  text(): string
  /** 文档版本号：任何一次内容变更（用户敲键或 AI 写入）都会自增 */
  rev(): number
  /** 把当前文件复制成 AI 副本并打开，返回新节点 */
  createCopy(sessionId: string): Promise<{ id: string; name: string }>
  /** 写入当前文档（唯一入口，保证 dirty/草稿/预览/诊断都跟着走） */
  write(text: string): Promise<void>
}

/** 一次工具调用的额度（§7 预算：每轮最多 6 次写入、20 轮循环） */
export interface ToolQuota {
  /** 本**轮用户消息**内还剩几次写入（apply_edits / replace_doc 各算一次） */
  writesLeft: number
  sessionId: string
}

export interface ToolResult {
  /** 回给模型的正文；错误也是正文（模型自己看错误码自纠） */
  content: string
  ok: boolean
}

export interface Toolbox {
  run(name: string, rawArgs: string, quota: ToolQuota): Promise<ToolResult>
  /** 作废全部读票（切文件、换会话、写入成功都要调） */
  invalidate(): void
}

/** 单次 `apply_edits` 的上限（§7）；超过就报 bad_arguments，让它分批 */
const MAX_EDITS = 50
/** 单次 `read_doc` 的行数/字符上限：一次读回 5 万字符，下一轮就超预算了 */
const MAX_READ_LINES = 400
const MAX_READ_CHARS = 16_000
/** `around` 模式默认上下各看这么多行 */
const AROUND_DEFAULT = 40

interface Ticket {
  id: string
  fileId: string
  rev: number
  from: number
  to: number
  /** 发出去时那段原文：慢路径靠它比对，不落库 */
  slice: string
}

/* ------------------------------------------------------------------ schema */

export function toolSchemas(): ToolSchema[] {
  return [
    {
      type: 'function',
      function: {
        name: 'get_state',
        description:
          '查看当前文件的位置信息（文件名、行数、字节数、是否只读、是否副本、光标）。不需要读票，不消耗额度。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_doc',
        description:
          '读取当前文件的一段内容，返回带行号的文本与一张读票（ticket）。写之前必须先读。' +
          '返回里的 truncated=true 说明只给了前一部分，需要更后面的内容就再读一次（用 lineFrom/lineTo）。',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['selection', 'around', 'range', 'full', 'outline'],
              description:
                'selection=用户选区；around=光标附近；range=指定行号；full=全文；outline=只给结构行（标题/顶层声明）',
            },
            lineFrom: { type: 'integer', description: 'range 模式：起始行（1 基，含）' },
            lineTo: { type: 'integer', description: 'range 模式：结束行（1 基，含）' },
            aroundLines: { type: 'integer', description: `around 模式：上下各看多少行，默认 ${AROUND_DEFAULT}` },
            offsetLines: { type: 'integer', description: 'around 模式：相对光标的行偏移，可正可负' },
          },
          required: ['mode'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'apply_edits',
        description:
          `对副本做多处修改，一次最多 ${MAX_EDITS} 处，全部按**同一份原始文本**一次性应用（互不影响）。` +
          '每处改动用两种形态之一：锚点 {find, replace}（首选，find 必须与原文逐字相等且在全文唯一）；' +
          '或行号 {lineFrom, lineTo, insert}（整行替换，行号 1 基、两端都含）。' +
          '每处改动都必须落在某张已有读票覆盖的区间内，否则返回 not_read。' +
          '成功写入后所有旧票立即作废，要继续改请重新 read_doc。',
        parameters: {
          type: 'object',
          properties: {
            tickets: {
              type: 'array',
              items: { type: 'string' },
              description: '本次改动所依据的读票 id，至少一张',
            },
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  find: { type: 'string', description: '锚点形态：被替换的原文片段' },
                  replace: { type: 'string', description: '锚点形态：替换成什么（可为空串＝删除）' },
                  lineFrom: { type: 'integer', description: '行号形态：起始行（1 基，含）' },
                  lineTo: { type: 'integer', description: '行号形态：结束行（1 基，含）' },
                  insert: { type: 'string', description: '行号形态：替换成什么（可为空串＝删除）' },
                },
                additionalProperties: false,
              },
            },
          },
          required: ['tickets', 'edits'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_doc',
        description:
          '用新全文替换整个副本。必须先 read_doc({mode:"full"}) 拿到覆盖全文的读票，否则返回 not_read。' +
          '只有「重写整篇」时才用它；局部改动请用 apply_edits。',
        parameters: {
          type: 'object',
          properties: {
            tickets: { type: 'array', items: { type: 'string' } },
            text: { type: 'string', description: '新的全文（不要带行号前缀）' },
          },
          required: ['tickets', 'text'],
          additionalProperties: false,
        },
      },
    },
  ]
}

/* ------------------------------------------------------------------ 工具箱 */

export function createToolbox(host: DocHost): Toolbox {
  const tickets = new Map<string, Ticket>()
  let seq = 0

  const fail = (error: string, message: string, extra?: Record<string, unknown>): ToolResult => ({
    ok: false,
    content: JSON.stringify({ error, message, ...extra }),
  })

  function issue(stat: DocStat, doc: string, from: number, to: number): Ticket {
    seq += 1
    const ticket: Ticket = {
      id: `t${seq}`,
      fileId: stat.fileId,
      rev: host.rev(),
      from,
      to,
      slice: doc.slice(from, to),
    }
    tickets.set(ticket.id, ticket)
    return ticket
  }

  /* ---------------------------------------------------------------- 读 */

  function readDoc(args: Record<string, unknown>, stat: DocStat, doc: string): ToolResult {
    const mode = String(args.mode ?? 'around')
    const total = stat.totalLines
    const cursorLine = stat.cursor.line
    let from = 0
    let to = doc.length
    let wanted: { fromLine: number; toLine: number }

    if (mode === 'full') {
      wanted = { fromLine: 1, toLine: total }
    } else if (mode === 'range') {
      const lineFrom = num(args.lineFrom)
      const lineTo = num(args.lineTo)
      if (lineFrom === null || lineTo === null) {
        return fail('bad_arguments', 'range 模式要同时给 lineFrom 与 lineTo')
      }
      if (lineFrom < 1 || lineTo < lineFrom || lineFrom > total) {
        return fail('out_of_range', `行号超出范围：文件共 ${total} 行`, { totalLines: total })
      }
      wanted = { fromLine: lineFrom, toLine: Math.min(lineTo, total) }
    } else if (mode === 'selection') {
      if (!stat.selection || stat.selection.to <= stat.selection.from) {
        return fail('bad_arguments', '当前没有选区；改用 around 或 range')
      }
      const exp = expandToLines(doc, stat.selection.from, stat.selection.to)
      wanted = { fromLine: exp.fromLine, toLine: exp.toLine }
    } else if (mode === 'outline') {
      const keys = outlineLines(doc)
      if (!keys.length) {
        return { ok: true, content: JSON.stringify({ file: stat.fileName, outline: [], hint: '没有结构行，改用 around 或 range' }) }
      }
      // 结构行只是索引：不给票（否则等于用 20 行换了全文的写权限）
      return {
        ok: true,
        content: JSON.stringify({
          file: stat.fileName,
          totalLines: total,
          outline: keys.slice(0, 200).map((line) => `${line}| ${clip(doc.split('\n')[line - 1] ?? '')}`),
          note: '结构行只是目录，不含内容也没有读票；要改哪一段请 read_doc 那一行附近。',
        }),
      }
    } else {
      const around = num(args.aroundLines) ?? AROUND_DEFAULT
      const offset = num(args.offsetLines) ?? 0
      const center = clamp(cursorLine + offset, 1, total)
      const half = Math.max(1, Math.floor(Math.abs(around) / 2))
      wanted = { fromLine: center - half, toLine: center + half }
    }

    wanted.fromLine = clamp(wanted.fromLine, 1, total)
    wanted.toLine = clamp(wanted.toLine, wanted.fromLine, total)

    // 行数/字符双上限：超大文件整篇读回来会直接把下一轮顶爆
    let lineCount = wanted.toLine - wanted.fromLine + 1
    let truncated = false
    let toLine = wanted.toLine
    if (lineCount > MAX_READ_LINES) {
      toLine = wanted.fromLine + MAX_READ_LINES - 1
      lineCount = MAX_READ_LINES
      truncated = true
    }
    from = offsetOfLine(doc, wanted.fromLine)
    to = offsetOfLine(doc, toLine + 1)
    if (to - from > MAX_READ_CHARS) {
      to = from + MAX_READ_CHARS
      const cutLine = lineOf(doc, to)
      // 退到整行：半行读回去，锚点一定对不上
      to = Math.max(from, cutLine > wanted.fromLine ? offsetOfLine(doc, cutLine) : to)
      toLine = Math.max(wanted.fromLine, cutLine - 1)
      truncated = true
    }

    const ticket = issue(stat, doc, from, to)
    const tag = ticket.id
    const head = {
      ticket: ticket.id,
      rev: ticket.rev,
      file: stat.fileName,
      fromLine: wanted.fromLine,
      toLine,
      totalLines: total,
      truncated,
      ...(truncated ? { hint: '只给了这一段；需要后面就带 lineFrom/lineTo 再读' } : {}),
    }
    return {
      ok: true,
      content: `${JSON.stringify(head)}\n${wrap(numbered(doc, from, to, wanted.fromLine), tag)}`,
    }
  }

  /* ---------------------------------------------------------------- 写 */

  /** 票覆盖检查 + 快慢路径（§7 第 5b/6/7/8 步） */
  function checkTickets(
    ids: string[],
    ranges: Array<{ from: number; to: number }>,
    stat: DocStat,
    doc: string,
  ): ToolResult | null {
    const picked: Ticket[] = []
    for (const id of ids) {
      const ticket = tickets.get(id)
      if (!ticket) return fail('not_read', `读票 ${id} 不存在或已作废，请重新 read_doc`)
      if (ticket.fileId !== stat.fileId) {
        // 副本刚由这份原文件建出来：内容逐字相同，票直接沿用。
        // 否则「首次写」必然白跑一轮（读原文件 → 建副本 → 票对不上 → 重读 → 再写）
        const viaCopy =
          stat.isCopy && stat.copySourceId !== null && ticket.fileId === stat.copySourceId
        if (!viaCopy) return fail('not_read', `读票 ${id} 是别的文件上的，请重新 read_doc`)
      }
      picked.push(ticket)
    }
    if (!picked.length) return fail('not_read', '至少给一张读票；写之前必须先 read_doc')

    const fresh = host.rev()
    for (const ticket of picked) {
      // 快路径：票是当前版本开的，直接过
      if (ticket.rev === fresh) continue
      // 慢路径：版本变了也不一定坏，比一下这段原文还在不在
      const moved = doc.slice(ticket.from, ticket.to) !== ticket.slice
      if (moved) {
        return fail('stale', `读票 ${ticket.id} 覆盖的原文已经变了，请重新 read_doc`, {
          rev: fresh,
          ticketRev: ticket.rev,
        })
      }
    }

    for (const range of ranges) {
      const cover = picked.find((t) => t.from <= range.from && range.to <= t.to)
      if (!cover) {
        return fail('not_read', '有改动不在任何一张读票覆盖的区间内，请 read_doc 之后再改', {
          from: range.from,
          to: range.to,
        })
      }
      const ticket = cover
      if (ticket.rev !== fresh && doc.slice(range.from, range.to) !== ticket.slice.slice(range.from - ticket.from, range.to - ticket.from)) {
        return fail('stale', '要改的这段原文与读票里的不一致，请重新 read_doc', { rev: fresh })
      }
    }
    return null
  }

  /** 把一处编辑解成字符区间；锚点优先，行号兜底 */
  function resolve(
    edit: Record<string, unknown>,
    stat: DocStat,
    doc: string,
  ): { from: number; to: number; insert: string } | ToolResult {
    const hasAnchor = typeof edit.find === 'string'
    if (hasAnchor) {
      const find = String(edit.find)
      if (!find) return fail('bad_arguments', 'find 不能为空串；要插入请用行号形态')
      const first = doc.indexOf(find)
      if (first < 0) return fail('not_found_anchor', '锚点在当前文本里找不到，请重新 read_doc 复制原文')
      if (doc.indexOf(find, first + 1) >= 0) {
        return fail('ambiguous_anchor', '锚点在全文出现不止一次，请带上前后文让它唯一')
      }
      return { from: first, to: first + find.length, insert: String(edit.replace ?? '') }
    }

    const lineFrom = num(edit.lineFrom)
    const lineTo = num(edit.lineTo)
    if (lineFrom === null || lineTo === null) {
      return fail('bad_arguments', '每处改动要么给 find/replace，要么给 lineFrom/lineTo/insert')
    }
    if (lineFrom < 1 || lineTo < lineFrom || lineFrom > stat.totalLines) {
      return fail('out_of_range', `行号超出范围：文件共 ${stat.totalLines} 行`, {
        totalLines: stat.totalLines,
      })
    }
    const from = offsetOfLine(doc, lineFrom)
    const to = offsetOfLine(doc, Math.min(lineTo + 1, stat.totalLines + 1))
    let insert = String(edit.insert ?? '')
    // 整行替换时保留行尾换行：模型写 "x" 想替换第 3 行，不该把第 4 行粘上来
    if (doc.slice(from, to).endsWith('\n') && !insert.endsWith('\n') && insert) insert += '\n'
    return { from, to, insert }
  }

  /** 算出新全文；校验不过就把错误原样返回（不写库） */
  function editNext(
    args: Record<string, unknown>,
    stat: DocStat,
    doc: string,
  ): { next: string } | { error: ToolResult } {
    const ids = strings(args.tickets)
    const rawEdits = Array.isArray(args.edits) ? args.edits : []
    if (!rawEdits.length) return { error: fail('bad_arguments', 'edits 不能为空') }
    if (rawEdits.length > MAX_EDITS) {
      return {
        error: fail('bad_arguments', `一次最多 ${MAX_EDITS} 处；请分成多次调用`, {
          given: rawEdits.length,
        }),
      }
    }

    const resolved: Array<{ from: number; to: number; insert: string }> = []
    for (const raw of rawEdits) {
      if (!raw || typeof raw !== 'object') {
        return { error: fail('bad_arguments', 'edits 里每一项都要是对象') }
      }
      const one = resolve(raw as Record<string, unknown>, stat, doc)
      if ('ok' in one) return { error: one }
      resolved.push(one)
    }

    // 同一批内互不重叠（含锚点命中的区间）
    const sorted = [...resolved].sort((a, b) => a.from - b.from || a.to - b.to)
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].from < sorted[i - 1].to) {
        return { error: fail('overlap', '同一批里有两处改动落在同一段原文上，请合并成一处') }
      }
    }

    const guard = checkTickets(ids, resolved, stat, doc)
    if (guard) return { error: guard }

    let next = doc
    for (const one of [...resolved].sort((a, b) => b.from - a.from)) {
      next = next.slice(0, one.from) + one.insert + next.slice(one.to)
    }
    return { next }
  }

  async function writeThrough(next: string, stat: DocStat): Promise<ToolResult> {
    await host.write(next)
    // INV-10：自己写完，旧票全废 —— 多步修改必须批量提交或重新读
    tickets.clear()
    return {
      ok: true,
      content: JSON.stringify({
        rev: host.rev(),
        applied: true,
        file: stat.fileName,
        lines: host.stat()?.totalLines ?? stat.totalLines,
        note: '旧读票已全部作废；继续修改请重新 read_doc',
      }),
    }
  }

  /* ---------------------------------------------------------------- 出口 */

  return {
    invalidate(): void {
      tickets.clear()
    },

    async run(name: string, rawArgs: string, quota: ToolQuota): Promise<ToolResult> {
      let args: Record<string, unknown> = {}
      if (rawArgs.trim()) {
        try {
          const parsed: unknown = JSON.parse(rawArgs)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return fail('bad_arguments', '工具参数必须是 JSON 对象')
          }
          args = parsed as Record<string, unknown>
        } catch {
          return fail('bad_arguments', '工具参数不是合法 JSON')
        }
      }

      const stat = host.stat()
      if (!stat) return fail('copy_not_open', '当前没有打开文件，无法操作文档')

      if (name === 'get_state') {
        return {
          ok: true,
          content: JSON.stringify({
            file: stat.fileName,
            lines: stat.totalLines,
            bytes: stat.totalBytes,
            readOnly: stat.readOnly,
            isCopy: stat.isCopy,
            cursor: stat.cursor,
          }),
        }
      }

      if (name === 'read_doc') {
        return readDoc(args, stat, host.text())
      }

      if (name !== 'apply_edits' && name !== 'replace_doc') {
        return fail('bad_arguments', `没有这个工具：${name}`)
      }

      // —— 写路径：先拦只读，再补副本，最后才看票 ——
      if (stat.readOnly) {
        return fail('readonly', '当前文件是只读的（用户锁定或大文件保护），不能修改', {
          hint: '向用户说明要改什么，或请用户解锁',
        })
      }
      if (quota.writesLeft <= 0) {
        return fail('budget', '本轮写入次数已用尽，请把剩下的改动说给用户听', { limit: 6 })
      }

      let live = stat
      if (!live.isCopy) {
        // §8：懒创建。首次写就建副本并打开，原文件一个字节都不动（INV-2）
        try {
          await host.createCopy(quota.sessionId)
        } catch {
          return fail('copy_not_open', '创建副本失败，无法写入')
        }
        const after = host.stat()
        if (!after) return fail('copy_not_open', '副本没有打开，无法写入')
        live = after
      }
      const doc = host.text()
      const current: DocStat = { ...live, totalLines: doc.split('\n').length }

      if (name === 'replace_doc') {
        const ids = strings(args.tickets)
        if (!ids.length) return fail('not_read', '至少给一张读票；写之前必须先 read_doc')
        const guard = checkTickets(ids, [{ from: 0, to: doc.length }], current, doc)
        if (guard) return guard
        quota.writesLeft -= 1
        return writeThrough(String(args.text ?? ''), current)
      }

      const outcome = editNext(args, current, doc)
      if ('error' in outcome) return outcome.error
      quota.writesLeft -= 1
      return writeThrough(outcome.next, current)
    },
  }
}

/* ------------------------------------------------------------------ 小工具 */

/** 结构行：Markdown 标题 + 顶层声明；够模型决定「读哪一段」就行 */
function outlineLines(doc: string): number[] {
  const out: number[] = []
  const lines = doc.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    if (/^#{1,6}\s/.test(line)) out.push(i + 1)
    else if (/^[A-Za-z_$#@].*(\(|:)\s*$/.test(line.slice(0, 120)) && !line.startsWith(' ')) {
      out.push(i + 1)
    }
  }
  return out
}

function clip(text: string): string {
  const flat = text.trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  return null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
