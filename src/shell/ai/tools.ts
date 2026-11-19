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
import type { FolderNode } from '../../types'
import { buildTree, findFiles, resolveUriToId, type NodeMap } from './tree'
import {
  parseUri,
  normalizeUri,
  checkRead,
  checkWrite,
  checkCopySource,
  checkCopyTarget,
  formatUri,
  type VirtualUri,
} from './project'
import { decodeBase64, MAX_ASSET_BYTES, mimeForName } from '../asset'
import { buildMatcher, grepProject } from './grep'

/** app.ts 注入的窄接口：读写都在这里，AI 接触不到别的东西 */
export interface DocHost {
  /** 当前打开文件的状态；没打开文件时 `null` */
  stat(): DocStat | null
  /** 当前文本（含未保存草稿） */
  text(): string
  /** 文档版本号：任何一次内容变更（用户敲键或 AI 写入）都会自增 */
  rev(): number
  /** 把当前文件复制成 AI 副本并打开，返回新节点。副本归属工作区（W-03） */
  createCopy(workspaceId: string): Promise<{ id: string; name: string }>
  /** 写入当前文档（唯一入口，保证 dirty/草稿/预览/诊断都跟着走） */
  write(text: string): Promise<void>
  /**
   * 幻灯片语法规格（`read_deck_spec` 的正文）；当前文件不是幻灯片时返回 `null`。
   *
   * 内容由壳层从 `ui/slides/spec.ts` 取——工具层不 import 那个模块（它连着 i18n），
   * 也不该自己维护一份语法说明。
   */
  deckSpec?(): string | null
  /** 按工作区 id 取（W-07：URI 前缀就是工作区 id）；不存在返回 `null` */
  workspace?(id: string): { root: FolderNode; nodes: NodeMap } | null
  /**
   * 库里全部工作区的摘要（W-S4 面板列表 / 切换浮层用）；按创建时间升序。
   * 面板不该自己遍历节点表 —— 那是壳层的 state。
   */
  listWorkspaces?(): ReadonlyArray<{
    id: string
    name: string
    nodeId: string
    grantIds: readonly string[]
    createdAt: number
  }>
  /** 新建工作区（W-08：只有用户点「新工作区」才建）；失败返回 `null` */
  createWorkspace?(): Promise<{ id: string; name: string; nodeId: string } | null>
  /**
   * 某个节点**所在**的工作区 id（沿祖先链找）；不在任何工作区里返回空串。
   * 面板用它算「当前工作区」的兜底（W-10），别拿「库里的第一个」凑合。
   */
  workspaceOf?(refId: string): string
  /** 按节点 id 读取规范文本（UTF-8）；二进制或无内容返回 `null`（S6 grep 用） */
  readNodeText?(id: string): Promise<string | null>
  /**
   * 取消某项授权（面板 UI 用，AI 不调用）；已 cp 进工作区的副本不受影响。
   * `workspaceId` 是面板列清单的那个工作区 —— 不能靠 refId 反推（跨工作区引用时会对不上）。
   */
  revokeGrant?(refId: string, workspaceId?: string): Promise<void>
  /**
   * 发消息时自动引用当前文件（W-04 §8.4）：把 refId 加进**指定工作区**，返回是否真的新增。
   * 工作区不存在（被删）返回 `false`：发消息本身不该因此失败。
   */
  grantRef?(refId: string, workspaceId: string): Promise<boolean>
  /** cp（S3）：把源节点的文本复制一份到目标文件夹下，返回新节点名与 id（只读源、只新建目标） */
  copyNode?(fromId: string, toFolderId: string, workspaceId: string): Promise<{ id: string; name: string }>

  /* —— S4 按 uri 读写项目节点（headless，不碰当前编辑器/弹窗）—— */

  /** 按节点 id 读取项目文件（proj 内）；返回文本与内容版本 rev，二进制/不存在返回 null */
  readProjectFile?(id: string): Promise<{ text: string; rev: number } | null>
  /** 按节点 id 写入文本（proj 内），返回写入后的行数与新 rev；调用方保证已过 checkWrite 与读票 */
  writeNodeText?(id: string, text: string): Promise<{ lines: number; rev: number }>
  /** 在 proj 文件夹下建节点，返回新节点 id / name / 完整虚拟地址 */
  createProjectNode?(parentId: string, kind: 'file' | 'folder', name: string): Promise<{ id: string; name: string }>
  /** 软删除 proj 内节点 */
  deleteProjectNode?(id: string): Promise<void>
  /** 移动节点到 proj 内另一文件夹（可改名），返回最终 name 与 parentId */
  moveProjectNode?(id: string, parentId: string, name?: string): Promise<{ name: string; parentId: string }>

  /* —— S5 二进制资产（P-10：AI 用 base64 写入）—— */

  /** 在 proj 文件夹下新建二进制资产，返回 id / name / rev */
  createProjectAsset?(
    parentId: string,
    name: string,
    bytes: Uint8Array,
    mime: string,
  ): Promise<{ id: string; name: string; rev: number }>
  /** 覆盖已有二进制资产的内容，返回新 rev */
  writeNodeBytes?(id: string, bytes: Uint8Array, mime: string): Promise<{ rev: number }>

  /* —— S7 脚本运行（P-14）—— */

  /**
   * 在隔离沙箱里跑一段脚本。宿主保证**永不 throw**：超时 / 联网关闭 / 运行时缺失
   * 都折进 `error` 字段，由这里翻译成 timeout / network_off / tool_failed。
   */
  runScript?(lang: 'js' | 'py', code: string, timeoutMs?: unknown): Promise<ScriptOutcome>
}

/** 沙箱执行结果（与 `sandbox.ts` 的 ScriptResult 同构，此处不复用避免 L4 依赖浏览器模块） */
export interface ScriptOutcome {
  ok: boolean
  stdout: string
  stderr: string
  error: 'timeout' | 'network_off' | 'runtime_off' | 'error' | null
  ms: number
}

/** 开关决定下发哪些工具（plans/ai-project-v2.md P-11 / P-16）：关则从根源不出现 */
export interface ToolFlags {
  script: boolean
  network: boolean
}

