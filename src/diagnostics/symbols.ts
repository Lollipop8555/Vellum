import type { SyntaxNode, Tree } from '@lezer/common'
import type { LangId } from '../editors/languages'
import { contentHash } from './parse'

/**
 * 符号表：一次遍历同时喂给「重复定义 / 未使用 / 近似拼错 / 参数个数」四条规则。
 *
 * 依据 plans/diagnostics.md §7.3「一次解析，五个消费者」。这里只做**提取**，
 * 一条规则都不判——判断放在 providers/symbols.ts，提取错了改一处就够。
 *
 * 刻意保守：认不出的写法（解构、泛型重载、成员调用）一律**不进表**，
 * 让规则看不到它，也就不会误报。宁可少报。
 */

export type SymKind = 'function' | 'class' | 'var' | 'field' | 'param' | 'method'

/**
 * 参数类型检查只认「基本类型」：TS 的 `string/number/boolean`、Java 的
 * `int/long/…/String/char/boolean`。泛型、union、数组、文件内定义的类一律 null
 * （= 不检查），见 plans/diagnostics.md §5 信任边界。
 */
export type ParamType = 'string' | 'number' | 'boolean' | 'int' | 'float' | 'char'

/** 实参的字面量类型；null = 认不出（变量、调用、运算…），一律不检查 */
export type ArgType = 'string' | 'number' | 'int' | 'float' | 'boolean' | 'char' | 'null'

/** 形参声明类型：`kind` 用来判兼容，`label` 是源码里的原样写法（`long` 不能显示成 `int`） */
export interface ParamTypeInfo {
  kind: ParamType
  label: string
}

/** 一个实参：字面量类型 + 原文（报错时原样给用户看，免得多一层翻译） */
export interface SymArg {
  kind: ArgType | null
  text: string
}

export interface SymDef {
  name: string
  from: number
  to: number
  kind: SymKind
  /** 声明的唯一标识（`类型@偏移`）。同一作用域内重名才算重复 */
  scope: string
  /** 顶层声明：不在任何函数/块里 */
  topLevel: boolean
  /** 被 `export` 直接包住 */
  exported: boolean
  /** `const` / `let` / `var`，只有 `var` 允许同名重复 */
  kw?: string
  /** 函数/方法的最少参数个数 */
  minArgs?: number
  /** 函数/方法的最多参数个数；Infinity = 有 rest 参数 */
  maxArgs?: number
  /** 形参声明类型，与「位置」对齐（`this` 已剔除，可选参数为 null = 不查） */
  paramTypes?: (ParamTypeInfo | null)[]
}

export interface SymCall {
  name: string
  from: number
  to: number
  argc: number
  /** 调用所在作用域，用于「单个函数最多报 1 条」的数量治理（§3） */
  scope: string
  /** 实参字面量类型，与位置对齐 */
  argTypes: SymArg[]
}

export interface SymTab {
  defs: SymDef[]
  /** 只收「裸调用」（`f(...)`），成员调用 `a.f(...)` 不进表 */
  calls: SymCall[]
  /** 名字 → 被引用次数（不含定义处） */
  refs: Map<string, number>
  /** import 进来的名字：它们「有定义」，但不该被当成重复/未使用 */
  imports: Set<string>
}

const TS_LANGS = new Set<LangId>(['typescript', 'javascript'])
const JAVA_LANGS = new Set<LangId>(['java'])

export function hasSymbols(lang: LangId): boolean {
  return TS_LANGS.has(lang) || JAVA_LANGS.has(lang)
}

/* ------------------------------------------------------------ TS / JS */

const TS_SCOPE = new Set(['Script', 'Block', 'FunctionDeclaration', 'ArrowFunction', 'MethodDeclaration', 'ClassBody'])
const TS_BOUNDARY = new Set(['FunctionDeclaration', 'ArrowFunction', 'MethodDeclaration', 'Block', 'ClassBody'])

function scopeKey(node: SyntaxNode): string {
  let cur: SyntaxNode | null = node.parent
  while (cur) {
    if (TS_SCOPE.has(cur.name)) return `${cur.name}@${cur.from}`
    cur = cur.parent
  }
  return 'root'
}

function isTopLevel(node: SyntaxNode, boundary: Set<string>): boolean {
  let cur: SyntaxNode | null = node.parent
  while (cur) {
    if (boundary.has(cur.name)) return false
    cur = cur.parent
  }
  return true
}

function isExported(node: SyntaxNode): boolean {
  let cur: SyntaxNode | null = node.parent
  while (cur && cur.name !== 'Script' && cur.name !== 'Block') {
    if (cur.name === 'ExportDeclaration') return true
    cur = cur.parent
  }
  return false
}

function childNamed(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let ch = node.firstChild; ch; ch = ch.nextSibling) if (ch.name === name) return ch
  return null
}

