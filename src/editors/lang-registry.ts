import type { Extension } from '@codemirror/state'
import type { StreamParser } from '@codemirror/streamparser'
import { StreamLanguage } from '@codemirror/language'
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

/**
 * 语言表：一张表同时喂给两个引擎、扩展名推断和语言菜单。
 *
 * - `cm`：有精确语法的 lezer 解析器（同步，随主包加载）
 * - `stream`：CodeMirror 5 时代的 stream 模式，按需 import，各自成 chunk
 * - `mono`：Monaco basic-languages 的注册 id，null 表示它没有这个语言
 *
 * 两边都没有的语言不收，保证菜单里每一行至少有一个引擎能着色。
 */
export interface LangDef {
  readonly id: string
  readonly label: string
  readonly mono: string | null
  readonly ext: readonly string[]
  /** 完整文件名（小写匹配），用于 Dockerfile 这种没有扩展名的 */
  readonly files?: readonly string[]
  readonly cm?: () => Extension
  readonly stream?: () => Promise<StreamParser<unknown>>
}

// 路径必须写成字面量，Vite 才能把它切成按需加载的 chunk
const legacy = (load: () => Promise<unknown>, key: string) => () =>
  load().then((m) => (m as Record<string, StreamParser<unknown>>)[key]!)

export const LANG_LIST = [
  { id: 'text', label: 'Plain text', mono: 'plaintext', ext: [] },
  { id: 'logcat', label: 'Android Logcat', mono: 'logcat', ext: ['logcat'] },

  { id: 'javascript', label: 'JavaScript', mono: 'javascript', ext: ['js', 'mjs', 'cjs', 'jsx'], cm: () => javascript() },
  { id: 'typescript', label: 'TypeScript', mono: 'typescript', ext: ['ts', 'tsx', 'mts', 'cts'], cm: () => javascript({ typescript: true, jsx: true }) },
  { id: 'python', label: 'Python', mono: 'python', ext: ['py', 'pyw', 'pyi', 'pyx'], cm: () => python() },
  { id: 'java', label: 'Java', mono: 'java', ext: ['java'], cm: () => java() },
  { id: 'cpp', label: 'C/C++', mono: 'c', ext: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'hh', 'ino'], cm: () => cpp() },
  { id: 'csharp', label: 'C#', mono: 'csharp', ext: ['cs', 'csx'], stream: legacy(() => import('@codemirror/legacy-modes/mode/clike.js'), 'csharp') },
  { id: 'php', label: 'PHP', mono: 'php', ext: ['php', 'phtml', 'php3', 'php4', 'php5'], cm: () => php() },
  { id: 'go', label: 'Go', mono: 'go', ext: ['go'], cm: () => go() },
  { id: 'rust', label: 'Rust', mono: 'rust', ext: ['rs'], cm: () => rust() },
  { id: 'ruby', label: 'Ruby', mono: 'ruby', ext: ['rb', 'rake', 'gemspec', 'ru'], stream: legacy(() => import('@codemirror/legacy-modes/mode/ruby.js'), 'ruby') },
  { id: 'kotlin', label: 'Kotlin', mono: 'kotlin', ext: ['kt', 'kts'], stream: legacy(() => import('@codemirror/legacy-modes/mode/clike.js'), 'kotlin') },
  { id: 'swift', label: 'Swift', mono: 'swift', ext: ['swift'], stream: legacy(() => import('@codemirror/legacy-modes/mode/swift.js'), 'swift') },
  { id: 'dart', label: 'Dart', mono: 'dart', ext: ['dart'], stream: legacy(() => import('@codemirror/legacy-modes/mode/clike.js'), 'dart') },
  { id: 'scala', label: 'Scala', mono: 'scala', ext: ['scala', 'sc'], stream: legacy(() => import('@codemirror/legacy-modes/mode/clike.js'), 'scala') },

  { id: 'shell', label: 'Shell', mono: 'shell', ext: ['sh', 'bash', 'zsh', 'ksh', 'fish'], stream: legacy(() => import('@codemirror/legacy-modes/mode/shell.js'), 'shell') },
  { id: 'powershell', label: 'PowerShell', mono: 'powershell', ext: ['ps1', 'psm1', 'psd1'], stream: legacy(() => import('@codemirror/legacy-modes/mode/powershell.js'), 'powerShell') },
  { id: 'sql', label: 'SQL', mono: 'sql', ext: ['sql', 'ddl'], cm: () => sql() },
  { id: 'html', label: 'HTML', mono: 'html', ext: ['html', 'htm', 'xhtml', 'vue', 'svelte', 'astro'], cm: () => html() },
  { id: 'css', label: 'CSS', mono: 'css', ext: ['css'], cm: () => css() },
  { id: 'scss', label: 'SCSS', mono: 'scss', ext: ['scss'], stream: legacy(() => import('@codemirror/legacy-modes/mode/css.js'), 'sCSS') },
  { id: 'sass', label: 'Sass', mono: 'scss', ext: ['sass'], stream: legacy(() => import('@codemirror/legacy-modes/mode/sass.js'), 'sass') },
  { id: 'less', label: 'Less', mono: 'less', ext: ['less'], stream: legacy(() => import('@codemirror/legacy-modes/mode/css.js'), 'less') },

  { id: 'json', label: 'JSON', mono: 'json', ext: ['json', 'jsonc', 'json5', 'har', 'webmanifest'], cm: () => json() },
  { id: 'yaml', label: 'YAML', mono: 'yaml', ext: ['yml', 'yaml'], cm: () => yaml() },
  { id: 'toml', label: 'TOML', mono: null, ext: ['toml'], stream: legacy(() => import('@codemirror/legacy-modes/mode/toml.js'), 'toml') },
  { id: 'xml', label: 'XML', mono: 'xml', ext: ['xml', 'svg', 'plist', 'xsd', 'xsl', 'xslt', 'wsdl', 'rss', 'atom'], cm: () => xml() },
  { id: 'markdown', label: 'Markdown', mono: 'markdown', ext: ['md', 'markdown', 'mdx', 'mdown'], cm: () => markdown() },

  { id: 'dockerfile', label: 'Dockerfile', mono: 'dockerfile', ext: ['dockerfile'], files: ['dockerfile', 'containerfile'], stream: legacy(() => import('@codemirror/legacy-modes/mode/dockerfile.js'), 'dockerFile') },
  { id: 'cmake', label: 'CMake', mono: null, ext: ['cmake'], files: ['cmakelists.txt'], stream: legacy(() => import('@codemirror/legacy-modes/mode/cmake.js'), 'cmake') },
  { id: 'nginx', label: 'Nginx', mono: null, ext: [], files: ['nginx.conf'], stream: legacy(() => import('@codemirror/legacy-modes/mode/nginx.js'), 'nginx') },
  { id: 'ini', label: 'INI / Properties', mono: 'ini', ext: ['ini', 'cfg', 'conf', 'properties', 'editorconfig'], stream: legacy(() => import('@codemirror/legacy-modes/mode/properties.js'), 'properties') },
  { id: 'protobuf', label: 'Protocol Buffers', mono: 'proto', ext: ['proto'], stream: legacy(() => import('@codemirror/legacy-modes/mode/protobuf.js'), 'protobuf') },
  { id: 'graphql', label: 'GraphQL', mono: 'graphql', ext: ['graphql', 'gql', 'graphqls'] },
  { id: 'hcl', label: 'HCL / Terraform', mono: 'hcl', ext: ['hcl', 'tf', 'tfvars', 'nomad'] },

  { id: 'objective-c', label: 'Objective-C', mono: 'objective-c', ext: ['m', 'mm'], stream: legacy(() => import('@codemirror/legacy-modes/mode/clike.js'), 'objectiveC') },
  { id: 'r', label: 'R', mono: 'r', ext: ['r'], stream: legacy(() => import('@codemirror/legacy-modes/mode/r.js'), 'r') },
  { id: 'julia', label: 'Julia', mono: 'julia', ext: ['jl'], stream: legacy(() => import('@codemirror/legacy-modes/mode/julia.js'), 'julia') },
  { id: 'perl', label: 'Perl', mono: 'perl', ext: ['pl', 'pm', 't', 'pod'], stream: legacy(() => import('@codemirror/legacy-modes/mode/perl.js'), 'perl') },
  { id: 'lua', label: 'Lua', mono: 'lua', ext: ['lua'], stream: legacy(() => import('@codemirror/legacy-modes/mode/lua.js'), 'lua') },
  { id: 'haskell', label: 'Haskell', mono: null, ext: ['hs', 'lhs', 'hsc'], stream: legacy(() => import('@codemirror/legacy-modes/mode/haskell.js'), 'haskell') },

  { id: 'elixir', label: 'Elixir', mono: 'elixir', ext: ['ex', 'exs', 'eex', 'heex'] },
  { id: 'erlang', label: 'Erlang', mono: null, ext: ['erl', 'hrl', 'escript'], stream: legacy(() => import('@codemirror/legacy-modes/mode/erlang.js'), 'erlang') },
  { id: 'clojure', label: 'Clojure', mono: 'clojure', ext: ['clj', 'cljs', 'cljc', 'edn'], stream: legacy(() => import('@codemirror/legacy-modes/mode/clojure.js'), 'clojure') },
  { id: 'fsharp', label: 'F#', mono: 'fsharp', ext: ['fs', 'fsi', 'fsx', 'fsscript'], stream: legacy(() => import('@codemirror/legacy-modes/mode/mllike.js'), 'fSharp') },
  { id: 'ocaml', label: 'OCaml', mono: null, ext: ['ml', 'mli', 'mll', 'mly'], stream: legacy(() => import('@codemirror/legacy-modes/mode/mllike.js'), 'oCaml') },
  { id: 'sml', label: 'Standard ML', mono: null, ext: ['sml', 'sig', 'fun'], stream: legacy(() => import('@codemirror/legacy-modes/mode/mllike.js'), 'sml') },
  { id: 'vb', label: 'Visual Basic', mono: 'vb', ext: ['vb'], stream: legacy(() => import('@codemirror/legacy-modes/mode/vb.js'), 'vb') },
  { id: 'pascal', label: 'Pascal', mono: 'pascal', ext: ['pas', 'pp', 'dpr', 'lpr'], stream: legacy(() => import('@codemirror/legacy-modes/mode/pascal.js'), 'pascal') },
  { id: 'groovy', label: 'Groovy', mono: null, ext: ['groovy', 'gradle', 'gvy'], stream: legacy(() => import('@codemirror/legacy-modes/mode/groovy.js'), 'groovy') },
  { id: 'solidity', label: 'Solidity', mono: 'sol', ext: ['sol'] },
  { id: 'gas', label: 'Assembly (GAS)', mono: null, ext: ['s', 'asm'], stream: legacy(() => import('@codemirror/legacy-modes/mode/gas.js'), 'gas') },

  { id: 'verilog', label: 'Verilog', mono: 'verilog', ext: ['v', 'vh'], stream: legacy(() => import('@codemirror/legacy-modes/mode/verilog.js'), 'verilog') },
  { id: 'vhdl', label: 'VHDL', mono: null, ext: ['vhd', 'vhdl'], stream: legacy(() => import('@codemirror/legacy-modes/mode/vhdl.js'), 'vhdl') },
  { id: 'systemverilog', label: 'SystemVerilog', mono: 'systemverilog', ext: ['sv', 'svh'] },
  { id: 'cobol', label: 'COBOL', mono: null, ext: ['cob', 'cbl', 'cpy', 'cobol'], stream: legacy(() => import('@codemirror/legacy-modes/mode/cobol.js'), 'cobol') },
  { id: 'fortran', label: 'Fortran', mono: null, ext: ['f', 'for', 'f77', 'f90', 'f95', 'f03', 'f08'], stream: legacy(() => import('@codemirror/legacy-modes/mode/fortran.js'), 'fortran') },

  { id: 'scheme', label: 'Scheme', mono: 'scheme', ext: ['scm', 'ss', 'sld', 'sls'], stream: legacy(() => import('@codemirror/legacy-modes/mode/scheme.js'), 'scheme') },
  { id: 'commonlisp', label: 'Common Lisp', mono: null, ext: ['lisp', 'lsp', 'cl', 'el'], stream: legacy(() => import('@codemirror/legacy-modes/mode/commonlisp.js'), 'commonLisp') },
  { id: 'crystal', label: 'Crystal', mono: null, ext: ['cr'], stream: legacy(() => import('@codemirror/legacy-modes/mode/crystal.js'), 'crystal') },
  { id: 'wast', label: 'WebAssembly', mono: null, ext: ['wat', 'wast'], stream: legacy(() => import('@codemirror/legacy-modes/mode/wast.js'), 'wast') },
  { id: 'tcl', label: 'Tcl', mono: 'tcl', ext: ['tcl', 'tm'], stream: legacy(() => import('@codemirror/legacy-modes/mode/tcl.js'), 'tcl') },
  { id: 'coffee', label: 'CoffeeScript', mono: 'coffeescript', ext: ['coffee', 'litcoffee'], stream: legacy(() => import('@codemirror/legacy-modes/mode/coffeescript.js'), 'coffeeScript') },

  { id: 'handlebars', label: 'Handlebars', mono: 'handlebars', ext: ['hbs', 'handlebars', 'mustache'] },
  { id: 'twig', label: 'Twig', mono: 'twig', ext: ['twig'] },
  { id: 'pug', label: 'Pug', mono: 'pug', ext: ['pug', 'jade'], stream: legacy(() => import('@codemirror/legacy-modes/mode/pug.js'), 'pug') },
  { id: 'liquid', label: 'Liquid', mono: 'liquid', ext: ['liquid'] },
  { id: 'razor', label: 'Razor', mono: 'razor', ext: ['cshtml', 'razor'] },

  { id: 'diff', label: 'Diff', mono: null, ext: ['diff', 'patch'], stream: legacy(() => import('@codemirror/legacy-modes/mode/diff.js'), 'diff') },
  { id: 'http', label: 'HTTP', mono: null, ext: ['http', 'rest'], stream: legacy(() => import('@codemirror/legacy-modes/mode/http.js'), 'http') },
  { id: 'cypher', label: 'Cypher', mono: 'cypher', ext: ['cypher', 'cql'], stream: legacy(() => import('@codemirror/legacy-modes/mode/cypher.js'), 'cypher') },
  { id: 'sparql', label: 'SPARQL', mono: 'sparql', ext: ['rq', 'sparql'], stream: legacy(() => import('@codemirror/legacy-modes/mode/sparql.js'), 'sparql') },
  { id: 'turtle', label: 'Turtle', mono: null, ext: ['ttl'], stream: legacy(() => import('@codemirror/legacy-modes/mode/turtle.js'), 'turtle') },
  { id: 'ntriples', label: 'N-Triples', mono: null, ext: ['nt'], stream: legacy(() => import('@codemirror/legacy-modes/mode/ntriples.js'), 'ntriples') },

  { id: 'd', label: 'D', mono: null, ext: ['d', 'di'], stream: legacy(() => import('@codemirror/legacy-modes/mode/d.js'), 'd') },
  { id: 'elm', label: 'Elm', mono: null, ext: ['elm'], stream: legacy(() => import('@codemirror/legacy-modes/mode/elm.js'), 'elm') },
  { id: 'haxe', label: 'Haxe', mono: null, ext: ['hx'], stream: legacy(() => import('@codemirror/legacy-modes/mode/haxe.js'), 'haxe') },
  { id: 'livescript', label: 'LiveScript', mono: null, ext: ['ls'], stream: legacy(() => import('@codemirror/legacy-modes/mode/livescript.js'), 'liveScript') },
  { id: 'eiffel', label: 'Eiffel', mono: null, ext: ['e'], stream: legacy(() => import('@codemirror/legacy-modes/mode/eiffel.js'), 'eiffel') },
  { id: 'dylan', label: 'Dylan', mono: null, ext: ['dylan', 'dyl', 'intr'], stream: legacy(() => import('@codemirror/legacy-modes/mode/dylan.js'), 'dylan') },
  { id: 'factor', label: 'Factor', mono: null, ext: ['factor'], stream: legacy(() => import('@codemirror/legacy-modes/mode/factor.js'), 'factor') },
  { id: 'forth', label: 'Forth', mono: null, ext: ['fth', '4th', 'forth', 'frt'], stream: legacy(() => import('@codemirror/legacy-modes/mode/forth.js'), 'forth') },
  { id: 'modelica', label: 'Modelica', mono: null, ext: ['mo'], stream: legacy(() => import('@codemirror/legacy-modes/mode/modelica.js'), 'modelica') },
  { id: 'q', label: 'Q', mono: null, ext: ['q'], stream: legacy(() => import('@codemirror/legacy-modes/mode/q.js'), 'q') },
  { id: 'sas', label: 'SAS', mono: null, ext: ['sas'], stream: legacy(() => import('@codemirror/legacy-modes/mode/sas.js'), 'sas') },

  { id: 'stex', label: 'LaTeX', mono: null, ext: ['tex', 'latex', 'sty', 'cls', 'dtx', 'ins', 'bib'], stream: legacy(() => import('@codemirror/legacy-modes/mode/stex.js'), 'stex') },
  { id: 'troff', label: 'Troff', mono: null, ext: ['roff', 'troff', 'man', 'ms', 'me'], stream: legacy(() => import('@codemirror/legacy-modes/mode/troff.js'), 'troff') },
  { id: 'ttcn', label: 'TTCN-3', mono: null, ext: ['ttcn', 'ttcn3'], stream: legacy(() => import('@codemirror/legacy-modes/mode/ttcn.js'), 'ttcn') },
  { id: 'velocity', label: 'Velocity', mono: null, ext: ['vm', 'vtl', 'vsl'], stream: legacy(() => import('@codemirror/legacy-modes/mode/velocity.js'), 'velocity') },
  { id: 'xquery', label: 'XQuery', mono: null, ext: ['xq', 'xquery', 'xqy', 'xqm'], stream: legacy(() => import('@codemirror/legacy-modes/mode/xquery.js'), 'xQuery') },
  { id: 'z80', label: 'Z80 Assembly', mono: null, ext: ['z80'], stream: legacy(() => import('@codemirror/legacy-modes/mode/z80.js'), 'z80') },
  { id: 'apl', label: 'APL', mono: null, ext: ['apl', 'dyalog'], stream: legacy(() => import('@codemirror/legacy-modes/mode/apl.js'), 'apl') },
  // .m 优先给 Objective-C，MATLAB 只能在语言菜单里手选
  { id: 'matlab', label: 'MATLAB', mono: null, ext: [], stream: legacy(() => import('@codemirror/legacy-modes/mode/octave.js'), 'octave') },

  { id: 'jinja2', label: 'Jinja2', mono: null, ext: ['j2', 'jinja', 'jinja2'], stream: legacy(() => import('@codemirror/legacy-modes/mode/jinja2.js'), 'jinja2') },
  { id: 'gherkin', label: 'Gherkin', mono: null, ext: ['feature'], stream: legacy(() => import('@codemirror/legacy-modes/mode/gherkin.js'), 'gherkin') },
  { id: 'puppet', label: 'Puppet', mono: null, ext: ['puppet'], stream: legacy(() => import('@codemirror/legacy-modes/mode/puppet.js'), 'puppet') },
  { id: 'vbscript', label: 'VBScript', mono: null, ext: ['vbs'], stream: legacy(() => import('@codemirror/legacy-modes/mode/vbscript.js'), 'vbScript') },
  { id: 'dtd', label: 'DTD', mono: null, ext: ['dtd'], stream: legacy(() => import('@codemirror/legacy-modes/mode/dtd.js'), 'dtd') },

  { id: 'restructuredtext', label: 'reStructuredText', mono: 'restructuredtext', ext: ['rst', 'rest'] },
  { id: 'abap', label: 'ABAP', mono: 'abap', ext: ['abap'] },
  { id: 'apex', label: 'Apex', mono: 'apex', ext: ['trigger'] },
  { id: 'bicep', label: 'Bicep', mono: 'bicep', ext: ['bicep'] },
  { id: 'azcli', label: 'Azure CLI', mono: 'azcli', ext: ['azcli'] },
  { id: 'mips', label: 'MIPS Assembly', mono: 'mips', ext: ['mips'] },
  { id: 'msdax', label: 'DAX', mono: 'msdax', ext: ['dax'] },
  { id: 'powerquery', label: 'Power Query', mono: 'powerquery', ext: ['pq', 'pquery'] },
  { id: 'qsharp', label: 'Q#', mono: 'qsharp', ext: ['qs'] },
  { id: 'freemarker2', label: 'FreeMarker', mono: 'freemarker2', ext: ['ftl', 'ftlh', 'ftlx'] },
  { id: 'wgsl', label: 'WGSL', mono: 'wgsl', ext: ['wgsl'] },
] as const satisfies readonly LangDef[]

