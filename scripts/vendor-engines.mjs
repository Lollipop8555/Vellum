/**
 * 把 CodeMirror / Monaco 及其传递依赖的源码固定到 vendor/。
 *
 * 构建与类型检查都只读 vendor/，不读 node_modules，
 * 因此引擎代码只有在显式运行本脚本后才会变化。
 *
 *   npm run vendor          从 node_modules 同步（已装依赖时最快）
 *   npm run vendor:pull     按 vendor/VERSIONS.json 的版本从 registry 重新拉取
 *   npm run vendor:check    离线校验 vendor 完整性，CI 使用
 *
 * 升级流程：
 *   1. 改 vendor/VERSIONS.json 中对应包的版本
 *   2. npm run vendor:pull
 *   3. 跑一遍构建与人工验收，然后提交 vendor/ 变更
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectCjsImports, collectSubpaths } from './vendor-manifest.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NM = path.join(ROOT, 'node_modules')
const VENDOR = path.join(ROOT, 'vendor')
const MANIFEST = path.join(VENDOR, 'VERSIONS.json')
const SRC = path.join(ROOT, 'src')

/** 引擎根包；其余包沿 dependencies 递归收集（不限前缀，间接依赖同样不能留在 registry） */
const ROOTS = [
  // 编辑器引擎
  'codemirror',
  'monaco-editor',
  'style-mod',
  'w3c-keyname',
  'crelt',
  // 渲染引擎：Markdown 预览的 remark/rehype 管线 + 高亮 + 公式 + 图表
  'unified',
  'remark-parse',
  'remark-gfm',
  'remark-math',
  'remark-frontmatter',
  'remark-directive',
  'remark-rehype',
  'remark-cjk-friendly',
  'rehype-raw',
  'rehype-sanitize',
  'rehype-slug',
  'rehype-autolink-headings',
  'rehype-highlight',
  'rehype-stringify',
  'katex',
  'lowlight',
  'highlight.js',
  'mermaid',
  '@viz-js/viz',
]
const SCOPES = ['@codemirror/', '@lezer/', '@marijn/']
const isEngine = (name) => ROOTS.includes(name) || SCOPES.some((s) => name.startsWith(s))

/** Monaco 只保留运行时用到的 esm；dev/min/min-maps 是给 <script> 用的全量包 */
const MONACO_KEEP = ['package.json', 'LICENSE', 'ThirdPartyNotices.txt']

/**
 * 大包的裁剪规则：(相对路径, 是否目录) => 是否保留。
 * 目录必须返回 true，否则子树里的文件没机会被逐个判断。
 *
 * - mermaid: dist 有 122MB 且含 core / esm / esm.min 三套；
 *   入口是 mermaid.core.mjs，其余两套与 map/docs 全部丢弃。
 * - katex: fonts 每套 ttf/woff/woff2 三份，而 katex.min.css 只引用 woff2。
 * - highlight.js: 入口是 es/，lib/ 是 CJS 副本，styles/ 由项目自己的 CSS 接管。
 */
const MERMAID_DENY_DIRS = new Set([
  'dist/chunks/mermaid.esm',
  'dist/chunks/mermaid.esm.min',
  'dist/docs',
  'dist/__mocks__',
])

const KEEP_RULES = {
  mermaid: (rel, isDir) => {
    if (isDir) return !MERMAID_DENY_DIRS.has(rel)
    return (
      rel === 'package.json' ||
      rel === 'LICENSE' ||
      rel === 'dist/mermaid.core.mjs' ||
      rel.startsWith('dist/chunks/mermaid.core/') ||
      rel.endsWith('.d.ts')
    )
  },
  katex: (rel, isDir) => {
    // 字体三种格式都要留：katex.min.css 同时声明 woff2/woff/ttf，
    // 少一个就是构建期的未解析告警加运行期 404
    if (isDir) return rel === 'dist' || rel === 'dist/fonts'
    return (
      rel === 'package.json' ||
      rel === 'LICENSE' ||
      rel === 'dist/katex.mjs' ||
      rel === 'dist/katex.min.css' ||
      rel.startsWith('dist/fonts/')
    )
  },
  /**
   * @viz-js/viz：DOT 渲染。
   * 实测 5.7MB，但真正的运行时只有一个文件——`dist/viz.js` 把 WASM 以字节数组
   * 内联在 JS 里（包里没有独立 .wasm），而 `lib/backend.js`、`dist/viz.cjs`、
   * `dist/viz-global.js` 是三份内容相同的另发行形式。只留 ESM 那份 + 类型声明。
   */
  '@viz-js/viz': (rel, isDir) => {
    if (isDir) return true
    return rel === 'package.json' || rel === 'dist/viz.js' || rel.startsWith('types/')
  },
  'highlight.js': (rel, isDir) => {
    // lowlight 用 highlight.js/lib/core 与 lib/languages/*。
    // lib/ 是完整可用的 CJS 版本，必须整棵保留（core/common 还是 CJS 入口）；
    // es/languages/ 是语言表的 ESM 实现，供 subpaths 改道用（见 vendor-manifest.mjs），
    // 而 es/core.js、es/common.js 只是 re-export lib/ 的壳子，没必要留。
    if (isDir) {
      return (
        rel === 'lib' ||
        rel === 'types' ||
        rel === 'es' ||
        rel === 'es/languages' ||
        rel.startsWith('lib/') ||
        rel.startsWith('types/') ||
        rel.startsWith('es/languages/')
      )
    }
    return (
      rel === 'package.json' ||
      rel === 'LICENSE' ||
      rel.startsWith('lib/') ||
      rel.startsWith('types/') ||
      rel.startsWith('es/languages/')
    )
  },
}

