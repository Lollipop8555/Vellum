/**
 * 凭据库：`vellum-ai` 库 + 信封加密 + profile 生命周期。
 *
 * 设计依据：plans/ai-assistant.md §5.2（存储）、§14.5（落点）、决策 D-02~D-07。
 *
 * 三条不可动摇的约束：
 * - **INV-1** apiKey 只允许出现在密文与解锁后的内存中。本模块不写日志、不拼错误文案，
 *   抛错只带 code（UI 负责翻译），因此异常对象里不会夹带明文。
 * - **D-02** 信封加密：PBKDF2-SHA256(600k) 派生 AES-GCM-256，salt/iv 每次全新，
 *   AAD 绑 `id:rev` —— 记录被搬动或旧版被重放到新 rev 上都会解密失败。
 * - **D-03** 密码只拒空；解锁失败与密文损坏给同一个结果（都是 `unlock_failed`），
 *   不区分「密码错」和「数据坏」，避免把库结构当侧信道。
 */

import { deflateSync, inflateSync, strToU8, zipSync } from 'fflate'
import { database, req } from './db'

const DB_NAME = 'vellum-ai'
const DB_VERSION = 1
const STORE = 'profiles'

/** KDF 迭代次数；解密以记录里的 `iter` 为准，改这里只影响新记录 */
const DEFAULT_ITER = 600_000
const SALT_BYTES = 16
const IV_BYTES = 12
const ENVELOPE_VERSION = 1

/* ------------------------------------------------------------- 口令格式 */

/**
 * 「口令」= 一段自带密文的可粘贴文本，用来把一套配置搬到另一个浏览器。
 *
 * 它**不是**本地信封的复制品（D-47）：本地信封的 AAD 绑 `id:rev`，跨设备毫无意义；
 * 而口令的明文只有三个元素（端点 / 密钥 / 模型清单），没有 id、没有名字、没有时间戳。
 * 所以走一条独立编码：裸排列 → deflate → AES-GCM → base64url。
 *
 * 布局（blob）：
 * ```
 * 0        verFlags  u8    高 4 位版本，低 4 位 flags（bit0 = 已 deflate）
 * 1        iterCode  u8    总迭代次数档位（见 TOKEN_ITERS）
 * 2..17    salt      16B
 * 18..29   iv        12B
 * 30..     cipher          AES-GCM(deflate(payload))，含 16B tag
 * 末 2B     crc16           覆盖前面全部字节
 * ```
 * AAD = 前 30 字节。零体积成本，但能挡住「把 iterCode 改成最低档再爆破」。
 *
 * payload（加密前的明文）：
 * ```
 * 0        scheme   u8  bit0: 0=https 1=http；bit1: 1=URL 原样未剥离协议
 * 1        urlLen   u8
 * 2..      url      utf8（已剥离 `https://` / `http://`，省 8 字节）
 * ..       keyLen   u8
 * ..       key      utf8
 * ..       count    u8
 * ..       (len u8 + model utf8) × count
 * ..       modelIdx u8
 * ```
 * 没有分隔符：每段前面先写长度，读的时候按长度取。所有长度前缀都是 1 字节，
 * 因此单字段上限 255 —— 超出直接报 `bad_token`，不做变长编码。
 */
const TOKEN_PREFIX = 'VELLUM-AI-2.'
const TOKEN_VERSION = 2
const TOKEN_HEAD_BYTES = 30
const TOKEN_TAG_BYTES = 16
const TOKEN_CRC_BYTES = 2
const TOKEN_MIN_BYTES = TOKEN_HEAD_BYTES + TOKEN_TAG_BYTES + TOKEN_CRC_BYTES
/** 单行容量上限（经典 PEM 宽度）；实际每行按总长均分，见 `wrapToken` */
const TOKEN_WRAP = 76
const TOKEN_FLAG_DEFLATE = 0b0001
const TOKEN_SCHEME_HTTP = 0b0001
const TOKEN_SCHEME_RAW = 0b0010
const TOKEN_MAX_FIELD = 0xff

