import type { Issue } from '../types'
import type { ArgType, ParamType, SymDef, SymTab } from '../symbols'

/**
 * 符号层五条规则：重复定义 / 定义未使用 / 调用近似拼错 / 参数个数不符 / 参数类型不符。
 *
 * 依据 plans/diagnostics.md §4 的默认值与 §5 的信任边界。五条共享同一张符号表，
 * 所以这里的每个函数都只做判断，不再遍历语法树。
 *
 * 总原则：**符号不在表里就不报**。表本身是保守的（见 symbols.ts），
 * 于是所有「认不出的写法」自动落到「不报」这一侧。
 */

const MAX_DUP = 20
const MAX_UNUSED = 30
const MAX_TYPO = 10
const MAX_ARITY = 30
const MAX_TYPEARG = 20

/** `main` 是入口（没人 call 它很正常）；`_` 前缀 = 有意不用的占位；全大写 = 常量 */
const SAFE_UNUSED = /^_|^[A-Z][A-Z0-9_]*$/

function issue(
  def: { from: number; to: number },
  kind: Issue['kind'],
  key: Issue['key'],
  severity: Issue['severity'],
  params?: Record<string, string | number>,
): Issue {
  return { from: def.from, to: def.to, severity, kind, key, params, source: 'symbols' }
}

/* ------------------------------------------------------ 重复定义 */

export function duplicateIssues(tab: SymTab): Issue[] {
  const groups = new Map<string, SymDef[]>()
  for (const def of tab.defs) {
    // 函数/方法不参与：TS 有重载声明、Java 有重载，同名是合法写法
    if (def.kind !== 'var' && def.kind !== 'param' && def.kind !== 'field' && def.kind !== 'class') continue
    // `var` 允许同名重复
    if (def.kw === 'var') continue
    const key = `${def.scope}|${def.name}`
    const list = groups.get(key)
    if (list) list.push(def)
    else groups.set(key, [def])
  }

  const issues: Issue[] = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    // 只报后来者：第一个是「本来那个」，用户要改的是重复的这份
    for (const def of list.slice(1)) {
      if (issues.length >= MAX_DUP) return issues
      issues.push(issue(def, 'duplicate', 'issues.duplicateDef', 'error', { name: def.name }))
    }
  }
  return issues
}

/* ------------------------------------------------------ 定义未使用 */

const TS_EXT_DTS = /\.d\.ts$/i

/**
 * 降噪前置条件（§4）：只报非导出的顶层符号；脚本式文件整条跳过；
 * `_` 前缀 / 全大写常量 / `main` 一律放过。宁可漏，不可吵。
 */
export function unusedIssues(tab: SymTab, name: string): Issue[] {
  if (TS_EXT_DTS.test(name)) return []
  // 没有顶层函数/类 = 脚本式文件（一堆裸语句），「未使用」在那里没有意义
  if (!tab.defs.some((d) => d.topLevel && (d.kind === 'function' || d.kind === 'class'))) return []

  const issues: Issue[] = []
  const seen = new Set<string>()
  for (const def of tab.defs) {
    if (issues.length >= MAX_UNUSED) break
    if (!def.topLevel || def.exported) continue
    if (def.kind !== 'function' && def.kind !== 'class' && def.kind !== 'var') continue
    if (seen.has(def.name)) continue
    if (def.name === 'main' || SAFE_UNUSED.test(def.name)) continue
    if ((tab.refs.get(def.name) ?? 0) > 0) continue
    seen.add(def.name)
    issues.push(issue(def, 'unused', 'issues.unusedDef', 'warning', { name: def.name }))
  }
  return issues
}

/* ---------------------------------------------------- 调用近似拼错 */

/**
 * 编辑距离 ≤ 1。只用来判「是不是把某个已定义的函数名打错了一个字符」，
 * 所以不做完整的 DP——一次插入/删除/替换就是全部情况。
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return false
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false

  let i = 0
  let j = 0
  let diff = 0
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++diff > 1) return false
    if (la > lb) i++
    else if (lb > la) j++
    else {
      i++
      j++
    }
  }
  // 有一边还剩尾巴：说明差一个字符
  if (i < la || j < lb) diff++
  return diff <= 1
}

/** 内建全局名。误把 `console` 认成 `consol` 的代价太大，宁可先把常见的一网打尽 */
const GLOBALS = new Set([
  'console', 'window', 'document', 'globalThis', 'self', 'global',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'queueMicrotask', 'structuredClone', 'postMessage',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
  'encodeURIComponent', 'decodeURIComponent', 'eval', 'require',
  'fetch', 'atob', 'btoa', 'alert', 'confirm', 'prompt',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'JSON', 'Math',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Proxy', 'Reflect', 'Intl', 'URL', 'URLSearchParams', 'Blob', 'File',
  'FileReader', 'FormData', 'Headers', 'Request', 'Response', 'AbortController',
  'Event', 'CustomEvent', 'Worker', 'localStorage', 'sessionStorage', 'performance',
  'navigator', 'history', 'location', 'crypto', 'screen', 'matchMedia', 'getComputedStyle',
])

const TYPO_MIN_LEN = 4