/** 形参信息：个数区间 + 与位置对齐的声明类型 */
interface ParamInfo {
  min: number
  max: number
  /** null = 整段不查（有 rest/可变参数时位置对不上） */
  types: (ParamTypeInfo | null)[] | null
}

/** TS 里只有这三个小写关键字类型进表；`String`（包装对象）、泛型、union、数组一律 null */
const TS_PARAM_TYPE: Record<string, ParamType> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
}

/**
 * `(x, y = 1, ...rest)`：**按顶层逗号切段**，一段就是一个参数。
 *
 * 不能只数 `VariableDefinition`：解构参数是 `ObjectPattern`，`this: Foo` 是纯类型标注
 * （不是运行时参数），`a?: T` 的可选标记是 `Optional` 而不是 `?`。
 * 切段还顺手解决了「默认值在类型标注之后」（`b: string = 'x'`）的顺序问题。
 */
function readTsParams(paramList: SyntaxNode, text: string): ParamInfo {
  let min = 0
  let max = 0
  /** 见过可选参数之后，后面的参数都算「可不传」（和 TS 的宽松理解保持一致） */
  let optionalSeen = false
  const types: (ParamTypeInfo | null)[] = []
  let broken = false

  let hasValue = false
  let segOptional = false
  let segSpread = false
  let segStart = -1
  let segType: ParamTypeInfo | null = null

  /** 返回 false 表示后面不用再数了（rest 参数已把上限拉成无穷） */
  const flush = (): boolean => {
    if (!hasValue) return true
    // `this: Foo` 只在类型层面存在，调用时不占位
    if (/^this\s*:/.test(text.slice(segStart, segStart + 8))) return true
    if (segSpread) {
      max = Infinity
      broken = true
      return false
    }
    max++
    if (segOptional) optionalSeen = true
    if (!optionalSeen) min++
    // 可选参数可以不传（等于 undefined），类型对不上也说得过去——不查
    types.push(segOptional ? null : segType)
    return true
  }

  for (let ch = paramList.firstChild; ch; ch = ch.nextSibling) {
    const name = ch.name
    if (name === '(' || name === ')') continue
    if (name === ',') {
      if (!flush()) return { min, max: Infinity, types: null }
      hasValue = false
      segOptional = false
      segSpread = false
      segStart = -1
      segType = null
      continue
    }
    if (!hasValue) segStart = ch.from
    hasValue = true
    if (name === 'Optional' || name === 'Equals') segOptional = true
    else if (name === 'Spread') segSpread = true
    else if (name === 'TypeAnnotation') {
      const inner = childNamed(ch, 'TypeName')
      const label = inner ? text.slice(inner.from, inner.to) : ''
      const kind = TS_PARAM_TYPE[label]
      segType = kind ? { kind, label } : null
    }
  }
  flush()
  return { min, max: max === Infinity ? Infinity : max, types: broken ? null : types }
}

/** 实参字面量类型：认不出的一律 null（变量、调用、运算…都不查） */
function tsArg(node: SyntaxNode, text: string): SymArg {
  const raw = text.slice(node.from, node.to)
  switch (node.name) {
    case 'String':
    case 'TemplateString':
      return { kind: 'string', text: raw }
    case 'Number':
      return { kind: /^\d+$/.test(raw) ? 'int' : 'number', text: raw }
    case 'BooleanLiteral':
      return { kind: 'boolean', text: raw }
    case 'null':
      return { kind: 'null', text: raw }
    default:
      return { kind: null, text: raw }
  }
}