/**
 * 口令的 KDF 比本地信封更贵（D-47）：它会被转发到微信、网盘、密码管理器，
 * 离线爆破的暴露面明显更大，而导入/导出是低频动作，多 0.4s 换一档强度划算。
 * `iterCode` 写在 blob 里，以后调高不会让老口令失效。
 */
const TOKEN_ITERS = [600_000, 1_000_000, 1_500_000, 2_000_000] as const
const TOKEN_ITER_DEFAULT = 1

/* ------------------------------------------------------------------ 类型 */

/**
 * 信封里的明文，仅存在于解锁后的内存。
 *
 * **一套配置 = 一个接口地址 + 一个密钥 + 一组模型**（D-41）。同一个 provider 常常给
 * 好几个可互换的模型（DeepSeek 的 flash / pro、OpenAI 的 mini / full），它们共用 key 与
 * 端点，所以把模型做成配置内的**清单**，而不是逼用户为每个模型各建一套配置。
 */
export interface ProfileConfig {
  /** OpenAI 兼容根地址，含 `/v1`，不带尾部斜杠由 transport 归一 */
  baseUrl: string
  apiKey: string
  /** 可选模型清单，去重保序，至少一个；顺序即切换器里的显示顺序 */
  models: string[]
  /** 当前选中的模型，必然 ∈ `models`；切换时只改这一项 */
  model: string
  temperature?: number
  maxTokens?: number
}

/**
 * 信封。除 `data` 外都是解密所需的参数，全部可公开。
 * `aad` 明文存一份是为了排查「为什么这条打不开」，真正参与校验的是解密时重新拼的那份。
 */
export interface Envelope {
  v: number
  kdf: 'PBKDF2-SHA256'
  iter: number
  /** base64 */
  salt: string
  /** base64 */
  iv: string
  aad: string
  /** base64 */
  data: string
}

/**
 * 落库行。索引字段即明文元数据，密文整体在 `env`，增删改单事务。
 *
 * 明文只有**用户自己起的配置名**和三个时间戳（D-40）：列表靠名字认人，不靠模型名。
 * 一套配置里有几个模型、用的哪个模型，都在信封里。
 */
export interface ProfileRecord {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number
  /** 每次保存配置自增；参与 AAD，所以旧密文不能重放到新 rev 上 */
  rev: number
  /** D-06：备份只记这个时间，不记在 settings 里 */
  lastBackupAt?: number
  env: Envelope
}

export type VaultErrorCode =
  | 'no_crypto'
  | 'empty_password'
  | 'empty_name'
  | 'bad_config'
  | 'unlock_failed'
  /** 口令外层不成立：前缀不认识、base64 坏掉、crc 对不上（与「密码错」分开） */
  | 'bad_token'
  | 'locked'
  | 'not_found'
  | 'io'

export class VaultError extends Error {
  readonly code: VaultErrorCode

  constructor(code: VaultErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'VaultError'
    this.code = code
  }
}

/* ------------------------------------------------------------------ 库 */

const db = database(DB_NAME, DB_VERSION, (d) => {
  if (!d.objectStoreNames.contains(STORE)) {
    d.createObjectStore(STORE, { keyPath: 'id' })
  }
})

/* ------------------------------------------------------------------ 编码 */

function toB64(bytes: Uint8Array): string {
  let bin = ''
  // 分块，避免大数组展开成参数时爆栈；JSON 信封目前很小，但别留雷
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function fromB64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

const bytes = (text: string) => new TextEncoder().encode(text)
const text = (data: ArrayBuffer | Uint8Array) =>
  new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data))

/* ------------------------------------------------------------------ 加解密 */

/**
 * `file://` 打开时 `crypto.subtle` 是 undefined（非安全上下文）。
 * 判两次：`subtle` 缺失是现象，`isSecureContext` 是原因。
 */
export function hasCrypto(): boolean {
  return typeof crypto !== 'undefined' && Boolean(crypto.subtle)
}

