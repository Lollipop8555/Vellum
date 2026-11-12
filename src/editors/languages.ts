import { langFromName, type LangId } from './lang-registry'

// 语言表、扩展名推断、两个引擎的映射都在 lang-registry.ts，这里继续对外导出，
// 调用方不用改 import 路径
export * from './lang-registry'

/* ------------------------------------------------------------ logcat */

export type LogcatTokenType =
  | 'time'
  | 'pid'
  | 'level-verbose'
  | 'level-debug'
  | 'level-info'
  | 'level-warn'
  | 'level-error'
  | 'tag'
  | 'stack'
  | 'error'

export interface LogcatToken {
  start: number
  end: number
  type: LogcatTokenType
}

const LEVEL_TYPES: Record<string, LogcatTokenType> = {
  V: 'level-verbose',
  D: 'level-debug',
  I: 'level-info',
  W: 'level-warn',
  E: 'level-error',
  F: 'level-error',
  A: 'level-error',
}

const STAMP = String.raw`(?<ts>\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d{3})`
const CLOCK = String.raw`(?<ts>\d{2}:\d{2}:\d{2}\.\d{3})`
// tag 到行尾的 ':' 为止，限制长度避免病态回溯
const TAG_TEXT = String.raw`[^\s:][^:]{0,79}?`

/**
 * 常见的 logcat 行格式，按优先级排列：
 * 1) threadtime  08-15 10:59:32.123  1234  1250 D Tag: msg
 * 2) time        10:59:32.123  1234  1250 D Tag: msg
 * 3) 无 TID      08-15 10:59:32.123 D Tag: msg
 * 4) brief       D/Tag( 1234): msg
 * 5) brief 无 PID D/Tag: msg
 */
const LINE_PATTERNS: RegExp[] = [
  new RegExp(
    String.raw`^\s*${STAMP}\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<lvl>[VDIWEFA])\s+(?<tag>${TAG_TEXT}):\s?(?<msg>.*)$`,
    'd',
  ),
  new RegExp(
    String.raw`^\s*${CLOCK}\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<lvl>[VDIWEFA])\s+(?<tag>${TAG_TEXT}):\s?(?<msg>.*)$`,
    'd',
  ),
  new RegExp(
    String.raw`^\s*${STAMP}\s+(?<lvl>[VDIWEFA])\s+(?<tag>${TAG_TEXT}):\s?(?<msg>.*)$`,
    'd',
  ),
  new RegExp(
    String.raw`^\s*(?<lvl>[VDIWEFA])/(?<tag>[^(]+)\(\s*(?<pid>\d+)\s*\):\s?(?<msg>.*)$`,
    'd',
  ),
  new RegExp(String.raw`^\s*(?<lvl>[VDIWEFA])/(?<tag>${TAG_TEXT}):\s?(?<msg>.*)$`, 'd'),
]

/** 消息体里值得单独着色的部分：异常名、堆栈帧、ANR 标记 */
const MESSAGE_PATTERNS: { re: RegExp; type: LogcatTokenType }[] = [
  { re: /\b(?:FATAL EXCEPTION|Caused by:|ANR in)\b/g, type: 'error' },
  { re: /\b[\w.$]*(?:Exception|Error)\b/g, type: 'error' },
  { re: /\bat\s+[\w.$<>[\]]+/g, type: 'stack' },
]

function isLogcatLine(line: string): boolean {
  return LINE_PATTERNS.some((re) => re.test(line))
}

/**
 * 把一行 logcat 解析成若干着色区间。两个引擎共用同一份结果，
 * 保证 CodeMirror 与 Monaco 的颜色分块完全一致。
 */
export function scanLogcatLine(line: string): LogcatToken[] {
  if (line.length > 2000) return []
  let matched: RegExpExecArray | null = null
  for (const re of LINE_PATTERNS) {
    matched = re.exec(line)
    if (matched) break
  }
  if (!matched?.indices?.groups) return []

  const groups = matched.indices.groups
  const values = matched.groups ?? {}
  const out: LogcatToken[] = []
  const add = (name: string, type: LogcatTokenType) => {
    const span = groups[name]
    if (span && span[1] > span[0]) out.push({ start: span[0], end: span[1], type })
  }

  add('ts', 'time')
  add('pid', 'pid')
  add('tid', 'pid')
  add('tag', 'tag')

  const level = values.lvl
  const levelSpan = groups.lvl
  if (level && levelSpan) {
    out.push({
      start: levelSpan[0],
      end: levelSpan[1],
      type: LEVEL_TYPES[level] ?? 'level-info',
    })
  }

  const msgSpan = groups.msg
  if (msgSpan && msgSpan[1] > msgSpan[0]) {
    const text = line.slice(msgSpan[0], msgSpan[1])
    for (const { re, type } of MESSAGE_PATTERNS) {
      re.lastIndex = 0
      let hit: RegExpExecArray | null
      while ((hit = re.exec(text))) {
        if (!hit[0]) {
          re.lastIndex++
          continue
        }
        out.push({
          start: msgSpan[0] + hit.index,
          end: msgSpan[0] + hit.index + hit[0].length,
          type,
        })
      }
    }
  }

  out.sort((a, b) => a.start - b.start)
  // 关键字区间可能重叠，保留靠前的那个，保证结果是不重叠的有序区间
  const merged: LogcatToken[] = []
  for (const token of out) {
    const last = merged[merged.length - 1]
    if (last && token.start < last.end) continue
    merged.push(token)
  }
  return merged
}

/**
 * 内容嗅探：后缀说明不了问题时靠它。取前 300 行，
 * 至少 3 行有效且 60% 以上符合 logcat 格式才认定。
 */
export function detectLogcat(text: string): boolean {
  const lines = text.slice(0, 60_000).split('\n', 300)
  let seen = 0
  let hits = 0
  for (const line of lines) {
    if (!line.trim()) continue
    seen++
    if (isLogcatLine(line)) hits++
  }
  return seen >= 3 && hits / seen >= 0.6
}

/** 按扩展名推断，推断不出来时再看内容 */
export function detectLang(name: string, text: string): LangId {
  const byExt = langFromName(name)
  if (byExt !== 'text') return byExt
  return detectLogcat(text) ? 'logcat' : 'text'
}