/** 一次工具调用的额度（§7 预算：每轮最多 `MAX_WRITE_LIMIT` 次写入、60 轮循环） */
export interface ToolQuota {
  /** 本**轮用户消息**内还剩几次写入（apply_edits / replace_doc 各算一次） */
  writesLeft: number
  /** 虚拟地址前缀 = 工作区 id（W-07）。没有工作区时为空串，URI 类工具一律 not_project */
  workspaceId: string
}

export interface ToolResult {
  /** 回给模型的正文；错误也是正文（模型自己看错误码自纠） */
  content: string
  ok: boolean
  /**
   * P-06：工具成功后要给会话追加的一条可见系统事件。
   * 工具层只产出结构化数据，文案与落库交给 chat 层 —— shell 不碰会话库与 i18n。
   */
  event?: ToolEvent
}

/** 会话事件（P-06）：cp / write / mkdir / rm / mv 成功后产出，由 chat 层落库渲染 */
export interface ToolEvent {
  kind: 'copy' | 'write' | 'mkdir' | 'rm' | 'mv'
  /** 源虚拟地址（mv/cp 有；write/mkdir/rm 用目标地址占位） */
  from: string
  /** 目标虚拟地址 */
  to: string
  /** 发生时刻（epoch ms） */
  at: number
}

export interface Toolbox {
  run(name: string, rawArgs: string, quota: ToolQuota): Promise<ToolResult>
  /** 作废全部读票（切文件、换会话、写入成功都要调） */
  invalidate(): void
}

/** 单次 `apply_edits` 的上限（§7）；超过就报 bad_arguments，让它分批 */
const MAX_EDITS = 50
/** Python 的默认超时：Pyodide 运行时要从 CDN 现下（几 MB），5s 必超时 */
const PY_TIMEOUT = 60_000
/**
 * 一次用户发言内最多写几次文档。原来是 6 —— 写个小单元测试就要
 * 「建文件 + 写实现 + 写测试 + 改两处 + 再补一处」，6 次在第 3 个文件就见底，
 * 用户体感是「一句话没说完就被掐断」。20 次足够收尾，又不至于失控刷库。
 *
 * 必须是**唯一**来源：`chat.ts` 的额度初始化与这里回给模型的 `limit` 都用它。
 */
export const MAX_WRITE_LIMIT = 20
/** 项目类工具（plans/ai-project-v2.md §3）：不依赖「当前打开文件」 */
const PROJECT_TOOLS = new Set([
  'tree', 'find_files', 'read_asset', 'grep', 'cp',
  // S4 项目读写
  'read_file', 'write_file', 'mkdir', 'rm', 'mv',
])
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

/**
 * S4 项目文件读票：按 uri 归属，不碰 fileId。
 * 与旧 `Ticket` 分开存放 —— 旧工具（当前打开文件 + 懒建副本）的语义一期不动，
 * P4 全套用例原样 survive；两套票互不串台（id 前缀 t/u 也不同）。
 */
interface UriTicket {
  id: string
  uri: string
  rev: number
  from: number
  to: number
  slice: string
}

/* ------------------------------------------------------------------ schema */

