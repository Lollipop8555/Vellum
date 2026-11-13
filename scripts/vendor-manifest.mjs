/**
 * 由 vendor 目录推导出构建期需要的两份清单，写进 vendor/VERSIONS.json。
 *
 * 背景：vite 的 alias 只把包名拼成 vendor 路径，既不理解 package.json 的
 * `exports` 条件导出，也不会像 commonjs 插件那样处理 CJS。两个缺口分别对应：
 *
 * - `subpaths`：alias 拼出来的朴素路径不存在、但 exports 给出了真实目标的精确子路径。
 * - `cjs`：vendor 源码里实际被 import 的裸标识符，且解析结果是 CJS 文件。
 *   dev 依赖预构建需要显式列出它们，构建期则由 commonjsOptions 处理。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

/** 浏览器构建下的条件优先级：node 条件必须靠后，否则会拿到 node 专用入口 */
const CONDITION_ORDER = ['import', 'module', 'browser', 'default', 'node', 'require']

/** 与 Vite 一致地做无扩展名探测 */
const RESOLVE_SUFFIXES = ['', '.js', '.mjs', '.json', '/index.js', '/index.mjs']

/** 只认文件：同名目录会让 '' 后缀的探测命中目录 */
const isFile = (file) => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

const resolveIn = (dir, rel) =>
  RESOLVE_SUFFIXES.map((ext) => path.join(dir, rel + ext)).find(isFile)

export function pickExportTarget(value, depth = 0) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || depth > 3) return undefined
  for (const key of CONDITION_ORDER) {
    const found = pickExportTarget(value[key], depth + 1)
    if (found) return found
  }
  return undefined
}

/** UMD/CJS 一定写 module.exports，ESM 一定写 export 语句 */
/**
 * 只认语法特征，不认 package.json 的 type 字段：vendor 里 index.js 混着 CJS 与 ESM。
 *
 * CJS 侧不能只看 `module.exports`：TS 编译产物常用
 * `Object.defineProperty(exports, "__esModule", …)` + `exports.foo = foo`
 * （典型受害者 @braintree/sanitize-url，dev 里会因为「没有 default 导出」整片崩掉）。
 */
