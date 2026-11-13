/**
 * 围栏语言名的归一化表。
 *
 * 语料实测：`kotlin`/`Kotlin`、`typescript`/`TypeScript`/`typeScript`、
 * `plain`/`plain`/`txt`/`text` 混用，还有 `uri` 这种项目自定义标注。
 * 归一化只影响「怎么着色」，不改写用户原文。
 */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  kt: 'kotlin',
  sh: 'bash',
  shell: 'bash',
  console: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  html: 'xml',
  // 项目方言：文档用 ```uri 标注文件路径与 svn 地址，本质是纯文本
  uri: 'plaintext',
  plain: 'plaintext',
  txt: 'plaintext',
  text: 'plaintext',
  // Android 工程的构建脚本习惯
  properties: 'ini',
  // highlight.js 没有独立的 toml 语言，ini 是最接近的
  toml: 'ini',
  gradle: 'groovy',
}

/** 取第一个词并转小写，再查别名；未知语言原样返回，交给高亮器自行降级 */
export function normalizeLang(raw: string | null | undefined): string {
  const first = (raw ?? '').trim().split(/\s+/)[0]?.toLowerCase()
  if (!first) return ''
  return ALIASES[first] ?? first
}