export type LangId = (typeof LANG_LIST)[number]['id']

const BY_ID = new Map<string, LangDef>(LANG_LIST.map((d) => [d.id, d as LangDef]))

const BY_EXT = new Map<string, LangId>()
const BY_FILE = new Map<string, LangId>()
for (const def of LANG_LIST) {
  for (const ext of def.ext) BY_EXT.set(ext, def.id)
  for (const file of (def as LangDef).files ?? []) BY_FILE.set(file, def.id)
}

export const ALL_LANGS: LangId[] = LANG_LIST.map((d) => d.id)

/**
 * 语言菜单的搜索别名（只参与筛选，不参与显示）。
 * 菜单标签是英文的，但用中文找「汇编」「数据库」「容器」这类词也该能命中。
 */
const LANG_ALT_ZH: Partial<Record<LangId, string>> = {
  javascript: '脚本 js',
  typescript: '类型脚本 ts',
  python: '蟒蛇 py',
  java: '爪哇',
  cpp: 'c语言 指针 c++',
  csharp: 'c井 点net',
  php: '网页后端',
  go: 'golang 高',
  rust: '锈',
  ruby: '红宝石',
  kotlin: '安卓',
  swift: '雨燕 苹果',
  dart: '镖 flutter',
  shell: '命令行 终端 脚本',
  powershell: '命令行 终端',
  sql: '数据库 查询',
  html: '网页',
  css: '样式',
  scss: '样式',
  sass: '样式',
  less: '样式',
  json: '配置',
  yaml: '配置',
  toml: '配置',
  ini: '配置 属性',
  markdown: '文档 笔记',
  dockerfile: '容器 镜像',
  cmake: '构建',
  nginx: '服务器 反向代理',
  protobuf: '序列化',
  graphql: '查询',
  matlab: '矩阵实验室',
  gas: '汇编 汇编语言 反汇编',
  mips: '汇编 汇编语言',
  z80: '汇编 汇编语言',
  verilog: '硬件描述',
  vhdl: '硬件描述',
  systemverilog: '硬件描述',
  stex: '排版 论文',
  troff: '手册 排版',
  diff: '差异 补丁',
  gherkin: '行为 用例',
  logcat: '日志 安卓日志',
  restructuredtext: '文档',
  text: '纯文本 无语法',
}

