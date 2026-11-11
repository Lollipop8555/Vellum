/**
 * 分层缓存：
 * - 导航请求 index.html 用 NetworkFirst（保证升级后拿到新壳）
 * - 带 hash 的静态资源与引擎 chunk 用 CacheFirst（一次下载，永久离线）
 * 作用域由注册路径（BASE_URL 下的 sw.js）决定，因此该文件必须放在 public 根目录
 */
const VERSION = 'v1'
const SHELL = `vellum-shell-${VERSION}`
const RUNTIME = `vellum-runtime-${VERSION}`

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k)),
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

async function networkFirst(req) {
  const cache = await caches.open(SHELL)
  try {
    const fresh = await fetch(req)
    if (fresh && fresh.ok) cache.put(req, fresh.clone())
    return fresh
  } catch {
    const hit = await cache.match(req)
    if (hit) return hit
    return new Response('离线且无可用的缓存页面', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME)
  const hit = await cache.match(req)
  if (hit) return hit
  const fresh = await fetch(req)
  if (fresh && fresh.ok && fresh.type === 'basic') cache.put(req, fresh.clone())
  return fresh
}
