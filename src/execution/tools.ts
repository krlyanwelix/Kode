import { globToRegExp } from "../tools.js";
import type { Tool } from "../types.js";
import type { ExecdClient } from "./client.js";
import { included, relativePath } from "./workspace.js";

function argsObject(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool arguments must be an object");
  return args as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function pathOf(value: unknown): string {
  let path = text(value, "path");
  if (path === "/workspace" || path === ".") return ".";
  if (path.startsWith("/workspace/")) path = path.slice(11);
  return relativePath(path);
}
function limit(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.floor(value))) : fallback;
}

/** Same schemas and permissions as local tools; all workspace I/O uses execd. */
export function sandboxTools(tools: Tool[], getClient: () => ExecdClient): Tool[] {
  return tools.map((tool) => {
    const name = tool.definition.name;
    if (name === "load_skill" || (tool.capabilities?.length && tool.capabilities.every((capability) => capability === "network"))) return tool;
    return {
      ...tool,
      definition: { ...tool.definition, ...(name === "bash" ? { description: "Run a shell command inside the Linux sandbox at /workspace." } : {}) },
      async execute(args, context) {
        const client = getClient();
        const input = argsObject(args);
        const signal = context?.signal;
        if (name === "bash") {
          const result = await client.run(text(input.command, "command"), { signal, timeoutMs: limit(input.timeoutMs, 30_000, 120_000) });
          return [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : "", `exit_code: ${result.exitCode}`].filter(Boolean).join("\n");
        }
        if (name === "read" || name === "write" || name === "edit") {
          const path = pathOf(input.path);
          if (name === "write") {
            if (typeof input.content !== "string") throw new Error("content must be a string");
            await client.writeFile(path, input.content, "utf-8", signal);
            return `Wrote ${input.content.length} characters to ${path}`;
          }
          const file = await client.readFile(path, "utf-8", signal);
          if (name === "edit") {
            const oldText = text(input.oldText, "oldText");
            if (typeof input.newText !== "string") throw new Error("newText must be a string");
            const count = file.content.split(oldText).length - 1;
            if (count !== 1) throw new Error(count === 0 ? "oldText was not found" : "oldText must match exactly once");
            await client.writeFile(path, file.content.replace(oldText, input.newText), "utf-8", signal, file.mode);
            return `Edited ${path}`;
          }
          const start = limit(input.offset, 1, Number.MAX_SAFE_INTEGER) - 1;
          const lines = file.content.split(/\r?\n/).slice(start, input.limit === undefined ? undefined : start + limit(input.limit, 100, Number.MAX_SAFE_INTEGER));
          return `${lines.map((line, index) => `${start + index + 1}: ${line}`).join("\n")}\n（行号 "N: " 只是显示用的，不属于文件内容；edit 的 oldText 不要包含它）`;
        }
        if (name !== "glob" && name !== "grep") throw new Error(`Tool ${name} has no sandbox adapter; host workspace access is disabled in Docker mode`);
        const base = pathOf(input.path ?? ".");
        const pattern = text(input.pattern, "pattern");
        const files: string[] = [];
        let capped = false;
        const walk = async (path: string, prefix: string, depth = 0): Promise<void> => {
          if (depth > 12 || capped) return;
          for (const entry of (await client.listDirectory(path, signal)).entries) {
            if (!included(prefix + entry.name)) continue;
            const target = path === "." ? relativePath(entry.name) : `${path}/${relativePath(entry.name)}`;
            if (entry.type === "directory") await walk(target, `${prefix}${entry.name}/`, depth + 1);
            else if (entry.type === "file" && entry.size <= 2 * 1024 * 1024) files.push(prefix + entry.name);
            if (files.length >= 5000) { capped = true; return; }
          }
        };
        await walk(base, "");
        if (name === "glob") {
          const matches = files.filter((file) => globToRegExp(pattern).test(file)).slice(0, limit(input.maxResults, 200, 1000));
          return matches.length ? `${matches.join("\n")}\n(${matches.length} files${capped ? "; capped" : ""})` : `No file matched ${pattern} under ${base}.`;
        }
        const expression = new RegExp(pattern, input.caseSensitive === true ? "" : "i");
        const filter = typeof input.glob === "string" ? globToRegExp(input.glob) : undefined;
        const matches: string[] = [];
        const maximum = limit(input.maxMatches, 100, 500);
        for (const file of files) {
          if (filter && !filter.test(String(input.glob).includes("/") ? file : file.split("/").at(-1)!)) continue;
          const content = (await client.readFile(base === "." ? file : `${base}/${file}`, "base64", signal)).content;
          const buffer = Buffer.from(content, "base64");
          if (buffer.subarray(0, 4096).includes(0)) continue;
          for (const [index, line] of buffer.toString("utf8").split(/\r?\n/).entries()) {
            if (line.length <= 400 && expression.test(line)) matches.push(`${file}:${index + 1}: ${line.trim().slice(0, 240)}`);
            if (matches.length >= maximum) break;
          }
          if (matches.length >= maximum) break;
        }
        return matches.length ? `${matches.join("\n")}\n(${matches.length} matches)` : `No match for ${pattern} (${files.length} files scanned).`;
      },
    };
  });
}
