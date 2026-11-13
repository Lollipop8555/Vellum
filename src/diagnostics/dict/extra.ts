/**
 * 代码注释里高频、但「日常英语词频表」里未必靠前的词。
 *
 * 只做加法：这里的词一律当作「拼对了」。词典的误报代价远高于漏报，
 * 所以宁可把常见技术词都收进来，也不要让 `callback` 被画红线。
 * 用户自己的项目词走设置里的「忽略的单词」，不要往这里加业务名词。
 *
 * 收录标准：技术写作 / 代码注释里常见，且不在 en.txt 前 2 万词内（例如
 * `configuration`、`serialization`、`deprecated`）。加之前先 `grep -qx` 查一下
 * en.txt，避免堆重复词。
 */
export const EXTRA_WORDS: readonly string[] = `
annotation annotations api apis arg args async authentication authorization await
backend base64 boolean bugfix callback callbacks changelog charset cli clippy
codepoint config configs configuration configurations css csv debounce debounced
declaration declarations deprecated deserialize deserialized destructure destructured
dev devs dict dir dirs documentation dropdown enum enums env envs eslint fallback
fallbacks filename filenames filesystem fn func funcs gif glob globs gzip handler
handlers href html http https idx iff init initialise initialised initialize
initialization initialized inline iterator iterable implementation implementations
json jsonc jsx keymap layout layouts lint linter lints localhost memoize memoized
metadata middleware monorepo mdx navbar normalise normalised normalize normalized
npm null nullable override overrides param params payload payloads png prettier
preload prepend prev proj pnpm pure refactor refactored refactoring repo repos
regex regexes render rendered renderer reorder rewrite rewrites rewriting rewritten
runtime scrollbar sdk sdks serialization serialize serialized sha sidebar stdin
stdout stderr struct structs svg tabindex timestamp timestamps todo tooltip
tooltips tsx tuple tuples ui uid uncheck uncheckable unescape unicode unlink
untracked uri url urls utf uuid validation viewport viewports vite webpack webp
whitespace workflow workflows yaml
`.trim().split(/\s+/)
