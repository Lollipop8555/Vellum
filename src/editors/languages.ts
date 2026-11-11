import type { Extension } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { yaml } from '@codemirror/lang-yaml'
import { xml } from '@codemirror/lang-xml'
import { sql } from '@codemirror/lang-sql'
import { python } from '@codemirror/lang-python'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'

export type LangId =
  | 'text'
  | 'markdown'
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'html'
  | 'css'
  | 'yaml'
  | 'xml'
  | 'sql'
  | 'python'
  | 'java'
  | 'cpp'
  | 'rust'
  | 'go'
  | 'php'

const BY_EXT: Record<string, LangId> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  html: 'html',
  htm: 'html',
  vue: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  sql: 'sql',
  py: 'python',
  java: 'java',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  rs: 'rust',
  go: 'go',
  php: 'php',
}

export function langFromName(name: string): LangId {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return BY_EXT[ext] ?? 'text'
}

export function cmLanguage(id: LangId): Extension {
  switch (id) {
    case 'markdown':
      return markdown()
    case 'javascript':
      return javascript()
    case 'typescript':
      return javascript({ typescript: true, jsx: true })
    case 'json':
      return json()
    case 'html':
      return html()
    case 'css':
      return css()
    case 'yaml':
      return yaml()
    case 'xml':
      return xml()
    case 'sql':
      return sql()
    case 'python':
      return python()
    case 'java':
      return java()
    case 'cpp':
      return cpp()
    case 'rust':
      return rust()
    case 'go':
      return go()
    case 'php':
      return php()
    default:
      return []
  }
}

/** Monaco 的 basic-languages id，与 LangId 基本一致 */
export function monacoLanguage(id: LangId): string {
  switch (id) {
    case 'text':
      return 'plaintext'
    case 'javascript':
      return 'javascript'
    case 'typescript':
      return 'typescript'
    case 'json':
      return 'json'
    case 'html':
      return 'html'
    case 'css':
      return 'css'
    case 'yaml':
      return 'yaml'
    case 'xml':
      return 'xml'
    case 'sql':
      return 'sql'
    case 'python':
      return 'python'
    case 'java':
      return 'java'
    case 'cpp':
      return 'cpp'
    case 'rust':
      return 'rust'
    case 'go':
      return 'go'
    case 'php':
      return 'php'
    case 'markdown':
      return 'markdown'
    default:
      return 'plaintext'
  }
}

export const LANG_LABELS: Record<LangId, string> = {
  text: 'Plain text',
  markdown: 'Markdown',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  yaml: 'YAML',
  xml: 'XML',
  sql: 'SQL',
  python: 'Python',
  java: 'Java',
  cpp: 'C/C++',
  rust: 'Rust',
  go: 'Go',
  php: 'PHP',
}
