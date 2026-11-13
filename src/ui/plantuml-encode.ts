/**
 * PlantUML 的 URL 编码，单独成文件是为了能在 node 里直接测：
 * 编码错一位，服务器就会回一张错的图，而错误信息只有一句「语法错误」，
 * 靠浏览器猜太难了。
 *
 * 规则来自 PlantUML 自己的 `encode6bit`：先 zlib deflate，再用它自己的 base64 变体。
 * 注意字母表顺序和标准 base64 不同，不能靠替换，只能按 6bit 重新拼。
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'

function encode64(bytes: Uint8Array): string {
  let out = ''
  // 尾巴不足三字节按 0 补齐，且**不留 = 填充**——PlantUML 的解码器就是这么要求的
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i]!
    const b2 = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const b3 = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out += ALPHABET[b1 >> 2]
    out += ALPHABET[((b1 & 0x03) << 4) | (b2 >> 4)]
    out += ALPHABET[((b2 & 0x0f) << 2) | (b3 >> 6)]
    out += ALPHABET[b3 & 0x3f]
  }
  return out
}

/** zlib deflate（RFC 1950）；环境没有 CompressionStream 时返回 null，由调用方降级 */
async function deflate(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * 把图表源码编成 URL 片段。
 * 没有 CompressionStream 就退回 `~h` 十六进制：体积翻倍，但语法简单、服务端一定认。
 */
export async function encodeSource(text: string): Promise<string> {
  const bytes = await deflate(text)
  if (bytes) return encode64(bytes)
  const hex = [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `~h${hex}`
}
