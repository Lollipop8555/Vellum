/**
 * 从 URL 导入：把远程文本拉成一个 File，交给和本地导入完全相同的 ingestFile 流程。
 * 只做一次 GET，不带任何自定义头 —— 多一个头就可能触发预检，
 * 而 S3 桶未必在 CORS 规则里放行。跨域能不能成完全取决于对方，这里只负责把失败说清楚。
 */

/** 配置文件都在内网或对象存储上，秒开；超过这个时间基本是地址写错了 */
const TIMEOUT = 30_000

export type UrlFailure = 'url' | 'scheme' | 'status' | 'network' | 'timeout' | 'empty'

export class UrlImportError extends Error {
  constructor(
    readonly reason: UrlFailure,
    readonly status = 0,
  ) {
    super(reason)
  }
}

export interface UrlProgress {
  /** 已收到的字节 */
  received: number
  /** Content-Length，未知时为 null */
  total: number | null
}

/** 文件名里不能出现的字符：URL 段解码后可能带 %2F 之类的残留 */
const ILLEGAL_NAME = /[\\/:*?"<>|\u0000-\u001f]/g

/** 纯版本号（1.0.41.3）：一个目录里全是这种名字，单看它认不出是哪个配置 */
const BARE_VERSION = /^\d+(?:\.\d+)*$/

const EXT_BY_SUBTYPE: Record<string, string> = {
  json: 'json',
  'ld+json': 'json',
  xml: 'xml',
  html: 'html',
  plain: 'txt',
  markdown: 'md',
  csv: 'csv',
  javascript: 'js',
  yaml: 'yaml',
  'x-yaml': 'yaml',
}

function parseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new UrlImportError('url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlImportError('scheme')
  return url
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function cleanName(raw: string): string {
  return raw.replace(ILLEGAL_NAME, '-').replace(/[.\s]+$/, '').trim()
}

function extFromType(type: string | null): string {
  const mime = (type ?? '').split(';')[0].trim().toLowerCase()
  const subtype = mime.split('/')[1] ?? ''
  return EXT_BY_SUBTYPE[subtype] ?? 'txt'
}

/**
 * 文件名推导：路径最后一段；如果它只是版本号，拼上上一级目录名（…/cardmaster/1.0.41.3.json
 * → cardmaster-1.0.41.3.json）。路径里什么都没有时才退回到「域名 + 按 Content-Type 猜后缀」。
 * 预签名 URL 的签名参数在 query 上，pathname 天然不含它。
 */
export function urlFileName(url: URL, contentType: string | null): string {
  const segments = url.pathname.split('/').filter(Boolean).map(safeDecode)
  const last = cleanName(segments.pop() ?? '')
  if (last) {
    const parent = segments.length ? cleanName(segments[segments.length - 1]) : ''
    const dot = last.lastIndexOf('.')
    if (parent && dot > 0 && BARE_VERSION.test(last.slice(0, dot))) return `${parent}-${last}`
    // 末尾没有后缀（/configs/ 这类目录式地址）就按 Content-Type 补一个，
    // 免得高亮和预览每次都要靠嗅探内容
    return dot > 0 ? last : `${last}.${extFromType(contentType)}`
  }
  const host = url.hostname.replace(/[^\w.-]/g, '-')
  return `${host || 'download'}.${extFromType(contentType)}`
}

export async function fetchUrlAsFile(
  raw: string,
  signal: AbortSignal | undefined,
  onProgress: (progress: UrlProgress) => void,
): Promise<File> {
  const url = parseUrl(raw)
  // 同源请求会被 Service Worker 的 cacheFirst 接住，加个一次性参数才不会拿到旧副本
  if (url.origin === location.origin) url.searchParams.set('_v', String(Date.now()))

  const ctrl = new AbortController()
  const forward = () => ctrl.abort()
  signal?.addEventListener('abort', forward, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, TIMEOUT)

  try {
    let res: Response
    try {
      res = await fetch(url, {
        cache: 'no-store',
        // 带 Cookie 的跨域要求对方不能返回 ACAO: *，而 S3 正是返回 *，所以明确不带
        credentials: 'omit',
        redirect: 'follow',
        signal: ctrl.signal,
      })
    } catch (err) {
      if (timedOut) throw new UrlImportError('timeout')
      // 用户主动取消：原样抛 AbortError，调用方按「关闭」处理
      if ((err as Error).name === 'AbortError') throw err
      // 浏览器不会告诉我们具体是 CORS 还是 DNS/断网，只能给一句含糊的
      throw new UrlImportError('network')
    }

    if (!res.ok) throw new UrlImportError('status', res.status)

    const total = Number(res.headers.get('content-length')) || null
    onProgress({ received: 0, total })
    let buf: ArrayBuffer
    try {
      buf = await res.arrayBuffer()
    } catch (err) {
      // 超时可能发生在读 body 的阶段，别把它当成用户取消吞掉
      if (timedOut) throw new UrlImportError('timeout')
      throw err
    }
    onProgress({ received: buf.byteLength, total })
    if (!buf.byteLength) throw new UrlImportError('empty')

    const type = res.headers.get('content-type')
    // File.type 只留 MIME 主体，charset 之类的参数带过去没有意义
    const mime = (type ?? '').split(';')[0].trim() || 'application/octet-stream'
    return new File([buf], urlFileName(url, type), { type: mime })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}