function defsOfTs(text: string, tree: Tree): SymTab {
  const defs: SymDef[] = []
  const calls: SymCall[] = []
  const refs = new Map<string, number>()
  const imports = new Set<string>()

  tree.iterate({
    enter(n) {
      const node = n.node

      if (n.name === 'VariableDeclaration') {
        const kwNode = node.firstChild
        const kw = kwNode && /^(const|let|var)$/.test(kwNode.name) ? kwNode.name : ''
        for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
          // 解构声明里没有 VariableDefinition，直接跳过（认不出就不进表）
          if (ch.name !== 'VariableDefinition') continue
          defs.push({
            name: text.slice(ch.from, ch.to),
            from: ch.from,
            to: ch.to,
            kind: 'var',
            scope: scopeKey(node),
            topLevel: isTopLevel(node, TS_BOUNDARY),
            exported: isExported(node),
            kw,
          })
        }
        return
      }

      if (n.name === 'FunctionDeclaration') {
        const nameNode = childNamed(node, 'VariableDefinition')
        const params = childNamed(node, 'ParamList')
        if (!nameNode) return
        const info = params
          ? readTsParams(params, text)
          : { min: 0, max: 0, types: [] as (ParamTypeInfo | null)[] }
        defs.push({
          name: text.slice(nameNode.from, nameNode.to),
          from: nameNode.from,
          to: nameNode.to,
          kind: 'function',
          scope: scopeKey(node),
          topLevel: isTopLevel(node, TS_BOUNDARY),
          exported: isExported(node),
          minArgs: info.min,
          maxArgs: info.max,
          paramTypes: info.types ?? undefined,
        })
        if (params) recordTsParams(params, defs, text, `FunctionDeclaration@${node.from}`)
        return
      }

      if (n.name === 'ClassDeclaration') {
        const nameNode = childNamed(node, 'VariableDefinition')
        if (!nameNode) return
        defs.push({
          name: text.slice(nameNode.from, nameNode.to),
          from: nameNode.from,
          to: nameNode.to,
          kind: 'class',
          scope: scopeKey(node),
          topLevel: isTopLevel(node, TS_BOUNDARY),
          exported: isExported(node),
        })
        return
      }

      if (n.name === 'CallExpression') {
        const callee = node.firstChild
        if (!callee || callee.name !== 'VariableName') return
        const argList = childNamed(node, 'ArgList')
        const argTypes: SymArg[] = []
        if (argList) {
          for (let ch = argList.firstChild; ch; ch = ch.nextSibling) {
            if (ch.name === '(' || ch.name === ')' || ch.name === ',') continue
            argTypes.push(tsArg(ch, text))
          }
        }
        calls.push({
          name: text.slice(callee.from, callee.to),
          from: callee.from,
          to: callee.to,
          argc: argTypes.length,
          scope: scopeKey(node),
          argTypes,
        })
        return
      }

      // JSX 标签名是 JSXIdentifier：不算进来的话，只在 `<Item />` 里用到的组件
      // 会被误报成「定义了却没用到」。属性名也是 JSXIdentifier，一起计入没关系
      // ——它只会让「未使用」少报，不会多报
      if (n.name === 'VariableName' || n.name === 'JSXIdentifier') {
        const name = text.slice(node.from, node.to)
        refs.set(name, (refs.get(name) ?? 0) + 1)
        return
      }

      if (n.name === 'ImportDeclaration') {
        const raw = text.slice(node.from, node.to)
        for (const word of raw.match(/[$A-Za-z_][$\w]*/g) ?? []) {
          if (word === 'import' || word === 'from' || word === 'as' || word === 'type') continue
          imports.add(word)
        }
      }
    },
  })

  return { defs, calls, refs, imports }
}

function recordTsParams(paramList: SyntaxNode, defs: SymDef[], text: string, scope: string): void {
  for (let ch = paramList.firstChild; ch; ch = ch.nextSibling) {
    if (ch.name !== 'VariableDefinition') continue
    defs.push({
      name: text.slice(ch.from, ch.to),
      from: ch.from,
      to: ch.to,
      kind: 'param',
      scope,
      topLevel: false,
      exported: false,
    })
  }
}

/* ---------------------------------------------------------------- Java */

const JAVA_SCOPE = new Set([
  'Program',
  'ClassBody',
  'Block',
  // 方法要算一层作用域：否则「形参与同名字段」会被判成重复定义
  'MethodDeclaration',
  'ConstructorDeclaration',
])


function javaScopeKey(node: SyntaxNode): string {
  let cur: SyntaxNode | null = node.parent
  while (cur) {
    if (JAVA_SCOPE.has(cur.name)) return `${cur.name}@${cur.from}`
    cur = cur.parent
  }
  return 'root'
}

/** Java 只有基本类型和 String 进表；泛型、数组、自定义类一律 null */
const JAVA_PARAM_TYPE: Record<string, ParamType> = {
  int: 'int',
  long: 'int',
  short: 'int',
  byte: 'int',
  double: 'float',
  float: 'float',
  boolean: 'boolean',
  char: 'char',
  String: 'string',
}

/** 可变参数（`String... a`）是 `SpreadParameter`，能收 0..n 个，上限必须是无穷 */
function readJavaParams(method: SyntaxNode, text: string): ParamInfo | null {
  const params = childNamed(method, 'FormalParameters')
  if (!params) return null
  let count = 0
  let spread = false
  const types: (ParamTypeInfo | null)[] = []
  for (let ch = params.firstChild; ch; ch = ch.nextSibling) {
    if (ch.name === 'FormalParameter') {
      count++
      // 修饰符（`final`）和注解都可能出现在类型前面，按节点名取，不按位置
      const typeNode = childNamed(ch, 'TypeName') ?? childNamed(ch, 'PrimitiveType')
      const label = typeNode ? text.slice(typeNode.from, typeNode.to) : ''
      const kind = JAVA_PARAM_TYPE[label]
      types.push(kind ? { kind, label } : null)
    } else if (ch.name === 'SpreadParameter') {
      count++
      spread = true
    }
  }
  return spread
    ? { min: Math.max(0, count - 1), max: Infinity, types: null }
    : { min: count, max: count, types }
}

