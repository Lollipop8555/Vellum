/**
 * 二进制资产工具函数（plans/ai-project-v2.md P-08 / P-09 / P-10）。
 *
 * 纯函数、不碰 DOM 与存储：MIME 推断、可预览判定、base64 解码都只吃字符串/字节，
 * 便于在 node 侧直接单测（plans/ai-project-check.mjs）。
 */

/** 常见扩展名 → MIME。未收录的一律 application/octet-stream */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  so: 'application/octet-stream',
  aar: 'application/octet-stream',
  jar: 'application/java-archive',
  dll: 'application/octet-stream',
  wasm: 'application/wasm',
}

/** 编辑器能内联预览的图片类型（P-09）：其余资产只显示元信息 */
const PREVIEWABLE = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
])

/** 去掉 `; charset=...` 之类的参数并转小写 */
function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase()
}

/**
 * 推断 MIME：`declared` 是完整类型（如 File.type）时优先，否则退回扩展名。
 * 扩展名也不认识就是 application/octet-stream。
 */
export function mimeForName(name: string, declared?: string): string {
  const given = baseMime(declared ?? '')
  if (given.includes('/')) return given
  const cut = name.lastIndexOf('.')
  const ext = cut < 0 ? '' : name.slice(cut + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** 是否属于「可内联预览的图片」 */
export function isPreviewableImage(mime: string): boolean {
  return PREVIEWABLE.has(baseMime(mime))
}

/**
 * 是否偏文本。仅用于提示（例如 svg 既能预览也能按文本编辑），
 * 不作为资产判定的唯一依据。
 */
export function isTextualMime(mime: string): boolean {
  const m = baseMime(mime)
  return m.startsWith('text/') || m === 'application/json' || m.endsWith('+xml') || m === 'image/svg+xml'
}

/** 单次 base64 写入上限（解码后字节数）。二进制比文本更吃配额，超出直接拒绝 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024

/**
 * 解 base64。容忍 `data:*;base64,` 前缀、换行与空格，也接受 url-safe 变体。
 * 非法编码返回 null（不抛异常），由调用方转成 bad_arguments。
 */
export function decodeBase64(text: string): Uint8Array | null {
  let body = text.trim()
  const comma = body.indexOf(',')
  if (comma > 0 && body.slice(0, comma).includes('base64')) body = body.slice(comma + 1)
  body = body.replace(/\s+/g, '')
  if (!body) return null
  if (!/^[A-Za-z0-9+/\-_]*={0,2}$/.test(body)) return null
  body = body.replace(/-/g, '+').replace(/_/g, '/')
  if (body.length % 4 === 1) return null
  while (body.length % 4 !== 0) body += '='
  try {
    const bin = atob(body)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** 文本 → 字节（资产元信息展示用，避免各处重复 new TextEncoder） */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