function requireCrypto(): void {
  if (!hasCrypto()) throw new VaultError('no_crypto')
}

async function deriveKey(password: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', bytes(password), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations: iter },
    base,
    { name: 'AES-GCM', length: 256 },
    // 不可导出：即使页面被 XSS，也拿不到派生密钥本体
    false,
    ['encrypt', 'decrypt'],
  )
}

function aadOf(id: string, rev: number): string {
  return `${id}:${rev}`
}

async function seal(
  id: string,
  rev: number,
  config: ProfileConfig,
  password: string,
): Promise<Envelope> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(password, salt, DEFAULT_ITER)
  const aad = aadOf(id, rev)
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: bytes(aad) },
    key,
    bytes(JSON.stringify(config)),
  )
  return {
    v: ENVELOPE_VERSION,
    kdf: 'PBKDF2-SHA256',
    iter: DEFAULT_ITER,
    salt: toB64(salt),
    iv: toB64(iv),
    aad,
    data: toB64(new Uint8Array(data)),
  }
}

async function openSealed(
  env: Envelope,
  password: string,
): Promise<{ config: ProfileConfig; key: CryptoKey }> {
  const salt = fromB64(env.salt)
  const iv = fromB64(env.iv)
  const key = await deriveKey(password, salt, env.iter)
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv as unknown as BufferSource,
      additionalData: bytes(env.aad),
    },
    key,
    fromB64(env.data) as unknown as BufferSource,
  )
  const parsed = JSON.parse(text(plain)) as unknown
  return { config: normalizeConfig(parsed), key }
}

/* ------------------------------------------------------------------ 口令编解码 */

/** CRC-16/CCITT-FALSE：只用来区分「口令复制坏了」和「密码错了」，不承担安全职责 */
function crc16(data: Uint8Array): number {
  let crc = 0xffff
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i] << 8
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc
}

