/**
 * GitHub 风格的锚点：小写、去标点、空格换连字符。
 *
 * 预览的 heading id、死链检查的锚点比对、补全的锚点候选必须用同一份实现，
 * 否则补出来的链接自己就是死链。
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[`*_~[\](){}<>#!.,:;'"?!+=|\\/@^$%]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+$/, '')
}
