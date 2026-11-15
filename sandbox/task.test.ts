import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Agent } from "../src/agent.js";
import { TaskExecution } from "../src/execution/task.js";
import { tools } from "../src/tools.js";
import type { AgentEvent, Message, Model } from "../src/types.js";
import { createControlPlane } from "./control-plane.js";
import { DockerRuntime } from "./docker-runtime.js";
import { MemoryMetadataStore } from "./metadata.js";
import { LifecycleService } from "./service.js";

const runtime = new DockerRuntime();
const available = await runtime.available();
const call = (name: string, args: unknown): Message => ({
  role: "assistant", content: null,
  tool_calls: [{ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

test("Docker tasks isolate tools, verify, export and clean up", { skip: !available, timeout: 240_000 }, async (t) => {
  const service = new LifecycleService({ runtime, metadata: new MemoryMetadataStore(), ttlSweepMs: 60_000 });
  const server = createControlPlane(service);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const env = { AGENT_EXECUTION: "docker", SANDBOX_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  try {
    for (const scenario of ["success", "export-only", "conflict", "verification-failure", "cancel"] as const) {
      await t.test(scenario, async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-docker-"));
        try {
          await writeFile(join(root, "hello.txt"), "before\n");
          await writeFile(join(root, ".env"), "PRIVATE_KEY=host-secret");
          const execution = new TaskExecution(tools, { root, env: { ...env, ...(scenario === "export-only" ? { SANDBOX_APPLY_CHANGES: "0" } : {}) } });
          const controller = new AbortController();
          let turn = 0;
          const model: Model = {
            async complete(messages) {
              const previous = messages.filter((message) => message.role === "tool").at(-1)?.content ?? "";
              // Every tool result must reach the model without failing over to the host.
              assert.doesNotMatch(previous, /Tool error:|Error:|exit_code: [1-9]/);
              if (turn++ === 0) return call("read", { path: "hello.txt" });
              if (turn === 2) { assert.match(previous, /before/); return call("edit", { path: "hello.txt", oldText: "before", newText: "after" }); }
              if (turn === 3) return call("bash", { command: "test ! -e .env && node -e \"require('fs').writeFileSync('generated.txt', 'node works')\"" });
              if (turn === 4) return call("glob", { pattern: "*.txt" });
              if (turn === 5) { assert.match(previous, /generated.txt/); return call("grep", { pattern: "after", glob: "*.txt" }); }
              assert.match(previous, /hello.txt:1: after/);
              assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "before\n");
              if (scenario === "conflict") await writeFile(join(root, "hello.txt"), "user edit\n");
              if (scenario === "cancel") controller.abort();
              return { role: "assistant", content: "done" };
            },
          };
          const agent = new Agent({
            model, tools: execution.tools, systemPrompt: "test", statusBar: false,
            confirmToolCall: async () => true,
            verification: { checks: [{ name: "container check", command: scenario === "verification-failure" ? "exit 1" : "grep -q after hello.txt && test -f generated.txt" }], maxAttempts: 0, execute: execution.verify },
          });
          const events: AgentEvent[] = [];
          const run = async () => { for await (const event of execution.run(agent, "edit", { signal: controller.signal })) events.push(event); };
          if (scenario === "conflict") await assert.rejects(run, /conflicts: hello.txt/);
          else await run();
          const applied = scenario === "success";
          assert.equal(await readFile(join(root, "hello.txt"), "utf8"), applied ? "after\n" : scenario === "conflict" ? "user edit\n" : "before\n");
          const results = join(root, "data", "sandbox-results");
          const [id] = await readdir(results);
          const manifest = JSON.parse(await readFile(join(results, id!, "changes.json"), "utf8"));
          assert.equal(manifest.applied, applied);
          assert.equal(manifest.changes.length, 2);
          assert.equal(await readFile(join(results, id!, "files", "generated.txt"), "utf8"), "node works");
          assert.equal(await readFile(join(root, ".env"), "utf8"), "PRIVATE_KEY=host-secret");
          assert.deepEqual(await service.list(), []);
          if (scenario === "cancel") assert.ok(events.some((event) => event.type === "aborted"));
          if (scenario === "verification-failure") assert.ok(events.some((event) => event.type === "agent_end" && event.message.content?.startsWith("[harness]")));
        } finally { await rm(root, { recursive: true, force: true }); }
      });
    }
  } finally {
    for (const sandbox of await service.list()) await service.delete(sandbox.id);
    service.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
