/**
 * 幻灯片文档模型：按 `---` 分页 → 页数组 → 每页源码与源码行号。
 *
 * 解析分两层：
 *   - `port/` 是 remark 的词法器与结构解析器（移植，规则不动）；
 *   - 这里负责「我们自己的口径」：比例、页属性归一化、行号、空态原因。
 *
 * **没有「这是不是演示文稿」的文档级别声明**：同一份 Markdown 在文档视图里就是普通
 * 文档，在幻灯片面板里就按 `---` 分页——这是「一份文件两种看法」，不该让文件头替
 * 用户做决定（`slides: true` 还会在文档视图里显示成一个灰色代码块）。
 *
 * 每页最终是一段**独立的 Markdown 源码**，交给 `renderMarkdown()` 单独渲染：
 * 围栏代码里的 `---` 天然不分页、每页可独立缓存、公式/图表/高亮与文档视图完全一致。
 */
import { cleanInput, parseSlides, type ContentPart, type SlideRaw } from './port/parser'

export interface DeckBackground {
  color?: string
  image?: string
  size?: string
  position?: string
}

export interface DeckProps {
  /** `name:` 页命名 */
  name?: string
  /** `class: center, middle` */
  classes: string[]
  background: DeckBackground
  /** `exclude: true` 已被解析层过滤掉，这里保留原始值供规则页展示 */
  continued: boolean
  /** 归一化前的原始属性，规则页与调试用 */
  raw: Record<string, string>
}

export interface DeckPage {
  /** 0-based，展示时 +1 */
  index: number
  /** 去掉页属性后的正文源码（单页独立 Markdown） */
  source: string
  /** `???` 之后的演讲者备注 */
  notes: string
  props: DeckProps
  /** 该页首行在源文件里的行号（1-based），供点击跳转 */
  line: number
}

export type DeckReason =
  /** 可以正常渲染 */
  | 'ok'
  /** 没有任何内容（空文件 / 只有空白） */
  | 'empty'
  /** 解析抛异常，降级为提示 */
  | 'broken'

export interface DeckDoc {
  /** `16:9` / `4:3`，来自文件头或首页属性 */
  ratio: string
  pages: DeckPage[]
  reason: DeckReason
  warnings: string[]
}

const DEFAULT_RATIO = '16:9'

export function parseDeck(text: string): DeckDoc {
  // 上游 lexer 只去掉第一个 \r，这里统一归一化；行号口径与原文一致（CRLF 不额外占行）
  const normalized = text.replace(/\r\n?/g, '\n')
  const front = readFrontmatter(normalized)

  let slides: SlideRaw[]
  let warnings: string[]
  try {
    const cleaned = cleanInput(front.body)
    const parsed = parseSlides(cleaned, { clean: false })
    slides = parsed.slides
    warnings = parsed.warnings
  } catch {
    return { ratio: DEFAULT_RATIO, pages: [], reason: 'broken', warnings: [] }
  }

  // 行号要用解析器看到的同一份文本（cleanInput 只删空白，行数不变）
  const cleanedForLines = cleanInput(front.body)

  const pages: DeckPage[] = []
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i]
    const source = flatten(slide.content).replace(/^\n+/, '')
    const notes = flatten(slide.notes ?? []).trim()
    // 分页符两侧的空页（如文首 `---`、文末 `---`）不占页
    if (source.trim() === '' && notes === '') continue

    pages.push({
      index: pages.length,
      source,
      notes,
      props: toProps(slide.properties),
      // 跳转目标是「该页正文首行」而不是分隔符：页属性行（name/class/background）
      // 已被摘走，按偏移算会落在属性行上，用户跳过去看不到内容
      line: locatePageLine(
        cleanedForLines,
        slide.start,
        i + 1 < slides.length ? slides[i + 1].start : cleanedForLines.length,
        source,
        front.prefixLines,
      ),
    })
  }

  const ratio = pickRatio(front.data.ratio, slides[0]?.properties.ratio)
  const reason: DeckReason = pages.length === 0 ? 'empty' : 'ok'

  return { ratio, pages, reason, warnings }
}

/** `16:9` → `{ w: 1280, h: 720 }`。设计基准宽固定 1280，高按比例算 */
export function ratioSize(ratio: string): { w: number; h: number } {
  const match = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(ratio.trim())
  const w = 1280
  if (!match) return { w, h: Math.round((w * 9) / 16) }
  const rw = Number(match[1])
  const rh = Number(match[2])
  if (!rw || !rh) return { w, h: Math.round((w * 9) / 16) }
  return { w, h: Math.round((w * rh) / rw) }
}

/* ------------------------------------------------------------------ 内部 */

function flatten(parts: ContentPart[]): string {
  let out = ''
  for (const part of parts) {
    out += typeof part === 'string' ? part : flatten(part.content)
  }
  return out
}

function toProps(raw: Record<string, string>): DeckProps {
  const classes = (raw.class ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    name: raw.name,
    classes,
    background: {
      color: raw['background-color'],
      image: raw['background-image'],
      size: raw['background-size'],
      position: raw['background-position'],
    },
    continued: raw.continued === 'true',
    raw,
  }
}

function pickRatio(front: string | undefined, page: string | undefined): string {
  const candidate = (front || page || '').trim()
  return /^\d+(?:\.\d+)?\s*[:/x]\s*\d+(?:\.\d+)?$/.test(candidate)
    ? candidate
    : DEFAULT_RATIO
}

interface Frontmatter {
  data: Record<string, string>
  body: string
  /** frontmatter 占了原文件的多少行（含两条 `---`），用于行号偏移 */
  prefixLines: number
}

/**
 * YAML frontmatter 的**保守**读取：只认 `key: value` 单行标量。
 *
 * 为什么不用管线里的 `remark-frontmatter`：解析层要先于渲染跑，且这里只需要
 * `ratio` 一个标量；真把 YAML 解析器引进来，就得为一个字符串多背一个依赖与一套错误处理。
 * 认不出来的键原样留在正文里，交给渲染器。
 */
function readFrontmatter(src: string): Frontmatter {
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src)
  if (!match) return { data: {}, body: src, prefixLines: 0 }

  const data: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line.trim())
    if (!kv) continue
    data[kv[1].toLowerCase()] = kv[2].replace(/^['"]|['"]$/g, '').trim()
  }

  return { data, body: src.slice(match[0].length), prefixLines: countLines(match[0]) }
}

/**
 * 页首正文所在行（1-based）。
 *
 * 用「正文首行文本」在本页区间内定位，而不是直接用 token 偏移：页属性行与分隔符
 * 的换行已被摘走，偏移会落在属性行甚至空行上。找不到（极端情况：首行被清洗变形）
 * 就退回本页起点，保证行号永远落在页内。
 */
function locatePageLine(
  cleaned: string,
  from: number,
  to: number,
  source: string,
  prefixLines: number,
): number {
  const firstLine = source.split('\n').find((line) => line.trim() !== '')
  if (firstLine) {
    const at = cleaned.indexOf(firstLine, from)
    if (at >= 0 && at < to) return prefixLines + 1 + countLines(cleaned.slice(0, at))
  }
  return prefixLines + 1 + countLines(cleaned.slice(0, from))
}

function countLines(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++
  }
  return count
}
