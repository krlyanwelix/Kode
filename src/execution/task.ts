import { resolve, join } from "node:path";
import type { Agent, RunOptions } from "../agent.js";
import type { AgentEvent, Tool } from "../types.js";
import type { VerifyCheck, VerifyResult } from "../harness/verify.js";
import { ControlPlaneClient, ExecdClient } from "./client.js";
import { sandboxTools } from "./tools.js";
import { uploadWorkspace, exportWorkspace, type Snapshot } from "./workspace.js";

const activeRoots = new Set<string>();

/** One sandbox per run; local mode preserves the existing tools and history. */
export class TaskExecution {
  readonly tools: Tool[];
  readonly docker: boolean;
  private client?: ExecdClient;
  private readonly root: string;
  private readonly control: ControlPlaneClient;

  constructor(tools: Tool[], private readonly options: {
    root?: string; env?: NodeJS.ProcessEnv; allowChanges?: boolean;
  } = {}) {
    const env = options.env ?? process.env;
    const mode = env.AGENT_EXECUTION ?? "local";
    if (mode !== "local" && mode !== "docker") throw new Error("AGENT_EXECUTION must be local or docker");
    this.docker = mode === "docker";
    this.root = resolve(options.root ?? process.cwd());
    this.control = new ControlPlaneClient({ baseUrl: env.SANDBOX_URL });
    this.tools = this.docker ? sandboxTools(tools, () => {
      if (!this.client) throw new Error("Sandbox is not ready");
      return this.client;
    }) : tools;
  }

  /** The completion gate executes in the same container as the tool calls. */
  readonly verify = async (_directory: string, checks: VerifyCheck[], signal?: AbortSignal): Promise<VerifyResult[]> => {
    if (!this.client) throw new Error("Sandbox is not ready");
    const results: VerifyResult[] = [];
    for (const check of checks) {
      const result = await this.client.run(check.command, { timeoutMs: check.timeoutMs ?? 60_000, signal });
      results.push({ name: check.name, pass: result.exitCode === 0, output: `${result.stdout}\n${result.stderr}\nexit_code: ${result.exitCode}`.slice(0, 1200) });
    }
    return results;
  };

  async *run(agent: Agent, input: string, runOptions: RunOptions = {}): AsyncGenerator<AgentEvent> {
    if (!this.docker) { yield* agent.run(input, runOptions); return; }
    const env = this.options.env ?? process.env;
    const lock = process.platform === "win32" ? this.root.toLowerCase() : this.root;
    if (activeRoots.has(lock)) throw new Error("A sandbox task is already running in this workspace; wait for it to finish");
    activeRoots.add(lock);
    let id: string | undefined;
    let before: Snapshot | undefined;
    let end: Extract<AgentEvent, { type: "agent_end" }> | undefined;
    let failure: unknown;
    let exportFailed = false;
    try {
      // No host environment variables or model credentials are sent to the container.
      const created = await this.control.create({ image: env.SANDBOX_IMAGE, ttlSeconds: 1800 });
      id = created.id;
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Control plane returned an invalid sandbox ID");
      runOptions.signal?.throwIfAborted();
      await this.control.waitReady(id, 120_000, runOptions.signal);
      this.client = new ExecdClient(await this.control.endpoint(id, created.execdPort));
      before = await uploadWorkspace(this.root, this.client, runOptions.signal);
      yield { type: "warning", message: `Sandbox ready: ${id}. Workspace tools and checks run in /workspace.` };
      try {
        for await (const event of agent.run(input, runOptions)) {
          if (event.type === "agent_end") end = event;
          else yield event;
        }
      } catch (error) { failure = error; }

      // Export after cancellation as well, but never apply an interrupted/failed task.
      const completed = end && !end.message.content?.startsWith("[harness]") && !failure && !runOptions.signal?.aborted;
      const apply = Boolean(completed && this.options.allowChanges !== false && env.SANDBOX_APPLY_CHANGES !== "0");
      try {
        const directory = join(this.root, "data", "sandbox-results", id);
        const result = await exportWorkspace(this.root, this.client, before, directory, apply);
        if (result.changes.length) {
          const status = result.conflicts.length ? `not applied; conflicts: ${result.conflicts.join(", ")}` : result.applied ? "applied" : "exported only";
          const message = `Sandbox: ${result.changes.length} file change(s), ${status}. Saved at ${directory}`;
          yield { type: "warning", message };
          // Keep the export location in the persisted answer, including after a reload.
          const last = end?.message;
          if (last) {
            last.content = `${last.content ?? ""}\n\n${message}`;
            yield { type: "message_end", message: last };
          }
          if (result.conflicts.length) failure = new Error(message);
        }
      } catch (error) { exportFailed = true; throw error; }
      if (failure) throw failure;
      if (end) yield end;
    } catch (error) {
      if (runOptions.signal?.aborted) yield { type: "aborted", partial: "" };
      else throw error;
    } finally {
      this.client = undefined;
      activeRoots.delete(lock);
      if (id && !exportFailed) await this.control.delete(id).catch((error: unknown) => {
        console.warn(`Sandbox cleanup failed for ${id}; TTL cleanup will retry: ${String(error)}`);
      });
      // If exporting failed, leave the workload until its TTL for recovery.
      if (id && exportFailed) console.warn(`Sandbox export failed; ${id} is retained until TTL expiry for recovery.`);
    }
  }
}
