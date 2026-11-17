/**
 * 流式 Markdown 渲染（D-36）。
 *
 * 不引 `streaming-markdown` 一类解析器：它们自带一套 md 规则，画不出本仓库的
 * katex / mermaid / highlight，最终要维护第二个渲染真相。这里的做法是
 * **块级切分 + 整块复用同一个 `renderMarkdown()`**：
 *
 *   delta → 缓冲 + rAF 合并 → 块切分（围栏/表格感知）
 *                              ├─ 已闭合块 → renderMarkdown() 一次 → 冻结追加
 *                              └─ 未闭合尾块 → textContent（pre-wrap）
 *   finish → 整条重渲染一次覆盖（跨块的列表、引用式链接、跨块表格才正确）
 *            唯一例外：整条只有一块、尾块为空时，逐块结果与整条结果相同，
 *            直接省掉这次重渲染（收尾那一下的卡顿就是它）
 *
 * 未闭合的尾块**不解析**：半截的 `**`、`` ` ``、`[` 解析出的 DOM 比纯文本更难看。
 */

import { renderMarkdown } from '../markdown'

/** 围栏行：``` 或 ~~~，最多三格缩进（与 CommonMark 的容差一致） */
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/

/**
 * 找第一个「块边界」：围栏外的空行。
 *
 * 只认空行，不认单个换行 —— 表格的每一行之间是单换行，必须在空行处才切，
 * 否则表头与分隔行会被拆成两次渲染，出来是两段坏 HTML。
 */
function boundaryOf(text: string): number {
  let offset = 0
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const marker = FENCE_LINE.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker[0]
      else if (marker[0] === fence) fence = null
    }
    if (!fence && line.trim() === '' && offset > 0 && text.slice(0, offset).trim()) {
      return offset
    }
    offset += line.length + 1
  }
  return -1
}

/** 粘底判定阈值：离底 48px 以内算「还在看最新一条」 */
const STICK_SLOP = 48

export interface StreamBody {
  /** 追加一段增量；内部按 rAF 合并，频繁调用也只在每帧跑一次切分 */
  push(delta: string): void
  /** 收尾：整条重渲染覆盖，并把图表画出来 */
  finish(fullText: string): Promise<void>
  /** 中途失败：保留已渲染内容，尾部给一句提示（不覆盖成白板） */
  fail(message: string): void
  /** 当前元素，供调用方测量/滚动 */
  readonly root: HTMLElement
}

/**
 * @param host 输出容器（每次消息一个）
 * @param scroller 滚动容器；给了就在贴底时自动粘底，用户上滚后不再抢滚动条
 */
