import { defineConfig } from 'vite'
import manifest from './vendor/VERSIONS.json'

// 本地与常规部署都在根路径（http://localhost:5173/）。
// 只有发布到 GitHub Pages 项目页（<user>.github.io/<repo>/）这种子路径时，
// 才由 CI 注入 VITE_BASE=/<repo>/，本地开发不受影响。
declare const process: { env: Record<string, string | undefined> }
const BASE = process.env.VITE_BASE || '/'

// 双引擎源码固定在 vendor/，构建不读 node_modules：
// 引擎只有在跑过 npm run vendor 并提交 vendor/ 之后才会变化。
const VENDOR = decodeURIComponent(new URL('./vendor/', import.meta.url).pathname)

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type Subpaths = Record<string, Record<string, string>>
const SUBPATHS = (manifest as { subpaths?: Subpaths }).subpaths ?? {}

// 只有 CJS 入口的包：dev 需要依赖预构建，构建期由 commonjsOptions 处理
const CJS_PACKAGES = (manifest as { cjs?: string[] }).cjs ?? []

// exports 子路径别名：alias 只拼路径、不懂条件导出，这类例外由 vendor 脚本固化进清单。
// 必须排在包名前缀规则之前，否则永远被前缀规则先命中；精确项又要排在通配项之前。
const subpathRule = (name: string, sub: string, target: string) => {
  const base = `${VENDOR}${name}/`
  const star = sub.indexOf('*')
  if (star === -1) {
    return { find: new RegExp(`^${escapeRegex(name)}/${escapeRegex(sub.slice(2))}$`), replacement: base + target }
  }
  // './lib/languages/*' → 'es/languages/*.js'：把 * 换成捕获组
  const head = sub.slice(2, star)
  const tail = sub.slice(star + 1)
  const targetStar = target.indexOf('*')
  const targetHead = targetStar === -1 ? target : target.slice(0, targetStar)
  const targetTail = targetStar === -1 ? '' : target.slice(targetStar + 1)
  return {
    find: new RegExp(`^${escapeRegex(name)}/${escapeRegex(head)}(.+)${escapeRegex(tail)}$`),
    replacement: `${base}${targetHead}$1${targetTail}`,
  }
}

const subpathAlias = Object.entries(SUBPATHS).flatMap(([name, map]) =>
  Object.entries(map)
    .sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')))
    .map(([sub, target]) => subpathRule(name, sub, target)),
)

// 按 vendor 清单生成别名，新增依赖无需再改这里
const packageAlias = Object.keys(manifest.packages).flatMap((name) => {
  const base = `${VENDOR}${name}`
  const id = escapeRegex(name)
  return [
    { find: new RegExp(`^${id}$`), replacement: base },
    { find: new RegExp(`^${id}/`), replacement: `${base}/` },
  ]
})

export default defineConfig({
  base: BASE,
  resolve: {
    alias: [...subpathAlias, ...packageAlias],
  },
  // dev 不走 commonjs 插件，vendor 里的 CJS 包必须显式交给依赖预构建，
  // 否则 `import extend from 'extend'` 会直接指向未转换的 CJS 文件。
  // 清单由 vendor 脚本扫描 package.json 生成，新增 CJS 依赖不会漏。
  optimizeDeps: {
    include: CJS_PACKAGES,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    // 产出一份产物清单，scripts/build-sw.mjs 靠它算出 Service Worker 的预缓存闭包
    manifest: true,
    // 引擎源码不在 node_modules 下，commonjs 插件默认只处理 node_modules，
    // 导致 unified 依赖的 CJS 包（extend）拿不到 default 导出
    commonjsOptions: {
      include: [/\/node_modules\//, /\/vendor\//],
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('monaco-editor')) return 'monaco'
          return undefined
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
})
