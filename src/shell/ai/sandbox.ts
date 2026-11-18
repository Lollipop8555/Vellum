/**
 * AI 脚本沙箱（plans/ai-project-v2.md P-11 / P-14）。
 *
 * 三层结构，各管一件事：
 * 1. **iframe（`sandbox="allow-scripts"`，不给 `allow-same-origin`）**：origin 变成 opaque，
 *    脚本读不到父页面的 localStorage / IndexedDB / DOM。它只当容器，几乎不干活。
 * 2. **iframe 内的 Worker（Blob URL）**：真正的计算在这里。独立线程是**超时能生效**的前提 ——
 *    否则 `while(true){}` 会把主线程和定时器一起冻住，「超时销毁」只是一句空话。
 * 3. **父页面**：只负责计时、收消息、销毁 iframe（连带回收它的 worker）。
 *
 * 网络：联网关闭时在 worker 里 stub 掉 fetch / XHR / WebSocket / EventSource / importScripts，
 * 调用即抛 `network_off`。这只是**堵常用入口**，浏览器里做不到绝对隔离 —— 计划 §7 已如实记录，
 * UI 文案也照这个口径说。
 *
 * 输出：worker 内先按 32KB 累积截断，父侧再过一遍 `clipOutput`，防止 postMessage 本身被撑爆。
 * 纯函数（clampTimeout / clipOutput / runnerSource）不碰 DOM，方便 node 侧单测。
 */

export type ScriptLang = 'js' | 'py'

export type ScriptError = 'timeout' | 'network_off' | 'runtime_off' | 'error' | null

export interface ScriptResult {
  /** 正常跑完（脚本内部抛异常时为 false） */
  ok: boolean
  stdout: string
  stderr: string
  error: ScriptError
  /** 从投递到结束的耗时（毫秒） */
  ms: number
}

export interface ScriptOptions {
  timeoutMs?: unknown
  /** 联网开关；false 时沙箱内网络 API 一律抛 network_off（P-11） */
  allowNetwork: boolean
}

export const MIN_TIMEOUT = 500
/** 上限给到 60s：Python 首次要下载 Pyodide，30s 在慢网下同样不够 */
export const MAX_TIMEOUT = 60_000
/**
 * 默认 15s。原来是 5s —— 一段带排序 / 建索引的验证脚本经常要跑 6-8s，
 * 卡在 5s 上就变成一个「假故障」：模型只看到 timeout，只能换个写法再烧一轮。
 */
export const DEFAULT_TIMEOUT = 15_000
/** 单次输出上限（stdout / stderr 各自计算） */
export const MAX_OUTPUT = 32 * 1024
export const PYODIDE_VERSION = '0.26.4'
export const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`
/** iframe → 宿主的消息标记；只认自己的 iframe 发来的这条 */
export const SCRIPT_TAG = '__vellum_script__'

/** 调用方给的 timeout 一律收口到 [500, 60000]，非数字回落到默认 15s */
export function clampTimeout(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT
  const ms = Math.round(n)
  if (ms < MIN_TIMEOUT) return MIN_TIMEOUT
  if (ms > MAX_TIMEOUT) return MAX_TIMEOUT
  return ms
}

/** 输出截断：超限只留前 MAX_OUTPUT 字符，并在尾巴上说清楚被截了 */
export function clipOutput(text: string, max = MAX_OUTPUT): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return {
    text: `${text.slice(0, max)}\n…（输出超过 ${Math.round(max / 1024)}KB，已截断）`,
    truncated: true,
  }
}

/**
 * 生成沙箱 worker 的源码（在 iframe 内以 Blob URL 启动）。
 * 单独抽出来是为了能在 node 侧断言：联网关闭确实 stub 了网络、输出确实有上限、
 * py 确实走 Pyodide —— 这些都是「断了就很难查」的点。
 */
export function runnerSource(lang: ScriptLang, code: string, allowNetwork: boolean): string {
  const cfg = JSON.stringify({
    lang,
    code,
    allowNetwork,
    max: MAX_OUTPUT,
    pyBase: PYODIDE_BASE,
    tag: SCRIPT_TAG,
  })
  return `
