import { Injectable, signal } from '@angular/core';

export interface TreeNode {
  name: string;
  path: string; // POSIX-style relative path, e.g. "src/main.py"
  kind: 'file' | 'directory';
  children?: TreeNode[];
}

/**
 * Workspace file system backed by OPFS (Origin Private File System).
 * Files live entirely in the browser and persist across reloads with no backend.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  readonly tree = signal<TreeNode[]>([]);
  readonly ready = signal(false);

  private root!: FileSystemDirectoryHandle;

  async init(): Promise<void> {
    if (this.ready()) return;
    this.root = await navigator.storage.getDirectory();
    await this.seedIfEmpty();
    await this.refresh();
    this.ready.set(true);
  }

  async refresh(): Promise<void> {
    this.tree.set(await this.listDir(this.root, ''));
  }

  async readFile(path: string): Promise<string> {
    const { dir, name } = await this.parent(path);
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return file.text();
  }

  async writeFile(path: string, content: string): Promise<void> {
    const { dir, name } = await this.parent(path, true);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    await this.refresh();
  }

  async createFolder(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    let dir = this.root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    await this.refresh();
  }

  async delete(path: string): Promise<void> {
    const { dir, name } = await this.parent(path);
    await dir.removeEntry(name, { recursive: true });
    await this.refresh();
  }

  async rename(path: string, newName: string): Promise<string> {
    const { dir, name } = await this.parent(path);
    const newPath = [...path.split('/').slice(0, -1), newName].join('/');
    const handle = await dir.getFileHandle(name).catch(() => null);
    if (handle && typeof handle.move === 'function') {
      await handle.move(newName);
    } else if (handle) {
      // Fallback: copy + delete
      const file = await handle.getFile();
      const target = await dir.getFileHandle(newName, { create: true });
      const writable = await target.createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();
      await dir.removeEntry(name);
    } else {
      // Directory rename: recursive copy + delete
      const source = await dir.getDirectoryHandle(name);
      const target = await dir.getDirectoryHandle(newName, { create: true });
      await this.copyDir(source, target);
      await dir.removeEntry(name, { recursive: true });
    }
    await this.refresh();
    return newPath;
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { dir, name } = await this.parent(path);
      const entries: string[] = [];
      for await (const key of dir.keys()) entries.push(key);
      return entries.includes(name);
    } catch {
      return false;
    }
  }

  /** Replace the whole workspace with the given files (cloud project load). */
  async replaceAll(files: { path: string; content: string }[]): Promise<void> {
    const names: string[] = [];
    for await (const key of this.root.keys()) names.push(key);
    for (const name of names) {
      await this.root.removeEntry(name, { recursive: true });
    }
    for (const file of files) {
      await this.writeFile(file.path, file.content);
    }
    await this.refresh();
  }

  /** All files under the workspace as {path, content} — used by runners. */
  async snapshot(): Promise<{ path: string; content: string }[]> {
    const files: { path: string; content: string }[] = [];
    const walk = async (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === 'file') {
          files.push({ path: node.path, content: await this.readFile(node.path) });
        } else if (node.children) {
          await walk(node.children);
        }
      }
    };
    await walk(this.tree());
    return files;
  }

  private async parent(
    path: string,
    create = false,
  ): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error(`Invalid path: ${path}`);
    let dir = this.root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return { dir, name };
  }

  private async listDir(dir: FileSystemDirectoryHandle, prefix: string): Promise<TreeNode[]> {
    const nodes: TreeNode[] = [];
    for await (const [name, handle] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        nodes.push({
          name,
          path,
          kind: 'directory',
          children: await this.listDir(handle as FileSystemDirectoryHandle, path),
        });
      } else {
        nodes.push({ name, path, kind: 'file' });
      }
    }
    return nodes.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === 'directory' ? -1 : 1) : a.name.localeCompare(b.name),
    );
  }

  private async copyDir(
    source: FileSystemDirectoryHandle,
    target: FileSystemDirectoryHandle,
  ): Promise<void> {
    for await (const [name, handle] of source.entries()) {
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile();
        const out = await target.getFileHandle(name, { create: true });
        const writable = await out.createWritable();
        await writable.write(await file.arrayBuffer());
        await writable.close();
      } else {
        const sub = await target.getDirectoryHandle(name, { create: true });
        await this.copyDir(handle as FileSystemDirectoryHandle, sub);
      }
    }
  }

  private async seedIfEmpty(): Promise<void> {
    for await (const _ of this.root.keys()) return; // not empty
    await this.writeFile(
      'welcome.js',
      [
        '// Welcome to browser-ide!',
        '// Everything here runs locally in YOUR browser — the server never executes code.',
        '',
        "console.log('Hello from your own machine!');",
        '',
      ].join('\n'),
    );
  }
}
