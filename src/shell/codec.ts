import type { EncodingId } from '../types'

export const ENCODING_LABELS: Record<EncodingId, string> = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  gb18030: 'GB18030 / GBK',
  big5: 'Big5',
  shift_jis: 'Shift_JIS',
  'windows-1252': 'Windows-1252',
}

/** 解码顺序：BOM → UTF-8 严格试探 → GB18030 兜底 */
const ORDER: EncodingId[] = ['utf-8', 'gb18030']

export interface DecodeResult {
  text: string
  encoding: EncodingId
  hadBom: boolean
}

export function decodeAuto(buf: ArrayBuffer): DecodeResult {
  const bytes = new Uint8Array(buf)

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', hadBom: true }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: new TextDecoder('utf-16le').decode(bytes.subarray(2)),
      encoding: 'utf-16le',
      hadBom: true,
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      text: new TextDecoder('utf-16be').decode(bytes.subarray(2)),
      encoding: 'utf-16be',
      hadBom: true,
    }
  }

  for (const enc of ORDER) {
    const text = tryDecode(bytes, enc)
    if (text !== null) return { text, encoding: enc, hadBom: false }
  }

  return {
    text: new TextDecoder('gb18030').decode(bytes),
    encoding: 'gb18030',
    hadBom: false,
  }
}

function tryDecode(bytes: Uint8Array, enc: EncodingId): string | null {
  try {
    return new TextDecoder(enc, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function decodeWith(buf: ArrayBuffer, enc: EncodingId): string {
  const bytes = new Uint8Array(buf)
  try {
    return new TextDecoder(enc).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** 二进制判定：出现 NUL 或控制字符比例过高 */
export function looksBinary(buf: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buf.slice(0, Math.min(buf.byteLength, 8192)))
  if (bytes.length === 0) return false
  let suspicious = 0
  for (const b of bytes) {
    if (b === 0) return true
    if (b < 7 || (b > 13 && b < 20)) suspicious++
  }
  return suspicious / bytes.length > 0.1
}

export function detectEol(text: string): 'lf' | 'crlf' {
  const crlf = text.indexOf('\r\n')
  const lf = text.indexOf('\n')
  if (crlf === -1) return 'lf'
  return lf === crlf + 1 || lf === -1 ? 'crlf' : 'lf'
}

export function normalizeEol(text: string, eol: 'lf' | 'crlf'): string {
  const unified = text.replace(/\r\n/g, '\n')
  return eol === 'crlf' ? unified.replace(/\n/g, '\r\n') : unified
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