export function toolSchemas(flags: ToolFlags = { script: false, network: true }): ToolSchema[] {
  const base = baseSchemas()
  const project: ToolSchema[] = [
    {
      type: 'function',
      function: {
        name: 'tree',
        description:
          '列出当前项目的全部可见文件（虚拟地址）。`:proj` 可读写，`:link` 为授权引用只读，' +
          '修改 link 内的文件前必须先用 cp 复制进 proj。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'find_files',
        description: '按文件名子串查找（大小写不敏感），只返回你有权读取的节点。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '文件名中的子串' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_asset',
        description: '查看二进制资产的元信息（类型、大小），不返回内容。',
        parameters: {
          type: 'object',
          properties: { uri: { type: 'string', description: '虚拟地址，如 ws_ab12cd34:proj/a.png' } },
          required: ['uri'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description:
          '在你有权读取的全部文件中逐行搜索（默认子串，大小写不敏感；regex=true 为正则）。' +
          '最多返回 100 条命中，超出会标记 truncated。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            regex: { type: 'boolean' },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cp',
        description:
          '把一个文本文件复制进项目（to 必须是 proj 内的文件夹虚拟地址）。' +
          '修改 link 内的文件前必须先 cp 到 proj，再对副本操作；源文件不会被改动。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '源虚拟地址，如 ws_ab12cd34:link/a.md' },
            to: { type: 'string', description: '目标文件夹虚拟地址，如 ws_ab12cd34:proj 或 ws_ab12cd34:proj/docs' },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        },
      },
    },
    // S4：项目内读写。read_file 发 uri 票，write_file / apply_edits(uri) 消费它
    {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          '读取项目内指定虚拟地址的文本文件，返回带行号的文本与一张读票。' +
          '写该文件（write_file / apply_edits 带 uri）之前必须先读。outline 只给结构行、不发票。',
        parameters: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: '虚拟地址，如 ws_ab12cd34:proj/docs/a.md' },
            mode: {
              type: 'string',
              enum: ['full', 'range', 'around', 'outline'],
              description: 'full=全文；range=指定行；around=附近行（默认）；outline=结构行（不发票）',
            },
            lineFrom: { type: 'integer' },
            lineTo: { type: 'integer' },
            aroundLines: { type: 'integer' },
            offsetLines: { type: 'integer' },
          },
          required: ['uri'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description:
          '写 proj 内文件。两种形态：' +
          '（1）text + tickets：用新全文覆盖文本文件，必须先 read_file({uri,mode:"full"}) 拿覆盖全文的读票，否则 not_read；' +
          '地址在 proj 里但文件还不存在时，直接给 text 就会新建（无需读票，父文件夹要已存在）；' +
          '（2）base64（可选 mime）：写二进制资产（如生成的 png），地址不存在就新建、已存在且是资产就覆盖，不需要读票。' +
          'text 是一次性全量覆盖：单次内容别超过约 200 行，更大的文件先写骨架，' +
          '再 read_file + apply_edits 分批补（一次输出太长会被 max_tokens 截断，参数就成了半截 JSON）。' +
          ':link 只读，写入返回 forbidden。',
        parameters: {
          type: 'object',
          properties: {
            uri: { type: 'string' },
            text: { type: 'string', description: '新的完整文本（不要带行号前缀）' },
            base64: { type: 'string', description: '二进制内容（标准 base64，可带 data: 前缀）' },
            mime: { type: 'string', description: '可选，覆盖按扩展名推断的 MIME' },
            tickets: { type: 'array', items: { type: 'string' }, description: 'text 形态必填' },
          },
          required: ['uri'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mkdir',
        description: '在 proj 内新建文件夹；uri 是新建文件夹的完整虚拟地址，其父文件夹必须已存在。',
        parameters: {
          type: 'object',
          properties: { uri: { type: 'string' } },
          required: ['uri'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'rm',
        description: '软删除 proj 内的文件或文件夹（进回收站，可恢复）。:link 只读，不可删。',
        parameters: {
          type: 'object',
          properties: { uri: { type: 'string' } },
          required: ['uri'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mv',
        description:
          '把 proj 内的节点移动到另一个文件夹或改名。from 与 to 都必须是 proj 内的虚拟地址，' +
          'to 为移动后的完整地址（末尾一段是新名字）。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        },
      },
    },
  ]
  // 运行类工具（S7 实现执行体）：开关关时根本不下发
  const runners: ToolSchema[] = flags.script
    ? [
        {
          type: 'function',
          function: {
            name: 'run_js',
            description:
              '在浏览器的隔离 Worker 里运行一段 JavaScript，返回 stdout / stderr。' +
              '可以用 console.log 输出；可以直接写顶层 await；最后一个表达式的值（或 return 的值）会自动打印；' +
              '内置 assert(条件, 说明) / assert.equal(a, b) / assert.deepEqual(a, b) / assert.throws(fn)，写测试不用再找断言库。' +
              '注意：这不是 Node —— 没有 require / module / process / fs，不能用 import/export，也读不到工作区文件' +
              '（要读写文件请用 read_file / write_file / apply_edits）；联网关闭时 fetch 等会抛 network_off。' +
              '默认 15s 超时，可用 timeoutMs 调大（上限 60s）；死循环会被强制终止。',
            parameters: {
              type: 'object',
              properties: { code: { type: 'string' }, timeoutMs: { type: 'integer' } },
              required: ['code'],
              additionalProperties: false,
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'run_py',
            description:
              '在 Pyodide（浏览器里的 Python 3.12）中运行一段 Python，返回 stdout / stderr。' +
              '有标准库与 asyncio，可直接写顶层 await；print 的输出会一并返回。' +
              '注意：没有第三方包（真要装可自己用 micropip，但需要联网），也读不到工作区文件。' +
              '首次调用要下载几 MB 运行时，慢网可能要几十秒；默认 60s 超时，可用 timeoutMs 调整（上限 60s）。',
            parameters: {
              type: 'object',
              properties: { code: { type: 'string' }, timeoutMs: { type: 'integer' } },
              required: ['code'],
              additionalProperties: false,
            },
          },
        },
      ]
    : []
  return [...base, ...project, ...runners]
}

function baseSchemas(): ToolSchema[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read_deck_spec',
        description:
          '查看幻灯片（remark 语法）的完整写法说明：分页、备注、页属性，以及每页是独立 Markdown 带来的限制。' +
          '当前文档还没有分页时返回 not_deck。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
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
          '成功写入后所有旧票立即作废，要继续改请重新读取。' +
          '可选的 uri：给了就改项目内那个文件（票由 read_file 发、只能 proj）；' +
          '不给则改当前打开文件的副本（票由 read_doc 发，旧行为）。',
        parameters: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: '可选。项目文件虚拟地址；不给则操作当前打开文件的副本' },
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
  const uriTickets = new Map<string, UriTicket>()
  let seq = 0
  let uSeq = 0

  const fail = (error: string, message: string, extra?: Record<string, unknown>): ToolResult => ({
    ok: false,
    content: JSON.stringify({ error, message, ...extra }),
  })

  function issueUri(uri: string, rev: number, doc: string, from: number, to: number): UriTicket {
    uSeq += 1
    const ticket: UriTicket = {
      id: `u${uSeq}`,
      uri,
      rev,
      from,
      to,
      slice: doc.slice(from, to),
    }
    uriTickets.set(ticket.id, ticket)
    return ticket
  }

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

  /* ---------------------------------------------------------------- S4 工作区读写 */

  /** uri 必须与当前工作区前缀一致（INV-13），否则模型可能跨工作区操作 */
  function uriInWorkspace(parsed: ReturnType<typeof parseUri>, workspaceId: string): parsed is VirtualUri {
    return parsed !== null && parsed.workspaceId === workspaceId
  }

  /**
   * 模型给来的地址 → VirtualUri。允许省略工作区前缀（真实模型常写 `:proj/a.md`），
   * 但完整前缀必须与当前工作区一致，否则视同格式错误 —— 跨工作区就是 bad_uri。
   */
  function uriFor(raw: unknown, workspaceId: string): VirtualUri | null {
    const parsed = normalizeUri(String(raw ?? ''), workspaceId)
    return uriInWorkspace(parsed, workspaceId) ? parsed : null
  }

  /** 报错时把真实前缀抄给模型：随机 id 只让它抄一次 */
  function uriHintFor(workspaceId: string): string {
    return `虚拟地址格式不对；本工作区前缀是 ${workspaceId}，例如 ${workspaceId}:proj/a.md`
  }

  /** 项目文件的读票覆盖检查：归属 uri + rev 快慢路径 + 区间覆盖，顺序同 checkTickets */
  function checkUriTickets(
    ids: string[],
    ranges: Array<{ from: number; to: number }>,
    uri: string,
    rev: number,
    doc: string,
  ): ToolResult | null {
    const picked: UriTicket[] = []
    for (const id of ids) {
      const ticket = uriTickets.get(id)
      if (!ticket) return fail('not_read', `读票 ${id} 不存在或已作废，请重新 read_file`)
      if (ticket.uri !== uri) return fail('not_read', `读票 ${id} 是别的文件上的，请重新 read_file`)
      picked.push(ticket)
    }
    if (!picked.length) return fail('not_read', '至少给一张读票；写之前必须先 read_file')

    for (const ticket of picked) {
      if (ticket.rev === rev) continue
      if (doc.slice(ticket.from, ticket.to) !== ticket.slice) {
        return fail('stale', `读票 ${ticket.id} 覆盖的原文已经变了，请重新 read_file`, {
          rev,
          ticketRev: ticket.rev,
        })
      }
    }
    for (const range of ranges) {
      const cover = picked.find((t) => t.from <= range.from && range.to <= t.to)
      if (!cover) {
        return fail('not_read', '有改动不在任何一张读票覆盖的区间内，请 read_file 之后再改', {
          from: range.from,
          to: range.to,
        })
      }
      if (cover.rev !== rev && doc.slice(range.from, range.to) !== cover.slice.slice(range.from - cover.from, range.to - cover.from)) {
        return fail('stale', '要改的这段原文与读票里的不一致，请重新 read_file', { rev })
      }
    }
    return null
  }

  /** 项目文件的一处编辑 → 字符区间（与 resolve 同规则，但行数来自项目文件） */
  function resolveUri(
    edit: Record<string, unknown>,
    doc: string,
    totalLines: number,
  ): { from: number; to: number; insert: string } | ToolResult {
    if (typeof edit.find === 'string') {
      const find = String(edit.find)
      if (!find) return fail('bad_arguments', 'find 不能为空串；要插入请用行号形态')
      const first = doc.indexOf(find)
      if (first < 0) {
        // 只说「找不到」等于让模型重读全文再猜一次。顺手告诉它最接近的那行在哪
        // （按首行公共前缀算），一次就能把锚点改对 —— AI 试错的主要成本就在这
        const lines = doc.split('\n')
        const head = (find.split('\n')[0] ?? '').trim()
        let near = -1
        let best = 0
        for (let i = 0; i < lines.length && head; i += 1) {
          const line = (lines[i] ?? '').trim()
          let same = 0
          while (same < line.length && same < head.length && line[same] === head[same]) same += 1
          if (same > best) {
            best = same
            near = i
          }
        }
        return fail('not_found_anchor', '锚点在当前文本里找不到，请重新 read_file 复制原文', {
          ...(best >= 8 && near >= 0
            ? { nearLine: near + 1, nearText: clip(lines[near] ?? '') }
            : { totalLines, hint: '也可以改用 lineFrom/lineTo/insert 的行号形态' }),
        })
      }
      let times = 0
      for (let at = first; at >= 0; at = doc.indexOf(find, at + 1)) times += 1
      if (times > 1) {
        return fail('ambiguous_anchor', '锚点在全文出现不止一次，请带上前后文让它唯一', {
          count: times,
          firstLine: doc.slice(0, first).split('\n').length,
        })
      }
      return { from: first, to: first + find.length, insert: String(edit.replace ?? '') }
    }
    const lineFrom = num(edit.lineFrom)
    const lineTo = num(edit.lineTo)
    if (lineFrom === null || lineTo === null) {
      return fail('bad_arguments', '每处改动要么给 find/replace，要么给 lineFrom/lineTo/insert')
    }
    if (lineFrom < 1 || lineTo < lineFrom || lineFrom > totalLines) {
      return fail('out_of_range', `行号超出范围：文件共 ${totalLines} 行`, { totalLines })
    }
    const from = offsetOfLine(doc, lineFrom)
    const to = offsetOfLine(doc, Math.min(lineTo + 1, totalLines + 1))
    let insert = String(edit.insert ?? '')
    if (doc.slice(from, to).endsWith('\n') && !insert.endsWith('\n') && insert) insert += '\n'
    return { from, to, insert }
  }

  /** 算出项目文件编辑后的新全文；校验不过原样返回错误（不写库） */
  function editUriNext(
    args: Record<string, unknown>,
    doc: string,
    uri: string,
    rev: number,
  ): { next: string } | { error: ToolResult } {
    const ids = strings(args.tickets)
    const rawEdits = Array.isArray(args.edits) ? args.edits : []
    if (!rawEdits.length) return { error: fail('bad_arguments', 'edits 不能为空') }
    if (rawEdits.length > MAX_EDITS) {
      return { error: fail('bad_arguments', `一次最多 ${MAX_EDITS} 处；请分成多次调用`, { given: rawEdits.length }) }
    }
    const totalLines = doc.split('\n').length
    const resolved: Array<{ from: number; to: number; insert: string }> = []
    for (const raw of rawEdits) {
      if (!raw || typeof raw !== 'object') return { error: fail('bad_arguments', 'edits 里每一项都要是对象') }
      const one = resolveUri(raw as Record<string, unknown>, doc, totalLines)
      if ('ok' in one) return { error: one }
      resolved.push(one)
    }
    const sorted = [...resolved].sort((a, b) => a.from - b.from || a.to - b.to)
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].from < sorted[i - 1].to) {
        return { error: fail('overlap', '同一批里有两处改动落在同一段原文上，请合并成一处') }
      }
    }
    const guard = checkUriTickets(ids, resolved, uri, rev, doc)
    if (guard) return { error: guard }
    let next = doc
    for (const one of [...resolved].sort((a, b) => b.from - a.from)) {
      next = next.slice(0, one.from) + one.insert + next.slice(one.to)
    }
    return { next }
  }

  /** 项目文件读区间：与 readDoc 同款 mode 语义，不依赖编辑器光标/选区 */
  function readUri(
    args: Record<string, unknown>,
    uri: string,
    fileName: string,
    doc: string,
    rev: number,
  ): ToolResult {
    const mode = String(args.mode ?? 'around')
    const total = Math.max(1, doc.split('\n').length)
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
    } else if (mode === 'outline') {
      const keys = outlineLines(doc)
      if (!keys.length) {
        return { ok: true, content: JSON.stringify({ file: fileName, outline: [], hint: '没有结构行，改用 range' }) }
      }
      return {
        ok: true,
        content: JSON.stringify({
          file: fileName,
          totalLines: total,
          outline: keys.slice(0, 200).map((line) => `${line}| ${clip(doc.split('\n')[line - 1] ?? '')}`),
          note: '结构行只是目录，不含内容也没有读票；要改哪一段请 read_file 那一行附近。',
        }),
      }
    } else {
      const around = num(args.aroundLines) ?? AROUND_DEFAULT
      const offset = num(args.offsetLines) ?? 0
      const center = clamp(1 + offset, 1, total)
      const half = Math.max(1, Math.floor(Math.abs(around) / 2))
      wanted = { fromLine: center - half, toLine: center + half }
    }
    wanted.fromLine = clamp(wanted.fromLine, 1, total)
    wanted.toLine = clamp(wanted.toLine, wanted.fromLine, total)

    let lineCount = wanted.toLine - wanted.fromLine + 1
    let truncated = false
    let toLine = wanted.toLine
    if (lineCount > MAX_READ_LINES) {
      toLine = wanted.fromLine + MAX_READ_LINES - 1
      lineCount = MAX_READ_LINES
      truncated = true
    }
    let from = offsetOfLine(doc, wanted.fromLine)
    let to = offsetOfLine(doc, toLine + 1)
    if (to - from > MAX_READ_CHARS) {
      to = from + MAX_READ_CHARS
      const cutLine = lineOf(doc, to)
      to = Math.max(from, cutLine > wanted.fromLine ? offsetOfLine(doc, cutLine) : to)
      toLine = Math.max(wanted.fromLine, cutLine - 1)
      truncated = true
    }
    const ticket = issueUri(uri, rev, doc, from, to)
    const head = {
      ticket: ticket.id,
      rev,
      file: fileName,
      uri,
      fromLine: wanted.fromLine,
      toLine,
      totalLines: total,
      truncated,
      ...(truncated ? { hint: '只给了这一段；需要后面就带 lineFrom/lineTo 再读' } : {}),
    }
    return {
      ok: true,
      content: `${JSON.stringify(head)}\n${wrap(numbered(doc, from, to, wanted.fromLine), ticket.id)}`,
    }
  }

  /** 写成功后的统一收尾：清 uri 票 + 返回含 rev 的结果，并附带可落库的可见事件 */
  function uriWritten(
    uri: string,
    fileName: string,
    rev: number,
    lines: number,
    note: string,
    event?: ToolEvent,
  ): ToolResult {
    uriTickets.clear()
    return {
      ok: true,
      content: JSON.stringify({ rev, applied: true, uri, file: fileName, lines, note }),
      ...(event ? { event } : {}),
    }
  }

  /* ---------------------------------------------------------------- 出口 */

  /* ---------------------------------------------------------------- 项目 */

  async function runProjectTool(
    name: string,
    args: Record<string, unknown>,
    quota: ToolQuota,
  ): Promise<ToolResult> {
    const workspaceId = quota.workspaceId
    // 按 id 取（W-07）：前缀就是工作区 id，不再靠「全库唯一的那个项目根」猜。
    // 没有 id 就是没有工作区 —— 不许退回去猜一个，那是 W-S5 清掉的旧语义。
    const proj = workspaceId ? (host.workspace?.(workspaceId) ?? null) : null
    if (!proj) return fail('not_project', '当前没有 AI 工作区（先在文件树上把文件夹设为工作区）')
    const { root, nodes } = proj
    if (name === 'tree') {
      const { entries, truncated } = buildTree(workspaceId, root, nodes)
      return { ok: true, content: JSON.stringify({ entries, truncated }) }
    }
    if (name === 'find_files') {
      const { hits, truncated } = findFiles(workspaceId, root, nodes, String(args.query ?? ''))
      return { ok: true, content: JSON.stringify({ hits, truncated }) }
    }
    if (name === 'read_asset') {
      const parsed = uriFor(args.uri, workspaceId)
      if (!parsed) return fail('bad_uri', uriHintFor(workspaceId))
      const id = resolveUriToId(parsed, root, nodes)
      if (!id) return fail('not_found', '找不到这个文件')
      const node = nodes.get(id)
      if (!node || node.kind !== 'file' || !node.asset) {
        return fail('bad_arguments', '这不是二进制资产；文本文件请用 read_doc')
      }
      const access = checkRead(parsed.zone, id, nodes, root)
      if (access) return fail(access, '没有读取这个文件的权限')
      return {
        ok: true,
        content: JSON.stringify({ uri: args.uri, mime: node.asset.mime, size: node.size, note: '仅返回元信息，不含内容' }),
      }
    }
    if (name === 'grep') {
      const pattern = String(args.pattern ?? '')
      const matcher = buildMatcher({ pattern, regex: args.regex === true })
      if (!matcher) return fail('bad_arguments', 'pattern 为空或正则不合法')
      if (!host.readNodeText) return fail('tool_failed', '当前宿主不支持 grep')
      const readText = host.readNodeText.bind(host)
      const result = await grepProject(workspaceId, root, nodes, matcher, readText)
      return { ok: true, content: JSON.stringify(result) }
    }
    if (name === 'cp') {
      const from = uriFor(args.from, workspaceId)
      const to = uriFor(args.to, workspaceId)
      if (!from || !to) return fail('bad_uri', uriHintFor(workspaceId))
      if (to.zone !== 'proj') {
        return fail('forbidden', '目标必须在 proj 内；link 只读', { hint: `请把 to 改成 ${workspaceId}:proj/...` })
      }
      const sourceId = resolveUriToId(from, root, nodes)
      if (!sourceId) return fail('not_found', '找不到源文件')
      const sourceErr = checkCopySource(from.zone, sourceId, nodes, root)
      if (sourceErr) return fail(sourceErr, copyMessage(sourceErr))
      const targetId = resolveUriToId(to, root, nodes)
      if (targetId === null) return fail('not_found', '找不到目标文件夹')
      const targetErr = checkCopyTarget(targetId, nodes, root)
      if (targetErr) return fail(targetErr, copyMessage(targetErr))
      if (!host.copyNode) return fail('tool_failed', '当前宿主不支持 cp')
      const created = await host.copyNode(sourceId, targetId, workspaceId)
      const destUri = formatUri({ workspaceId, zone: 'proj', rel: joinRel(to.rel, created.name) })
      return {
        ok: true,
        content: JSON.stringify({
          copied: true,
          from: args.from,
          to: destUri,
          note: '源文件未改动；修改请对新副本使用 read_doc / apply_edits',
        }),
        // P-06：落库一条可见事件（来源 / 目标 / 时间），给用户看也给 AI 看
        event: { kind: 'copy', from: String(args.from), to: destUri, at: Date.now() },
      }
    }

    /* —— S4：项目内读写 —— */

    // 读：先会话前缀，再权限（:proj 子树），再文件类型，最后发票
    if (name === 'read_file') {
      const parsed = uriFor(args.uri, workspaceId)
      if (!parsed) return fail('bad_uri', uriHintFor(workspaceId))
      const id = resolveUriToId(parsed, root, nodes)
      if (!id) return fail('not_found', '找不到这个文件')
      const access = checkRead(parsed.zone, id, nodes, root)
      if (access) return fail(access, '没有读取这个文件的权限')
      const node = nodes.get(id)!
      if (node.kind !== 'file' || node.asset) {
        return fail('bad_arguments', '这是文件夹或二进制资产，文本文件请用 read_file')
      }
      if (!host.readProjectFile) return fail('tool_failed', '当前宿主不支持读取项目文件')
      const file = await host.readProjectFile(id)
      if (!file) return fail('not_found', '读不到这个文件的内容')
      return readUri(args, parsed.zone === 'proj' ? String(args.uri) : formatUri(parsed), node.name, file.text, file.rev)
    }

    // 以下都是写工具：统一顺序 —— 会话前缀 → checkWrite(拦 link) → 节点 → readonly → budget → 票 → 写
    if (name === 'write_file' || name === 'mkdir' || name === 'rm' || name === 'mv') {
      // 1) 解析所有涉及的地址并校验会话前缀
      const uris = name === 'mv'
        ? [uriFor(args.from, workspaceId), uriFor(args.to, workspaceId)]
        : [uriFor(args.uri, workspaceId)]
      if (uris.some((u) => u === null)) {
        return fail('bad_uri', uriHintFor(workspaceId))
      }
      // 2) 写权限判定必须在最前：:link 直接 forbidden（P-04）
      for (const u of uris) {
        const writeErr = checkWrite(u!.zone, null, nodes, root)
        if (writeErr) return fail(writeErr, '只能写 :proj 内的文件；:link 是只读引用')
      }
      if (quota.writesLeft <= 0) {
        return fail('budget', '本轮写入次数已用尽，请把剩下的改动说给用户听', { limit: MAX_WRITE_LIMIT })
      }

      if (name === 'mkdir') {
        const u = uris[0]!
        if (u.zone !== 'proj' || !u.rel) return fail('forbidden', '只能在 proj 内建文件夹')
        const { parentRel, name: namePart } = splitRel(u.rel)
        if (!namePart) return fail('bad_arguments', '文件夹地址不能为空')
        const parentId = parentRel ? resolveUriToId({ ...u, rel: parentRel }, root, nodes) : root.id
        if (!parentId) return fail('not_found', '父文件夹不存在；请先 mkdir 建父级')
        const parent = nodes.get(parentId)
        if (!parent || parent.kind !== 'folder' || parent.deletedAt !== null) {
          return fail('bad_target', '父级必须是 proj 内的文件夹')
        }
        if (!host.createProjectNode) return fail('tool_failed', '当前宿主不支持建文件夹')
        const created = await host.createProjectNode(parentId, 'folder', namePart)
        quota.writesLeft -= 1
        const destUri = formatUri({ workspaceId, zone: 'proj', rel: joinRel(parentRel, created.name) })
        return {
          ok: true,
          content: JSON.stringify({ created: true, uri: destUri, note: '文件夹已建在 proj 内' }),
          event: { kind: 'mkdir', from: destUri, to: destUri, at: Date.now() },
        }
      }

      if (name === 'rm') {
        const u = uris[0]!
        const id = resolveUriToId(u, root, nodes)
        if (!id) return fail('not_found', '找不到要删除的节点')
        if (id === root.id) return fail('forbidden', '不能删除项目根')
        const node = nodes.get(id)!
        if (node.kind === 'file' && node.readOnlyUser) return fail('readonly', '这个节点被用户锁定，不能删除')
        if (!host.deleteProjectNode) return fail('tool_failed', '当前宿主不支持删除')
        await host.deleteProjectNode(id)
        quota.writesLeft -= 1
        uriTickets.clear()
        return {
          ok: true,
          content: JSON.stringify({ removed: true, uri: args.uri, note: '已软删除（进回收站，可恢复）' }),
          event: { kind: 'rm', from: String(args.uri), to: String(args.uri), at: Date.now() },
        }
      }

      if (name === 'mv') {
        const [from, to] = uris as [NonNullable<typeof uris[0]>, NonNullable<typeof uris[0]>]
        const sourceId = resolveUriToId(from, root, nodes)
        if (!sourceId) return fail('not_found', '找不到源节点')
        if (sourceId === root.id) return fail('forbidden', '不能移动项目根')
        const sourceNode = nodes.get(sourceId)!
        if (sourceNode.kind === 'file' && sourceNode.readOnlyUser) return fail('readonly', '这个节点被用户锁定，不能移动')
        const { parentRel, name: newName } = splitRel(to.rel)
        if (!newName) return fail('bad_arguments', '目标地址末端要有新名字')
        const parentId = parentRel ? resolveUriToId({ ...to, rel: parentRel }, root, nodes) : root.id
        if (!parentId) return fail('not_found', '目标文件夹不存在')
        const parent = nodes.get(parentId)
        if (!parent || parent.kind !== 'folder' || parent.deletedAt !== null) {
          return fail('bad_target', '目标必须是 proj 内的文件夹')
        }
        if (!host.moveProjectNode) return fail('tool_failed', '当前宿主不支持移动')
        const moved = await host.moveProjectNode(sourceId, parentId, newName)
        quota.writesLeft -= 1
        uriTickets.clear()
        const destUri = formatUri({ workspaceId, zone: 'proj', rel: joinRel(parentRel, moved.name) })
        return {
          ok: true,
          content: JSON.stringify({ moved: true, from: args.from, to: destUri }),
          event: { kind: 'mv', from: String(args.from), to: destUri, at: Date.now() },
        }
      }

      // write_file：文本整篇覆盖，或 base64 写二进制资产
      const u = uris[0]!
      const id = resolveUriToId(u, root, nodes)

      // P-10：base64 → 资产。二进制没法 diff，所以不要求文本读票，
      // 但 checkWrite / 额度 / readonly / 目标类型一样不能少。
      const b64 = typeof args.base64 === 'string' ? args.base64.trim() : ''
      if (b64) {
        const bytes = decodeBase64(b64)
        if (!bytes) return fail('bad_arguments', 'base64 解码失败；请给标准 base64（可带 data: 前缀）')
        if (bytes.byteLength > MAX_ASSET_BYTES) {
          return fail('bad_arguments', `单次写入上限 ${MAX_ASSET_BYTES / 1024 / 1024}MB`, {
            bytes: bytes.byteLength,
          })
        }
        const mime = mimeForName(u.rel || u.zone, typeof args.mime === 'string' ? args.mime : undefined)
        const event: ToolEvent = { kind: 'write', from: String(args.uri), to: String(args.uri), at: Date.now() }

        if (id) {
          const node = nodes.get(id)!
          if (node.kind !== 'file') return fail('bad_arguments', '目标不是文件')
          if (!node.asset) return fail('bad_target', '目标已是文本文件；二进制请换新地址或改用 text 写入')
          if (node.readOnlyUser) return fail('readonly', '这个文件被用户锁定，不能写入')
          if (!host.writeNodeBytes) return fail('tool_failed', '当前宿主不支持写入二进制')
          const res = await host.writeNodeBytes(id, bytes, mime)
          quota.writesLeft -= 1
          uriTickets.clear()
          return {
            ok: true,
            content: JSON.stringify({
              rev: res.rev,
              applied: true,
              uri: String(args.uri),
              file: node.name,
              bytes: bytes.byteLength,
              mime,
              note: '资产已覆盖；旧读票已作废',
            }),
            event,
          }
        }

        if (u.zone !== 'proj' || !u.rel) return fail('forbidden', '只能在 proj 内新建资产')
        const { parentRel, name: assetName } = splitRel(u.rel)
        if (!assetName) return fail('bad_arguments', '资产地址末端要有文件名')
        const parentId = parentRel ? resolveUriToId({ ...u, rel: parentRel }, root, nodes) : root.id
        if (!parentId) return fail('not_found', '目标文件夹不存在；请先 mkdir 建父级')
        const parent = nodes.get(parentId)
        if (!parent || parent.kind !== 'folder' || parent.deletedAt !== null) {
          return fail('bad_target', '父级必须是 proj 内的文件夹')
        }
        if (!host.createProjectAsset) return fail('tool_failed', '当前宿主不支持新建资产')
        const created = await host.createProjectAsset(parentId, assetName, bytes, mime)
        quota.writesLeft -= 1
        uriTickets.clear()
        const destUri = formatUri({ workspaceId, zone: 'proj', rel: joinRel(parentRel, created.name) })
        return {
          ok: true,
          content: JSON.stringify({
            rev: created.rev,
            applied: true,
            uri: destUri,
            file: created.name,
            bytes: bytes.byteLength,
            mime,
            note: '资产已新建',
          }),
          event: { ...event, from: destUri, to: destUri },
        }
      }

      if (!id) {
        // 新建：AI 写新模块 / 新测试的第一步就是「写一个还不存在的地址」。
        // 原来这里直接 not_found，它只能先 cp 一个模板再覆盖 —— 白白多烧好几轮，
        // 用户体感就是「写个小测试反复被中断」。
        if (u.zone !== 'proj' || !u.rel) return fail('forbidden', '只能在 proj 内新建文件；:link 只读')
        const { parentRel, name: fileName } = splitRel(u.rel)
        if (!fileName) return fail('bad_arguments', '地址末端要有文件名')
        if (typeof args.text !== 'string') return fail('bad_arguments', '新建文本文件要同时给 text')
        const parentId = parentRel ? resolveUriToId({ ...u, rel: parentRel }, root, nodes) : root.id
        if (!parentId) return fail('not_found', '目标文件夹不存在；请先 mkdir 建父级')
        const parent = nodes.get(parentId)
        if (!parent || parent.kind !== 'folder' || parent.deletedAt !== null) {
          return fail('bad_target', '父级必须是 proj 内的文件夹')
        }
        if (!host.createProjectNode || !host.writeNodeText) {
          return fail('tool_failed', '当前宿主不支持新建项目文件')
        }
        const created = await host.createProjectNode(parentId, 'file', fileName)
        const written = await host.writeNodeText(created.id, String(args.text))
        quota.writesLeft -= 1
        uriTickets.clear()
        const destUri = formatUri({ workspaceId, zone: 'proj', rel: joinRel(parentRel, created.name) })
        return {
          ok: true,
          content: JSON.stringify({
            rev: written.rev,
            applied: true,
            created: true,
            uri: destUri,
            file: created.name,
            lines: written.lines,
            note: '文件已新建',
          }),
          event: { kind: 'write', from: destUri, to: destUri, at: Date.now() },
        }
      }
      const node = nodes.get(id)!
      if (node.kind !== 'file' || node.asset) return fail('bad_arguments', '只能写文本文件')
      if (node.readOnlyUser) return fail('readonly', '这个文件被用户锁定，不能写入')
      if (!host.readProjectFile || !host.writeNodeText) return fail('tool_failed', '当前宿主不支持写入项目文件')
      const before = await host.readProjectFile(id)
      const doc = before?.text ?? ''
      if (typeof args.text !== 'string') return fail('bad_arguments', 'text 与 base64 至少给一个')
      const ids = strings(args.tickets)
      if (!ids.length) return fail('not_read', '至少给一张读票；写之前必须先 read_file')
      const guard = checkUriTickets(ids, [{ from: 0, to: doc.length }], String(args.uri), before?.rev ?? 0, doc)
      if (guard) return guard
      const written = await host.writeNodeText(id, String(args.text ?? ''))
      quota.writesLeft -= 1
      return uriWritten(
        String(args.uri), node.name, written.rev, written.lines, '整篇已覆盖；旧读票已作废',
        { kind: 'write', from: String(args.uri), to: String(args.uri), at: Date.now() },
      )
    }

    // apply_edits 带 uri：项目文件的锚点/行号局部修改（票由 read_file 发）
    if (name === 'apply_edits_uri') {
      const parsed = parseUri(String(args.uri ?? ''))
      if (!uriInWorkspace(parsed, workspaceId)) return fail('bad_uri', '虚拟地址格式不对或工作区前缀不匹配')
      const writeErr = checkWrite(parsed.zone, null, nodes, root)
      if (writeErr) return fail(writeErr, '只能写 :proj 内的文件；:link 是只读引用')
      if (quota.writesLeft <= 0) {
        return fail('budget', '本轮写入次数已用尽，请把剩下的改动说给用户听', { limit: MAX_WRITE_LIMIT })
      }
      const id = resolveUriToId(parsed, root, nodes)
      if (!id) return fail('not_found', '找不到要修改的文件')
      const node = nodes.get(id)!
      if (node.kind !== 'file' || node.asset) return fail('bad_arguments', '只能修改文本文件')
      if (node.readOnlyUser) return fail('readonly', '这个文件被用户锁定，不能修改')
      if (!host.readProjectFile || !host.writeNodeText) return fail('tool_failed', '当前宿主不支持写入项目文件')
      const before = await host.readProjectFile(id)
      const doc = before?.text ?? ''
      const outcome = editUriNext(args, doc, String(args.uri), before?.rev ?? 0)
      if ('error' in outcome) return outcome.error
      const written = await host.writeNodeText(id, outcome.next)
      quota.writesLeft -= 1
      return uriWritten(
        String(args.uri), node.name, written.rev, written.lines, '局部修改已应用；旧读票已作废',
        { kind: 'write', from: String(args.uri), to: String(args.uri), at: Date.now() },
      )
    }
    return fail('bad_arguments', `没有这个工具：${name}`)
  }

  return {
    invalidate(): void {
      tickets.clear()
      uriTickets.clear()
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
          // 最常见的成因是输出被 max_tokens 截断（写大文件时必现）。只说「不是合法 JSON」，
          // 模型不知道是被截断，会拿同样的内容反复重试 —— 把长度和自纠办法一起给它。
          return fail(
            'bad_arguments',
            `工具参数不是合法 JSON（收到 ${rawArgs.length} 字符，多半是输出被 max_tokens 截断）。` +
              '请把内容拆小：先用较短的骨架调用一次，再用 read_file + apply_edits 分批补全。',
            { received: rawArgs.length },
          )
        }
      }

      if (PROJECT_TOOLS.has(name)) return await runProjectTool(name, args, quota)

      // apply_edits 带 uri 时改项目文件（票由 read_file 发），否则走下面的当前文件旧路径
      if (name === 'apply_edits' && typeof args.uri === 'string' && args.uri.trim()) {
        return await runProjectTool('apply_edits_uri', args, quota)
      }

      // 脚本运行（S7）：不依赖「当前打开文件」，所以放在 stat 检查之前
      if (name === 'run_js' || name === 'run_py') {
        const lang = name === 'run_js' ? 'js' : 'py'
        const code = typeof args.code === 'string' ? args.code : ''
        if (!code.trim()) return fail('bad_arguments', 'code 不能为空')
        if (!host.runScript) return fail('tool_failed', '当前环境不支持运行脚本')
        // Python 首次要先从 CDN 下载 Pyodide（几 MB），5s 的默认值必然超时 ——
        // 单独抬到上限，别让「第一次用 py 就报超时」变成一个假故障
        const timeoutMs = args.timeoutMs ?? (lang === 'py' ? PY_TIMEOUT : undefined)
        const res = await host.runScript(lang, code, timeoutMs)
        if (res.error === 'timeout') {
          return fail(
            'timeout',
            lang === 'py'
              ? '脚本运行超时（Python 首次要下载 Pyodide 运行时，慢网会很久）。已跑的耗时与输出见下；可把任务拆小，或稍后重试'
              : '脚本运行超时（默认 15s，可用 timeoutMs 调大，上限 60s）；沙箱已销毁。请缩小数据量或拆成几次跑',
            { stderr: res.stderr },
          )
        }
        if (res.error === 'network_off') {
          return fail('network_off', '联网已关闭，脚本内的网络请求被拦截；可在设置里打开联网', {
            stderr: res.stderr,
          })
        }
        if (res.error === 'runtime_off') {
          return fail('tool_failed', 'Python 运行时（Pyodide）加载失败：需要联网下载', {
            stderr: res.stderr,
          })
        }
        const body = { lang, ms: res.ms, stdout: res.stdout, stderr: res.stderr }
        // 脚本自己抛异常不算工具失败：把 stdout/stderr 原样交回，模型据此自纠
        if (!res.ok) {
          return { ok: false, content: JSON.stringify({ error: 'tool_failed', ...body }) }
        }
        return { ok: true, content: JSON.stringify(body) }
      }

      if (name === 'read_deck_spec') {
        // 规格是静态文本，不依赖当前文件；还没分页就直说，别让模型以为工具坏了
        const spec = host.deckSpec?.()
        if (!spec) return fail('not_deck', '当前文档还没有分页：用单独一行 --- 把内容分成至少两页。')
        return { ok: true, content: spec }
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
        return fail('budget', '本轮写入次数已用尽，请把剩下的改动说给用户听', { limit: MAX_WRITE_LIMIT })
      }

      let live = stat
      if (!live.isCopy) {
        // §8：懒创建。首次写就建副本并打开，原文件一个字节都不动（INV-2）
        try {
          await host.createCopy(quota.workspaceId)
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

/** cp 失败时给模型的说明：只说现象与出路，不暴露节点 id */
function copyMessage(code: string): string {
  if (code === 'bad_source') return '源必须是存在的文本文件（二进制与文件夹不能 cp）'
  if (code === 'bad_target') return '目标必须是 proj 内存在的文件夹'
  if (code === 'not_granted') return '没有读取这个文件的权限'
  return '没有复制这个文件的权限'
}

/** 把目标文件夹的 rel 与新名字拼成 rel（空目标即区根） */
function joinRel(folderRel: string, name: string): string {
  return folderRel ? `${folderRel}/${name}` : name
}

/** 拆出 rel 的父目录与末端名字；无 '/' 时父目录为空（区根） */
function splitRel(rel: string): { parentRel: string; name: string } {
  const cut = rel.lastIndexOf('/')
  return cut < 0 ? { parentRel: '', name: rel } : { parentRel: rel.slice(0, cut), name: rel.slice(cut + 1) }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