(function () {
  var CFG = ${cfg}
  var out = []
  var err = []
  var used = 0
  var cut = false

  function asText(value) {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && value.stack) return String(value.stack)
    try {
      if (typeof value === 'object' && value !== null) return JSON.stringify(value)
      return String(value)
    } catch (e) {
      return Object.prototype.toString.call(value)
    }
  }

  function add(bucket, text) {
    var s = asText(text)
    if (used >= CFG.max) {
      cut = true
      return
    }
    if (used + s.length > CFG.max) {
      s = s.slice(0, CFG.max - used)
      cut = true
    }
    used += s.length
    bucket.push(s)
  }

  function finish(extra) {
    var payload = {
      tag: CFG.tag,
      stdout: out.join(''),
      stderr: err.join(''),
      truncated: cut,
      error: null,
    }
    if (extra) {
      for (var key in extra) payload[key] = extra[key]
    }
    self.postMessage(payload)
  }

  function failRun(error) {
    var text = asText(error)
    var brief = String((error && error.message) || '')
    // 模型的心智模型是 Node：写 require / import / process 是常态，报「xx is not defined」
    // 它只会照着同样的写法再试一次。这里把环境差异一次说清，能省掉好几轮试错。
    if (
      /require is not defined|module is not defined|process is not defined|exports is not defined|Cannot use import statement|Unexpected token 'export'|import is not defined/.test(
        brief,
      )
    ) {
      text +=
        '\\n[提示] 这是浏览器 Worker 沙箱，不是 Node：没有 require / module / process / fs，' +
        '不能用 import/export，也读不到工作区文件。断言用内置 assert(条件, 说明) / ' +
        'assert.equal(a, b) / assert.deepEqual(a, b)；要读写文件请用 read_file / write_file / apply_edits。'
    }
    add(err, text)
    var code = error && error.code ? String(error.code) : ''
    finish(code === 'network_off' ? { error: 'network_off', message: asText(error) } : { error: 'error' })
  }

  function line(args) {
    var list = []
    for (var i = 0; i < args.length; i += 1) list.push(asText(args[i]))
    return list.join(' ') + '\\n'
  }

  // console 挂到 self：用户代码经 new Function 运行，作用域是 worker 全局，只能看到 self 上的属性
  var proxy = {
    log: function () { add(out, line(arguments)) },
    info: function () { add(out, line(arguments)) },
    debug: function () { add(out, line(arguments)) },
    warn: function () { add(err, line(arguments)) },
    error: function () { add(err, line(arguments)) },
    trace: function () { add(err, line(arguments)) },
    table: function (value) { add(out, asText(value) + '\\n') },
  }
  try {
    self.console = proxy
  } catch (e) {
    /* 只读环境忽略 */
  }

  // 内置一个够用的 assert：AI 写「单元测试」时第一步几乎总是 require('assert')，
  // 沙箱里没有 require，一整轮就白跑了。这里给 node 风格的常用子集。
  function show(value) {
    try {
      return typeof value === 'string' ? value : JSON.stringify(value)
    } catch (e) {
      return String(value)
    }
  }
  function assertOk(value, message) {
    if (value) return
    // name 会被拼进 stack 首行，message 里就不要再带一遍前缀（否则打印两层 AssertionError）
    var error = new Error(message || '断言失败')
    error.name = 'AssertionError'
    throw error
  }
  assertOk.ok = assertOk
  assertOk.equal = function (actual, expected, message) {
    if (actual == expected) return
    assertOk(false, message || '期望 ' + show(expected) + '，实际 ' + show(actual))
  }
  assertOk.strictEqual = function (actual, expected, message) {
    if (actual === expected) return
    assertOk(false, message || '期望 ' + show(expected) + '，实际 ' + show(actual))
  }
  assertOk.deepEqual = function (actual, expected, message) {
    if (show(actual) === show(expected)) return
    assertOk(false, message || '期望 ' + show(expected) + '，实际 ' + show(actual))
  }
  assertOk.notEqual = function (actual, expected, message) {
    if (actual != expected) return
    assertOk(false, message || '不应该等于 ' + show(expected))
  }
  assertOk.throws = function (fn, message) {
    var threw = false
    try {
      fn()
    } catch (e) {
      threw = true
    }
    if (!threw) assertOk(false, message || '期望抛出异常，但没有')
  }
  try {
    self.assert = assertOk
    // print 是 Python 习惯，顺手给 JS 一个同名出口，省掉「print is not defined」
    self.print = function () { add(out, line(arguments)) }
  } catch (e) {
    /* 只读环境忽略 */
  }

  // 联网关闭：常见网络入口换成抛错桩，调用即 network_off，模型能据此自纠
  if (!CFG.allowNetwork) {
    var blocked = function (name) {
      return function () {
        var error = new Error('network_off: 联网已关闭，脚本内不能访问网络（' + name + '）')
        error.code = 'network_off'
        throw error
      }
    }
    var stubs = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']
    for (var i = 0; i < stubs.length; i += 1) {
      try {
        self[stubs[i]] = blocked(stubs[i])
      } catch (e) {
        /* 只读属性，跳过 */
      }
    }
  }

  if (CFG.lang === 'js') {
    // AsyncFunction 而不是 Function：验证脚本里几乎一定会写顶层 await
    // （形如 const r = await foo()），同步作用域遇到 await 直接 SyntaxError，
    // 模型却看不出是「环境不支持」，只会再试一次。
    var AsyncFn = Object.getPrototypeOf(async function () {}).constructor
    var result
    try {
      result = new AsyncFn(CFG.code)()
    } catch (error) {
      failRun(error)
      return
    }
    Promise.resolve(result).then(
      function (value) {
        if (value !== undefined) add(out, asText(value) + '\\n')
        finish(null)
      },
      function (error) { failRun(error) },
    )
    return
  }

  // Python：运行时本身要从网络拉，联网关闭就没得跑
  if (!CFG.allowNetwork) {
    finish({
      error: 'network_off',
      message: 'network_off: 联网已关闭，Python 运行时（Pyodide）需要联网下载',
    })
    return
  }

  try {
    importScripts(CFG.pyBase + 'pyodide.js')
  } catch (error) {
    finish({ error: 'runtime_off', message: 'Pyodide 运行时下载失败（网络不通或被拦截）' })
    return
  }

  self.loadPyodide({ indexURL: CFG.pyBase }).then(
    function (py) {
      py.setStdout({ batched: function (text) { add(out, text + '\\n') } })
      py.setStderr({ batched: function (text) { add(err, text + '\\n') } })
      return py.runPythonAsync(CFG.code)
    },
  ).then(
    function () { finish(null) },
    function (error) { failRun(error) },
  )
})()
`
}

/** iframe 里的引导脚本：起 worker、把 worker 的消息原样转发给父页面 */
function bootstrapSource(lang: ScriptLang, code: string, allowNetwork: boolean): string {
  const worker = runnerSource(lang, code, allowNetwork)
  return `