const ESM_SYNTAX = /(?:^|[\n;])\s*(?:export\s+(?:default|const|let|var|function|class|async|\{|\*)|import\s+[\w$*{'"])/
const CJS_SYNTAX = /(?:^|[^\w$.])(?:module\.exports\b|exports\.[\w$]|Object\.defineProperty\(\s*exports\b)/

const looksCjs = (code) => CJS_SYNTAX.test(code) && !ESM_SYNTAX.test(code)

const isCjsFile = (file) => {
  try {
    return looksCjs(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

/**
 * 手工补充的改道表。
 *
 * 只用于「exports 目标更适合浏览器、但朴素路径也确实能跑」的情况：生成逻辑按
 * 「朴素路径存在就不改道」处理，这里补上例外。键/值的语义与 subpaths 一致。
 */
const SUBPATH_OVERRIDES = {
  // lowlight 写的是 highlight.js/lib/languages/*，那是 es/languages/* 的 CJS 编译产物。
  // 保留 CJS 的 core/common（构建期只需转换两个文件），语言表改走真正的 ESM 实现，
  // 否则 dev 预构建要为 190 多个语言文件各建一个入口。
  'highlight.js': { './lib/languages/*': 'es/languages/*.js' },
}

/**
 * 收集 alias 拼不出来的 exports 子路径。
 *
 * 判定标准是「朴素路径解析不到 exports 给出的目标」，而不是「朴素路径不存在」：
 * es-toolkit/compat 这类包的朴素路径是个 CJS 桩文件，exports 指的才是 ESM 真身。
 * 通配子路径只比较静态前缀目录，避免把整棵子树展开进清单。
 */
export async function collectSubpaths(dir, name) {
  const pkgFile = path.join(dir, 'package.json')
  if (!existsSync(pkgFile)) return undefined
  const exportsField = JSON.parse(await readFile(pkgFile, 'utf8')).exports
  if (!exportsField || typeof exportsField !== 'object') return undefined

  const map = { ...SUBPATH_OVERRIDES[name] }
  for (const [key, value] of Object.entries(exportsField)) {
    if (!key.startsWith('./')) continue
    const target = pickExportTarget(value)
    if (!target) continue
    const clean = target.replace(/^\.\//, '')
    const star = key.indexOf('*')

    if (star === -1) {
      const naive = resolveIn(dir, key.slice(2))
      const wanted = resolveIn(dir, clean)
      if (!wanted || naive === wanted) continue
      // 朴素路径能解析且也是 ESM 时无需覆盖；指向 CJS 桩才需要改道
      if (naive && !(isCjsFile(naive) && !isCjsFile(wanted))) continue
      map[key] = clean
      continue
    }

    // 通配：'./lib/languages/*' → 'es/languages/*.js'
    const head = key.slice(2, star)
    const tail = key.slice(star + 1)
    const targetStar = clean.indexOf('*')
    if (targetStar === -1) continue
    if (head === '') continue // './*' 恒等映射，包名前缀 alias 已经覆盖
    if (existsSync(path.join(dir, head))) continue // 朴素前缀目录还在，alias 能直接命中
    const targetHead = clean.slice(0, targetStar)
    const targetDir = targetHead.endsWith('/') ? targetHead.slice(0, -1) : path.posix.dirname(targetHead)
    if (targetDir && !existsSync(path.join(dir, targetDir))) continue
    if (tail && !targetHead.endsWith(tail)) continue
    map[key] = clean
  }
  return Object.keys(map).length ? map : undefined
}

const JS_FILE = /\.(?:js|mjs|cjs)$/
const SPECIFIER_RE = [
  /\bfrom\s*["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /^\s*import\s+["']([^"'\n]+)["']/gm,
]

const isBare = (spec) => !/^[./#]/.test(spec) && !spec.includes(':')

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (JS_FILE.test(entry.name)) yield full
  }
}

/**
 * 扫描 vendor 里所有 ESM 源码的裸 import，挑出真正解析到 CJS 文件的那部分。
 * 只收「实际被引用」的标识符，避免把未使用的 CJS 包塞进 dev 预构建
 * （例如 elkjs 的默认入口 main.js 需要没装的 web-worker）。
 */
/**
 * 包根入口解析：exports['.'] → module → main → 无扩展名探测。
 *
 * 不能只靠「无扩展名探测」：`format` 这类老包的入口写在 `main: "format.js"`，
 * 探测会落空，于是它被漏出 CJS 清单，dev 里直接 500。
 */
async function resolveEntry(dir) {
  const pkgFile = path.join(dir, 'package.json')
  if (existsSync(pkgFile)) {
    let pkg
    try {
      pkg = JSON.parse(await readFile(pkgFile, 'utf8'))
    } catch {
      pkg = undefined
    }
    if (pkg) {
      const exported = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.']
      for (const rel of [pickExportTarget(exported), pkg.module, pkg.main].filter(Boolean)) {
        const found = resolveIn(dir, rel.replace(/^\.\//, ''))
        if (found) return found
      }
    }
  }
  return resolveIn(dir, '')
}

export async function collectCjsImports(vendorDir, names, scanDirs = [vendorDir]) {
  const specs = new Set()

  for (const dir of scanDirs) {
    for await (const file of walk(dir)) {
      // .d.ts 里全是 `import type`，不是运行时依赖
      if (file.endsWith('.d.ts')) continue
      let code
      try {
        code = await readFile(file, 'utf8')
      } catch {
        continue
      }
      // 注释里的 `@import {X} from 'y'`（JSDoc 类型标注）会被正则当成真导入，
      // 典型受害者：lowlight 注释里的 `from 'highlight.js'`，
      // 它会把整个 highlight.js 包塞进 CJS 预构建清单，让 dev 直接 EISDIR
      code = code.replace(/\/\*[\s\S]*?\*\//g, ' ')
      if (!/(?:\bfrom\s*["']|\bimport\s*[("'])/.test(code)) continue
      for (const re of SPECIFIER_RE) {
        re.lastIndex = 0
        let match
        while ((match = re.exec(code))) {
          if (isBare(match[1])) specs.add(match[1])
        }
      }
    }
  }

  const subpathCache = new Map()
  const cjs = new Set()

  // 与 vite.config.ts 里的 alias 生成保持同一套匹配：先精确、后通配
  const matchSubpath = (map, sub) => {
    const exact = map[`./${sub}`]
    if (exact) return exact
    const spec = `./${sub}`
    for (const [key, target] of Object.entries(map)) {
      const star = key.indexOf('*')
      if (star === -1) continue
      const head = key.slice(2, star)
      const tail = key.slice(star + 1)
      if (!spec.startsWith(`./${head}`) || !spec.endsWith(tail)) continue
      const matched = spec.slice(2 + head.length, spec.length - tail.length)
      const targetStar = target.indexOf('*')
      return target.slice(0, targetStar) + matched + target.slice(targetStar + 1)
    }
    return undefined
  }

  for (const spec of specs) {
    const parts = spec.split('/')
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    if (!names.has(name)) continue
    const sub = spec.slice(name.length).replace(/^\//, '')

    const dir = path.join(vendorDir, name)
    let resolved
    if (sub) {
      if (!subpathCache.has(name)) subpathCache.set(name, (await collectSubpaths(dir, name)) ?? {})
      const mapped = matchSubpath(subpathCache.get(name), sub)
      resolved = resolveIn(dir, mapped ?? sub)
    } else {
      resolved = await resolveEntry(dir)
    }
    if (!resolved || !JS_FILE.test(resolved)) continue

    if (looksCjs(await readFile(resolved, 'utf8'))) cjs.add(spec)
  }

  return [...cjs].sort()
}