export const LANG_LABELS = Object.fromEntries(LANG_LIST.map((d) => [d.id, d.label])) as Record<
  LangId,
  string
>

/** 语言菜单的匹配串：英文名 + id + 中文别名，全部小写 */
export function langKeywords(id: LangId): string {
  return `${LANG_LABELS[id] ?? ''} ${id} ${LANG_ALT_ZH[id] ?? ''}`.toLowerCase()
}

export function langFromName(name: string): LangId {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? ''
  const byFile = BY_FILE.get(base)
  if (byFile) return byFile
  const dot = base.lastIndexOf('.')
  const ext = dot >= 0 ? base.slice(dot + 1) : ''
  return BY_EXT.get(ext) ?? 'text'
}

/** 同步可得的高亮扩展；null 表示要等异步模式（或该语言没有） */
export function cmLanguageSync(id: LangId): Extension | null {
  return BY_ID.get(id)?.cm?.() ?? null
}

/** 完整的 CodeMirror 扩展：lezer 直接用，stream 模式按需加载 */
export async function cmLanguageAsync(id: LangId): Promise<Extension | null> {
  const def = BY_ID.get(id)
  if (!def) return null
  if (def.cm) return def.cm()
  if (!def.stream) return null
  return StreamLanguage.define(await def.stream())
}

export function monacoLanguage(id: LangId): string {
  return BY_ID.get(id)?.mono ?? 'plaintext'
}

/** 当前引擎能不能给这个语言上色，状态栏据此决定显示「高亮」还是「无语法」 */
export function cmSupports(id: LangId): boolean {
  if (id === 'text' || id === 'logcat') return true
  const def = BY_ID.get(id)
  return Boolean(def?.cm ?? def?.stream)
}

export function monoSupports(id: LangId): boolean {
  if (id === 'text' || id === 'logcat') return true
  return BY_ID.get(id)?.mono != null
}
