export type SaveHow = 'handle' | 'picker' | 'download'

export const hasFsAccess = typeof window.showSaveFilePicker === 'function'

export async function pickFileWithHandle(): Promise<{ file: File; handle?: FileSystemFileHandle } | null> {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ multiple: false })
      if (!handle) return null
      const file = await handle.getFile()
      return { file, handle }
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null
      throw err
    }
  }
  return null
}

async function ensurePermission(handle: FileSystemFileHandle): Promise<boolean> {
  try {
    if (handle.queryPermission) {
      const state = await handle.queryPermission({ mode: 'readwrite' })
      if (state === 'granted') return true
    }
    if (handle.requestPermission) {
      return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
    }
    return true
  } catch {
    return false
  }
}

export async function writeToHandle(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<boolean> {
  if (!(await ensurePermission(handle))) return false
  const writable = await handle.createWritable()
  await writable.write(bytes as unknown as BufferSource)
  await writable.close()
  return true
}

export async function saveAs(
  name: string,
  bytes: Uint8Array,
  handle?: FileSystemFileHandle,
): Promise<{ how: SaveHow; handle?: FileSystemFileHandle }> {
  if (handle && (await writeToHandle(handle, bytes))) {
    return { how: 'handle', handle }
  }

  if (window.showSaveFilePicker) {
    try {
      const picked = await window.showSaveFilePicker({ suggestedName: name })
      if (await writeToHandle(picked, bytes)) return { how: 'picker', handle: picked }
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') throw err
      // 用户取消 → 不降级为下载，直接返回取消语义
      return { how: 'picker' }
    }
  }

  download(name, bytes)
  return { how: 'download' }
}

export function download(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
