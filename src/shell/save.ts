/**
 * 文件进出浏览器的唯一通道。
 *
 * 按 D-15 已移除 File System Access 的「持久句柄」能力：编辑器有自己的库，
 * 不再直连磁盘文件。这里只保留「读一个文件进来」和「把一个 Blob 送出去」。
 */
export const hasFsAccess = typeof window.showSaveFilePicker === 'function'

/** 打开系统选择器读取一个文件；不支持时返回 null 由调用方回落 input[type=file] */
export async function pickFile(): Promise<File | null> {
  if (!window.showOpenFilePicker) return null
  try {
    const [handle] = await window.showOpenFilePicker({ multiple: false })
    if (!handle) return null
    return await handle.getFile()
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return null
    throw err
  }
}

export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export function download(name: string, bytes: Uint8Array, mime = 'text/plain;charset=utf-8'): void {
  downloadBlob(name, new Blob([bytes as unknown as BlobPart], { type: mime }))
}

export type SaveOutcome = 'picker' | 'download' | 'cancelled'

/**
 * 优先让用户选位置直接写盘（Chromium），否则退回下载。
 * 用户取消时不降级为下载，避免「点了取消却下载了一份」。
 */
export async function saveAs(
  name: string,
  bytes: Uint8Array,
  mime = 'text/plain;charset=utf-8',
): Promise<SaveOutcome> {
  const writable = await openSaveTarget(name)
  if (writable === 'cancelled') return 'cancelled'
  if (writable) {
    await writable.write(bytes as unknown as BufferSource)
    await writable.close()
    return 'picker'
  }
  download(name, bytes, mime)
  return 'download'
}

/**
 * 拿到一个可写目标，供导出时边压边写（P3 流式增强）。
 * 返回 null 表示浏览器不支持，调用方应回落到 Blob + download。
 */
export async function openSaveTarget(
  name: string,
): Promise<FileSystemWritableFileStream | null | 'cancelled'> {
  if (!window.showSaveFilePicker) return null
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: name })
    return await handle.createWritable()
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return 'cancelled'
    throw err
  }
}
