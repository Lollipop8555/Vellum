import type { LangId } from '../editors/languages'
import { LIMITS } from './largefile'

export interface FormatOptions {
  tabWidth: number
  singleQuote: boolean
  semi: boolean
  printWidth: number
}

export const DEFAULT_FORMAT: FormatOptions = {
  tabWidth: 2,
  singleQuote: true,
  semi: false,
  printWidth: 100,
}

const PRETTIER_PARSER: Partial<Record<LangId, string>> = {
  json: 'json',
  javascript: 'babel',
  typescript: 'babel-ts',
  html: 'html',
  css: 'css',
  markdown: 'markdown',
  yaml: 'yaml',
}

export function canFormat(lang: LangId): boolean {
  return lang in PRETTIER_PARSER || lang === 'xml' || lang === 'sql'
}

/** 全部走动态 import：首次使用某语言才会下载对应插件 chunk */
export async function formatText(
  text: string,
  lang: LangId,
  opts: FormatOptions = DEFAULT_FORMAT,
): Promise<string> {
  if (text.length > LIMITS.format) {
    throw new Error(`text too large (${text.length} chars)`)
  }

  if (lang === 'xml') {
    const { default: xmlFormat } = await import('xml-formatter')
    return xmlFormat(text, {
      indentation: ' '.repeat(opts.tabWidth),
      collapseContent: true,
      lineSeparator: '\n',
    })
  }

  if (lang === 'sql') {
    const { format } = await import('sql-formatter')
    return format(text, { language: 'sql', tabWidth: opts.tabWidth, keywordCase: 'upper' })
  }

  const parser = PRETTIER_PARSER[lang]
  if (!parser) throw new Error(`no formatter for ${lang}`)

  const prettier = await import('prettier/standalone')
  const plugins: unknown[] = []

  const needBabel = ['json', 'javascript', 'typescript'].includes(lang)
  if (needBabel) {
    const [babel, estree] = await Promise.all([
      import('prettier/plugins/babel'),
      import('prettier/plugins/estree'),
    ])
    plugins.push(babel, estree)
  }
  if (lang === 'html') plugins.push(await import('prettier/plugins/html'))
  if (lang === 'css') plugins.push(await import('prettier/plugins/postcss'))
  if (lang === 'markdown') plugins.push(await import('prettier/plugins/markdown'))
  if (lang === 'yaml') plugins.push(await import('prettier/plugins/yaml'))

  const result = await prettier.format(text, {
    parser,
    plugins: plugins as never[],
    tabWidth: opts.tabWidth,
    printWidth: opts.printWidth,
    singleQuote: opts.singleQuote,
    semi: opts.semi,
    proseWrap: 'preserve',
  })

  // Prettier 总是补一个结尾换行，原文件没有就去掉，避免无意义的 dirty
  return result.replace(/\n$/, text.endsWith('\n') ? '\n' : '')
}
