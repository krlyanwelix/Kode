import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, unlink, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve, relative, sep } from "node:path";
import type { ExecdClient } from "./client.js";

const SKIP = new Set([".git", "node_modules", "data", "dist", "build", "coverage", ".next", ".venv", "venv", "__pycache__", ".cache", ".mem0", ".codegraph", ".ssh", ".aws", ".azure", ".docker", ".codex"]);
const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
export interface FileState { hash: string; mode: number }
export type Snapshot = Map<string, FileState>;

export function included(path: string): boolean {
  return !path.split("/").some((part) => SKIP.has(part.toLowerCase()) || /^\.env(?:\.|$)|^\.npmrc$|^\.pypirc$|^id_(?:rsa|ed25519)|\.(?:pem|key|sqlite(?:3)?|db)$/i.test(part));
}

export function relativePath(path: string): string {
  if (!path || path.split("/").some((part) => !part || /[. ]$|[\\<>:"|?*\x00-\x1f]|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Invalid workspace path: ${path}`);
  }
  return path;
}

function hash(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function state(content: Buffer, mode: number): FileState { return { hash: hash(content), mode: mode & 0o777 }; }
function same(a: FileState | undefined, b: FileState | undefined): boolean {
  return a?.hash === b?.hash && (process.platform === "win32" || a?.mode === b?.mode);
}

/** Never follow a link while applying container output back to the host. */
async function hostPath(root: string, path: string): Promise<string> {
  let target = root;
  for (const part of relativePath(path).split("/")) {
    target = join(target, part);
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (info?.isSymbolicLink()) throw new Error(`Refusing symlink in host path: ${path}`);
  }
  return target;
}

/** Copy a bounded project snapshot; secrets, generated files and symlinks stay on the host. */
export async function uploadWorkspace(root: string, client: ExecdClient, signal?: AbortSignal): Promise<Snapshot> {
  const snapshot: Snapshot = new Map();
  let bytes = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const path = prefix + entry.name;
      if (!included(path) || entry.isSymbolicLink()) continue;
      relativePath(path);
      if (entry.isDirectory()) { await walk(join(directory, entry.name), `${path}/`); continue; }
      if (!entry.isFile()) continue;
      const target = await hostPath(root, path);
      const info = await lstat(target);
      if (info.size > MAX_FILE_BYTES || bytes + info.size > MAX_BYTES || snapshot.size >= MAX_FILES) throw new Error("Workspace snapshot exceeds 10,000 files, 16 MiB per file or 64 MiB total");
      const content = await readFile(target);
      if (content.length > MAX_FILE_BYTES || bytes + content.length > MAX_BYTES) throw new Error("Workspace snapshot exceeds byte limits");
      bytes += content.length;
      snapshot.set(path, state(content, info.mode));
      await client.writeFile(path, content.toString("base64"), "base64", signal, info.mode & 0o777);
    }
  };
  await walk(resolve(root), "");
  return snapshot;
}

export interface Change { path: string; before?: FileState; after?: FileState }
export interface ExportResult { directory: string; changes: Change[]; conflicts: string[]; applied: boolean }

/** Always save the complete change set before checking or modifying host files. */
export async function exportWorkspace(root: string, client: ExecdClient, before: Snapshot, directory: string, apply: boolean): Promise<ExportResult> {
  directory = await hostPath(root, relative(root, directory).split(sep).join("/"));
  const after: Snapshot = new Map();
  const changes: Change[] = [];
  let bytes = 0;
  const walk = async (prefix: string): Promise<void> => {
    const { entries } = await client.listDirectory(prefix || ".");
    for (const entry of entries) {
      const path = prefix + entry.name;
      relativePath(path);
      if (!included(path)) continue;
      if (entry.type === "directory") { await walk(`${path}/`); continue; }
      if (entry.type !== "file") throw new Error(`Refusing sandbox link or special file: ${path}`);
      if (entry.size > MAX_FILE_BYTES || bytes + entry.size > MAX_BYTES || after.size >= MAX_FILES) throw new Error("Sandbox export exceeds workspace limits");
      const file = await client.readFile(path, "base64");
      const content = Buffer.from(file.content, "base64");
      if (content.length > MAX_FILE_BYTES || bytes + content.length > MAX_BYTES) throw new Error("Sandbox export exceeds workspace limits");
      bytes += content.length;
      const value = state(content, file.mode ?? before.get(path)?.mode ?? 0o644);
      after.set(path, value);
      if (same(before.get(path), value)) continue;
      const target = join(directory, "files", ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      changes.push({ path, before: before.get(path), after: value });
    }
  };
  await walk("");
  for (const [path, value] of before) if (!after.has(path)) changes.push({ path, before: value });
  const conflicts: string[] = [];
  if (apply) {
    for (const change of changes) {
      try {
        const target = await hostPath(root, change.path);
        const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
        const current = info?.isFile() ? state(await readFile(target), info.mode) : undefined;
        if ((info && !info.isFile()) || !same(current, change.before)) conflicts.push(change.path);
      } catch { conflicts.push(change.path); }
    }
  }
  const result: ExportResult = { directory, changes, conflicts, applied: false };
  await mkdir(directory, { recursive: true });
  const manifest = join(directory, "changes.json");
  await writeFile(manifest, JSON.stringify(result, null, 2));
  if (apply && conflicts.length === 0) {
    for (const change of changes) {
      const target = await hostPath(root, change.path);
      if (!change.after) { await unlink(target); continue; }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(join(directory, "files", ...change.path.split("/"))));
      if (process.platform !== "win32") await chmod(target, change.after.mode);
    }
    result.applied = true;
    await writeFile(manifest, JSON.stringify(result, null, 2));
  }
  return result;
}