export function createStreamBody(host: HTMLElement, scroller: HTMLElement | null = null): StreamBody {
  const root = document.createElement('div')
  // 复用 `.markdown-body` 的排版规则（标题/表格/代码/引用全都现成），
  // 再用 `.ai-md` 把它的「整页滚动容器」属性改回普通块
  root.className = 'ai-md markdown-body'
  host.append(root)

  const tail = document.createElement('pre')
  tail.className = 'ai-stream-tail'
  root.append(tail)

  /** 已经切出来、还没渲染的完整块（不包含尾块） */
  let pending = ''
  /** 等下一帧合并的增量 */
  let queued = ''
  let raf = 0
  /** 每次收尾/复位都 +1：旧的在途 renderMarkdown 靠它作废 */
  let epoch = 0
  /** 串行渲染：块顺序必须与文本顺序一致，并发 insert 会乱序 */
  let chain: Promise<void> = Promise.resolve()
  /** 已经切出去渲染过的块数：收尾时据此判断「要不要整条重渲染」 */
  let blocks = 0

  const stuck = (): boolean =>
    !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_SLOP

  const keepBottom = (stick: boolean) => {
    if (stick && scroller) scroller.scrollTop = scroller.scrollHeight
  }

  const appendBlock = (html: string, myEpoch: number, stick: boolean) => {
    if (myEpoch !== epoch) return
    const node = document.createElement('div')
    node.className = 'ai-md-block'
    node.innerHTML = html
    root.insertBefore(node, tail)
    keepBottom(stick)
  }

  const scheduleBlock = (block: string) => {
    blocks += 1
    const myEpoch = epoch
    chain = chain.then(async () => {
      if (myEpoch !== epoch) return
      const stick = stuck()
      const html = await renderMarkdown(block)
      appendBlock(html, myEpoch, stick)
    })
  }

  const flush = () => {
    raf = 0
    const stick = stuck()
    pending += queued
    queued = ''
    let at = boundaryOf(pending)
    while (at > 0) {
      const block = pending.slice(0, at).trim()
      pending = pending.slice(at).replace(/^\n+/, '')
      if (block) scheduleBlock(block)
      at = boundaryOf(pending)
    }
    // 内容没变就别重设：改 `textContent` 会丢掉旧文本节点重建一次，
    // 每帧白做一次 DOM 写入（一段长尾块能连续触发几十帧）
    if (tail.textContent !== pending) tail.textContent = pending
    keepBottom(stick)
  }

  return {
    root,

    push(delta: string): void {
      if (!delta) return
      queued += delta
      if (!raf) raf = window.requestAnimationFrame(flush)
    },

    async finish(fullText: string): Promise<void> {
      if (raf) {
        window.cancelAnimationFrame(raf)
        raf = 0
      }
      // 先把最后一帧还没合并的增量并进 pending 并切完块：
      // 下面「尾块是否为空」的判断，以及要不要重渲染，都取决于切完后的状态
      flush()
      const stick = stuck()

      // 整条只有一个块、尾块也为空：逐块渲染的结果和「整条重渲染」逐字相同，
      // 再渲染一遍只是白付一次解析 + 一次 `innerHTML` 全量重建 —— 长回答收尾那一下
      // 的卡顿就来自这里（用户反馈「AI 返回的时候显得很慢」）。
      // 只有一块是唯一能确定「跨块语义不影响结果」的情形，别贪。
      if (blocks === 1 && !pending.trim()) {
        // 等这一块的渲染落地（不 +epoch，否则它会把自己作废）
        await chain
        tail.remove()
        keepBottom(stick)
        await hydrateDiagrams(root)
        return
      }

      epoch += 1
      const myEpoch = epoch
      const html = await renderMarkdown(fullText)
      if (myEpoch !== epoch) return
      root.innerHTML = html
      keepBottom(stick)
      await hydrateDiagrams(root)
    },

    fail(message: string): void {
      if (raf) {
        window.cancelAnimationFrame(raf)
        raf = 0
      }
      epoch += 1
      const note = document.createElement('div')
      note.className = 'ai-stream-err'
      note.textContent = message
      root.append(note)
      keepBottom(true)
    },
  }
}

/**
 * 消息里可能带 mermaid / graphviz / plantuml。三个引擎都按「真有才加载」处理：
 * mermaid 4MB、viz 1.2MB，聊天里偶尔画一次图不该让首屏付钱。
 *
 * 只在 `finish` 时画：流式过程中每来一块就画一次，既抖又贵。
 * 历史消息（已落库的整段 Markdown）也走这里，别让两处各写一份「先 mermaid 再 graphviz」。
 */
export async function hydrateDiagrams(body: HTMLElement): Promise<void> {
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  if (body.querySelector('.mermaid-block')) {
    const { renderMermaidBlocks } = await import('../mermaid')
    await renderMermaidBlocks(body, theme)
  }
  if (body.querySelector('.graphviz-block')) {
    const { renderGraphvizBlocks } = await import('../graphviz')
    await renderGraphvizBlocks(body, theme)
  }
  if (body.querySelector('.plantuml-block')) {
    const { renderPlantumlBlocks } = await import('../plantuml')
    await renderPlantumlBlocks(body, theme)
  }
}
