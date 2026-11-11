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
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NM = path.join(ROOT, 'node_modules')
const VENDOR = path.join(ROOT, 'vendor')
const MANIFEST = path.join(VENDOR, 'VERSIONS.json')

/** 引擎根包；其余包沿 dependencies 递归收集（不限前缀，间接依赖同样不能留在 registry） */
const ROOTS = ['codemirror', 'monaco-editor', 'style-mod', 'w3c-keyname', 'crelt']
const SCOPES = ['@codemirror/', '@lezer/', '@marijn/']
const isEngine = (name) => ROOTS.includes(name) || SCOPES.some((s) => name.startsWith(s))

/** Monaco 只保留运行时用到的 esm；dev/min/min-maps 是给 <script> 用的全量包 */
const MONACO_KEEP = ['package.json', 'LICENSE', 'ThirdPartyNotices.txt']

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

  return found
}

/** 把 range 解析成具体版本，用于补全清单里尚未登记的间接依赖 */
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

    const pkgDir = path.join(dir, 'package')
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

  await cp(from, to, {
    recursive: true,
    // 包内嵌套的 node_modules 不属于源码；只按包内相对路径判断
    filter: (src) => !path.relative(from, src).split(path.sep).includes('node_modules'),
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
    // 依赖闭包必须自洽：缺一个就会在构建时回落到 node_modules 或直接报错
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!names.has(dep)) problems.push(`${name}: 依赖 ${dep} 未纳入清单`)
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
    await rm(VENDOR, { recursive: true, force: true })

    const versions = {}
    for (const [name, info] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
      await copyPackage(name, info.dir)
      versions[name] = info.version
    }

    await writeFile(
      MANIFEST,
      JSON.stringify(
        {
          note: '由 npm run vendor / vendor:pull 生成，请勿手改；升级见 scripts/vendor-engines.mjs 顶部说明',
          packages: versions,
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