export function typoIssues(tab: SymTab): Issue[] {
  const defined = new Set<string>(tab.imports)
  for (const def of tab.defs) defined.add(def.name)

  const callables: string[] = []
  for (const def of tab.defs) {
    if (def.kind === 'function' || def.kind === 'method') callables.push(def.name)
  }
  if (callables.length === 0) return []

  const issues: Issue[] = []
  const seen = new Set<string>()
  for (const call of tab.calls) {
    if (issues.length >= MAX_TYPO) break
    if (call.name.length < TYPO_MIN_LEN) continue
    if (defined.has(call.name) || GLOBALS.has(call.name) || seen.has(call.name)) continue
    const suggest = callables.find((name) => withinOneEdit(name, call.name))
    if (!suggest) continue
    seen.add(call.name)
    issues.push(issue(call, 'typo', 'issues.typoCall', 'warning', { name: call.name, suggest }))
  }
  return issues
}

/* ------------------------------------------------------ 参数个数 */

export function arityIssues(tab: SymTab): Issue[] {
  const byName = new Map<string, SymDef[]>()
  for (const def of tab.defs) {
    if (def.kind !== 'function' && def.kind !== 'method') continue
    if (def.minArgs === undefined || def.maxArgs === undefined) continue
    const list = byName.get(def.name)
    if (list) list.push(def)
    else byName.set(def.name, [def])
  }
  if (byName.size === 0) return []

  const issues: Issue[] = []
  const reportedScopes = new Set<string>()
  for (const call of tab.calls) {
    if (issues.length >= MAX_ARITY) break
    const defs = byName.get(call.name)
    if (!defs) continue
    // import 进来的同名符号可能来自别的文件，本文件里的定义说明不了它的签名
    if (tab.imports.has(call.name)) continue
    // 同名还有变量/类定义 → 调用目标不确定，放过
    if (tab.defs.some((d) => d.name === call.name && d.kind !== 'function' && d.kind !== 'method')) continue
    // 任何一个重载能接受这个个数就不算错
    if (defs.some((d) => call.argc >= d.minArgs! && call.argc <= d.maxArgs!)) continue

    let min = Infinity
    let max = -Infinity
    for (const def of defs) {
      min = Math.min(min, def.minArgs!)
      max = Math.max(max, def.maxArgs!)
    }

    // §3 的数量治理：参数类问题单个函数最多报 1 条。
    // 修好第一条再出现的第二条会自己冒出来——不是漏报，是排队
    if (reportedScopes.has(call.scope)) continue
    reportedScopes.add(call.scope)

    const params = { name: call.name, actual: call.argc }
    if (min === max) {
      issues.push(issue(call, 'arity', 'issues.arityExact', 'error', { ...params, n: min }))
    } else if (max === Infinity) {
      issues.push(issue(call, 'arity', 'issues.arityMin', 'error', { ...params, min }))
    } else {
      issues.push(issue(call, 'arity', 'issues.arityRange', 'error', { ...params, min, max }))
    }
  }
  return issues
}

/* ------------------------------------------------------ 参数类型 */

/**
 * 每个「声明类型」能接受哪些「实参字面量类型」。
 *
 * 只放**语言层面一定成立**的转换：Java 里 int 字面量能传给 `double`（加宽），
 * 反过来不行。认不出的组合一律不在表里 → 不报。
 */
const ACCEPTS: Record<ParamType, ArgType[]> = {
  string: ['string'],
  number: ['int', 'number'],
  int: ['int'],
  float: ['int', 'float'],
  boolean: ['boolean'],
  char: ['char'],
}

/**
 * 参数类型：只比「形参写了基本类型」+「实参是字面量」这一种组合，
 * 其余（泛型、union、数组、自定义类、变量实参、`any`/无注解）全部放过。
 * 这是 §5 信任边界里最容易误报的一条，宁可少报。
 */
export function typeArgIssues(tab: SymTab): Issue[] {
  const byName = new Map<string, SymDef[]>()
  for (const def of tab.defs) {
    if (def.kind !== 'function' && def.kind !== 'method') continue
    if (!def.paramTypes || def.paramTypes.length === 0) continue
    const list = byName.get(def.name)
    if (list) list.push(def)
    else byName.set(def.name, [def])
  }
  if (byName.size === 0) return []

  const issues: Issue[] = []
  for (const call of tab.calls) {
    if (issues.length >= MAX_TYPEARG) break
    const defs = byName.get(call.name)
    // 重载同名时无法确定调用的是哪一个签名，整条放过
    if (!defs || defs.length !== 1) continue
    const def = defs[0]
    if (tab.imports.has(call.name)) continue
    if (tab.defs.some((d) => d.name === call.name && d.kind !== 'function' && d.kind !== 'method')) continue
    // 个数都不对的话，arity 已经报过了，这里别凑热闹
    if (call.argc < def.minArgs! || call.argc > def.maxArgs!) continue

    const types = def.paramTypes!
    for (let i = 0; i < call.argTypes.length && i < types.length; i++) {
      const expected = types[i]
      const actual = call.argTypes[i]
      // 没注解 / 可选参数 / 认不出的实参 / null 字面量：都不判
      if (!expected || actual.kind === null || actual.kind === 'null') continue
      if (ACCEPTS[expected.kind].includes(actual.kind)) continue
      issues.push(
        issue(call, 'typeArgs', 'issues.typeArg', 'error', {
          name: call.name,
          index: i + 1,
          expected: expected.label,
          actual: actual.text.length > 16 ? `${actual.text.slice(0, 16)}…` : actual.text,
        }),
      )
      // 一个调用点只报第一处不对（§3 数量治理）；顶层的「脚本作用域」不是函数，
      // 按函数去重会把整份文件压成一条，所以这里按调用点算
      break
    }
  }
  return issues
}
