// Augmentations for File System Access API members not yet in TypeScript's lib.dom.
interface FileSystemDirectoryHandle {
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<FileSystemHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

interface FileSystemFileHandle {
  // Chromium-only; feature-detected before use.
  move?(newName: string): Promise<void>;
}