/** 所有包通用排除：source map 与明显的非运行时代码（demo 目录曾占满 cytoscape-fcose 的 8.2MB） */
const NON_RUNTIME_DIRS = new Set([
  'demo',
  'demos',
  'examples',
  'docs',
  'test',
  'tests',
  '__tests__',
  'playwright-tests',
  'benchmark',
  'coverage',
  '.github',
])

const isJunk = (rel) => {
  if (rel.endsWith('.map')) return true
  return NON_RUNTIME_DIRS.has(rel.split('/')[0])
}

/** 裁剪后的必检文件：裁错一个就会在运行期直接报模块找不到 */
const REQUIRED_FILES = {
  mermaid: ['dist/mermaid.core.mjs'],
  katex: ['dist/katex.mjs', 'dist/katex.min.css'],
  'highlight.js': ['lib/core.js', 'lib/common.js', 'lib/languages/groovy.js', 'lib/languages/kotlin.js'],
  '@viz-js/viz': ['dist/viz.js', 'types/index.d.ts'],
}

const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--pull')
    ? 'pull'
    : 'sync'

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

/* ------------------------------------------------------------ 收集 */

async function collectFromNodeModules() {
  const found = new Map()

  async function add(name) {
    if (found.has(name)) return
    const dir = path.join(NM, name)
    const pkgFile = path.join(dir, 'package.json')
    if (!existsSync(pkgFile)) throw new Error(`node_modules 中缺少 ${name}`)
    const pkg = await readJson(pkgFile)
    found.set(name, { version: pkg.version, dir })
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      await add(dep)
    }
  }

  for (const entry of await readdir(NM, { withFileTypes: true })) {
    if (entry.isDirectory() && isEngine(entry.name)) {
      await add(entry.name)
    } else if (entry.isDirectory() && entry.name.startsWith('@')) {
      for (const child of await readdir(path.join(NM, entry.name), { withFileTypes: true })) {
        const name = `${entry.name}/${child.name}`
        if (child.isDirectory() && isEngine(name)) await add(name)
      }
    }
  }

  // 扁平化提示：嵌套 node_modules 说明某依赖的版本区间与顶层不一致，
  // 复制到 vendor 后会按顶层版本解析。这里只警告不阻断——
  // 多数情况是 CLI 依赖（commander）或类型包，真正影响渲染的需要人工确认。
  const nested = []
  for (const [name, info] of found) {
    const nestedDir = path.join(info.dir, 'node_modules')
    if (!existsSync(nestedDir)) continue
    const entries = (await readdir(nestedDir, { withFileTypes: true }))
      // npm 会留下 .bin 与 .pkg-XXXX 形式的临时目录，不是真实依赖
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '@types')
    if (entries.length) nested.push(`${name} → ${entries.map((e) => e.name).join(', ')}`)
  }
  if (nested.length) {
    console.warn(
      '注意：以下包带有嵌套依赖，vendor 里会按顶层版本解析，请确认不影响运行：\n  ' +
        nested.join('\n  '),
    )
  }

  return found
}
function resolveRange(name, range) {
  const out = execFileSync('npm', ['view', `${name}@${range || 'latest'}`, 'version', '--json'], {
    encoding: 'utf8',
  }).trim()
  const parsed = JSON.parse(out)
  return Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed
}