function javaArg(node: SyntaxNode, text: string): SymArg {
  const raw = text.slice(node.from, node.to)
  switch (node.name) {
    case 'StringLiteral':
    case 'TextBlock':
      return { kind: 'string', text: raw }
    case 'IntegerLiteral':
      return { kind: 'int', text: raw }
    case 'FloatingPointLiteral':
      return { kind: 'float', text: raw }
    case 'BooleanLiteral':
      return { kind: 'boolean', text: raw }
    case 'CharacterLiteral':
      return { kind: 'char', text: raw }
    case 'null':
      return { kind: 'null', text: raw }
    default:
      return { kind: null, text: raw }
  }
}

function defsOfJava(text: string, tree: Tree): SymTab {
  const defs: SymDef[] = []
  const calls: SymCall[] = []
  const refs = new Map<string, number>()
  const imports = new Set<string>()

  tree.iterate({
    enter(n) {
      const node = n.node
      const name = n.name

      if (name === 'ImportDeclaration') {
        const raw = text.slice(node.from, node.to)
        for (const word of raw.match(/[A-Za-z_$][\w$]*/g) ?? []) {
          if (word === 'import' || word === 'static') continue
          imports.add(word)
        }
        return
      }

      if (name === 'Definition') {
        const parent = node.parent
        if (!parent) return
        const ident = text.slice(node.from, node.to)

        if (
          parent.name === 'ClassDeclaration' ||
          parent.name === 'InterfaceDeclaration' ||
          parent.name === 'EnumDeclaration'
        ) {
          defs.push({
            name: ident,
            from: node.from,
            to: node.to,
            kind: 'class',
            scope: javaScopeKey(parent),
            topLevel: true,
            exported: true, // Java 顶层类型天生对外可见，不该被「未使用」盯上
          })
          return
        }

        if (parent.name === 'MethodDeclaration' || parent.name === 'ConstructorDeclaration') {
          const info = readJavaParams(parent, text)
          defs.push({
            name: ident,
            from: node.from,
            to: node.to,
            kind: 'method',
            scope: javaScopeKey(parent),
            topLevel: false,
            exported: false,
            minArgs: info?.min,
            maxArgs: info?.max,
            paramTypes: info?.types ?? undefined,
          })
          return
        }

        if (parent.name === 'FormalParameter') {
          defs.push({
            name: ident,
            from: node.from,
            to: node.to,
            kind: 'param',
            scope: javaScopeKey(parent),
            topLevel: false,
            exported: false,
          })
          return
        }

        if (parent.name === 'VariableDeclarator') {
          const grand = parent.parent
          const isField = grand?.name === 'FieldDeclaration'
          defs.push({
            name: ident,
            from: node.from,
            to: node.to,
            kind: isField ? 'field' : 'var',
            scope: javaScopeKey(grand ?? parent),
            topLevel: false,
            exported: false,
          })
        }
        return
      }

      if (name === 'MethodInvocation') {
        const methodName = childNamed(node, 'MethodName')
        if (!methodName) return
        // 只有裸调用才进表：`obj.f()` 的 f 不在本文件的符号里
        const prefix = text.slice(node.from, methodName.from)
        if (prefix.includes('.')) return
        const args = childNamed(node, 'ArgumentList')
        const argTypes: SymArg[] = []
        if (args) {
          for (let ch = args.firstChild; ch; ch = ch.nextSibling) {
            if (ch.name === '(' || ch.name === ')' || ch.name === ',') continue
            argTypes.push(javaArg(ch, text))
          }
        }
        calls.push({
          name: text.slice(methodName.from, methodName.to),
          from: methodName.from,
          to: methodName.to,
          argc: argTypes.length,
          scope: javaScopeKey(node),
          argTypes,
        })
        return
      }

      if (name === 'Identifier') {
        const ident = text.slice(node.from, node.to)
        refs.set(ident, (refs.get(ident) ?? 0) + 1)
      }
    },
  })

  return { defs, calls, refs, imports }
}

/* -------------------------------------------------------------- 缓存 */

/**
 * 符号表按内容缓存。`analyze()` 一轮里四条规则共用同一张表；
 * 跨轮次（同一份内容重复分析，例如切回来）也能直接命中。
 */
const cache = new Map<string, SymTab>()
const CACHE_LIMIT = 4

export function symbolTable(lang: LangId, name: string, tree: Tree, text: string): SymTab | null {
  const key = `${lang}:${name}:${contentHash(text)}`
  const hit = cache.get(key)
  if (hit) return hit

  const table = TS_LANGS.has(lang)
    ? defsOfTs(text, tree)
    : JAVA_LANGS.has(lang)
      ? defsOfJava(text, tree)
      : null
  if (!table) return null

  cache.set(key, table)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return table
}
