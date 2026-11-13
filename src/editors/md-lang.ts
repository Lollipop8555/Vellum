import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import type { Extension } from '@codemirror/state'
import { blockLangs } from '../ui/md/blocks'
import type { LangDef } from './lang-registry'
import { createMarkdownCompletions } from './md-complete'

/**
 * Markdown 在 CodeMirror 这边的全部配置，单独成文件是因为它有两个来源：
 * 语言表（围栏里高亮什么）和区块注册表（围栏里能画什么）。
 * 放在 lang-registry 里会把那张大表和补全实现搅在一起。
 */

let descriptions: LanguageDescription[] | null = null

async function loadSupport(def: LangDef): Promise<LanguageSupport> {
  if (def.cm) {
    const extension = def.cm()
    // 语言包返回的一律是 LanguageSupport；真遇到裸 Language 时补一层壳
    return extension instanceof LanguageSupport ? extension : new LanguageSupport(extension as never)
  }
  return new LanguageSupport(StreamLanguage.define(await def.stream!()))
}

/** 围栏里的代码块真上色：语言表有几种，这里就有几种，不另立清单 */
function codeLanguages(langs: readonly LangDef[]): LanguageDescription[] {
  descriptions ??= langs
    .filter((def) => def.cm || def.stream)
    .map((def) =>
      LanguageDescription.of({
        name: def.id,
        alias: [def.id, ...def.ext],
        extensions: [...def.ext],
        // 用 load 而不是 support：markdown 自己也可能出现在围栏里，
        // 提前求值会绕回本函数
        load: () => loadSupport(def),
      }),
    )
  return descriptions
}

export function markdownSupport(langs: readonly LangDef[]): Extension {
  return [
    markdown({ codeLanguages: codeLanguages(langs) }),
    markdownLanguage.data.of({
      autocomplete: createMarkdownCompletions({
        blockLangs: blockLangs(),
        codeLangs: langs.map((def) => def.id),
      }),
    }),
  ]
}