(function () {
  var TAG = ${JSON.stringify(SCRIPT_TAG)}
  var source = ${JSON.stringify(worker)}
  try {
    var url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    var worker = new Worker(url)
    worker.onmessage = function (event) { parent.postMessage(event.data, '*') }
    worker.onerror = function (event) {
      parent.postMessage(
        { tag: TAG, stdout: '', stderr: String((event && event.message) || event), error: 'error' },
        '*',
      )
    }
  } catch (error) {
    parent.postMessage(
      {
        tag: TAG,
        stdout: '',
        stderr: 'worker_init_failed: ' + String((error && error.message) || error),
        error: 'error',
      },
      '*',
    )
  }
})()
`
}

/**
 * 在隔离沙箱里跑一段脚本。**永不 reject**：所有失败都折成 `error` 字段，
 * 上层（tools.ts）负责翻译成 timeout / network_off / tool_failed。
 */
export function runScript(lang: ScriptLang, code: string, opts: ScriptOptions): Promise<ScriptResult> {
  const timeout = clampTimeout(opts.timeoutMs)
  const started = performance.now()

  return new Promise<ScriptResult>((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('title', 'script-sandbox')
    // 不占布局：position:fixed 挪到视口外，宽高为 0
    frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;border:0;visibility:hidden'

    let settled = false
    let timer = 0

    const cleanup = () => {
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      // 销毁 iframe 会连带回收它里面的 worker —— 死循环到这里才真正停下
      frame.remove()
    }

    const settle = (result: ScriptResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    function onMessage(event: MessageEvent) {
      // 只认这个 iframe 发来的：页面上可能还有别的 postMessage
      if (event.source !== frame.contentWindow) return
      const data = event.data as
        | { tag?: string; stdout?: string; stderr?: string; error?: ScriptError; message?: string }
        | null
      if (!data || data.tag !== SCRIPT_TAG) return

      const rawErr = typeof data.stderr === 'string' && data.stderr
        ? data.stderr
        : data.message
          ? String(data.message)
          : ''
      const stdout = clipOutput(typeof data.stdout === 'string' ? data.stdout : '')
      const stderr = clipOutput(rawErr)
      const error: ScriptError =
        data.error === 'network_off' || data.error === 'runtime_off' || data.error === 'error'
          ? data.error
          : null
      settle({
        ok: error === null,
        stdout: stdout.text,
        stderr: stderr.text,
        error,
        ms: Math.round(performance.now() - started),
      })
    }

    timer = window.setTimeout(() => {
      settle({
        ok: false,
        stdout: '',
        stderr: `脚本运行超过 ${timeout}ms，已终止（沙箱被销毁）`,
        error: 'timeout',
        ms: Math.round(performance.now() - started),
      })
    }, timeout)

    window.addEventListener('message', onMessage)

    // 用户代码里可能带 `</script>`：只转义引导脚本自身，别碰我们自己那个真正的闭合标签
    const boot = bootstrapSource(lang, code, opts.allowNetwork).replace(/<\/script/gi, '<\\/script')
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><body><script>${boot}</script>`
    document.body.appendChild(frame)
  })
}