/** 按清单版本逐个 npm pack，并递归补全依赖树，返回 {version, dir} */
async function collectFromManifest() {
  const manifest = await readJson(MANIFEST)
  const work = await mkdtemp(path.join(tmpdir(), 'vellum-vendor-'))
  const versions = new Map(Object.entries(manifest.packages))
  const found = new Map()
  const queue = [...versions.keys()]

  while (queue.length) {
    const name = queue.shift()
    const version = versions.get(name)
    const before = new Set(await readdir(work))
    execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', work], {
      stdio: 'ignore',
    })
    const tgz = (await readdir(work)).find((f) => f.endsWith('.tgz') && !before.has(f))
    if (!tgz) throw new Error(`npm pack ${name}@${version} 未产出 tarball`)

    const dir = path.join(work, 'x', name.replace('/', '__'))
    await mkdir(dir, { recursive: true })
    execFileSync('tar', ['-xzf', path.join(work, tgz), '-C', dir])

    // tarball 的顶层目录不一定叫 package/：绝大多数是，但老一些的 @types/* 用包名本身。
    // 先把实际落地的那一层找出来，别假设（@types/d3 就是这么炸的）。
    const unpacked = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory())
    const root = unpacked.find((e) => e.name === 'package') ?? unpacked[0]
    if (!root) throw new Error(`npm pack ${name}@${version} 解开后是空的`)
    const pkgDir = path.join(dir, root.name)
    if (!existsSync(path.join(pkgDir, 'package.json'))) {
      throw new Error(`${name}@${version} 解包目录 ${pkgDir} 下没有 package.json`)
    }
    found.set(name, { version, dir: pkgDir })

    const pkg = await readJson(path.join(pkgDir, 'package.json'))
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (versions.has(dep)) continue
      const resolved = resolveRange(dep, range)
      versions.set(dep, resolved)
      queue.push(dep)
      console.log(`  + ${dep}@${resolved}（${name} 的依赖）`)
    }
  }

  return { found, cleanup: () => rm(work, { recursive: true, force: true }) }
}

/* ------------------------------------------------------------ 写入 */

/**
 * monaco 的 esm 里没有 .map（14 个 map 全在 dev/ 下），但 marked.js 末尾留了一行
 * 指向 marked.umd.js.map 的注释，dev server 启动时会报一次读不到 map。
 * 只删这一行注释，其余字节保持与上游一致。
 */
async function stripDanglingSourcemap(dir) {
  const file = path.join(dir, 'esm/vs/base/common/marked/marked.js')
  if (!existsSync(file)) return
  const code = await readFile(file, 'utf8')
  const cleaned = code.replace(/^\/\/# sourceMappingURL=marked\.umd\.js\.map[ \t]*\r?\n?/m, '')
  if (cleaned !== code) await writeFile(file, cleaned)
}

async function copyPackage(name, from) {
  const to = path.join(VENDOR, name)

  if (name === 'monaco-editor') {
    for (const file of MONACO_KEEP) {
      const src = path.join(from, file)
      if (existsSync(src)) await cp(src, path.join(to, file))
    }
    await cp(path.join(from, 'esm'), path.join(to, 'esm'), { recursive: true })
    await stripDanglingSourcemap(to)
    return
  }

  const keep = KEEP_RULES[name]
  if (keep) {
    await cp(from, to, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(from, src).split(path.sep).join('/')
        if (!rel) return true
        if (rel.split('/').includes('node_modules')) return false
        if (isJunk(rel)) return false
        return keep(rel, statSync(src).isDirectory())
      },
    })
    return
  }

  await cp(from, to, {
    recursive: true,
    // 包内嵌套的 node_modules 不属于源码；只按包内相对路径判断
    filter: (src) => {
      const parts = path.relative(from, src).split(path.sep)
      if (!parts.join('')) return true
      if (parts.includes('node_modules')) return false
      return !isJunk(parts.join('/'))
    },
  })
}

async function walkSize(dir) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? await walkSize(full) : (await stat(full)).size
  }
  return total
}

/* ------------------------------------------------------------ 校验 */

/** vendor 下的实际包目录（含 @scope 子目录） */
async function listVendorPackages() {
  const actual = new Set()
  for (const entry of await readdir(VENDOR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(VENDOR, entry.name)
      for (const child of await readdir(scopeDir, { withFileTypes: true })) {
        if (child.isDirectory()) actual.add(`${entry.name}/${child.name}`)
      }
    } else {
      actual.add(entry.name)
    }
  }
  return actual
}

