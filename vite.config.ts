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

// 按 vendor 清单生成别名，新增依赖无需再改这里
const engineAlias = Object.keys(manifest.packages).flatMap((name) => {
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
    alias: engineAlias,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
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
