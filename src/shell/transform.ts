export type TransformId =
  | 'sort'
  | 'dedupe'
  | 'trim'
  | 'upper'
  | 'lower'
  | 'indent2'
  | 'indent4'
  | 'tabs'
  | 'removeEmpty'

export function transformText(text: string, id: TransformId): string {
  const lines = text.split('\n')

  switch (id) {
    case 'sort':
      return [...lines].sort((a, b) => a.localeCompare(b)).join('\n')
    case 'dedupe':
      return [...new Set(lines)].join('\n')
    case 'trim':
      return lines.map((l) => l.trim()).join('\n')
    case 'upper':
      return text.toUpperCase()
    case 'lower':
      return text.toLowerCase()
    case 'indent2':
      return lines.map((l) => l.replace(/^\t+/, (m) => ' '.repeat(m.length * 2))).join('\n')
    case 'indent4':
      return lines.map((l) => l.replace(/^\t+/, (m) => ' '.repeat(m.length * 4))).join('\n')
    case 'tabs':
      return lines
        .map((l) => l.replace(/^ +/, (m) => '\t'.repeat(Math.floor(m.length / 2))))
        .join('\n')
    case 'removeEmpty':
      return lines.filter((l) => l.trim() !== '').join('\n')
    default:
      return text
  }
}

export function wordCount(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length
  const words = text
    .replace(/[\u4e00-\u9fa5]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length
  return cjk + words
}
