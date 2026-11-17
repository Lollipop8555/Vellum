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

import { strToU8, zipSync } from 'fflate'
import { database, req } from './db'

const DB_NAME = 'vellum-ai'
const DB_VERSION = 1
const STORE = 'profiles'

/** KDF 迭代次数；解密以记录里的 `iter` 为准，改这里只影响新记录 */
const DEFAULT_ITER = 600_000
const SALT_BYTES = 16
const IV_BYTES = 12
const ENVELOPE_VERSION = 1

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
