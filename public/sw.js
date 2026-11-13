/**
 * 分层缓存：
 * - install 时预缓存外壳（index.html + 入口 chunk + 样式 + 图标），第一次访问完就能离线打开；
 * - 导航请求 NetworkFirst：在线拿新壳，断网退回缓存的 index.html；
 * - 其余同源静态资源 CacheFirst：文件名带内容哈希，一次下载永久离线
 *   （Monaco、Prettier、图表渲染器这些按需 chunk 就是这样在首次用到之后离线的）。
 *
 * VERSION / PRECACHE 两行是构建期占位符，由 scripts/build-sw.mjs 换成真实构建号与清单，
 * 在 public/ 里手改没有意义（构建会覆盖）。作用域由注册路径（BASE_URL 下的 sw.js）决定，
 * 所以这个文件必须留在 public 根目录。
 */
const VERSION = '__VELLUM_VERSION__'
const PRECACHE = ['__VELLUM_PRECACHE__']

const SHELL = `vellum-shell-${VERSION}`
// 运行时缓存不带构建号：文件名自带内容哈希，换版本不会撞车；不带号才能让
// Monaco 那类大 chunk 跨发布复用，不用每次重新下载
const RUNTIME = 'vellum-runtime'

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (PRECACHE[0]?.includes('__VELLUM')) {
        // 直接跑 vite build 会漏掉 npm run sw，这里至少别静悄悄地「装了个空壳」
        console.warn('[sw] 预缓存清单没有注入，请用 npm run build')
      }
      const cache = await caches.open(SHELL)
      // 逐个 add 而不是 addAll：addAll 是全有或全无，一个 404 就让整次安装失败，
      // 结果反而一个能离线的资源都没有
      const results = await Promise.allSettled(PRECACHE.map((url) => cache.add(url)))
      const failed = results.filter((r) => r.status === 'rejected')
      if (failed.length) console.warn(`[sw] ${failed.length}/${PRECACHE.length} 个外壳资源预缓存失败`, failed)
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        // 只清自己的：项目页和用户页同源，别人的 cache 不归这里管
        keys
          .filter((k) => k.startsWith('vellum-') && k !== SHELL && k !== RUNTIME)
          .map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req))
    return
  }

  event.respondWith(cacheFirst(req))
})

// 缓存里的外壳可能挂在 '/' 或 '/index.html' 上（导航 URL 决定），两个都试一遍
const SHELL_FALLBACKS = ['./', './index.html']

async function networkFirst(req) {
  const cache = await caches.open(SHELL)
  try {
    const fresh = await fetch(req)
    // 只把真正的 HTML 存成壳，别让网关或 CDN 的错误页顶掉首页
    if (fresh && fresh.ok && (fresh.headers.get('content-type') ?? '').includes('text/html')) {
      cache.put(req, fresh.clone())
    }
    return fresh
  } catch {
    const hit = await cache.match(req)
    if (hit) return hit
    for (const url of SHELL_FALLBACKS) {
      const shell = await cache.match(url)
      if (shell) return shell
    }
    return new Response('离线且没有可用的缓存页面', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
}

async function cacheFirst(req) {
  const shellHit = await (await caches.open(SHELL)).match(req)
  if (shellHit) return shellHit

  const runtime = await caches.open(RUNTIME)
  const runtimeHit = await runtime.match(req)
  if (runtimeHit) return runtimeHit

  try {
    const fresh = await fetch(req)
    if (fresh && fresh.ok && fresh.type === 'basic') runtime.put(req, fresh.clone())
    return fresh
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' })
  }
}
