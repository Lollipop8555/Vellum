/**
 * 逐行扫描的公共设施。
 *
 * `structure` 与 `mdLint` 都要「先切行、再把代码块挖掉」：
 * 文档里贴一段示例 Markdown 是常态，那里面什么奇怪写法都有，
 * 不屏蔽围栏就等于拿示例当错误报。
 */

export interface Line {
  /** 该行首字符在全文中的偏移 */
  start: number
  /** 去掉行尾 `\r` 的正文 */
  text: string
}

export function toLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  while (start <= text.length) {
    const nl = text.indexOf('\n', start)
    const end = nl < 0 ? text.length : nl
    lines.push({ start, text: text.slice(start, end).replace(/\r$/, '') })
    if (nl < 0) break
    start = nl + 1
  }
  return lines
}

export const FENCE = /^\s{0,3}(`{3,}|~{3,})/

/**
 * 逐行标出「这一行是不是代码块/前置元数据」。
 * 死链、标题跳级、表格列数、lint 规则都必须在代码块外才成立。
 */
export function maskLines(lines: Line[]): boolean[] {
  const skip = new Array<boolean>(lines.length).fill(false)
  let fence: string | null = null
  // 前置元数据只在文件最开头成立
  if (lines.length > 1 && /^---\s*$/.test(lines[0].text)) {
    const end = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line.text))
    if (end > 0) for (let i = 0; i <= end; i++) skip[i] = true
  }
  lines.forEach((line, i) => {
    if (skip[i]) return
    const match = FENCE.exec(line.text)
    if (fence) {
      skip[i] = true
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = null
      return
    }
    if (match) {
      fence = match[1]
      skip[i] = true
    }
  })
  return skip
}

/** 空行（含只有空格的「伪空行」） */
export function isBlank(text: string): boolean {
  return /^\s*$/.test(text)
}

/**
 * 缩进代码块：4 空格或 Tab 开头的行。
 * 这类行里的「行尾空格」「Tab」都是代码内容，不该按排版规则报。
 */
export function isIndentedCode(text: string): boolean {
  return /^(?: {4,}|\t)/.test(text)
}
