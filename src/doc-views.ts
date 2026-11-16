/**
 * 文档视图能力表（PN-10）。
 *
 * 「这个语言能不能渲染成文档 / 导图」和「这个语言的语法是什么」是两件事：
 * 前者决定右侧面板有哪些入口，后者决定着色、补全、检查规则。
 * 从前判定散在 8 处 `lang === 'markdown'`，加一个视图就要再散一遍，
 * 所以收在这里：加视图只改这张表，调用方一律问函数。
 *
 * 放在 src 根目录而不是 shell/ 或 ui/：outline（ui）与 diagnostics 都要用，
 * 任何一侧放都会制造反向依赖。
 */
export type DocView = 'doc' | 'mindmap'

const DOC_VIEWS: Partial<Record<string, readonly DocView[]>> = {
  markdown: ['doc', 'mindmap'],
}

export function docViewsOf(lang: string): readonly DocView[] {
  return DOC_VIEWS[lang] ?? []
}

/** 语法层面是否 Markdown 系：检查规则、大纲解析、围栏补全都按它判断 */
export function isMarkdownLike(lang: string): boolean {
  return docViewsOf(lang).includes('doc')
}

/** 该语言是否提供某个面板视图：右侧入口的显隐按它判断 */
export function supportsDocView(lang: string, view: DocView): boolean {
  return docViewsOf(lang).includes(view)
}
