import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecdClient } from "./client.js";
import { exportWorkspace, uploadWorkspace, relativePath } from "./workspace.js";

function remote() {
  const files = new Map<string, { content: string; mode: number }>();
  const client = {
    async writeFile(path: string, content: string, encoding: string, _signal?: AbortSignal, mode = 0o644) {
      files.set(path, { content: encoding === "base64" ? content : Buffer.from(content).toString("base64"), mode });
    },
    async readFile(path: string, encoding: string) {
      const file = files.get(path);
      if (!file) throw new Error("missing file");
      return { ...file, content: encoding === "base64" ? file.content : Buffer.from(file.content, "base64").toString(), size: Buffer.from(file.content, "base64").length };
    },
    async listDirectory(path: string) {
      const prefix = path === "." ? "" : path;
      const entries = new Map<string, { name: string; type: string; size: number }>();
      for (const [file, value] of files) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const name = rest.split("/")[0]!;
        entries.set(name, { name, type: rest.includes("/") ? "directory" : "file", size: rest.includes("/") ? 0 : Buffer.from(value.content, "base64").length });
      }
      return { entries: [...entries.values()] };
    },
  } as unknown as ExecdClient;
  return { client, files };
}

test("workspace copies binary files, excludes secrets and exports additions, edits and deletions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.txt"), "original");
  await writeFile(join(root, "remove.txt"), "remove");
  await writeFile(join(root, ".env"), "SECRET=never-copy");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "dependency.js"), "ignored");
  const { client, files } = remote();
  const before = await uploadWorkspace(root, client);
  assert.deepEqual([...before.keys()].sort(), ["remove.txt", "source.txt"]);
  files.delete("remove.txt");
  await client.writeFile("source.txt", "updated");
  await client.writeFile("nested/blob.bin", Buffer.from([0, 255, 42]).toString("base64"), "base64");
  const result = await exportWorkspace(root, client, before, join(root, "data", "export"), true);
  assert.equal(result.applied, true);
  assert.equal(result.changes.length, 3);
  assert.equal(await readFile(join(root, "source.txt"), "utf8"), "updated");
  assert.deepEqual(await readFile(join(root, "nested", "blob.bin")), Buffer.from([0, 255, 42]));
  await assert.rejects(readFile(join(root, "remove.txt")), /ENOENT/);
  assert.equal(await readFile(join(root, ".env"), "utf8"), "SECRET=never-copy");
  assert.equal(JSON.parse(await readFile(join(result.directory, "changes.json"), "utf8")).applied, true);
});

test("a host conflict prevents every change from being applied, while artifacts remain available", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.txt"), "original");
  const { client } = remote();
  const before = await uploadWorkspace(root, client);
  await client.writeFile("source.txt", "agent edit");
  await client.writeFile("new.txt", "agent addition");
  await writeFile(join(root, "source.txt"), "user edit");
  const result = await exportWorkspace(root, client, before, join(root, "data", "export"), true);
  assert.deepEqual(result.conflicts, ["source.txt"]);
  assert.equal(result.applied, false);
  assert.equal(await readFile(join(root, "source.txt"), "utf8"), "user edit");
  await assert.rejects(readFile(join(root, "new.txt")), /ENOENT/);
  assert.equal(await readFile(join(result.directory, "files", "source.txt"), "utf8"), "agent edit");
});

test("export-only mode never writes the source workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { client } = remote();
  await client.writeFile("new.txt", "agent addition");
  const result = await exportWorkspace(root, client, new Map(), join(root, "data", "export"), false);
  assert.equal(result.applied, false);
  await assert.rejects(readFile(join(root, "new.txt")), /ENOENT/);
  assert.equal(await readFile(join(result.directory, "files", "new.txt"), "utf8"), "agent addition");
});

test("host junctions cannot redirect exported files outside the workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-links-"));
  const outside = await mkdtemp(join(tmpdir(), "sandbox-outside-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const { client } = remote();
  await client.writeFile("linked/escape.txt", "must stay inside");
  const result = await exportWorkspace(root, client, new Map(), join(root, "data", "export"), true);
  assert.equal(result.applied, false);
  assert.deepEqual(result.conflicts, ["linked/escape.txt"]);
  await assert.rejects(readFile(join(outside, "escape.txt")), /ENOENT/);
});

test("container paths cannot escape or address Windows devices", () => {
  for (const path of ["../escape", "/absolute", "a/../../escape", "C:/escape", "a\\escape", "a\u0000b", "NUL", "CON.txt", "data /agent.sqlite"]) {
    assert.throws(() => relativePath(path), /Invalid workspace path/);
  }
});
