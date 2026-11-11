// File System Access API 中未进入 lib.dom 的部分
export {}

declare global {
  interface Window {
    showOpenFilePicker?(options?: {
      multiple?: boolean
      excludeAcceptAllOption?: boolean
      types?: { description?: string; accept: Record<string, string[]> }[]
    }): Promise<FileSystemFileHandle[]>
    showSaveFilePicker?(options?: {
      suggestedName?: string
      types?: { description?: string; accept: Record<string, string[]> }[]
    }): Promise<FileSystemFileHandle>
  }

  interface FileSystemFileHandle {
    queryPermission?(d?: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
    requestPermission?(d?: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  }
}
