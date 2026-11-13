/**
 * 生成 dist/sw.js 的预缓存清单（vite build 之后跑）。
 *
 * 为什么要有这一步：Service Worker 在 window.load 之后才注册，页面外壳在那之前就已经
 * 下载完了，如果 install 阶段不主动缓存，第一次访问的缓存永远是空的 —— 断网刷新只会
 * 拿到「离线且没有可用的缓存页面」。
 *
 * 清单来源是 dist/.vite/manifest.json（vite.config.ts 打开 build.manifest）：
 * 从 index.html 直接引用的 chunk 出发，沿**静态** imports / css 走闭包。动态 import 的
 * Monaco 适配层、Prettier 插件、mermaid / graphviz 不进清单，它们首次用到时由
 * CacheFirst 收进 RUNTIME，之后一样能离线。
 *
 * 全部用相对路径（'./assets/x.js'）：sw.js 在部署根目录，相对 URL 由它自己的位置解析，
 * 所以根路径部署和 GitHub Pages 的 /<repo>/ 项目页都不用改这里。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const SW = join(DIST, 'sw.js')
const MANIFEST = join(DIST, '.vite', 'manifest.json')

// 不在 rollup 清单里，但断网打开页面同样要有的文件
const STATIC = ['index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-maskable.svg']

const die = (msg) => {
  console.error(`[sw] ${msg}`)
  process.exit(1)
}

if (!existsSync(MANIFEST)) {
  die('缺少 dist/.vite/manifest.json —— vite.config.ts 的 build.manifest 必须为 true')
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
// 清单的键是 chunk 名（'index.html'、'_monaco-xxx.js'），imports 里放的是键；
// css 与 file 才是真实产物路径，所以两个方向都建索引
const byFile = new Map(Object.values(manifest).map((entry) => [entry.file, entry]))

const html = await readFile(join(DIST, 'index.html'), 'utf8')

// index.html 里的 src / href 可能是 '/assets/x.js' 或 '/<repo>/assets/x.js'，统一折成 'assets/x.js'
const refs = []
for (const match of html.matchAll(/(?:src|href)="[^"]*?(assets\/[^"]+)"/g)) refs.push(match[1])
if (!refs.length) die('dist/index.html 里没找到任何 assets/ 引用')

const files = new Set(STATIC)
const queue = [...refs]
while (queue.length) {
  const file = queue.shift()
  if (files.has(file)) continue
  files.add(file)
  const entry = byFile.get(file)
  // css 之类不会被单独记进清单，只做叶子节点
  if (!entry) {
    if (file.endsWith('.js')) die(`dist/.vite/manifest.json 里没有 ${file}，静态闭包断了`)
    continue
  }
  for (const key of entry.imports ?? []) {
    const dep = manifest[key]
    if (!dep) die(`dist/.vite/manifest.json 里没有 import ${key}，静态闭包断了`)
    queue.push(dep.file)
  }
  queue.push(...(entry.css ?? []))
}

const missing = [...files].filter((file) => !existsSync(join(DIST, file)))
if (missing.length) die(`清单里的文件不存在：${missing.join(', ')}`)

// index.html 排第一，其余按名字排序，保证同一份产物生成的 sw.js 逐字节一致
const list = [
  'index.html',
  ...[...files].filter((file) => file !== 'index.html').sort(),
].map((file) => `./${file}`)

// 版本号取「清单 + index.html」的哈希：外壳一变就换 cache 名，旧的 SHELL 在 activate 里清掉
const version = createHash('sha1').update(list.join('\n')).update(html).digest('hex').slice(0, 8)

const before = await readFile(SW, 'utf8')
let after = before
  .replace("'__VELLUM_VERSION__'", `'${version}'`)
  .replace("['__VELLUM_PRECACHE__']", JSON.stringify(list, null, 2))

if (after === before) die('dist/sw.js 里没找到占位符，预缓存清单没注入')
if (after.includes('__VELLUM_')) die('dist/sw.js 里的占位符没替换干净')
await writeFile(SW, after)

// manifest 只在构建期有用，不留在发布产物里
await rm(join(DIST, '.vite'), { recursive: true, force: true })

console.log(`[sw] 版本 ${version} · 预缓存 ${list.length} 项`)
