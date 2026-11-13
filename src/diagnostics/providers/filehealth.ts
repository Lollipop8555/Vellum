import type { Tree } from '@lezer/common'
import type { Issue } from '../types'

/**
 * 文件体检：与语言无关的「文本卫生」问题。
 *
 * 这一组不靠语法树，纯线性扫描，任何文件都能跑——所以它是唯一一个能力矩阵里
 * 永远 `ok` 的检查项（plans/diagnostics.md §7.1）。
 * 严重度统一 warning：它们不会让程序跑不起来，只会让某些工具莫名其妙地出错。
 */

const MAX_EACH = 3

function issue(
  from: number,
  to: number,
  severity: 'error' | 'warning',
  key: Issue['key'],
  params?: Record<string, string | number>,
): Issue {
  return { from, to: Math.max(from + 1, to), severity, kind: 'fileHealth', key, params, source: 'fileHealth' }
}

/** BOM：解析器/脚本经常把它当内容，报出来比让它静默捣乱强 */
function bomIssues(text: string): Issue[] {
  if (text.charCodeAt(0) !== 0xfeff) return []
  return [issue(0, 1, 'warning', 'issues.bom', { code: 'FEFF' })]
}

/** 行尾符混用：git 会把整个文件标成改动，有些工具直接解析失败 */
function eolIssues(text: string): Issue[] {
  let crlf = 0
  let lfOnly = 0
  let firstCrlf = -1
  let firstLfOnly = -1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue
    if (i > 0 && text.charCodeAt(i - 1) === 13) {
      crlf++
      if (firstCrlf < 0) firstCrlf = i - 1
    } else {
      lfOnly++
      if (firstLfOnly < 0) firstLfOnly = i
    }
  }
  if (crlf === 0 || lfOnly === 0) return []
  // 指在少数派的第一处，用户才知道该往哪看
  const at = crlf <= lfOnly ? firstCrlf : firstLfOnly
  return [issue(at, at + 2, 'warning', 'issues.eolMixed', { crlf, lf: lfOnly })]
}

const CONFLICT = /^(<{7}|={7}|>{7})(?:[ \t]|$)/

/** 没合完的冲突标记：这种东西留在文件里是最典型的「肉眼看不出」的错 */
function conflictIssues(text: string): Issue[] {
  const issues: Issue[] = []
  let start = 0
  while (start < text.length && issues.length < MAX_EACH) {
    const nl = text.indexOf('\n', start)
    const end = nl < 0 ? text.length : nl
    const line = text.slice(start, end)
    if (CONFLICT.test(line)) {
      const match = CONFLICT.exec(line)
      issues.push(
        issue(start, start + (match?.[1].length ?? 7), 'warning', 'issues.conflictMarker'),
      )
    }
    if (nl < 0) break
    start = nl + 1
  }
  return issues
}

/** 零宽字符：肉眼完全看不见，却会让编译器的报错位置对不上、让 diff 变成玄学 */
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0x180e, 0xfeff])

function zeroWidthIssues(text: string): Issue[] {
  const issues: Issue[] = []
  for (let i = 0; i < text.length && issues.length < MAX_EACH; i++) {
    const code = text.charCodeAt(i)
    // 开头的 FEFF 是 BOM，上面已经单独报过
    if (i === 0 && code === 0xfeff) continue
    if (!ZERO_WIDTH.has(code)) continue
    issues.push(issue(i, i + 1, 'warning', 'issues.zeroWidth', { code: code.toString(16).toUpperCase() }))
  }
  return issues
}

export function fileHealthIssues(text: string): Issue[] {
  if (text.length === 0) return []
  return [
    ...bomIssues(text),
    ...eolIssues(text),
    ...conflictIssues(text),
    ...zeroWidthIssues(text),
  ]
}

/* ------------------------------------------------------- 全角标点 */

/**
 * 全角标点 → 半角。只收「误按中文输入法」会打出来、且换成半角就合法的那几个：
 * `（）` `；` `：` `，` 在代码里出现几乎必然是打错了，而 `。` `、` `“”` 更常出现在注释里，
 * 注释本来就被排除了，所以一并收进来不会制造噪音。
 */
const FULLWIDTH: Record<string, string> = {
  '（': '(',
  '）': ')',
  '［': '[',
  '］': ']',
  '｛': '{',
  '｝': '}',
  '；': ';',
  '：': ':',
  '，': ',',
  '。': '.',
  '！': '!',
  '？': '?',
  '、': ',',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '《': '<',
  '》': '>',
  '＜': '<',
  '＞': '>',
  '＝': '=',
  '＋': '+',
  '－': '-',
  '＊': '*',
  '／': '/',
  '＃': '#',
  '＆': '&',
  '％': '%',
  '＄': '$',
  '＠': '@',
}

const SKIP_NODE = /comment|string|template|regexp|character|doctyp/i

/** 注释与字符串里出现中文标点是正常的，必须靠语法树把它们排除掉 */
function skipRanges(tree: Tree, textLength: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  tree.iterate({
    enter(node) {
      if (!SKIP_NODE.test(node.name)) return
      if (node.to > node.from) ranges.push([node.from, Math.min(node.to, textLength)])
      return false
    },
  })
  if (ranges.length < 2) return ranges
  // 节点会嵌套（字符串里的模板片段），先合并成互不相交的区间，
  // 下面才敢用二分；不合并的话二分会在重叠区间上漏判
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = [ranges[0]]
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1]
    const next = ranges[i]
    if (next[0] <= last[1]) last[1] = Math.max(last[1], next[1])
    else merged.push(next)
  }
  return merged
}

function inRanges(ranges: Array<[number, number]>, pos: number): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [from, to] = ranges[mid]
    if (pos < from) hi = mid - 1
    else if (pos >= to) lo = mid + 1
    else return true
  }
  return false
}

export function fullwidthIssues(text: string, tree: Tree | null): Issue[] {
  if (!tree) return []
  // 先廉价地找一遍：绝大多数文件一个全角符号都没有，不必建跳过区间
  const hits: number[] = []
  for (let i = 0; i < text.length && hits.length < 40; i++) {
    if (FULLWIDTH[text[i]]) hits.push(i)
  }
  if (hits.length === 0) return []

  const ranges = skipRanges(tree, text.length)
  const issues: Issue[] = []
  for (const pos of hits) {
    if (issues.length >= 8) break
    if (inRanges(ranges, pos)) continue
    const ch = text[pos]
    issues.push({
      from: pos,
      to: pos + 1,
      severity: 'warning',
      kind: 'fullwidth',
      key: 'issues.fullwidth',
      params: { char: ch, ascii: FULLWIDTH[ch] },
      source: 'fullwidth',
    })
  }
  return issues
}