/** base64url（去 padding）：`+` 在 query 里会被当空格，`/` 在聊天软件里会被断行 */
function toTokenB64(data: Uint8Array): string {
  return toB64(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromTokenB64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = normalized.length % 4
  return fromB64(pad ? normalized + '='.repeat(4 - pad) : normalized)
}

function pushField(out: number[], value: string): void {
  const raw = bytes(value)
  if (!raw.length || raw.length > TOKEN_MAX_FIELD) throw new VaultError('bad_config')
  out.push(raw.length)
  for (const byte of raw) out.push(byte)
}

function packTokenPayload(config: ProfileConfig): Uint8Array {
  // 协议几乎总是 https：剥掉能省 8 字节，不认识的写法原样存并置 bit1
  const url = config.baseUrl
  const isHttp = url.startsWith('http://')
  const rest = isHttp ? url.slice(7) : url.startsWith('https://') ? url.slice(8) : url
  let scheme = isHttp ? TOKEN_SCHEME_HTTP : 0
  if (rest === url) scheme |= TOKEN_SCHEME_RAW

  const out: number[] = [scheme]
  pushField(out, rest)
  pushField(out, config.apiKey)
  if (config.models.length > TOKEN_MAX_FIELD) throw new VaultError('bad_config')
  out.push(config.models.length)
  for (const model of config.models) pushField(out, model)
  const index = config.models.indexOf(config.model)
  out.push(index < 0 ? 0 : index)
  return new Uint8Array(out)
}

function unpackTokenPayload(data: Uint8Array): ProfileConfig {
  let at = 0
  const readByte = (): number => {
    if (at >= data.length) throw new VaultError('bad_token')
    return data[at++]
  }
  const readField = (): string => {
    const length = readByte()
    if (!length || at + length > data.length) throw new VaultError('bad_token')
    const value = text(data.subarray(at, at + length))
    at += length
    return value
  }

  const scheme = readByte()
  const rest = readField()
  const apiKey = readField()
  const count = readByte()
  const models: string[] = []
  for (let i = 0; i < count; i += 1) models.push(readField())
  const index = readByte()

  const raw = scheme & TOKEN_SCHEME_RAW
  const prefix = raw ? '' : scheme & TOKEN_SCHEME_HTTP ? 'http://' : 'https://'
  return normalizeConfig({
    baseUrl: prefix + rest,
    apiKey,
    models,
    model: models[index] ?? models[0],
  })
}

/**
 * 折行，**均分**而不是按 76 硬截。
 *
 * 硬截的毛病是末行长度完全看运气：总长 182 时是 76/76/30，末行只剩 30 个字符，
 * 看着像被截断；补装饰又会在密文里掺进非 base64 字符，出戏且要额外的剥离规则。
 *
 * 均分不引入任何新字符：行数仍按 76 的容量算（所以单行不会超过 76），
 * 再把这个总长平均摊到各行。同一个例子会变成 61/61/60 —— 三行几乎等长，
 * 整块看上去就是一个规规矩矩的密文块，粘贴出去也不会有多出来的符号。
 */
function wrapToken(flat: string): string {
  if (!flat) return ''
  const lines = Math.max(1, Math.ceil(flat.length / TOKEN_WRAP))
  const width = Math.ceil(flat.length / lines)
  const out: string[] = []
  for (let i = 0; i < flat.length; i += width) out.push(flat.slice(i, i + width))
  return out.join('\n')
}

export interface TokenResult {
  token: string
  /** 去掉换行后的字符数，UI 用来提示「复制了多长一段」 */
  chars: number
}

/**
 * 导出口令（D-47）。**必须先验证密码**：加密本身不挑密码，任何字符串都能「加密成功」，
 * 不验就会生成一段谁也打不开的文本。所以这里多一次 PBKDF2（约 0.4s）。
 */
export async function exportToken(id: string, password: string): Promise<TokenResult> {
  requireCrypto()
  if (!password) throw new VaultError('empty_password')
  const rec = await getProfile(id)
  if (!rec) throw new VaultError('not_found')

  let config: ProfileConfig
  try {
    config = (await openSealed(rec.env, password)).config
  } catch {
    throw new VaultError('unlock_failed')
  }

  const payload = packTokenPayload(config)
  const packed = deflateSync(payload, { level: 9 })
  const useDeflate = packed.length < payload.length

  const iterCode = TOKEN_ITER_DEFAULT
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))

  const head = new Uint8Array(TOKEN_HEAD_BYTES)
  head[0] = (TOKEN_VERSION << 4) | (useDeflate ? TOKEN_FLAG_DEFLATE : 0)
  head[1] = iterCode
  head.set(salt, 2)
  head.set(iv, 2 + SALT_BYTES)

  const key = await deriveKey(password, salt, TOKEN_ITERS[iterCode])
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
        additionalData: head as unknown as BufferSource,
      },
      key,
      (useDeflate ? packed : payload) as unknown as BufferSource,
    ),
  )

  const blob = new Uint8Array(TOKEN_HEAD_BYTES + cipher.length + TOKEN_CRC_BYTES)
  blob.set(head, 0)
  blob.set(cipher, TOKEN_HEAD_BYTES)
  const crc = crc16(blob.subarray(0, blob.length - TOKEN_CRC_BYTES))
  blob[blob.length - 2] = crc >> 8
  blob[blob.length - 1] = crc & 0xff

  const flat = TOKEN_PREFIX + toTokenB64(blob)
  return { token: wrapToken(flat), chars: flat.length }
}

/**
 * 导入口令：解出明文，**不落库**。落库由调用方在测试通过后自己调 `createProfile`
 * —— 口令的 id / 名字都没有意义，导入必然是「新记录 + 重封装」。
 *
 * 失败分两种，因为用户该做的事不同：
 * - `bad_token`：前缀、base64、crc 不成立 → 重新复制；
 * - `unlock_failed`：密码错或密文被改 → 核对密码（沿用 D-03，不区分两者）。
 */
