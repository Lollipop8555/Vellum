export function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin)
}

export function b64decode(text: string): string {
  const bin = atob(text.trim())
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function urlEncode(text: string): string {
  return encodeURIComponent(text)
}

export function urlDecode(text: string): string {
  return decodeURIComponent(text)
}

export interface JwtParts {
  header: unknown
  payload: unknown
  signature: string
}

export function decodeJwt(token: string): JwtParts {
  const parts = token.trim().split('.')
  if (parts.length < 2) throw new Error('invalid JWT')
  const dec = (s: string) => JSON.parse(b64UrlToUtf8(s))
  return { header: dec(parts[0]), payload: dec(parts[1]), signature: parts[2] ?? '' }
}

function b64UrlToUtf8(seg: string): string {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(seg.length / 4) * 4, '=')
  return b64decode(b64)
}

/** 输入秒或毫秒时间戳，输出本地时间；输入日期字符串则输出毫秒戳 */
export function convertTimestamp(input: string): { ms?: number; date?: string } {
  const raw = input.trim()
  if (!raw) return {}

  if (/^\d{9,13}$/.test(raw)) {
    const n = Number(raw)
    const ms = raw.length <= 10 ? n * 1000 : n
    return { ms, date: new Date(ms).toString() }
  }

  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) return {}
  return { ms: parsed, date: new Date(parsed).toString() }
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}
