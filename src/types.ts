export type EngineId = 'cm' | 'monaco'

export type EncodingId =
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  | 'gb18030'
  | 'big5'
  | 'shift_jis'
  | 'windows-1252'

/** 只有 utf-8 支持写回；其余仅解码 */
export const WRITABLE_ENCODINGS: EncodingId[] = ['utf-8']

export interface FileRecord {
  id: string
  name: string
  size: number
  blob: Blob
  lang: string
  encoding: EncodingId
  eol: 'lf' | 'crlf'
  engine: EngineId
  readOnly: boolean
  dirty: boolean
  /** 仅在支持 File System Access 且用户授权后存在，无法跨浏览器迁移 */
  handle?: FileSystemFileHandle
  /** 原始字节副本，用于“以其他编码重新解码”；大文件不保存 */
  originalBytes?: Blob
  createdAt: number
  updatedAt: number
}

export interface SnapshotRecord {
  id: string
  fileId: string
  blob: Blob
  createdAt: number
  note: string
}

export interface MetaRecord {
  key: string
  value: unknown
}

export type FileMode = 'full' | 'light' | 'readonly' | 'rejected'

export interface OpenResult {
  text: string
  encoding: EncodingId
  eol: 'lf' | 'crlf'
  size: number
}

export interface Settings {
  theme: 'dark' | 'light'
  language: 'zh' | 'en' | 'auto'
  fontSize: number
  accentOn: boolean
  defaultEngine: EngineId
  wordWrap: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  language: 'auto',
  fontSize: 13,
  accentOn: true,
  defaultEngine: 'cm',
  wordWrap: false,
}