export async function importToken(token: string, password: string): Promise<ProfileConfig> {
  requireCrypto()
  if (!password) throw new VaultError('empty_password')
  const flat = token.replace(/\s+/g, '')
  const at = flat.indexOf(TOKEN_PREFIX)
  if (at < 0) throw new VaultError('bad_token')
  // 只吃 base64url 字符：从聊天记录里一起复制过来的前后文字在这截掉
  const body = flat.slice(at + TOKEN_PREFIX.length)
  const end = body.search(/[^A-Za-z0-9_-]/)
  const core = end < 0 ? body : body.slice(0, end)

  let blob: Uint8Array
  try {
    blob = fromTokenB64(core)
  } catch {
    throw new VaultError('bad_token')
  }
  if (blob.length < TOKEN_MIN_BYTES) throw new VaultError('bad_token')

  const crcAt = blob.length - TOKEN_CRC_BYTES
  const expected = (blob[crcAt] << 8) | blob[crcAt + 1]
  if (crc16(blob.subarray(0, crcAt)) !== expected) throw new VaultError('bad_token')

  const verFlags = blob[0]
  if (verFlags >> 4 !== TOKEN_VERSION) throw new VaultError('bad_token')
  const iter = TOKEN_ITERS[blob[1]]
  if (!iter) throw new VaultError('bad_token')

  const head = blob.subarray(0, TOKEN_HEAD_BYTES)
  const salt = blob.slice(2, 2 + SALT_BYTES)
  const iv = blob.slice(2 + SALT_BYTES, TOKEN_HEAD_BYTES)
  const key = await deriveKey(password, salt, iter)

  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
        additionalData: head as unknown as BufferSource,
      },
      key,
      blob.subarray(TOKEN_HEAD_BYTES, crcAt) as unknown as BufferSource,
    )
  } catch {
    throw new VaultError('unlock_failed')
  }

  const raw = new Uint8Array(plain)
  let payload = raw
  if (verFlags & TOKEN_FLAG_DEFLATE) {
    try {
      payload = inflateSync(raw)
    } catch {
      throw new VaultError('bad_token')
    }
  }
  return unpackTokenPayload(payload)
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 手写库里的 JSON 与将来迁移过来的备份都要过这里，形状不对就当解密失败 */
function normalizeConfig(raw: unknown): ProfileConfig {
  if (!raw || typeof raw !== 'object') throw new VaultError('bad_config')
  const o = raw as Record<string, unknown>
  const baseUrl = typeof o.baseUrl === 'string' ? o.baseUrl.trim() : ''
  const apiKey = typeof o.apiKey === 'string' ? o.apiKey.trim() : ''
  const current = typeof o.model === 'string' ? o.model.trim() : ''
  // `models` 是清单，`model` 只表示「当前选哪个」。老记录只有 model：
  // 这里把它补成单元素清单，不用改库版本也不用迁移脚本。
  const models = [...new Set([...strList(o.models), ...(current ? [current] : [])])]
  if (!baseUrl || !apiKey || !models.length) throw new VaultError('bad_config')
  const out: ProfileConfig = {
    baseUrl,
    apiKey,
    models,
    // 当前模型被删掉时落到第一个，不留「指向不存在模型」的悬空状态
    model: models.includes(current) ? current : models[0],
  }
  if (typeof o.temperature === 'number' && Number.isFinite(o.temperature)) {
    out.temperature = o.temperature
  }
  if (typeof o.maxTokens === 'number' && Number.isFinite(o.maxTokens)) {
    out.maxTokens = Math.floor(o.maxTokens)
  }
  return out
}

/* ------------------------------------------------------------------ 解锁态 */

/**
 * 只存在于内存。`key` 不可导出，用来在「保存配置」时重新封装，避免再问一次密码；
 * 但 **查看/导出明文必须重新输密码**（D-05）—— 那条路径走 `reveal()`，不用这里的 key。
 */
interface Unlocked {
  id: string
  rev: number
  config: ProfileConfig
  key: CryptoKey
}

let session: Unlocked | null = null

