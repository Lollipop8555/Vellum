export interface DiffRow {
  kind: 'context' | 'add' | 'del'
  oldNo: number | null
  newNo: number | null
  text: string
}

export interface DiffResult {
  rows: DiffRow[]
  added: number
  removed: number
}

/** DP 上限，超过后中间段直接按“全删 + 全增”处理，避免页面卡死 */
const MAX_CELLS = 4_000_000

export function computeDiff(oldText: string, newText: string): DiffResult {
  const a = splitLines(oldText)
  const b = splitLines(newText)

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const rows: DiffRow[] = []
  let added = 0
  let removed = 0
  let oldNo = 1
  let newNo = 1

  for (let i = 0; i < start; i++) {
    rows.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: a[i] })
  }

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  if (midA.length * midB.length > MAX_CELLS) {
    for (const line of midA) {
      rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line })
      removed++
    }
    for (const line of midB) {
      rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line })
      added++
    }
  } else {
    for (const op of lcs(midA, midB)) {
      if (op.kind === 'equal') {
        rows.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: midA[op.ai] })
      } else if (op.kind === 'del') {
        rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: midA[op.ai] })
        removed++
      } else {
        rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text: midB[op.bi] })
        added++
      }
    }
  }

  for (let i = endA; i < a.length; i++) {
    rows.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: a[i] })
  }

  return { rows, added, removed }
}

type Op =
  | { kind: 'equal'; ai: number; bi: number }
  | { kind: 'del'; ai: number; bi: number }
  | { kind: 'add'; ai: number; bi: number }

function lcs(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  const width = m + 1
  const table = new Int32Array((n + 1) * width)

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', ai: i, bi: j })
      i++
      j++
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ kind: 'del', ai: i, bi: j })
      i++
    } else {
      ops.push({ kind: 'add', ai: i, bi: j })
      j++
    }
  }
  while (i < n) ops.push({ kind: 'del', ai: i++, bi: j })
  while (j < m) ops.push({ kind: 'add', ai: i, bi: j++ })
  return ops
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