async function check() {
  if (!existsSync(MANIFEST)) {
    console.error('缺少 vendor/VERSIONS.json，请先运行 npm run vendor')
    process.exit(1)
  }
  const manifest = await readJson(MANIFEST)
  const names = new Set(Object.keys(manifest.packages))
  const problems = []

  for (const [name, version] of Object.entries(manifest.packages)) {
    const dir = path.join(VENDOR, name)
    const pkgFile = path.join(dir, 'package.json')
    if (!existsSync(pkgFile)) {
      problems.push(`${name}: 缺少目录或 package.json`)
      continue
    }
    const pkg = await readJson(pkgFile)
    if (pkg.version !== version) problems.push(`${name}: 清单 ${version} / 实际 ${pkg.version}`)
    if (name === 'monaco-editor') {
      if (!existsSync(path.join(dir, 'esm/vs/editor/editor.api.js'))) {
        problems.push('monaco-editor: 缺少 esm 运行时')
      }
      const marked = path.join(dir, 'esm/vs/base/common/marked/marked.js')
      if (
        existsSync(marked) &&
        (await readFile(marked, 'utf8')).includes('sourceMappingURL=marked.umd.js.map')
      ) {
        problems.push('monaco-editor: marked.js 仍带悬空 sourceMappingURL，请用 npm run vendor:pull 重新生成')
      }
    }
    for (const file of REQUIRED_FILES[name] ?? []) {
      if (!existsSync(path.join(dir, file))) {
        problems.push(`${name}: 缺少 ${file}（KEEP 规则裁过头或同步未完成）`)
      }
    }
    // 依赖闭包必须自洽：缺一个就会在构建时回落到 node_modules 或直接报错
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!names.has(dep)) problems.push(`${name}: 依赖 ${dep} 未纳入清单`)
    }
    // exports 子路径由 vite alias 直接映射，目标文件被裁掉就会在构建期 ENOENT
    for (const [sub, target] of Object.entries(manifest.subpaths?.[name] ?? {})) {
      const star = target.indexOf('*')
      const head = target.slice(0, star)
      const prefix =
        star === -1 ? target : head.endsWith('/') ? head.slice(0, -1) : path.posix.dirname(head)
      const probe = star === -1 ? target : `${prefix}/`
      if (!existsSync(path.join(dir, probe))) {
        problems.push(`${name}: 子路径 ${sub} 的目标 ${target} 缺失`)
      }
    }
  }

  // 清单之外的残留目录同样算失败，避免旧版本包继续被打进产物
  for (const name of await listVendorPackages()) {
    if (!names.has(name)) problems.push(`${name}: 清单外的目录`)
  }

  if (problems.length) {
    console.error('vendor 校验失败：\n  ' + problems.join('\n  '))
    process.exit(1)
  }
  console.log(`vendor 校验通过：${names.size} 个包`)
}

/* ------------------------------------------------------------ 主流程 */

if (mode === 'check') {
  await check()
} else {
  const source = mode === 'pull'
    ? await collectFromManifest()
    : { found: await collectFromNodeModules(), cleanup: async () => {} }
  const found = source.found

  // 先确认收全再动 vendor：否则一次空收集会把已提交的源码删光
  const missing = ROOTS.filter((name) => !found.has(name))
  if (!found.size || missing.length) {
    await source.cleanup()
    console.error(
      (missing.length ? `收集失败，缺少 ${missing.join('、')}。` : '未收集到任何包。') +
        (mode === 'pull'
          ? '检查网络与 vendor/VERSIONS.json 中的版本号。'
          : 'node_modules 里没有引擎包：改用 npm run vendor:pull，或先 npm i --no-save 对应版本再同步。'),
    )
    process.exit(1)
  }

  try {
    try {
      await rm(VENDOR, { recursive: true, force: true })
    } catch (error) {
      // 部分 IDE 会对大批量删除做二次确认保护（BULK_CONFIRM），
      // 这类拦截无法在脚本内绕过，交给人工执行一次即可。
      if (String(error?.message ?? error).includes('BULK_CONFIRM')) {
        console.error('无法自动清空 vendor/（安全删除保护拦截）。请手动执行：rm -rf vendor 后重跑。')
        process.exit(1)
      }
      throw error
    }

    const versions = {}
    const subpaths = {}
    for (const [name, info] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
      await copyPackage(name, info.dir)
      versions[name] = info.version
      // 必须按 vendor 里裁剪后的副本判断，node_modules 里的文件是全的，
      // 拿它判断会把「已被裁掉、需要改道」的子路径漏掉
      const map = await collectSubpaths(path.join(VENDOR, name), name)
      if (map) subpaths[name] = map
    }

    // 必须在 copyPackage 之后扫描：裁剪规则决定最终哪些文件还在，
    // dev 预构建清单要按裁剪后的结果算，才不会指向被删掉的入口。
    // src/ 也要一起扫：应用代码直接 import 的裸标识符同样需要预构建。
    const cjs = await collectCjsImports(VENDOR, new Set(Object.keys(versions)), [VENDOR, SRC])

    await writeFile(
      MANIFEST,
      JSON.stringify(
        {
          note: '由 npm run vendor / vendor:pull 生成，请勿手改；升级见 scripts/vendor-engines.mjs 顶部说明',
          packages: versions,
          subpaths,
          cjs,
        },
        null,
        2,
      ) + '\n',
    )

    const bytes = await walkSize(VENDOR)
    console.log(
      `已同步 ${found.size} 个包到 vendor/（${(bytes / 1048576).toFixed(1)} MB）\n` +
        Object.entries(versions)
          .map(([n, v]) => `  ${n}@${v}`)
          .join('\n'),
    )
  } finally {
    await source.cleanup()
  }
}