export function isUnlocked(): boolean {
  return session !== null
}

/** 当前解锁的 profile id；未解锁为 null。UI 只读它，不持有 config（INV-1） */
export function unlockedId(): string | null {
  return session?.id ?? null
}

export function lock(): void {
  session = null
}

/* ------------------------------------------------------------------ 列表与 CRUD */

export async function listProfiles(): Promise<ProfileRecord[]> {
  const all = await db.read([STORE], (s) => req<ProfileRecord[]>(s(STORE).getAll()))
  return all.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

async function getProfile(id: string): Promise<ProfileRecord | undefined> {
  return db.read([STORE], (s) => req<ProfileRecord | undefined>(s(STORE).get(id)))
}

async function putProfile(rec: ProfileRecord): Promise<void> {
  await db.write([STORE], async (s) => {
    s(STORE).put(rec)
  })
}

/**
 * 新建 profile。名称只做「非空」校验（与 D-03 的宽松口径一致），重名允许 —— id 才是键。
 * 创建后 **不自动解锁**：调用方负责接着调 `unlock()`，少一条隐式状态。
 */
export async function createProfile(
  name: string,
  password: string,
  config: ProfileConfig,
): Promise<ProfileRecord> {
  requireCrypto()
  const trimmed = name.trim()
  if (!trimmed) throw new VaultError('empty_name')
  if (!password) throw new VaultError('empty_password')

  const clean = normalizeConfig(config)
  const now = Date.now()
  const id = crypto.randomUUID()
  const rev = 1
  const rec: ProfileRecord = {
    id,
    name: trimmed,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    rev,
    env: await seal(id, rev, clean, password),
  }
  await putProfile(rec)
  return rec
}

/**
 * 解锁：解出明文放进内存（INV-1 允许的「解锁后的内存」）。
 * 任何失败（密码错、密文损坏、字段缺失）统一成 `unlock_failed`（D-03）。
 */
export async function unlock(id: string, password: string): Promise<ProfileConfig> {
  requireCrypto()
  if (!password) throw new VaultError('empty_password')

  const rec = await getProfile(id)
  if (!rec) throw new VaultError('not_found')

  let opened: { config: ProfileConfig; key: CryptoKey }
  try {
    // 只派生一次：600k 次迭代在低端机上是实打实的百毫秒级开销
    opened = await openSealed(rec.env, password)
  } catch {
    throw new VaultError('unlock_failed')
  }

  const { config, key } = opened
  session = { id: rec.id, rev: rec.rev, config, key }

  // lastUsedAt 只影响排序，写失败不该让解锁失败
  const touched = { ...rec, lastUsedAt: Date.now() }
  void putProfile(touched).catch(() => {})

  return config
}

/** 给 UI 用的只读副本：返回副本而不是引用，避免面板顺手改到解锁态（`models` 也要浅拷一层） */
export function getConfig(): ProfileConfig | null {
  if (!session) return null
  return { ...session.config, models: [...session.config.models] }
}

/**
 * 保存配置（需已解锁）。用内存里的 key 重新封装，rev 自增，
 * 因此上一次导出的密文立刻作废（AAD 不匹配）。
 */
export async function saveConfig(patch: Partial<ProfileConfig>): Promise<void> {
  if (!session) throw new VaultError('locked')
  const rec = await getProfile(session.id)
  if (!rec) {
    lock()
    throw new VaultError('not_found')
  }

  const merged = normalizeConfig({ ...session.config, ...patch })
  const rev = rec.rev + 1
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const aad = aadOf(rec.id, rev)
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: bytes(aad) },
    session.key,
    bytes(JSON.stringify(merged)),
  )

  const now = Date.now()
  const next: ProfileRecord = {
    ...rec,
    rev,
    updatedAt: now,
    lastUsedAt: now,
    env: {
      ...rec.env,
      iter: rec.env.iter,
      iv: toB64(iv),
      aad,
      data: toB64(new Uint8Array(data)),
    },
  }
  await putProfile(next)
  session = { ...session, rev, config: merged }
}

/**
 * 切换当前模型（需已解锁）。只动 `model`，不碰清单；不在清单里的值直接拒绝 ——
 * 模型名会原样发给接口，不能让它变成任意字符串。
 *
 * 走 `saveConfig` 会 rev++ 并重写密文：多一次 AES，但没有 PBKDF2，代价可忽略；
 * 换来的是「下次解锁还记得你上次选的模型」。
 */
export async function switchModel(model: string): Promise<void> {
  if (!session) throw new VaultError('locked')
  const next = model.trim()
  if (!next || !session.config.models.includes(next)) throw new VaultError('bad_config')
  if (next === session.config.model) return
  await saveConfig({ model: next })
}

/** 改名只动明文元数据，不重新加密（密文只保护 config） */
export async function renameProfile(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new VaultError('empty_name')
  const rec = await getProfile(id)
  if (!rec) throw new VaultError('not_found')
  await putProfile({ ...rec, name: trimmed, updatedAt: Date.now() })
}

export async function deleteProfile(id: string): Promise<void> {
  await db.write([STORE], async (s) => {
    s(STORE).delete(id)
  })
  if (session?.id === id) lock()
}

/**
 * D-05：查看/导出明文必须重新解锁。
 * 不复用内存里的 key —— 否则「离开工位的同事点一下导出」就能拿到 key。
 * 成功后不顺带替换解锁态（他要的可能不是当前这份）。
 */
export async function reveal(id: string, password: string): Promise<ProfileConfig> {
  requireCrypto()
  if (!password) throw new VaultError('empty_password')
  const rec = await getProfile(id)
  if (!rec) throw new VaultError('not_found')
  try {
    return (await openSealed(rec.env, password)).config
  } catch {
    throw new VaultError('unlock_failed')
  }
}

/* ------------------------------------------------------------------ 备份 */

export interface BackupResult {
  fileName: string
  blob: Blob
  count: number
  bytes: number
}

/**
 * D-06：把所有**信封**打成一个无密码 zip。zip 里没有明文，所以不需要密码 ——
 * 有了密码反而会有「忘记备份密码 = 备份作废」的第二个失败面。
 * 备份成功后给每条记录打 `lastBackupAt`（备份是一次性动作，值相同）。
 */
export async function exportBackup(at = new Date()): Promise<BackupResult> {
  const all = await listProfiles()
  if (!all.length) throw new VaultError('not_found')

  const files: Record<string, Uint8Array> = {}
  const used = new Set<string>()
  for (const rec of all) {
    // 文件名：可读名 + id 前缀，重名不影响 —— zip 内路径必须唯一
    const base = rec.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'profile'
    let path = `profiles/${base}-${rec.id.slice(0, 8)}.json`
    let n = 2
    while (used.has(path)) {
      path = `profiles/${base}-${rec.id.slice(0, 8)}-${n}.json`
      n += 1
    }
    used.add(path)
    files[path] = strToU8(JSON.stringify(rec, null, 2))
  }

  const manifest = {
    app: 'vellum',
    kind: 'ai-vault-backup',
    v: 1,
    at: at.toISOString(),
    note: '仅含加密信封与公开元数据，不含 apiKey。恢复需要原密码。',
    profiles: all.map((p) => ({ id: p.id, name: p.name, rev: p.rev, updatedAt: p.updatedAt })),
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))

  const zip = zipSync(files, { level: 6 })
  const blob = new Blob([zip as unknown as BlobPart], { type: 'application/zip' })

  const stamp = `${at.getFullYear()}${`${at.getMonth() + 1}`.padStart(2, '0')}${`${at.getDate()}`.padStart(2, '0')}`
  const now = at.getTime()
  await db.write([STORE], async (s) => {
    for (const rec of all) s(STORE).put({ ...rec, lastBackupAt: now })
  })

  return {
    fileName: `vellum-ai-vault-${stamp}.zip`,
    blob,
    count: all.length,
    bytes: blob.size,
  }
}
